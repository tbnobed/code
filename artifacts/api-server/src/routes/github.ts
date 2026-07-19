import { Router, type IRouter } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { getRequester } from "../lib/auth";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import {
  GITHUB_API,
  githubHeaders,
  githubUser,
  noreplyEmail,
  resolveGithubToken,
  gitPush,
} from "../lib/github";
import { ensureRepo, commitTurn } from "../lib/workspace-git";
import { getSessionOr404 } from "./sessions";

const run = promisify(execFile);
const router: IRouter = Router();

/** Full user row for the logged-in user (getRequester only projects id/isAdmin). */
async function getMe(req: { session: { userId?: number } }) {
  const requester = await getRequester(req);
  if (!requester) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, requester.id));
  return user ?? null;
}

// ---------------- account level ----------------

router.get("/me/github", async (req, res) => {
  const me = await getMe(req);
  if (!me) return res.status(401).json({ error: "Not authenticated" });
  const connected = Boolean(me.githubToken && decryptSecret(me.githubToken));
  return res.json({
    connected,
    login: connected ? me.githubLogin : null,
    // Single-user installs may still rely on the server-wide env token.
    serverToken: !connected && Boolean((process.env.GITHUB_TOKEN || "").trim()),
  });
});

router.put("/me/github", async (req, res) => {
  const me = await getMe(req);
  if (!me) return res.status(401).json({ error: "Not authenticated" });
  const token = typeof (req.body ?? {}).token === "string" ? req.body.token.trim() : "";
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) {
    return res
      .status(400)
      .json({ error: "That doesn't look like a GitHub personal access token" });
  }
  let gh: Awaited<ReturnType<typeof githubUser>>;
  try {
    gh = await githubUser(token);
  } catch (err: any) {
    if (err?.status === 401 || err?.status === 403) {
      return res.status(400).json({
        error: "GitHub rejected the token — check that it's valid, not expired, and has repo access",
      });
    }
    return res.status(502).json({
      error: `Could not reach GitHub to verify the token: ${err?.message ?? "unknown error"}`,
    });
  }
  await db
    .update(usersTable)
    .set({
      githubToken: encryptSecret(token),
      githubLogin: gh.login,
      githubEmail: noreplyEmail(gh.id, gh.login),
    })
    .where(eq(usersTable.id, me.id));
  return res.json({ connected: true, login: gh.login });
});

router.delete("/me/github", async (req, res) => {
  const me = await getMe(req);
  if (!me) return res.status(401).json({ error: "Not authenticated" });
  await db
    .update(usersTable)
    .set({ githubToken: null, githubLogin: null, githubEmail: null })
    .where(eq(usersTable.id, me.id));
  return res.json({ connected: false });
});

// Repo picker for "link existing" — personal token only: the env fallback
// belongs to the server operator's GitHub account, not this user.
router.get("/me/github/repos", async (req, res) => {
  const me = await getMe(req);
  if (!me) return res.status(401).json({ error: "Not authenticated" });
  const token = me.githubToken ? decryptSecret(me.githubToken) : null;
  if (!token) return res.status(400).json({ error: "Connect your GitHub account first" });
  try {
    const resp = await fetch(`${GITHUB_API}/user/repos?per_page=100&sort=pushed`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return res.status(502).json({ error: `GitHub repo listing failed (HTTP ${resp.status})` });
    }
    const repos = (await resp.json()) as Array<{
      full_name: string;
      private: boolean;
      pushed_at: string | null;
      permissions?: { push?: boolean };
    }>;
    return res.json(
      repos
        .filter((r) => r.permissions?.push !== false)
        .map((r) => ({ fullName: r.full_name, private: r.private, pushedAt: r.pushed_at })),
    );
  } catch (err: any) {
    return res.status(502).json({ error: `Could not reach GitHub: ${err?.message ?? err}` });
  }
});

// ---------------- session level ----------------

/**
 * Session repo operations use the session OWNER's token (not the requester's):
 * turn-time pushes run as the owner, so the link must be usable by them.
 * Falls back to the server-wide env token for legacy single-user installs.
 */
async function ownerCredentials(userId: number) {
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  const personal = owner?.githubToken ? decryptSecret(owner.githubToken) : null;
  const token = personal ?? ((process.env.GITHUB_TOKEN || "").trim() || null);
  return { owner, personal, token };
}

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

