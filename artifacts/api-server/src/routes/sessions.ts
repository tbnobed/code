import { Router, raw, type IRouter } from "express";
import { eq, desc, asc, and, gte, sql } from "drizzle-orm";
import { db, sessionsTable, messagesTable, usersTable } from "@workspace/db";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { ZipArchive } from "archiver";
import { makePreviewToken } from "./preview";
import path from "node:path";
import { createWorkspace, resolveInWorkspace, languageFromPath } from "../lib/workspace";
import { DEFAULT_MODEL } from "../lib/ollama";
import { runAgentTurn, runArchitectTurn } from "../lib/agent-loop";

/** Turn low-level fetch/socket failures into something the user can act on. */
function friendlyTurnError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "Agent failed";
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket|terminated|network error|Connection error/i.test(raw)) {
    return (
      "Lost the connection to Ollama mid-turn (" + raw + "). " +
      "Check that Ollama is running and healthy on the host (ollama ps) — an over-long prompt or an out-of-memory model crash is the usual cause. " +
      "Retry with a short instruction; avoid re-pasting large content, the conversation is already in the agent's context."
    );
  }
  return raw;
}
import { runReviewTurn } from "../lib/review";
import { reviewAvailable } from "../lib/anthropic";
import { redactSecrets, workspaceEnv, makeStreamRedactor } from "../lib/agent-tools";
import {
  ensureRepo,
  commitTurn,
  listCheckpoints,
  diffCheckpoint,
  revertTo,
} from "../lib/workspace-git";
import { getRequester } from "../lib/auth";

const router: IRouter = Router();

function serializeSession(s: typeof sessionsTable.$inferSelect, username?: string) {
  return {
    id: s.id,
    userId: s.userId,
    ...(username !== undefined ? { username } : {}),
    title: s.title,
    model: s.model,
    workspacePath: s.workspacePath,
    messageCount: s.messageCount,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function serializeMessage(m: typeof messagesTable.$inferSelect) {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    toolCallId: m.toolCallId,
    mode: m.mode,
    createdAt: m.createdAt.toISOString(),
  };
}

async function getSessionOr404(
  req: { params: Record<string, string | undefined>; session: { userId?: number } },
  res: any,
) {
  const requester = await getRequester(req);
  if (!requester) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));
  // Non-owners get the same 404 as a missing session: don't leak existence.
  if (!session || (session.userId !== requester.id && !requester.isAdmin)) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  return session;
}

// List sessions — each user sees only their own; admins see everyone's
// (with the owner's username attached so the UI can label them).
router.get("/sessions", async (req, res) => {
  const requester = await getRequester(req);
  if (!requester) return res.status(401).json({ error: "Not authenticated" });
  const rows = await db
    .select({ session: sessionsTable, username: usersTable.username })
    .from(sessionsTable)
    .leftJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(requester.isAdmin ? undefined : eq(sessionsTable.userId, requester.id))
    .orderBy(desc(sessionsTable.updatedAt));
  return res.json(rows.map((r) => serializeSession(r.session, r.username ?? undefined)));
});

// Create session
router.post("/sessions", async (req, res) => {
  const requester = await getRequester(req);
  if (!requester) return res.status(401).json({ error: "Not authenticated" });
  const { title, model } = req.body ?? {};
  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }
  const [session] = await db
    .insert(sessionsTable)
    .values({
      title,
      model: typeof model === "string" && model ? model : DEFAULT_MODEL,
      workspacePath: "pending",
      userId: requester.id,
    })
    .returning();
  const workspacePath = await createWorkspace(session.id);
  const [updated] = await db
    .update(sessionsTable)
    .set({ workspacePath })
    .where(eq(sessionsTable.id, session.id))
    .returning();
  return res.status(201).json(serializeSession(updated));
});

// Get session with messages
router.get("/sessions/:id", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id))
    .orderBy(asc(messagesTable.id));
  res.json({ ...serializeSession(session), messages: messages.map(serializeMessage) });
});

// Delete session
router.delete("/sessions/:id", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
  await fs.rm(session.workspacePath, { recursive: true, force: true }).catch(() => {});
  res.status(204).end();
});

// List messages
router.get("/sessions/:id/messages", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id))
    .orderBy(asc(messagesTable.id));
  res.json(messages.map(serializeMessage));
});

