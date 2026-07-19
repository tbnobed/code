import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type OpenAI from "openai";
import { resolveInWorkspace } from "./workspace";
import { OLLAMA_BASE_URL } from "./ollama";

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
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch a web page or API over HTTP(S) and return its text content. HTML is stripped to readable text (max ~8000 chars). Use for documentation, examples, or data the user links to.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http:// or https:// URL" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_image",
      description:
        "Look at an image file in the workspace (png/jpg/webp/gif) with a local vision model and return what it shows. Use when the user uploads a screenshot, mockup, or photo you need to understand.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the image in the workspace" },
          question: {
            type: "string",
            description: "What to find out about the image (optional; defaults to a detailed description)",
          },
        },
        required: ["path"],
      },
    },
  },
];

const MAX_OUTPUT = 16_000;

const VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? "qwen2.5vl";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Combine an optional caller signal with a timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const signals = [AbortSignal.timeout(ms)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

/** Crude but dependency-free HTML → readable text. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Redact known secrets (e.g. the GitHub token) from tool output. */
// Env vars whose VALUES must never appear in tool/terminal output.
const REDACT_ENV = /SECRET|PASSWORD|TOKEN|API_?KEY|CREDENTIAL|DATABASE_URL|^PG/i;
// Env vars stripped entirely from user-facing shells (terminal + run_command).
// GITHUB_TOKEN is intentionally kept: the git credential helper reads it at
// use time, and its value is still redacted from all output.
const STRIP_ENV = /SECRET|PASSWORD|DATABASE_URL|^PG|^REPL/i;

export function redactSecrets(s: string): string {
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!REDACT_ENV.test(name)) continue;
    if (s.includes(value)) s = s.split(value).join(`[REDACTED_${name}]`);
  }
  return s;
}

/** Environment for user-facing shells: server-only secrets (session signing
 * key, admin password, database URL) are stripped so they cannot leak via
 * `env`, child processes, or crash dumps. */
export function workspaceEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "GITHUB_TOKEN" && STRIP_ENV.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/**
 * Stateful redactor for streamed output. Redacting chunk-by-chunk can leak a
 * secret split across two chunks, so complete lines are redacted and emitted
 * while the trailing partial line is held back until it completes (or flush).
 */
export function makeStreamRedactor() {
  const MAX_HOLD = 8192; // force-flush pathological single lines
  let carry = "";
  return {
    push(chunk: string): string {
      carry += chunk;
      const cut = Math.max(carry.lastIndexOf("\n"), carry.lastIndexOf("\r"));
      let emit = "";
      if (cut >= 0) {
        emit = carry.slice(0, cut + 1);
        carry = carry.slice(cut + 1);
      }
      if (carry.length > MAX_HOLD) {
        // No line break in sight: emit most of it but keep a tail large
        // enough to cover a secret still being received.
        emit += carry.slice(0, carry.length - 256);
        carry = carry.slice(carry.length - 256);
      }
      return emit ? redactSecrets(emit) : "";
    },
    flush(): string {
      const rest = carry;
      carry = "";
      return rest ? redactSecrets(rest) : "";
    },
  };
}

