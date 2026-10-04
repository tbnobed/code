import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import { resolveInWorkspace } from "./workspace";
import { workspaceEnv, redactSecrets } from "./agent-tools";
import { runtimeLogSink } from "./runtime-log";

type Framework = "next" | "vite";
export type Running = { child: ChildProcess; port: number; base: string; touched: number; log: string; ready: Promise<void> };
const servers = new Map<string, Running>();
const MAX_SERVERS = 3;

export async function detectFramework(dir: string): Promise<Framework | null> {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(await resolveInWorkspace(dir, "package.json"), "utf8"));
  } catch { return null; }
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  if (deps.next) return "next";
  if (deps.vite) return "vite";
  return null;
}

export function stopFrameworkPreview(dir: string) {
  for (const key of servers.keys()) {
    if (key.startsWith(dir + "\0")) stopServer(key);
  }
}

function stopServer(key: string) {
  const server = servers.get(key);
  if (!server) return;
  servers.delete(key);
  try { if (server.child.pid) process.kill(-server.child.pid, "SIGTERM"); } catch {}
  const timer = setTimeout(() => {
    try { if (server.child.pid) process.kill(-server.child.pid, "SIGKILL"); } catch {}
  }, 3000);
  timer.unref();
}

setInterval(() => {
  for (const [key, server] of servers) {
    if (Date.now() - server.touched > 15 * 60_000) stopServer(key);
  }
}, 60_000).unref();
process.once("exit", () => { for (const key of servers.keys()) stopServer(key); });
process.once("SIGTERM", () => {
  for (const key of servers.keys()) stopServer(key);
  // Let the runtime manager terminate custom process groups too.
  setTimeout(() => process.exit(0), 1800).unref();
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = (socket.address() as net.AddressInfo).port;
      socket.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

// Run framework/config code ONLY in a separate, secret-stripped process.
// Do not import user packages or evaluate project configuration in Forge.
const LAUNCHER = `
const {createRequire}=require("node:module");
const {pathToFileURL}=require("node:url");
const req=createRequire(process.cwd()+"/package.json");
const [framework,portText,base]=process.argv.slice(1);
const port=Number(portText);
(async()=>{
  if(framework==="next"){
    const configModule=req("next/dist/server/config");
    const load=configModule.default;
    // Next's custom dev server reloads config independently of next({conf}).
    // Override its loader in this child only, preserving config functions.
    req.cache[req.resolve("next/dist/server/config")].exports={...configModule,
      __esModule:true,default:async(...args)=>({...await load(...args),
        basePath:base,assetPrefix:base,output:undefined,
        distDir:".next/forge-preview-"+require("node:crypto").createHash("sha256").update(base).digest("hex").slice(0,12)})};
    const app=req("next")({dev:true,dir:process.cwd(),hostname:"127.0.0.1",port});
    await app.prepare();
    const server=require("node:http").createServer(app.getRequestHandler());
    server.on("upgrade",app.getUpgradeHandler());
    server.listen(port,"127.0.0.1");
  }else{
    const {createServer}=await import(pathToFileURL(req.resolve("vite")).href);
    const server=await createServer({root:process.cwd(),base:base+"/",
      server:{host:"127.0.0.1",port,strictPort:true,open:false,hmr:{},
        cors:{origin:"*"},fs:{strict:true,allow:[process.cwd()]}}});
    await server.listen();
  }
})().catch(error=>{console.error(error);process.exit(1)});
`;

// Serialize startup so parallel HTML/asset requests never create duplicate
// processes or exceed the global resource limit.
let startup = Promise.resolve();
export async function frameworkPreview(dir: string, framework: Framework, base: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Running> {
  const key = dir + "\0" + base;
  let selected!: Running;
  const operation = startup.then(async () => {
    let server = servers.get(key);
    if (server && (server.child.exitCode !== null || server.child.signalCode)) {
      stopServer(key);
      server = undefined;
    }
    if (!server) {
      if (servers.size >= MAX_SERVERS) {
        const oldest = [...servers].sort((a, b) => a[1].touched - b[1].touched)[0];
        stopServer(oldest[0]);
      }
      const port = await freePort();
      const env = workspaceEnv();
      Object.assign(env, extraEnv);
      env.NODE_ENV = "development";
      delete env.GITHUB_TOKEN;
      // Signed preview URLs must not enter framework telemetry.
      env.NEXT_TELEMETRY_DISABLED = "1";
      const child = spawn(process.execPath, ["-e", LAUNCHER, framework, String(port), base], {
        cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      server = { child, port, base, touched: Date.now(), log: "", ready: Promise.resolve() };
      const entry = server;
      const write = (text: string) => { entry.log = (entry.log + text.replaceAll(base, "[preview]")).slice(-12_000); };
      const values = Object.entries(extraEnv).filter(([k]) => !/^(PORT|HOST|NODE_ENV|BASE_PATH|FORGE_PREVIEW_BASE|FORGE_BACKEND_PORT)$/.test(k)).map(([, v]) => v!).filter(Boolean);
      const stdout = runtimeLogSink(write, values), stderr = runtimeLogSink(write, values);
      child.stdout?.on("data", chunk => stdout.push(chunk.toString()));
      child.stderr?.on("data", chunk => stderr.push(chunk.toString()));
      child.on("exit", () => { stdout.flush(); stderr.flush(); });
      child.on("error", error => { entry.log += error.message; });
      servers.set(key, entry);
      entry.ready = (async () => {
        for (let i = 0; i < 120; i++) {
          if (child.exitCode !== null || child.signalCode || !child.pid) break;
          const listening = await new Promise<boolean>(resolve => {
            const socket = net.connect(port, "127.0.0.1");
            socket.setTimeout(300);
            socket.once("connect", () => { socket.destroy(); resolve(true); });
            socket.once("error", () => { socket.destroy(); resolve(false); });
            socket.once("timeout", () => { socket.destroy(); resolve(false); });
          });
          if (listening) return;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (servers.get(key) === entry) stopServer(key);
        throw new Error(redactSecrets(entry.log.replaceAll(base, "[preview]")) ||
          "Preview server did not start within 60 seconds.");
      })();
      // A failed startup may finish before the caller attaches its await.
      void entry.ready.catch(() => {});
    }
    server.touched = Date.now();
    selected = server;
  });
  startup = operation.catch(() => {});
  await operation;
  await selected.ready;
  return selected;
}