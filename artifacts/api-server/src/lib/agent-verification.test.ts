import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletionGuard, runtimeToolResult, verifyApplication } from "./agent-verification";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("completion guard retries failures twice, cannot be waived by stopping, accepts evidence", () => {
  const guard = new CompletionGuard();
  guard.observe("read_file", {});
  assert.equal(guard.dirty, false);
  guard.observe("edit_file", {});
  guard.observe("manage_runtime", { action: "stop" });
  assert.equal(guard.dirty, true);
  assert.equal(guard.needsRestart, true);
  guard.observe("manage_runtime", { action: "restart" }, true);
  assert.equal(guard.needsRestart, true);
  guard.observe("manage_runtime", { action: "restart" });
  assert.equal(guard.needsRestart, false);
  guard.observe("edit_file", {});
  assert.equal(guard.needsRestart, true);
  const failure = { ok: false, summary: "starting is not ready", checked: 0 };
  assert.equal(guard.decide(failure, false), "retry");
  assert.equal(guard.decide(failure, false), "retry");
  assert.equal(guard.decide(failure, false), "block");
  assert.equal(new CompletionGuard().decide(failure, true), "block");
  assert.equal(guard.decide({ ok: true, summary: "HTTP passed", checked: 2 }, false), "accept");
});

test("tool diagnostics retain newest logs and identify the Forge launcher", () => {
  const result = runtimeToolResult({
    state: "error", error: "createServer is not a function",
    logs: "old startup logs".repeat(2000) + "\nLATEST FAILURE",
    framework: "vite", settings: { command: "", backendCommand: "", backendDirectory: "." },
    environmentKeys: [], previewPath: "/api/sessions/1/preview/private/",
    diagnostics: { phase: "forge-framework-launcher", expectedPort: null, host: "127.0.0.1", nodeEnv: "development", launcher: "forge-framework" },
  });
  assert.ok(result.logs.endsWith("LATEST FAILURE"));
  assert.equal(result.logs.length, 8000);
  assert.equal(result.logsTruncated, true);
  assert.match(result.guidance, /Forge's framework launcher/);
  assert.equal(result.previewPath, "[active preview]");
});

test("unconfigured Express imports cannot bypass the web completion gate", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-server-import-"));
  try {
    assert.equal((await verifyApplication(dir, undefined, 0)).ok, true, "non-web work is not forced into a preview");
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { express: "^5" } }));
    const result = await verifyApplication(dir, undefined, 0);
    assert.equal(result.ok, false);
    assert.match(result.summary, /stopped/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});