/** Redact first (so truncation can never split a secret), then truncate. */
function sanitize(s: string) {
  const clean = redactSecrets(s);
  return clean.length > MAX_OUTPUT ? clean.slice(0, MAX_OUTPUT) + "\n...[truncated]" : clean;
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
  signal?: AbortSignal,
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
        return { result: sanitize(content), isError: false };
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
          const child = spawn("/bin/bash", ["-c", String(args.command)], {
            cwd: workspaceDir,
            env: workspaceEnv(), // server-only secrets stripped
            detached: true, // own process group so abort/timeout kills the whole tree
          });
          const killTree = () => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL"); // negative pid = whole group
              else child.kill("SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          };

          const CAP = 1024 * 1024;
          let out = "";
          let errOut = "";
          let truncated = false;
          const collect = (target: "out" | "err") => (buf: Buffer) => {
            if (out.length + errOut.length > CAP) {
              if (!truncated) {
                truncated = true;
                killTree();
              }
              return;
            }
            if (target === "out") out += buf.toString("utf8");
            else errOut += buf.toString("utf8");
          };
          child.stdout.on("data", collect("out"));
          child.stderr.on("data", collect("err"));

          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            killTree();
          }, 60_000);
          const onAbort = () => killTree();
          signal?.addEventListener("abort", onAbort, { once: true });

          let done = false;
          const finish = (code: number | null, spawnErr?: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            const parts = [];
            if (out) parts.push(out);
            if (errOut) parts.push(`[stderr]\n${errOut}`);
            if (truncated) parts.push("[output truncated at 1MB — process killed]");
            if (timedOut) parts.push("[timed out after 60s — process killed]");
            if (signal?.aborted) parts.push("[cancelled by user]");
            if (spawnErr) parts.push(`[error: ${spawnErr.message}]`);
            else if (code !== 0) parts.push(`[exit code: ${code ?? "killed"}]`);
            resolve({
              result: sanitize(parts.join("\n") || "(no output)"),
              isError: Boolean(spawnErr) || code !== 0,
            });
          };
          child.on("close", (code) => finish(code));
          child.on("error", (err) => finish(null, err));
        });
      }
      case "fetch_url": {
        const rawUrl = String(args.url ?? "").trim();
        let u: URL;
        try {
          u = new URL(rawUrl);
        } catch {
          return { result: `Invalid URL: ${rawUrl}`, isError: true };
        }
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return { result: "Only http(s) URLs are supported", isError: true };
        }
        const resp = await fetch(u, {
          redirect: "follow",
          signal: withTimeout(signal, 20_000),
          headers: {
            "User-Agent": "ForgeAgent/1.0 (local coding agent)",
            Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
          },
        });
        if (!resp.ok) {
          return { result: `HTTP ${resp.status} ${resp.statusText} for ${u}`, isError: true };
        }
        const ctype = resp.headers.get("content-type") ?? "";
        if (!/text\/|json|xml|javascript/i.test(ctype)) {
          return {
            result: `Unsupported content-type "${ctype}" — only text-based responses can be read`,
            isError: true,
          };
        }
        const raw = (await resp.text()).slice(0, 2_000_000);
        const isHtml = /html/i.test(ctype);
        const text = isHtml ? stripHtml(raw) : raw;
        const title = isHtml ? raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() : null;
        const out =
          `URL: ${u}\n` +
          (title ? `Title: ${title}\n` : "") +
          `\n${text.slice(0, 8000)}${text.length > 8000 ? "\n...[truncated]" : ""}`;
        return { result: sanitize(out), isError: false };
      }
      case "analyze_image": {
        const rel = String(args.path ?? "").trim();
        const p = await resolveInWorkspace(workspaceDir, rel);
        const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
        if (!mime) {
          return { result: `Not a supported image type: ${rel} (png/jpg/jpeg/webp/gif)`, isError: true };
        }
        const stat = await fs.stat(p).catch(() => null);
        if (!stat) return { result: `File not found: ${rel}`, isError: true };
        if (stat.size > 10 * 1024 * 1024) {
          return {
            result: `Image too large (${Math.round(stat.size / 1024 / 1024)}MB; 10MB max)`,
            isError: true,
          };
        }
        const b64 = (await fs.readFile(p)).toString("base64");
        const question = String(
          args.question ??
            "Describe this image in detail: layout, all visible text, colors, and any design elements.",
        );
        // Ollama's native chat API takes base64 images directly.
        const resp = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: VISION_MODEL,
            stream: false,
            messages: [{ role: "user", content: question, images: [b64] }],
          }),
          signal: withTimeout(signal, 180_000),
        });
        if (resp.status === 404) {
          return {
            result: `Vision model "${VISION_MODEL}" is not installed on the Ollama host. The user must run: ollama pull ${VISION_MODEL} (or set OLLAMA_VISION_MODEL to an installed vision model).`,
            isError: true,
          };
        }
        if (!resp.ok) {
          const detail = await resp.text().then((t) => t.slice(0, 300)).catch(() => "");
          return { result: `Vision request failed: HTTP ${resp.status} ${detail}`, isError: true };
        }
        const data = (await resp.json()) as { message?: { content?: string } };
        const answer = data?.message?.content?.trim();
        if (!answer) return { result: "Vision model returned no content", isError: true };
        return { result: sanitize(`[${VISION_MODEL} looked at ${rel}]\n${answer}`), isError: false };
      }
      default:
        return { result: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { result: sanitize(err instanceof Error ? err.message : String(err)), isError: true };
  }
}
