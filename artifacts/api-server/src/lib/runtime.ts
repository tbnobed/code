import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { detectFramework, frameworkPreview, stopFrameworkPreview, type Running } from "./framework-preview";
import { readRuntimeConfig, type RuntimeConfig } from "./runtime-settings";
import { spawnManaged, allocatePort, waitForPort, killProcess } from "./runtime-process";
import { resolveInWorkspace } from "./workspace";
import { redactSecrets } from "./agent-tools";
import { redactRuntime } from "./runtime-log";

type State = "stopped" | "installing" | "starting" | "running" | "building" | "error";
type Runtime = {
  state: State; logs: string; error: string; base: string; framework: string;
  generation: number; abort: AbortController; children: ChildProcess[];
  frontend?: Running; port?: number; backendPort?: number; fingerprint?: string;
  touched: number; config: RuntimeConfig; started: number;
  phase?: string; expectedPort?: number;
};
const runtimes = new Map<string, Runtime>();
const installs = new Map<string, string>();
export function appendRuntimeLog(dir: string, text: string) {
  const runtime = runtimes.get(dir);
  if (!runtime) return;
  runtime.logs = (runtime.logs + text).slice(-64000);
}
function clean(runtime: Runtime, text: string) {
  return redactRuntime(text, Object.values(runtime.config.environment))
    .replaceAll(runtime.base || "\0", "[preview]");
}
export async function runtimeStatus(dir: string) {
  const config = await readRuntimeConfig(dir);
  const r = runtimes.get(dir);
  if (r) {
    r.touched = Date.now();
    if (r.frontend) r.frontend.touched = Date.now();
    if (r.state === "running" && r.frontend && (r.frontend.child.exitCode !== null || r.frontend.child.signalCode)) {
      r.error = "Preview process stopped. Click Run to start it again."; r.state = "error";
      r.abort.abort(); r.children.forEach(killProcess);
    }
  }
  return {
    state: r?.state || "stopped", error: r ? clean(r, r.error) : "",
    logs: r ? clean(r, r.logs + (r.frontend?.log || "")) : "",
    framework: r?.framework || await detectFramework(dir) || "static",
    settings: { command: config.command, backendCommand: config.backendCommand, backendDirectory: config.backendDirectory },
    environmentKeys: Object.keys(config.environment).sort(),
    diagnostics: {
      phase: r?.phase || "idle", expectedPort: r?.expectedPort ?? r?.port ?? null,
      host: "127.0.0.1", nodeEnv: "development",
      launcher: config.command ? "project-command" : "forge-framework",
    },
    previewPath: r?.state === "running" ? r.base + "/" : "",
  };
}
export function runtimeBusy(dir: string) {
  return ["installing", "starting", "building"].includes(runtimes.get(dir)?.state || "");
}
export function stopRuntime(dir: string) {
  const r = runtimes.get(dir);
  if (r) {
    r.generation++; r.abort.abort();
    for (const child of r.children) killProcess(child);
    r.children = []; r.state = "stopped"; r.port = undefined; r.backendPort = undefined;
    if (r.frontend) r.logs = (r.logs + r.frontend.log).slice(-64000);
    r.frontend = undefined;
  }
  stopFrameworkPreview(dir);
}
export function forgetRuntime(dir: string) {
  stopRuntime(dir); runtimes.delete(dir); installs.delete(dir);
}
async function fingerprint(dir: string, config: RuntimeConfig) {
  const hash = crypto.createHash("sha256");
  for (const cwd of new Set([dir, await resolveInWorkspace(dir, config.backendDirectory)])) {
    for (const name of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "node_modules/.package-lock.json"]) {
      try { hash.update(await fs.readFile(path.join(cwd, name))); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return hash.digest("hex");
}
async function install(dir: string, r: Runtime, force: boolean, log: (s: string) => void) {
  const before = await fingerprint(dir, r.config);
  if (!force && installs.get(dir) === before) return;
  for (const cwd of new Set([dir, await resolveInWorkspace(dir, r.config.backendDirectory)])) {
    const exists = (file: string) => fs.access(path.join(cwd, file)).then(() => true, () => false);
    if (!await exists("package.json")) continue;
    const command = await exists("pnpm-lock.yaml") ? "pnpm install --prod=false" :
      await exists("yarn.lock") ? "yarn install" : "npm install --include=dev";
    log(`\n[install] ${path.relative(dir, cwd) || "."}: ${command}\n`);
    const proc = spawnManaged(command, cwd, { ...r.config.environment, NODE_ENV: "development" }, r.abort.signal, log);
    r.children.push(proc.child);
    const timer = setTimeout(() => killProcess(proc.child), 10 * 60_000);
    try { await proc.done; } finally { clearTimeout(timer); }
  }
  installs.set(dir, await fingerprint(dir, r.config));
}
let controls: Promise<unknown> = Promise.resolve();
export function controlRuntime(dir: string, action: "run" | "stop" | "restart" | "install" | "build", base: string) {
  const operation = controls.then(() => control(dir, action, base));
  controls = operation.catch(() => {});
  return operation;
}
async function control(dir: string, action: "run" | "stop" | "restart" | "install" | "build", base: string) {
  if (action === "stop") { stopRuntime(dir); return; }
  if (runtimeBusy(dir)) throw new Error("An operation is already in progress. Stop it before starting another.");
  const active = [...runtimes.entries()].filter(([key, r]) => key !== dir && ["running", "starting", "installing", "building"].includes(r.state));
  if (active.length >= 3) throw new Error("Three projects are already active. Stop another project first.");
  const config = await readRuntimeConfig(dir);
  stopRuntime(dir);
  const r: Runtime = {
    state: action === "build" ? "building" : "installing", logs: "", error: "", base,
    framework: await detectFramework(dir) || "static", generation: 0,
    abort: new AbortController(), children: [], touched: Date.now(), config, started: Date.now(),
  };
  runtimes.set(dir, r);
  const log = (s: string) => { r.logs = (r.logs + s).slice(-64000); };
  const alive = () => { if (r.abort.signal.aborted) throw new Error("Operation stopped"); };
  const failProcess = (message: string) => {
    if (r.abort.signal.aborted) return;
    r.state = "error"; r.error = message;
    log(`\n[error] ${message}\n`);
    r.abort.abort(); r.children.forEach(killProcess);
    if (r.frontend) killProcess(r.frontend.child);
  };
  void (async () => {
    try {
      r.phase = "dependency-install";
      await install(dir, r, action === "install", log); alive();
      if (action === "install") { r.state = "stopped"; log("\nDependencies installed. Click Run.\n"); return; }
      if (action === "build") {
        r.phase = "production-build";
        const manifest = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        if (!manifest.scripts?.build) throw new Error("No build script in package.json.");
        log("\n[build] NODE_ENV=production npm run build\n");
        const proc = spawnManaged("npm run build", dir, { ...config.environment, NODE_ENV: "production" }, r.abort.signal, log);
        r.children.push(proc.child);
        const timer = setTimeout(() => killProcess(proc.child), 10 * 60_000);
        try { await proc.done; } finally { clearTimeout(timer); }
        alive(); r.state = "stopped"; log("\nBuild passed. Click Run to preview.\n"); return;
      }
      r.state = "starting";
      const env: NodeJS.ProcessEnv = { ...config.environment, NODE_ENV: "development", HOST: "127.0.0.1", BASE_PATH: base, FORGE_PREVIEW_BASE: base };
      const launch = async (command: string, cwd: string) => {
        const port = await allocatePort(); alive();
        r.expectedPort = port;
        log(`\n[start] ${command} (PORT=${port}, HOST=127.0.0.1, NODE_ENV=development)\n`);
        const proc = spawnManaged(command, cwd, { ...env, PORT: String(port) }, r.abort.signal, log);
        r.children.push(proc.child);
        void proc.done.then(() => {
          failProcess("Application process exited.");
        }, error => {
          failProcess(error.message);
        });
        await waitForPort(port, proc.child, r.abort.signal);
        return port;
      };
      if (config.backendCommand) {
        r.phase = "project-backend";
        r.backendPort = await launch(config.backendCommand, await resolveInWorkspace(dir, config.backendDirectory));
        env.FORGE_BACKEND_PORT = String(r.backendPort);
      }
      if (config.command) { r.phase = "project-command"; r.port = await launch(config.command, dir); }
      else if (r.framework === "next" || r.framework === "vite") {
        r.phase = "forge-framework-launcher";
        r.frontend = await frameworkPreview(dir, r.framework, base, env);
        if (r.abort.signal.aborted) { killProcess(r.frontend.child); return; }
        r.port = r.frontend.port;
      } else {
        r.phase = "static-entry";
        await fs.access(await resolveInWorkspace(dir, "index.html")).catch(() => { throw new Error("No Next.js, Vite, or index.html found. Configure a custom run command that listens on PORT."); });
      }
      alive(); r.fingerprint = await fingerprint(dir, config);
      r.state = "running"; log("\nApplication is running.\n");
    } catch (error) {
      if (r.abort.signal.aborted) return;
      r.state = "error"; r.error = error instanceof Error ? error.message : "Runtime failed";
      log(`\n[error] ${r.error}\n`);
      r.abort.abort(); r.children.forEach(killProcess); stopFrameworkPreview(dir);
    }
  })();
}
export async function runtimeTarget(dir: string, base: string, pathname: string) {
  const r = runtimes.get(dir);
  if (!r || r.state !== "running" || r.base !== base) throw new Error("Application is stopped or this preview is old. Use Run and reopen Preview.");
  r.touched = Date.now();
  if (r.frontend) r.frontend.touched = Date.now();
  if (r.fingerprint !== await fingerprint(dir, r.config)) {
    await controlRuntime(dir, "restart", base);
    throw new Error("Dependencies changed. Restarting the application; reload in a moment.");
  }
  if (r.backendPort && /^\/api(?:\/|$)/.test(pathname)) return { port: r.backendPort, prefix: false };
  return { port: r.port, prefix: !r.config.command && (r.framework === "next" || r.framework === "vite") };
}
setInterval(() => {
  for (const [dir, r] of runtimes) {
    if (Date.now() - r.touched > 15 * 60_000) stopRuntime(dir);
  }
}, 60_000).unref();
process.on("exit", () => { for (const dir of runtimes.keys()) stopRuntime(dir); });
process.on("SIGTERM", () => { for (const dir of runtimes.keys()) stopRuntime(dir); });