// Chat (SSE stream)
router.post("/sessions/:id/chat", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const { content, architect } = req.body ?? {};
  if (!content || typeof content !== "string") {
    return res.status(400).json({ error: "content is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // STOP: the client aborts its fetch, the socket closes, and we cancel the
  // whole turn server-side (model generation + running tools).
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  const send = (event: Record<string, unknown>) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Checkpoint any manual changes (uploads, editor saves, terminal work)
  // separately, so each turn's diff is purely the agent's doing.
  try {
    await ensureRepo(session.workspacePath);
    await commitTurn(session.workspacePath, "manual changes");
  } catch (err) {
    req.log.warn({ err }, "pre-turn checkpoint failed");
  }

  try {
    if (architect === true) {
      // Deep-dive turn: reasoning model, no tools, thinking streamed to UI.
      await runArchitectTurn(session, content, send, ac.signal);
    } else {
      await runAgentTurn(session, content, send, ac.signal);
    }
  } catch (err) {
    req.log.error({ err }, "agent turn failed");
    send({ type: "error", message: friendlyTurnError(err) });
  } finally {
    try {
      const hash = await commitTurn(session.workspacePath, content);
      if (hash) send({ type: "checkpoint", hash });
    } catch (err) {
      req.log.warn({ err }, "checkpoint commit failed");
    }
    send({ type: "done" });
    if (!res.destroyed) res.end();
  }
  return undefined;
});

// Send the session's work to Claude for an external code review (SSE).
router.post("/sessions/:id/review", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  if (!reviewAvailable()) {
    return res.status(503).json({
      error: "Code review is not configured — set ANTHROPIC_API_KEY on the server.",
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  const send = (event: Record<string, unknown>) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Fold any manual edits into a checkpoint so the review sees them too.
  try {
    await ensureRepo(session.workspacePath);
    await commitTurn(session.workspacePath, "manual changes");
  } catch (err) {
    req.log.warn({ err }, "pre-review checkpoint failed");
  }

  try {
    await runReviewTurn(session, send, ac.signal);
  } catch (err) {
    req.log.error({ err }, "review turn failed");
    send({ type: "error", message: err instanceof Error ? err.message : "Review failed" });
  } finally {
    send({ type: "done" });
    if (!res.destroyed) res.end();
  }
  return undefined;
});

// Checkpoints (git history of the workspace)
router.get("/sessions/:id/checkpoints", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  try {
    // Opportunistic heal: legacy repos without a root commit get their
    // baseline here, so the tab works without needing a turn first.
    await ensureRepo(session.workspacePath).catch((err) => {
      req.log.warn({ err }, "checkpoint heal failed");
    });
    res.json(await listCheckpoints(session.workspacePath));
  } catch (err) {
    req.log.error({ err }, "checkpoint list failed");
    res.status(500).json({ error: "Failed to list checkpoints" });
  }
});

router.get("/sessions/:id/checkpoints/:hash/diff", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  try {
    res.json({ diff: await diffCheckpoint(session.workspacePath, req.params.hash) });
  } catch (err) {
    req.log.warn({ err }, "checkpoint diff failed");
    res.status(400).json({ error: "Failed to load diff" });
  }
});

router.post("/sessions/:id/checkpoints/:hash/revert", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  try {
    const commit = await revertTo(session.workspacePath, req.params.hash);
    res.json({ ok: true, commit });
  } catch (err) {
    req.log.error({ err }, "checkpoint revert failed");
    res.status(400).json({ error: "Revert failed" });
  }
});

// Delete a message and everything after it (retry / edit-last-message)
router.delete("/sessions/:id/messages/:messageId", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const mid = Number(req.params.messageId);
  if (!Number.isInteger(mid)) {
    return res.status(400).json({ error: "Invalid message id" });
  }
  const [target] = await db
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.sessionId, session.id), eq(messagesTable.id, mid)));
  if (!target) return res.status(404).json({ error: "Message not found" });
  await db
    .delete(messagesTable)
    .where(and(eq(messagesTable.sessionId, session.id), gte(messagesTable.id, mid)));
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id));
  await db
    .update(sessionsTable)
    .set({ messageCount: row.count, updatedAt: new Date() })
    .where(eq(sessionsTable.id, session.id));
  return res.json({ deletedFrom: mid, remaining: row.count });
});

// Save a file from the in-app editor
router.put("/sessions/:id/file", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const { path: relPath, content } = req.body ?? {};
  if (!relPath || typeof relPath !== "string" || typeof content !== "string") {
    return res.status(400).json({ error: "path and content are required" });
  }
  if (content.length > 2_000_000) {
    return res.status(413).json({ error: "File too large to save via the editor (2MB max)" });
  }
  try {
    await fs.mkdir(session.workspacePath, { recursive: true });
    const full = await resolveInWorkspace(session.workspacePath, relPath);
    await fs.writeFile(full, content, "utf8");
    return res.json({ ok: true });
  } catch (err) {
    req.log.warn({ err }, "file save failed");
    return res.status(400).json({ error: "Could not save file" });
  }
});

