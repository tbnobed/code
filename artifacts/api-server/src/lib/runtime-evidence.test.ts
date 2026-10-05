import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFacts, wrongRuntimeProbe } from "./runtime-evidence";
import { boundedBrief } from "./claude-code";

const status = {
  state: "starting", error: "", logs: "Server running at http://localhost:8080",
  diagnostics: { expectedPort: 42931, phase: "project-command" },
};
test("transcript regression: wrong-port probes are rejected before execution", () => {
  assert.match(wrongRuntimeProbe("curl -s http://localhost:8080/ | grep After", status)!, /Blocked/);
  assert.match(wrongRuntimeProbe("curl -s http://localhost:3000/", status)!, /42931/);
  assert.equal(wrongRuntimeProbe("curl http://127.0.0.1:42931/", status), null);
  assert.equal(wrongRuntimeProbe("grep -n PORT server.js", status), null);
  assert.equal(wrongRuntimeProbe("curl https://example.com/docs", status), null);
  assert.equal(wrongRuntimeProbe("curl http://localhost:8080/health", { ...status, state: "running" }), null);
  assert.equal(wrongRuntimeProbe("curl http://localhost:8080/", { ...status, diagnostics: { ...status.diagnostics, expectedPort: null } }), null);
});
test("runtime facts survive the minimal-token help budget", () => {
  const facts = runtimeFacts({ ...status, error: "Server did not listen on assigned PORT=42931" });
  const brief = boundedBrief(facts + "\n" + "summary ".repeat(2000));
  assert.match(brief, /PORT MISMATCH/);
  assert.match(brief, /assigned PORT=42931/);
  assert.match(brief, /Startup-log ports=8080/);
  assert.match(brief, /Exact runtime error/);
  assert.ok(Buffer.byteLength(brief) <= 3200);
  assert.doesNotMatch(runtimeFacts({ ...status, logs: "Listening http://localhost:42931" }), /PORT MISMATCH/);
});