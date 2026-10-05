import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { probeSignedPreview } from "./preview-verification";

test("signed HTTP verification rejects failures, escaped redirects, and broken entry assets", async () => {
  const base = "/api/sessions/1/preview/test/";
  let mode = "ok";
  let externalRequests = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    if (!req.url?.startsWith(base)) externalRequests++;
    if (mode === "redirect") { res.writeHead(302, { location: "/api/private" }).end(); return; }
    if (mode === "loop") { res.writeHead(302, { location: base }).end(); return; }
    if (mode === "500") { res.writeHead(500).end(); return; }
    if (req.url === base) {
      res.setHeader("content-type", "text/html");
      res.end(`<html><script src="${mode === "escape" ? "/" : base}app.js"></script></html>`);
    } else if (mode === "missing") res.writeHead(404).end();
    else if (mode === "fallback") res.writeHead(200, { "content-type": "text/html" }).end("<html/>");
    else res.writeHead(200, { "content-type": "text/javascript" }).end("console.log('ok')");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    const good = await probeSignedPreview(origin, base);
    assert.equal(good.ok, true, good.summary);
    assert.equal(good.checked, 2);
    for (mode of ["500", "redirect", "loop", "missing", "fallback", "escape"]) {
      const result = await probeSignedPreview(origin, base);
      assert.equal(result.ok, false, mode);
      assert.ok(!result.summary.includes(base), "signed paths never leak");
    }
    assert.equal(externalRequests, 0);
    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    await assert.rejects(probeSignedPreview(origin, base, controller.signal), /cancellation/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});