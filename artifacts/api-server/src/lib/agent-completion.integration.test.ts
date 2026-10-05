import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { db, sessionsTable, messagesTable, type Session } from "@workspace/db";
import { ollama } from "./ollama";
import { runAgentTurn } from "./agent-loop";
import previewRouter from "../routes/preview";
import { forgetRuntime } from "./runtime";
import { deleteRuntimeConfig } from "./runtime-settings";

// Script the model, not the agent loop, tools, runtime, or preview proxy.
// This makes premature-success regression tests deterministic and GPU-free.
test("real agent loop withholds false completion, retries tools, and verifies the real signed proxy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-completion-"));
  const dir = path.join(root, "987654");
  await fs.mkdir(dir);
  const session = { id: 987654, userId: 1, workspacePath: dir, model: "test", githubRepo: null } as Session;
  const records: any[] = [];
  const events: Record<string, unknown>[] = [];
  const oldPort = process.env.PORT;
  const oldSecret = process.env.SESSION_SECRET;
  // Signing reads SESSION_SECRET at module evaluation. The test runner provides
  // a disposable value when it is absent, without changing production secrets.
  mock.method(db, "insert", () => ({
    values: async (rows: any) => { records.push(...(Array.isArray(rows) ? rows : [rows])); },
  }));
  mock.method(db, "select", () => ({
    from: (table: unknown) => ({
      where: () => Object.assign(table === sessionsTable ? [session] : [], {
        orderBy: async () => table === messagesTable ? records : [],
      }),
    }),
  }));
  mock.method(db, "update", () => ({ set: () => ({ where: async () => {} }) }));
  const app = express();
  app.use("/api", previewRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  process.env.PORT = String((server.address() as import("node:net").AddressInfo).port);
  let step = 0;
  const tool = (name: string, args: unknown) => ({
    tool_calls: [{ index: 0, id: `test_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  mock.method(ollama.chat.completions, "create", async (request: any) => {
    step++;
    let delta: any;
    if (step === 1) delta = tool("create_file", { path: "index.html", content: "<html><head></head><body>verified fixture</body></html>" });
    else if (step === 2) delta = { content: "FALSE SUCCESS THAT MUST NOT APPEAR" };
    else if (step === 3) {
      assert.ok(request.messages.some((m: any) => m.content?.includes("completion verification failed")));
      delta = tool("manage_runtime", { action: "run" });
    } else delta = { content: "The application preview is available." };
    return (async function* () { yield { choices: [{ delta }] }; })();
  });
  try {
    await runAgentTurn(session, "Build and run this fixture", event => events.push(event));
    assert.equal(step, 4);
    assert.ok(!JSON.stringify(events).includes("FALSE SUCCESS"));
    assert.ok(!JSON.stringify(records).includes("FALSE SUCCESS"));
    const checks = events.filter(e => e.type === "tool_result" && e.name === "verify_runtime");
    assert.equal(checks.length, 2);
    assert.equal(checks[0].isError, true);
    assert.equal(checks[1].isError, false);
    assert.match(String(events.at(-1)?.content), /Verification: Signed preview HTML/);
    // A model that keeps asserting success is stopped after two repair chances.
    forgetRuntime(dir);
    step = 0; events.length = 0; records.length = 0;
    mock.method(ollama.chat.completions, "create", async () => {
      step++;
      const delta = step === 1
        ? tool("run_command", { command: "true" })
        : { content: "ANOTHER FALSE SUCCESS" };
      return (async function* () { yield { choices: [{ delta }] }; })();
    });
    await runAgentTurn(session, "Repair the fixture", event => events.push(event));
    assert.equal(step, 4);
    assert.ok(!JSON.stringify(events).includes("ANOTHER FALSE SUCCESS"));
    assert.match(String(events.at(-1)?.content), /not confirmed complete/);
  } finally {
    mock.restoreAll();
    forgetRuntime(dir);
    await deleteRuntimeConfig(dir);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
  }
});