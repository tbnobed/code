import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { controlRuntime, runtimeStatus, runtimeTarget, forgetRuntime } from "./runtime";
import { saveRuntimeConfig, deleteRuntimeConfig } from "./runtime-settings";
import { runtimeLogSink } from "./runtime-log";

test("runtime logs never emit partial environment values", () => {
  let out = "";
  const sink = runtimeLogSink(s => out += s, ["test-private-value"]);
  sink.push("value=test-");
  assert.equal(out, "");
  sink.push("private-value\n");
  assert.equal(out, "value=[REDACTED]\n");
});

test("managed full-stack lifecycle, environment, install/build, failure and stop", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-runtime-test-"));
  const base = "/api/sessions/999/preview/test";
  async function wait() {
    for (let i = 0; i < 300; i++) {
      const s = await runtimeStatus(dir);
      if (!["installing", "starting", "building"].includes(s.state)) return s;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("runtime timeout");
  }
  try {
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { build: `node -e "if(process.env.NODE_ENV!=='production')process.exit(1)"` },
    }));
    await fs.writeFile(path.join(dir, "server.cjs"), `
      require("http").createServer((req,res)=>{
        res.setHeader("Content-Type","application/json");
        res.end(JSON.stringify({url:req.url,mode:process.env.NODE_ENV,hostSecret:!!process.env.SESSION_SECRET,configured:!!process.env.TEST_PRIVATE}));
      }).listen(Number(process.env.PORT),"127.0.0.1");
      console.log("private="+process.env.TEST_PRIVATE);
    `);
    await saveRuntimeConfig(dir, { command: "node server.cjs", backendCommand: "node server.cjs", backendDirectory: ".", environment: { TEST_PRIVATE: "test-private-value" } });
    await controlRuntime(dir, "run", base);
    const running = await wait();
    assert.equal(running.state, "running", running.logs);
    assert.ok(!JSON.stringify(running).includes("test-private-value"));
    assert.deepEqual(running.environmentKeys, ["TEST_PRIVATE"]);
    const frontend = await runtimeTarget(dir, base, "/");
    const backend = await runtimeTarget(dir, base, "/api/test");
    assert.notEqual(frontend.port, backend.port);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${backend.port}/api/test`)).json(),
      { url: "/api/test", mode: "development", hostSecret: false, configured: true });
    await controlRuntime(dir, "stop", base);
    assert.equal((await runtimeStatus(dir)).state, "stopped");
    await assert.rejects(runtimeTarget(dir, base, "/"), /stopped/);
    await controlRuntime(dir, "build", base);
    assert.equal((await wait()).state, "stopped");
    assert.match((await runtimeStatus(dir)).logs, /Build passed/);
    await saveRuntimeConfig(dir, { command: "node -e 'process.exit(7)'", backendCommand: "", backendDirectory: "." });
    await controlRuntime(dir, "run", base);
    const failed = await wait();
    assert.equal(failed.state, "error");
    assert.ok(failed.error);
    await assert.rejects(saveRuntimeConfig(dir, { command: "", backendCommand: "", backendDirectory: "../" }), /outside|escape|workspace/i);
  } finally {
    forgetRuntime(dir); await deleteRuntimeConfig(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
});