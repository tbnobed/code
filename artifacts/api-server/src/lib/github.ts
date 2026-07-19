import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { decryptSecret } from "./crypto";
import { workspaceEnv } from "./agent-tools";
import { GITHUB_CREDENTIAL_HELPER } from "./git-setup";
import { logger } from "./logger";

const run = promisify(execFile);

export const GITHUB_API = "https://api.github.com";

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "forge-agent",
  };
}

/**
 * The token used for a session's git operations: the session OWNER's personal
 * PAT (so pushes attribute to them), falling back to the server-wide
 * GITHUB_TOKEN env var that single-user installs relied on before per-user
 * accounts existed.
 */
export async function resolveGithubToken(userId: number): Promise<string | null> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (user?.githubToken) {
    const token = decryptSecret(user.githubToken);
    if (token) return token;
  }
  return (process.env.GITHUB_TOKEN || "").trim() || null;
}

export async function githubUser(token: string) {
  const resp = await fetch(`${GITHUB_API}/user`, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`GitHub rejected the token (HTTP ${resp.status})`), {
      status: resp.status,
    });
  }
  return (await resp.json()) as { login: string; id: number; name: string | null };
}

/** Commit email that links pushes to the account without exposing a real address. */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/** Strip a secret value from text destined for clients or logs. */
export function redactValue(s: string, secret: string | null | undefined): string {
  return secret && s.includes(secret) ? s.split(secret).join("[REDACTED_TOKEN]") : s;
}

/**
 * Push the workspace's current branch to origin. The token travels via env —
 * the boot-time git credential helper reads $GITHUB_TOKEN at use time, so it
 * is never written to disk or embedded in remote URLs.
 */
export async function gitPush(
  workspaceDir: string,
  token: string,
  repoFullName: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    // Server-side pushes must not trust anything the workspace can write:
    // - push to the canonical URL from the DB, never the mutable "origin"
    //   remote (.git/config is user-writable);
    // - reset the credential-helper chain before re-adding ours — a planted
    //   .git/config helper would otherwise receive the token via its store
    //   callback;
    // - disable workspace-planted hooks;
    // - workspaceEnv keeps server-only secrets out of the child process.
    const { stdout, stderr } = await run(
      "git",
      [
        "-c", "credential.helper=",
        "-c", "credential.https://github.com.helper=",
        "-c", `credential.https://github.com.helper=${GITHUB_CREDENTIAL_HELPER}`,
        "-c", "core.hooksPath=/dev/null",
        "push", `https://github.com/${repoFullName}.git`, "HEAD",
      ],
      {
        cwd: workspaceDir,
        env: { ...workspaceEnv(token), GIT_TERMINAL_PROMPT: "0" },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return { ok: true, detail: redactValue((stderr || stdout || "").trim().slice(-2000), token) };
  } catch (err: any) {
    const detail = [err?.stderr, err?.stdout, err?.message]
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(-2000);
    return { ok: false, detail: redactValue(detail, token) };
  }
}

/**
 * Best-effort auto-push after a turn's checkpoint. Re-reads the session row
 * so a mid-turn unlink or toggle change is respected; failures are logged,
 * never surfaced as turn errors.
 */
export async function autoPushIfEnabled(sessionId: number): Promise<void> {
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session?.githubRepo || !session.githubAutopush) return;
  const token = await resolveGithubToken(session.userId);
  if (!token) return;
  const res = await gitPush(session.workspacePath, token, session.githubRepo);
  if (res.ok) {
    logger.info({ sessionId, repo: session.githubRepo }, "auto-pushed checkpoint");
  } else {
    logger.warn({ sessionId, repo: session.githubRepo, detail: res.detail }, "auto-push failed");
  }
}
