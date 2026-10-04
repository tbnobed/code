import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { workspaceEnv } from "./agent-tools";
import { runtimeLogSink } from "./runtime-log";

export function killProcess(child: ChildProcess) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1500);
  timer.unref();
}
export async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}
export function spawnManaged(command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, log: (text: string) => void) {
  const environment = { ...workspaceEnv(), ...env };
  delete environment.GITHUB_TOKEN;
  const child = spawn("/bin/bash", ["-c", command], { cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const abort = () => killProcess(child);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // Only user environment values need redacting; system host/mode/ports are
  // operational diagnostics, not credentials.
  const privateValues = Object.entries(env).filter(([k]) => !/^(PORT|HOST|NODE_ENV|BASE_PATH|FORGE_PREVIEW_BASE|FORGE_BACKEND_PORT)$/.test(k)).map(([, v]) => v!).filter(Boolean);
  const stdout = runtimeLogSink(log, privateValues), stderr = runtimeLogSink(log, privateValues);
  child.stdout.on("data", chunk => stdout.push(chunk.toString()));
  child.stderr.on("data", chunk => stderr.push(chunk.toString()));
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, sig) => {
      stdout.flush(); stderr.flush();
      signal.removeEventListener("abort", abort);
      if (code === 0 && !signal.aborted) resolve();
      else reject(new Error(signal.aborted ? "Operation stopped" : `Command exited with ${code ?? sig}`));
    });
  });
  void done.catch(() => {});
  return { child, done };
}
export async function waitForPort(port: number, child: ChildProcess, signal: AbortSignal) {
  for (let i = 0; i < 240; i++) {
    if (signal.aborted) throw new Error("Operation stopped");
    if (child.exitCode !== null || child.signalCode) throw new Error("Server exited before opening its port");
    const ready = await new Promise<boolean>(resolve => {
      const s = net.connect(port, "127.0.0.1");
      s.setTimeout(300);
      const finish = (ok: boolean) => { s.destroy(); resolve(ok); };
      s.once("connect", () => finish(true));
      s.once("error", () => finish(false));
      s.once("timeout", () => finish(false));
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Server did not listen within 120 seconds. Bind the command to process.env.PORT (and HOST).");
}