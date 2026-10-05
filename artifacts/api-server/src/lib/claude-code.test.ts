import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedBrief, BRIEF_BYTE_LIMIT, requestClaudeHelp } from "./claude-code";
import { localCodingModel, DEFAULT_MODEL } from "./ollama";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("briefs are bounded in bytes, including multibyte content", () => {
  assert.equal(boundedBrief("  short  "), "short");
  for (const text of ["x".repeat(20000), "漢".repeat(9000), "😀".repeat(9000)]) {
    const result = boundedBrief(text);
    assert.ok(Buffer.byteLength(result) <= BRIEF_BYTE_LIMIT);
    assert.match(result, /truncated/);
  }
});
test("saved Claude coding selections cannot enable automatic Claude use", () => {
  assert.equal(localCodingModel("claude-code/sonnet"), DEFAULT_MODEL);
  assert.equal(localCodingModel("claude-code/opus"), DEFAULT_MODEL);
  assert.equal(localCodingModel("local-model"), "local-model");
});

test("Unix transport, explicit bridge failure and cancellation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-claude-test-"));
  const socket = path.join(dir, "bridge.sock");
  const previous = process.env.CLAUDE_CODE_SOCKET;
  process.env.CLAUDE_CODE_SOCKET = socket;
  let mode = "success";
  let requested!: () => void;
  let disconnected!: () => void;
  const received = new Promise<void>(resolve => { requested = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = http.createServer((req, res) => {
    let input = "";
    req.on("data", c => { input += c; });
    req.on("end", () => {
      const payload = JSON.parse(input);
      assert.equal(payload.model, "sonnet");
      assert.equal(req.url, "/review");
      assert.ok(Buffer.byteLength(payload.brief) <= BRIEF_BYTE_LIMIT);
      assert.equal(payload.messages, undefined);
      assert.equal(payload.tools, undefined);
      if (mode === "wait") { requested(); res.on("close", disconnected); return; }
      res.writeHead(mode === "error" ? 502 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(mode === "error" ? { error: "Subscription unavailable" } : { text: "Ready" }));
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    await assert.rejects(requestClaudeHelp(""), /not contacted/);
    assert.equal(await requestClaudeHelp("x".repeat(50000)), "Ready");
    mode = "error";
    await assert.rejects(requestClaudeHelp("Brief"), /Subscription unavailable/);
    mode = "wait";
    const controller = new AbortController();
    const pending = requestClaudeHelp("Brief", controller.signal);
    await received;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await closed;
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SOCKET;
    else process.env.CLAUDE_CODE_SOCKET = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true });
  }
});