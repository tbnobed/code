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
 * NOTES.md is the agent's long-term memory: the agent loop injects it into
 * the system prompt on every model call, so it survives conversation
 * trimming. Oversized notes keep the head (project overview) and tail
 * (latest decisions) — the cap protects the prompt's reserved-token room.
 */
export async function readProjectNotes(workspaceDir: string): Promise<string> {
  const HEAD = 2_000;
  const TAIL = 4_000;
  try {
    // Same symlink containment as every other workspace read: NOTES.md is
    // agent/user-writable and could be a symlink pointing outside the
    // workspace — never inject foreign file content into the prompt.
    const p = await resolveInWorkspace(workspaceDir, "NOTES.md");
    const raw = (await fs.readFile(p, "utf8")).trim();
    if (raw.length <= HEAD + TAIL) return raw;
    return (
      raw.slice(0, HEAD) +
      "\n\n...[NOTES.md over 6000 chars — middle omitted from context; consider tightening it]...\n\n" +
      raw.slice(-TAIL)
    );
  } catch {
    return ""; // no NOTES.md yet — normal for a young project
  }
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
