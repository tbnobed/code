import { test } from "node:test";
import assert from "node:assert/strict";
import { platformCapabilities, platformContext } from "./platform-context";
import { executeTool, toolDefinitions } from "./agent-tools";

test("platform facts correct the false denials without inventing missing services", () => {
  const facts = platformCapabilities(false, "coding", {});
  assert.match(facts.identity, /built-in coding agent of ForgeOS/);
  assert.match(facts.platform.accounts, /Authenticated/);
  assert.match(facts.platform.backend, /PostgreSQL/);
  assert.match(facts.platform.memory, /loaded automatically/);
  assert.match(facts.platform.github, /First-class/);
  assert.match(facts.platform.runtime, /WebSocket/);
  assert.match(facts.platform.orchestration, /not arbitrary parallel/);
  assert.equal(facts.configuration.imageGenerationConfigured, false);
  assert.equal(facts.configuration.githubForRequester, "not configured");
  assert.match(facts.platform.projectDatabases, /separate PostgreSQL database/);
  assert.match(facts.limits.join(" "), /not secure OS-level isolation/);
});

test("configuration exposes flags and model names, never keys, URLs or credentials", () => {
  const facts = platformCapabilities(true, "coding", {
    IMAGE_GEN_URL: "http://private-provider.invalid",
    ANTHROPIC_API_KEY: "fake-private-api-key",
    SESSION_SECRET: "fake-private-session-secret",
    DATABASE_URL: "postgres://private:password@db/private",
    GITHUB_TOKEN: "fake-private-github-token",
    OLLAMA_MODEL: "custom-coder",
  });
  const output = JSON.stringify(facts);
  assert.equal(facts.configuration.imageGenerationConfigured, true);
  assert.equal(facts.configuration.optionalCloudReviewConfigured, true);
  assert.equal(facts.configuration.codingModel, "custom-coder");
  assert.equal(facts.configuration.githubForRequester, "configured");
  assert.doesNotMatch(output, /fake-private|postgres:\/\/|private-provider/);
  assert.match(facts.configuration.health, /require runtime checks/);
});

test("both agent modes receive platform context and stale-claim correction", () => {
  assert.match(platformContext(false), /get_platform_capabilities/);
  assert.match(platformContext(), /not checked/);
  assert.match(platformContext(undefined, "architect"), /without execution tools/);
  assert.match(platformContext(), /correct conflicting claims/);
});

test("coding tool returns request-scoped facts without running shell commands", async () => {
  assert.ok(toolDefinitions.some(tool => tool.type === "function" && tool.function.name === "get_platform_capabilities"));
  const result = await executeTool("/unused", "get_platform_capabilities", {}, undefined, { githubToken: "fake-actor-token" });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.result).configuration.githubForRequester, "configured");
  assert.doesNotMatch(result.result, /fake-actor-token/);
  const absent = await executeTool("/unused", "get_platform_capabilities", {});
  assert.equal(JSON.parse(absent.result).configuration.githubForRequester, "not configured");
});