import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeDecision } from "./claude-code";
import { claudeCodeStream } from "./claude-code";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tools = [{ type: "function" as const, function: { name: "read_file", parameters: { type: "object" } } }];
test("Claude decisions preserve Forge's tool-call contract", () => {
  const delta = decodeDecision({ content: "Inspecting the file.", tool_calls: [{ name: "read_file", arguments: '{"path":"main.ts"}' }] }, tools);
  assert.equal(delta.tool_calls[0].function.arguments, '{"path":"main.ts"}');
  assert.equal(delta.tool_calls[0].index, 0);
  assert.ok(delta.tool_calls[0].id);
  assert.equal(decodeDecision({ content: "Hello", tool_calls: [] }, tools).content, "Hello");
});
test("malformed or unsupported decisions fail explicitly", () => {
  for (const value of [null, {}, { content: "", tool_calls: [] }, { content: "", tool_calls: [{ name: "Bash", arguments: "{}" }] },
    { content: "", tool_calls: [{ name: "read_file", arguments: "null" }] },
    { content: "", tool_calls: [{ name: "read_file", arguments: "[]" }] }]) {
    assert.throws(() => decodeDecision(value, tools));
  }
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
      assert.equal(JSON.parse(input).model, "sonnet");
      if (mode === "wait") { requested(); res.on("close", disconnected); return; }
      res.writeHead(mode === "error" ? 502 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(mode === "error" ? { error: "Subscription unavailable" } : { content: "Ready", tool_calls: [] }));
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    for await (const chunk of claudeCodeStream("old-ollama-model", [], tools)) {
      assert.equal(chunk.choices[0].delta.content, "Ready");
    }
    mode = "error";
    await assert.rejects(async () => { for await (const _ of claudeCodeStream("claude-code/sonnet", [], tools)) {} }, /Subscription unavailable/);
    mode = "wait";
    const controller = new AbortController();
    const pending = (async () => { for await (const _ of claudeCodeStream("claude-code/sonnet", [], tools, controller.signal)) {} })();
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