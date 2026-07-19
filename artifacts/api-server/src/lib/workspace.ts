import path from "node:path";
import fs from "node:fs/promises";

export const WORKSPACES_ROOT =
  process.env.AGENT_WORKSPACES_DIR ?? "/tmp/agent-workspaces";

export async function createWorkspace(sessionId: number | string) {
  const dir = path.join(WORKSPACES_ROOT, String(sessionId));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a relative path inside a workspace, rejecting escapes.
 * Checks both the lexical path and the realpath (symlink-resolved) of the
 * deepest existing ancestor, so symlinks cannot escape the workspace.
 */
export async function resolveInWorkspace(workspaceDir: string, relPath: string) {
  const resolved = path.resolve(workspaceDir, relPath);
  const wsReal = await fs.realpath(workspaceDir);
  const contained = (p: string, root: string) =>
    p === root || p.startsWith(root + path.sep);
  if (!contained(resolved, workspaceDir)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  // Resolve symlinks on the deepest existing ancestor of the target path.
  let probe = resolved;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!contained(real, wsReal)) {
        throw new Error(`Path escapes workspace (symlink): ${relPath}`);
      }
      break;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      throw err;
    }
  }
  return resolved;
}

export function languageFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase().replace(".", "");
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "tsx", jsx: "jsx",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
    html: "html", css: "css", scss: "scss", json: "json",
    yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown",
    sh: "bash", bash: "bash", sql: "sql", txt: "text",
  };
  return map[ext] ?? "text";
}
