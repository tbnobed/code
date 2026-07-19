import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import type OpenAI from "openai";
import { resolveInWorkspace } from "./workspace";

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create or overwrite a file in the workspace with the given content. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the workspace" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact string with a new string. The old string must appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the workspace" },
          old_string: { type: "string", description: "Exact text to replace" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the workspace" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the workspace recursively.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace directory. Returns stdout and stderr. 60 second timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" },
        },
        required: ["command"],
      },
    },
  },
];

const MAX_OUTPUT = 16_000;

function truncate(s: string) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n...[truncated]" : s;
}

async function listFilesRecursive(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(full, base)));
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

export async function executeTool(
  workspaceDir: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
  try {
    switch (name) {
      case "create_file": {
        const rel = String(args.path ?? "").trim();
        const p = await resolveInWorkspace(workspaceDir, rel);
        if (!rel || rel === "." || path.resolve(p) === path.resolve(workspaceDir)) {
          return {
            result: `Invalid path "${args.path}": provide a file path relative to the workspace root, e.g. "index.html"`,
            isError: true,
          };
        }
        const existing = await fs.stat(p).catch(() => null);
        if (existing?.isDirectory()) {
          return {
            result: `"${rel}" is a directory; provide a file path, e.g. "${rel}/index.html"`,
            isError: true,
          };
        }
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, String(args.content ?? ""), "utf8");
        return { result: `Created ${args.path}`, isError: false };
      }
      case "edit_file": {
        const p = await resolveInWorkspace(workspaceDir, String(args.path));
        const content = await fs.readFile(p, "utf8");
        const oldStr = String(args.old_string);
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          return { result: `old_string not found in ${args.path}`, isError: true };
        }
        if (occurrences > 1) {
          return {
            result: `old_string appears ${occurrences} times in ${args.path}; it must be unique`,
            isError: true,
          };
        }
        await fs.writeFile(p, content.replace(oldStr, String(args.new_string)), "utf8");
        return { result: `Edited ${args.path}`, isError: false };
      }
      case "read_file": {
        const p = await resolveInWorkspace(workspaceDir, String(args.path));
        const content = await fs.readFile(p, "utf8");
        return { result: truncate(content), isError: false };
      }
      case "list_files": {
        const files = await listFilesRecursive(workspaceDir, workspaceDir);
        return {
          result: files.length ? files.join("\n") : "(workspace is empty)",
          isError: false,
        };
      }
      case "run_command": {
        return await new Promise((resolve) => {
          exec(
            String(args.command),
            { cwd: workspaceDir, timeout: 60_000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
              const parts = [];
              if (stdout) parts.push(stdout);
              if (stderr) parts.push(`[stderr]\n${stderr}`);
              if (error && error.code !== 0) parts.push(`[exit code: ${error.code ?? "killed"}]`);
              resolve({
                result: truncate(parts.join("\n") || "(no output)"),
                isError: Boolean(error),
              });
            },
          );
        });
      }
      default:
        return { result: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { result: err instanceof Error ? err.message : String(err), isError: true };
  }
}