router.post("/sessions/:id/github/repo", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  if (session.githubRepo) {
    return res.status(409).json({ error: `Already linked to ${session.githubRepo} — unlink first` });
  }
  const { owner, personal, token } = await ownerCredentials(session.userId);
  if (!token) {
    return res.status(400).json({ error: "The session owner has no GitHub account connected" });
  }

  const { mode } = (req.body ?? {}) as Record<string, unknown>;
  let fullName: string;

  if (mode === "create") {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!REPO_NAME_RE.test(name)) {
      return res.status(400).json({ error: "Repo name: 1-100 letters, digits, dots, dashes, underscores" });
    }
    const isPrivate = req.body?.private !== false; // default private
    let resp: Response;
    try {
      resp = await fetch(`${GITHUB_API}/user/repos`, {
        method: "POST",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      return res.status(502).json({ error: `Could not reach GitHub: ${err?.message ?? err}` });
    }
    if (resp.status === 422) {
      return res.status(409).json({ error: `A repo named "${name}" already exists on that account` });
    }
    if (!resp.ok) {
      const detail = await resp.json().then((j: any) => j?.message).catch(() => "");
      return res.status(502).json({ error: `GitHub repo creation failed (HTTP ${resp.status}${detail ? `: ${detail}` : ""})` });
    }
    fullName = ((await resp.json()) as { full_name: string }).full_name;
  } else if (mode === "link") {
    const repo = typeof req.body?.repo === "string" ? req.body.repo.trim() : "";
    if (!FULL_NAME_RE.test(repo)) {
      return res.status(400).json({ error: "Provide the repo as owner/name" });
    }
    let resp: Response;
    try {
      resp = await fetch(`${GITHUB_API}/repos/${repo}`, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      return res.status(502).json({ error: `Could not reach GitHub: ${err?.message ?? err}` });
    }
    if (resp.status === 404) {
      return res.status(404).json({ error: "Repo not found (or the token has no access to it)" });
    }
    if (!resp.ok) {
      return res.status(502).json({ error: `GitHub repo lookup failed (HTTP ${resp.status})` });
    }
    const data = (await resp.json()) as { full_name: string; permissions?: { push?: boolean } };
    if (data.permissions && data.permissions.push === false) {
      return res.status(400).json({ error: "The token has read-only access to that repo — push is required" });
    }
    fullName = data.full_name;
  } else {
    return res.status(400).json({ error: 'mode must be "create" or "link"' });
  }

  // Wire the workspace: origin remote + (when a personal account is known)
  // a local commit identity so checkpoints attribute to the user on GitHub.
  await ensureRepo(session.workspacePath);
  const ws = { cwd: session.workspacePath };
  await run("git", ["remote", "remove", "origin"], ws).catch(() => {});
  await run("git", ["remote", "add", "origin", `https://github.com/${fullName}.git`], ws);
  if (personal && owner?.githubLogin && owner?.githubEmail) {
    await run("git", ["config", "user.name", owner.githubLogin], ws);
    await run("git", ["config", "user.email", owner.githubEmail], ws);
  }

  await db
    .update(sessionsTable)
    .set({ githubRepo: fullName })
    .where(eq(sessionsTable.id, session.id));

  // Fresh repos get the existing checkpoint history immediately; linked repos
  // may have foreign history, so pushing stays an explicit user action.
  let pushed = false;
  let pushDetail = "";
  if (mode === "create") {
    await commitTurn(session.workspacePath, "manual changes").catch(() => {});
    const p = await gitPush(session.workspacePath, token, fullName);
    pushed = p.ok;
    pushDetail = p.detail;
  }
  return res.status(201).json({ repo: fullName, pushed, pushDetail });
});

router.post("/sessions/:id/github/push", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  if (!session.githubRepo) {
    return res.status(400).json({ error: "No GitHub repo linked to this session" });
  }
  const token = await resolveGithubToken(session.userId);
  if (!token) {
    return res.status(400).json({ error: "The session owner has no GitHub account connected" });
  }
  await ensureRepo(session.workspacePath);
  // Capture uncommitted editor/terminal work so the push reflects what's on disk.
  await commitTurn(session.workspacePath, "manual changes").catch(() => {});
  const result = await gitPush(session.workspacePath, token, session.githubRepo);
  if (!result.ok) {
    return res.status(502).json({ error: "git push failed", detail: result.detail });
  }
  return res.json({ ok: true, detail: result.detail });
});

router.patch("/sessions/:id/github", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const { autopush, unlink } = (req.body ?? {}) as Record<string, unknown>;

  if (unlink === true) {
    await run("git", ["remote", "remove", "origin"], { cwd: session.workspacePath }).catch(() => {});
    await db
      .update(sessionsTable)
      .set({ githubRepo: null, githubAutopush: false })
      .where(eq(sessionsTable.id, session.id));
    return res.json({ repo: null, autopush: false });
  }
  if (typeof autopush === "boolean") {
    if (!session.githubRepo) {
      return res.status(400).json({ error: "Link a repo before enabling auto-push" });
    }
    await db
      .update(sessionsTable)
      .set({ githubAutopush: autopush })
      .where(eq(sessionsTable.id, session.id));
    return res.json({ repo: session.githubRepo, autopush });
  }
  return res.status(400).json({ error: "Nothing to update" });
});

export default router;