// User terminal: run a command in the workspace, stream output (SSE)
router.post("/sessions/:id/exec", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const { command } = req.body ?? {};
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "command is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: Record<string, unknown>) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  await fs.mkdir(session.workspacePath, { recursive: true });
  const child = spawn("/bin/bash", ["-c", command], {
    cwd: session.workspacePath,
    env: workspaceEnv(), // server-only secrets stripped from user shells
    detached: true, // own process group so we can kill the whole tree
  });
  const killTree = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL"); // negative pid = whole group
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL"); // group already gone or not permitted; best effort
    }
  };

  const OUTPUT_CAP = 1_000_000;
  let streamed = 0;
  // Per-channel stateful redactors: they hold back partial lines so a secret
  // split across chunk boundaries can never be emitted unredacted.
  const redactors = { stdout: makeStreamRedactor(), stderr: makeStreamRedactor() };
  const forward = (kind: "stdout" | "stderr") => (buf: Buffer) => {
    if (streamed > OUTPUT_CAP) return;
    streamed += buf.length;
    const safe = redactors[kind].push(buf.toString("utf8"));
    if (safe) send({ type: kind, data: safe });
    if (streamed > OUTPUT_CAP) {
      send({ type: "stderr", data: "\n[output cap reached — process killed]\n" });
      killTree();
    }
  };
  child.stdout.on("data", forward("stdout"));
  child.stderr.on("data", forward("stderr"));

  const timer = setTimeout(() => {
    send({ type: "stderr", data: "\n[timed out after 5 minutes — process killed]\n" });
    killTree();
  }, 5 * 60_000);

  res.on("close", () => {
    if (!res.writableEnded) killTree();
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    for (const kind of ["stdout", "stderr"] as const) {
      const rest = redactors[kind].flush();
      if (rest) send({ type: kind, data: rest });
    }
    send({ type: "exit", code });
    if (!res.destroyed) res.end();
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    send({ type: "stderr", data: String(err) });
    send({ type: "exit", code: -1 });
    if (!res.destroyed) res.end();
  });
  return undefined;
});

// Workspace file listing
// Raw file bytes (images and other binaries) for the file viewer and chat
// thumbnails. sendFile with `root` jails the path inside the workspace and
// rejects traversal attempts.
router.get("/sessions/:id/file/raw", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const rel = String(req.query.path ?? "").trim();
  if (!rel) {
    res.status(400).json({ error: "path query parameter is required" });
    return;
  }
  // Realpath containment via resolveInWorkspace — sendFile's `root` option is
  // only a lexical check and is escapable through symlinks created inside the
  // workspace (e.g. via run_command or the terminal).
  let abs: string;
  try {
    abs = await resolveInWorkspace(session.workspacePath, rel);
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  // dotfiles are legitimate workspace files (.env, .gitignore) — containment is
  // already enforced by the realpath check above, not by name filtering.
  res.sendFile(abs, { dotfiles: "allow" }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "File not found" });
  });
});

router.get("/sessions/:id/files", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;

  async function walk(dir: string): Promise<any[]> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: any[] = [];
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      const stat = await fs.stat(full);
      const rel = path.relative(session!.workspacePath, full);
      out.push({
        name: e.name,
        path: rel,
        type: e.isDirectory() ? "directory" : "file",
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
      if (e.isDirectory()) out.push(...(await walk(full)));
    }
    return out;
  }

  res.json(await walk(session.workspacePath));
});

// Upload a file into the workspace root. Raw body (any content type, files
// are opaque bytes); the file name travels in the URL so no multipart parser
// is needed. esbuild-friendly: static imports only.
router.put(
  "/sessions/:id/files/:name",
  raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const session = await getSessionOr404(req, res);
    if (!session) return;
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: "Expected a raw file body" });
    }
    // Flatten to a bare file name: no directories, no traversal. Reject
    // control characters (they'd leak into prompts/logs) and absurd lengths.
    const name = path.basename(req.params.name).trim();
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.length > 255 ||
      /[\x00-\x1f\x7f]/.test(name)
    ) {
      return res.status(400).json({ error: "Invalid file name" });
    }
    try {
      // Self-heal: workspace dirs live under /tmp in dev and can vanish
      // across host restarts; recreate before resolving.
      await fs.mkdir(session.workspacePath, { recursive: true });
      const full = await resolveInWorkspace(session.workspacePath, name);
      await fs.writeFile(full, req.body);
      return res.status(201).json({ name, size: req.body.length });
    } catch (err) {
      req.log?.error({ err }, "file upload failed");
      return res.status(400).json({ error: "Could not save file" });
    }
  },
);

// Issue a signed preview token (requires login); the preview routes
// themselves are cookie-free because the sandboxed iframe drops cookies.
router.get("/sessions/:id/preview-token", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  res.json({ token: makePreviewToken(session.id) });
});

// Download the whole workspace as a zip (excludes node_modules/.git)
router.get("/sessions/:id/download", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;

  const safeName = (session.title || `session-${session.id}`)
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase() || `session-${session.id}`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("error", (err: Error) => {
    req.log?.error({ err }, "zip archive failed");
    res.destroy();
  });
  res.on("close", () => {
    // Stop compressing if the client disconnects mid-download.
    if (!res.writableFinished) archive.abort();
  });
  archive.pipe(res);
  archive.glob("**/*", {
    cwd: session.workspacePath,
    ignore: ["node_modules/**", ".git/**"],
    dot: true,
  });
  await archive.finalize();
});

// Read workspace file
router.post("/sessions/:id/file", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const { path: relPath } = req.body ?? {};
  if (!relPath || typeof relPath !== "string") {
    return res.status(400).json({ error: "path is required" });
  }
  try {
    const full = await resolveInWorkspace(session.workspacePath, relPath);
    const content = await fs.readFile(full, "utf8");
    return res.json({ path: relPath, content, language: languageFromPath(relPath) });
  } catch {
    return res.status(404).json({ error: "File not found" });
  }
});

export default router;
