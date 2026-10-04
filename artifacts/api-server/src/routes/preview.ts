import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, sessionsTable } from "@workspace/db";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { resolveInWorkspace } from "../lib/workspace";
import { runtimeTarget, runtimeStatus, appendRuntimeLog } from "../lib/runtime";
import { previewBridge } from "../lib/preview-bridge";

// The preview iframe/tab is sandboxed (opaque origin), so browsers do NOT
// send the session cookie for its asset requests (css/js/images 401'd).
// Instead, access is authorized by a signed, expiring token embedded in the
// URL path — issued only to logged-in users via /sessions/:id/preview-token.
const SECRET = process.env.SESSION_SECRET!;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1h — frontend fetches a fresh token per open/reload

function sign(sessionId: number, exp: number): string {
  return crypto.createHmac("sha256", SECRET).update(`preview:${sessionId}:${exp}`).digest("base64url");
}

export function makePreviewToken(sessionId: number): string {
  const exp = Date.now() + TOKEN_TTL_MS;
  return `${exp}~${sign(sessionId, exp)}`;
}

export function verifyPreviewToken(sessionId: number, token: string): boolean {
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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function previewError(title: string, detail: string) {
  return `<html><body style="font:14px system-ui;background:#111;color:#eee;padding:32px"><h2>${escapeHtml(title)}</h2><pre style="white-space:pre-wrap">${escapeHtml(detail)}</pre><p>Fix the workspace, then reload the preview.</p></body></html>`;
}

// GET /sessions/:id/preview/:token/            -> index.html
// GET /sessions/:id/preview/:token/<any/path>  -> that file
router.all(/^\/sessions\/(\d+)\/preview\/([A-Za-z0-9_~-]+)(\/.*)?$/, async (req, res) => {
  const sessionId = Number(req.params[0]);
  const token = req.params[1]!;
  if (!verifyPreviewToken(sessionId, token)) {
    return res.status(401).json({ error: "Invalid or expired preview link. Reopen the preview." });
  }
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) return res.status(404).json({ error: "Session not found" });

  const base = `${req.baseUrl}/sessions/${sessionId}/preview/${token}/`;

  // The token is a bearer credential in the URL: never let it propagate
  // to other sites via the Referer header.
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms");
  // Module scripts/fetches originate from the sandbox's opaque (null) origin.
  // Authorization is the signed path, never cookies or CORS credentials.
  res.removeHeader("Access-Control-Allow-Credentials");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Action");
    return res.status(204).end();
  }

  let target;
  try { target = await runtimeTarget(session.workspacePath, base.slice(0, -1), req.params[2] || "/"); }
  catch (error) {
    return res.status(503).type("html").send(previewError("Application is not ready", error instanceof Error ? error.message : "Click Run."));
  }
  // Static sites need a trailing slash; frameworks own their routing.
  if (req.params[2] === undefined && !target.port) {
    return res.redirect(301, base);
  }

  if (target.port) {
    try {
      if (res.destroyed) return;
      const headers: http.OutgoingHttpHeaders = {};
      // Never forward Forge cookies, auth headers, or proxy headers to code
      // controlled by a generated project.
      for (const name of ["accept", "content-type", "rsc", "next-router-state-tree", "next-router-prefetch", "next-action"]) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      let body: string | undefined;
      if (req.body !== undefined && /application\/json/i.test(String(req.headers["content-type"]))) {
        body = JSON.stringify(req.body);
      } else if (req.body !== undefined && /application\/x-www-form-urlencoded/i.test(String(req.headers["content-type"]))) {
        body = new URLSearchParams(req.body).toString();
      }
      if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
      const upstream = http.request({
        hostname: "127.0.0.1", port: target.port, method: req.method,
        path: (target.prefix ? base.slice(0, -1) + (req.params[2] || "") : (req.params[2] || "/")) + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
        headers, timeout: 120_000,
      }, response => {
        res.status(response.statusCode || 502);
        for (const name of ["content-type", "content-encoding"]) {
          if (response.headers[name]) res.setHeader(name, response.headers[name]!);
        }
        if ((response.statusCode || 200) >= 500) {
          response.resume();
          appendRuntimeLog(session.workspacePath, `\n[http] ${req.method} ${req.params[2] || "/"} returned ${response.statusCode}\n`);
          void runtimeStatus(session.workspacePath).then(status => {
            res.type("html").send(previewError("Application error", status.logs || "See the Runtime panel for server logs."));
          }, () => res.end("Application failed. See runtime logs."));
          return;
        }
        const location = response.headers.location;
        if (location) {
          // Keep framework redirects inside the signed preview; never allow a
          // generated server to redirect into Forge's authenticated UI.
          if (location === base.slice(0, -1) || location.startsWith(base) || location.startsWith(base.slice(0, -1) + "?")) res.setHeader("Location", location);
          else if (location.startsWith("/") && !location.startsWith("//")) res.setHeader("Location", base + location.slice(1));
          else { res.status(502); response.resume(); res.end("Unsupported preview redirect"); return; }
        }
        response.on("error", () => res.destroy());
        if (String(response.headers["content-type"]).includes("text/html") && !response.headers["content-encoding"]) {
          let html = "";
          response.on("data", chunk => {
            html += chunk.toString();
            if (html.length > 8 * 1024 * 1024) { response.destroy(); res.destroy(); }
          });
          response.on("end", () => {
            const bridge = previewBridge(base.slice(0, -1));
            if (!target.prefix) html = rewriteRootUrls(html, base, "html");
            res.end(/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + bridge) : bridge + html);
          });
        } else response.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("Preview request timed out")));
      upstream.on("error", () => {
        if (!res.headersSent) res.status(502).type("html").send(previewError("Preview server unavailable", "The framework server stopped or timed out. Check the project dependencies and reload."));
        else res.destroy();
      });
      res.on("close", () => upstream.destroy());
      if (body !== undefined) upstream.end(body);
      else req.pipe(upstream);
      return;
    } catch (error) {
      return res.status(503).type("html").send(previewError(
        "Application preview could not start",
        `Run npm install --include=dev in this workspace. Resolve any configuration errors below.\n\n${error instanceof Error ? error.message : "Unknown startup error"}`,
      ));
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
  let relPath: string;
  try { relPath = decodeURIComponent(req.params[2]).replace(/^\/+/, "") || "index.html"; }
  catch { return res.status(400).end("Invalid preview path"); }
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
          previewError("No preview entry point", `Could not find ${relPath}. Static websites need index.html in the workspace root. Next.js and Vite projects are detected through package.json and started automatically.`),
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
      const rewritten = rewriteRootUrls(text, base, ext === ".css" ? "css" : "html");
      return res.send(ext === ".html" || ext === ".htm" ? previewBridge(base.slice(0, -1)) + rewritten : rewritten);
    }
    return res.send(await fs.readFile(full));
  } catch {
    return res.status(404).json({ error: "File not found" });
  }
});

export default router;
