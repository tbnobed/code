import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workspaceEnv } from "./agent-tools";
import { detectFramework, frameworkPreview, stopFrameworkPreview } from "./framework-preview";

test("production server environment does not omit workspace dev dependencies", () => {
  const keys = ["NODE_ENV", "NPM_CONFIG_OMIT", "npm_config_production", "npm_config_only"];
  const original = keys.map(key => process.env[key]);
  try {
    process.env.NODE_ENV = "production";
    process.env.NPM_CONFIG_OMIT = "dev";
    process.env.npm_config_production = "true";
    process.env.npm_config_only = "prod";
    const env = workspaceEnv();
    assert.equal(env.NODE_ENV, undefined);
    assert.equal(env.npm_config_include, "dev");
    for (const key of keys.slice(1)) assert.equal(env[key], undefined);
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(env.SESSION_SECRET, undefined);
  } finally {
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    });
  }
});

test("detect frameworks and surface missing dependencies without hanging", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-preview-unit-"));
  try {
    assert.equal(await detectFramework(dir), null);
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "*" } }));
    assert.equal(await detectFramework(dir), "vite");
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "*" } }));
    assert.equal(await detectFramework(dir), "next");
    await assert.rejects(frameworkPreview(dir, "next", "/api/sessions/1/preview/test"), /Cannot find module/);
  } finally {
    stopFrameworkPreview(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
});