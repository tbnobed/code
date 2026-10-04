import fs from "node:fs/promises";
import path from "node:path";
import { encryptSecret, decryptSecret } from "./crypto";
import { resolveInWorkspace } from "./workspace";

export type RuntimeConfig = { command: string; backendCommand: string; backendDirectory: string; environment: Record<string, string> };
export const defaultConfig = (): RuntimeConfig => ({ command: "", backendCommand: "", backendDirectory: ".", environment: {} });
// Outside the generated source tree; never included in checkpoints or ZIPs.
function configPath(dir: string) {
  return path.join(path.dirname(dir), ".forge-runtime", path.basename(dir) + ".json");
}
export async function readRuntimeConfig(dir: string): Promise<RuntimeConfig> {
  try {
    const stored = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
    const env = stored.encryptedEnvironment ? decryptSecret(stored.encryptedEnvironment) : "{}";
    if (env === null) throw new Error("Cannot decrypt project environment. Restore the original SESSION_SECRET or reconfigure the project.");
    return { ...defaultConfig(), ...stored, environment: JSON.parse(env) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw error;
  }
}
export async function saveRuntimeConfig(dir: string, input: Omit<RuntimeConfig, "environment"> & { environment?: Record<string, string> }) {
  await resolveInWorkspace(dir, input.backendDirectory || ".");
  const current = await readRuntimeConfig(dir);
  for (const [key, value] of Object.entries(input.environment || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(PORT|HOST|NODE_ENV|BASE_PATH|FORGE_BACKEND_PORT|FORGE_PREVIEW_BASE|NODE_OPTIONS)$/i.test(key)) {
      throw new Error(`Reserved or invalid environment key: ${key}`);
    }
    if (value.length > 16384) throw new Error("Environment value is too long");
    if (value === "") delete current.environment[key];
    else current.environment[key] = value;
  }
  const file = configPath(dir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const stored = {
    command: input.command.trim(), backendCommand: input.backendCommand.trim(),
    backendDirectory: input.backendDirectory || ".",
    encryptedEnvironment: encryptSecret(JSON.stringify(current.environment)),
  };
  await fs.writeFile(file + ".tmp", JSON.stringify(stored), { mode: 0o600 });
  await fs.rename(file + ".tmp", file);
}
export async function deleteRuntimeConfig(dir: string) {
  await fs.rm(configPath(dir), { force: true });
}