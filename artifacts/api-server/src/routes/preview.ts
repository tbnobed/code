import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, sessionsTable } from "@workspace/db";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInWorkspace } from "../lib/workspace";

// The preview iframe/tab is sandboxed (opaque origin), so browsers do NOT
// send the session cookie for its asset requests (css/js/images 401'd).
// Instead, access is authorized by a signed, expiring token embedded in the
// URL path — issued only to logged-in users via /sessions/:id/preview-token.
const SECRET = process.env.SESSION_SECRET!;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function sign(sessionId: number, exp: number): string {
  return crypto.createHmac("sha256", SECRET).update(`preview:${sessionId}:${exp}`).digest("base64url");
}

export function makePreviewToken(sessionId: number): string {
  const exp = Date.now() + TOKEN_TTL_MS;
  return `${exp}~${sign(sessionId, exp)}`;
}

function verifyPreviewToken(sessionId: number, token: string): boolean {
  const [expStr, sig] = token.split("~");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expected = sign(sessionId, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

// Sites often reference assets with root-absolute paths ("/styles.css"),
// which would escape the preview prefix and 404. Rewrite them to stay
// under the tokened preview base.
function rewriteRootUrls(content: string, base: string, kind: "html" | "css"): string {
  let out = content;
  if (kind === "html") {
    out = out.replace(/(\s(?:href|src|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${base}`);
    out = out.replace(/(\ssrcset\s*=\s*["'])([^"']+)(["'])/gi, (_m, p1, val, p3) => {
      return p1 + val.replace(/(^|,\s*)\/(?!\/)/g, `$1${base}`) + p3;
    });
  }
  // url(/...) in inline <style> or css files
  out = out.replace(/(url\(\s*["']?)\/(?!\/)/gi, `$1${base}`);
  return out;
}

const router: IRouter = Router();

// GET /sessions/:id/preview/:token/            -> index.html
// GET /sessions/:id/preview/:token/<any/path>  -> that file
router.get(/^\/sessions\/(\d+)\/preview\/([A-Za-z0-9_~-]+)(\/.*)?$/, async (req, res) => {
  const sessionId = Number(req.params[0]);
  const token = req.params[1]!;
  if (!verifyPreviewToken(sessionId, token)) {
    return res.status(401).json({ error: "Invalid or expired preview link. Reopen the preview." });
  }
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) return res.status(404).json({ error: "Session not found" });

  const base = `${req.baseUrl}/sessions/${sessionId}/preview/${token}/`;

  // Redirect bare .../preview/<token> to .../<token>/ so relative URLs resolve
  if (req.params[2] === undefined) {
    return res.redirect(301, base);
  }

  const relPath = decodeURIComponent(req.params[2]).replace(/^\/+/, "") || "index.html";
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
    const ext = path.extname(full).toLowerCase();
    res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    // Force an opaque origin even when opened in a new tab: agent-generated
    // code must never run with the app's origin/auth context.
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms");
    if (ext === ".html" || ext === ".htm" || ext === ".css") {
      const text = await fs.readFile(full, "utf8");
      return res.send(rewriteRootUrls(text, base, ext === ".css" ? "css" : "html"));
    }
    return res.send(await fs.readFile(full));
  } catch {
    return res.status(404).json({ error: "File not found" });
  }
});

export default router;
