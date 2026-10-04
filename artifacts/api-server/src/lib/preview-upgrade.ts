import http from "node:http";
import type { Server } from "node:http";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyPreviewToken } from "../routes/preview";
import { runtimeTarget } from "./runtime";

/** WebSocket transport for applications, authenticated by the signed preview
 * path. Never forward Forge cookies/auth to project processes. */
export function attachPreviewUpgrades(server: Server) {
  server.on("upgrade", async (req, socket, head) => {
    try {
      const match = /^\/api\/sessions\/(\d+)\/preview\/([A-Za-z0-9_~-]+)(\/[^?]*)?(\?.*)?$/.exec(req.url || "");
      if (!match || !verifyPreviewToken(Number(match[1]), match[2])) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
      const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, Number(match[1])));
      if (!session) { socket.destroy(); return; }
      const base = `/api/sessions/${match[1]}/preview/${match[2]}`;
      const target = await runtimeTarget(session.workspacePath, base, match[3] || "/");
      if (!target.port) { socket.destroy(); return; }
      const headers: http.OutgoingHttpHeaders = { connection: "Upgrade", upgrade: "websocket" };
      for (const key of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
        if (req.headers[key]) headers[key] = req.headers[key];
      }
      const upstream = http.request({
        hostname: "127.0.0.1", port: target.port,
        path: (target.prefix ? base : "") + (match[3] || "/") + (match[4] || ""), headers,
      });
      upstream.setTimeout(120000, () => upstream.destroy());
      upstream.on("upgrade", (response, peer, peerHead) => {
        const responseHeaders = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade"];
        for (const key of ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]) {
          if (response.headers[key]) responseHeaders.push(`${key}: ${response.headers[key]}`);
        }
        socket.write(responseHeaders.join("\r\n") + "\r\n\r\n");
        if (head.length) peer.write(head);
        if (peerHead.length) socket.write(peerHead);
        socket.on("error", () => peer.destroy());
        peer.on("error", () => socket.destroy());
        socket.on("close", () => peer.destroy());
        peer.on("close", () => socket.destroy());
        peer.pipe(socket); socket.pipe(peer);
      });
      upstream.on("response", response => { response.resume(); socket.destroy(); });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.end();
    } catch { socket.destroy(); }
  });
}