import { Router, type IRouter } from "express";
import { eq, desc, asc } from "drizzle-orm";
import { db, sessionsTable, messagesTable } from "@workspace/db";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorkspace, resolveInWorkspace, languageFromPath } from "../lib/workspace";
import { DEFAULT_MODEL } from "../lib/ollama";
import { runAgentTurn } from "../lib/agent-loop";

const router: IRouter = Router();

function serializeSession(s: typeof sessionsTable.$inferSelect) {
  return {
    id: s.id,
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
    createdAt: m.createdAt.toISOString(),
  };
}

async function getSessionOr404(id: string, res: any) {
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  return session;
}

// List sessions
router.get("/sessions", async (_req, res) => {
  const sessions = await db
    .select()
    .from(sessionsTable)
    .orderBy(desc(sessionsTable.updatedAt));
  res.json(sessions.map(serializeSession));
});

// Create session
router.post("/sessions", async (req, res) => {
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
  const session = await getSessionOr404(req.params.id, res);
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
  const session = await getSessionOr404(req.params.id, res);
  if (!session) return;
  await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
  await fs.rm(session.workspacePath, { recursive: true, force: true }).catch(() => {});
  res.status(204).end();
});

// List messages
router.get("/sessions/:id/messages", async (req, res) => {
  const session = await getSessionOr404(req.params.id, res);
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
  const session = await getSessionOr404(req.params.id, res);
  if (!session) return;
  const { content } = req.body ?? {};
  if (!content || typeof content !== "string") {
    return res.status(400).json({ error: "content is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await runAgentTurn(session, content, send);
  } catch (err) {
    req.log.error({ err }, "agent turn failed");
    send({ type: "error", message: err instanceof Error ? err.message : "Agent failed" });
  } finally {
    send({ type: "done" });
    res.end();
  }
  return undefined;
});

// Workspace file listing
router.get("/sessions/:id/files", async (req, res) => {
  const session = await getSessionOr404(req.params.id, res);
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

// Live static preview of the workspace (serves the site the agent built).
// GET /sessions/:id/preview/            -> index.html
// GET /sessions/:id/preview/<any/path>  -> that file
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

router.get(/^\/sessions\/(\d+)\/preview(\/.*)?$/, async (req, res) => {
  const session = await getSessionOr404(req.params[0]!, res);
  if (!session) return;

  // Redirect bare /preview to /preview/ so relative asset URLs resolve
  if (req.params[1] === undefined) {
    return res.redirect(301, `${req.baseUrl}/sessions/${session.id}/preview/`);
  }

  const relPath = decodeURIComponent(req.params[1]).replace(/^\/+/, "") || "index.html";
  try {
    let full = await resolveInWorkspace(session.workspacePath, relPath);
    let stat = await fs.stat(full).catch(() => null);
    if (stat?.isDirectory()) {
      full = path.join(full, "index.html");
      stat = await fs.stat(full).catch(() => null);
    }
    if (!stat?.isFile()) {
      return res
        .status(404)
        .type("html")
        .send(
          `<html><body style="font-family:monospace;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div><h2>No preview yet</h2><p>The workspace has no <code>${relPath === "index.html" ? "index.html" : relPath}</code>. Ask the agent to build a website first.</p></div></body></html>`,
        );
    }
    res.setHeader(
      "Content-Type",
      MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
    );
    res.setHeader("Cache-Control", "no-store");
    return res.send(await fs.readFile(full));
  } catch {
    return res.status(404).json({ error: "File not found" });
  }
});

// Read workspace file
router.post("/sessions/:id/file", async (req, res) => {
  const session = await getSessionOr404(req.params.id, res);
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
