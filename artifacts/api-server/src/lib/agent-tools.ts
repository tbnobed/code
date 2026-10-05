import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type OpenAI from "openai";
import { resolveInWorkspace } from "./workspace";
import { OLLAMA_BASE_URL } from "./ollama";
import { clampDimension, generateImage, imageGenAvailable } from "./image-gen";
import { platformCapabilities, platformContext } from "./platform-context";
import { searchWeb } from "./web-search";
import { filePage } from "./file-page";
import { saveGeneratedImage, imageFingerprint } from "./generated-image-artifact";

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the public web for real source URLs, titles and snippets. Use before fetch_url when researching without a known URL. Fetch primary sources to verify claims, cite returned URLs, and never invent documentation addresses. Reports explicitly if search is unavailable.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Specific search terms, preferably names and relevant keywords." } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "project_database",
      description: "Provision this project's own PostgreSQL database, inspect its tables, or execute one SQL statement using its restricted database role. Create injects DATABASE_URL into runtime settings; restart the app to use it. Never put database credentials into source. Get user permission before destructive SQL; database deletion is only available through the Database UI.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["status", "create", "query"] }, sql: { type: "string" } }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_platform_capabilities",
      description: "Read ForgeOS platform features, the current requester's GitHub configuration status, model configuration and real limitations. Use when asked what Forge/ForgeOS can do. Does not expose secrets or claim provider health.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
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
      description: "Read a numbered page of a workspace file. Use start_line/end_line or offset/limit (1-based lines). Follow the returned next start_line instead of rereading the same page. For a known symbol, use run_command with grep first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the workspace" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          offset: { type: "integer", minimum: 1, description: "Alias for start_line; 1-based line number." },
          limit: { type: "integer", minimum: 1, maximum: 400, description: "Maximum lines; default 200." },
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
      name: "get_runtime_status",
      description: "Read runtime state, assigned PORT, startup phase, and latest redacted logs. Starting is not success; distinguish Forge launcher errors from project errors before editing.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_runtime",
      description: "Wait for startup (up to 150 seconds), then check the actual signed preview HTTP response and local script/style entry assets. Returns evidence, not a browser/feature test. Use before claiming a web app works.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_runtime",
      description: "Run, stop, restart, install dependencies, or production-build the managed application. Returns immediately; use get_runtime_status to check progress. Do not start duplicate servers in shell commands.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["run", "stop", "restart", "install", "build"] } }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "configure_runtime",
      description: "Configure application processes. Empty command auto-detects Next/Vite/static. Custom commands must listen on PORT. Optional backend is exposed at /api. Stops the app; does not change project environment secrets.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, backendCommand: { type: "string" }, backendDirectory: { type: "string" } },
        required: ["command", "backendCommand", "backendDirectory"],
      },
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
  {
    type: "function",
    function: {
      name: "consult_architect",
      description:
        "Consult a senior software architect (a larger reasoning model) for a design plan, a code review, or a diagnosis of a bug that resists fixing. Slow — reserve it for genuinely hard or high-stakes decisions, not routine steps. Pass the relevant file paths so the architect can read them.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The design question, review request, or bug description — include what was already tried",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Workspace-relative paths of files the architect should read (max 8)",
          },
        },
        required: ["question"],
      },
    },
  },
];

// Local image generation is opt-in (IMAGE_GEN_URL). The tool stays out of the
// schema entirely when unconfigured so the model never tries to call it.
if (imageGenAvailable()) {
  toolDefinitions.push({
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate an image with the local Stable Diffusion server and save it into the workspace as a PNG. Use it for app assets: logos, icons, hero/background images, textures, illustrations. Write a detailed visual prompt (subject, style, colors, lighting, composition). Generation can take 10-60+ seconds, so only generate assets the app really needs.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed visual description of the image" },
          path: {
            type: "string",
            description: 'Workspace-relative output path ending in .png, e.g. "assets/logo.png"',
          },
          width: { type: "number", description: "Width in pixels (256-2048, default 1024)" },
          height: { type: "number", description: "Height in pixels (256-2048, default 1024)" },
          negative_prompt: {
            type: "string",
            description: "Things to avoid in the image (optional)",
          },
          model: { type: "string", enum: ["default", "flux2-klein", "sdxl"], description: "Use default for the configured model, flux2-klein for the newer local four-step model, or sdxl to compare with the previous checkpoint. FLUX distilled does not use negative prompts." },
        },
        required: ["prompt", "path"],
      },
    },
  });
}

const MAX_OUTPUT = 16_000;

const VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? "qwen2.5vl";

export const ARCHITECT_MODEL =
  process.env.OLLAMA_ARCHITECT_MODEL ?? "qwen3-next:80b-a3b-thinking";

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
const STRIP_ENV = /SECRET|PASSWORD|DATABASE_URL|API_KEY|TOKEN|ANTHROPIC|AI_INTEGRATIONS|^PG|^REPL/i;

export function redactSecrets(s: string, extraSecrets?: readonly string[]): string {
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!REDACT_ENV.test(name)) continue;
    if (s.includes(value)) s = s.split(value).join(`[REDACTED_${name}]`);
  }
  // Per-user secrets (e.g. the session owner's GitHub PAT) live in the DB,
  // not the environment, so callers pass them explicitly.
  for (const value of extraSecrets ?? []) {
    if (!value || value.length < 8) continue;
    if (s.includes(value)) s = s.split(value).join("[REDACTED_TOKEN]");
  }
  return s;
}

/** Environment for user-facing shells: server-only secrets (session signing
 * key, admin password, database URL) are stripped so they cannot leak via
 * `env`, child processes, or crash dumps. */
export function workspaceEnv(githubToken?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "GITHUB_TOKEN" && STRIP_ENV.test(k)) continue;
    env[k] = v;
  }
  // The Forge server is production software; generated projects are development
  // workspaces. Inheriting production mode silently omits build dependencies.
  for (const k of Object.keys(env)) {
    if (/^npm_config_(production|omit|only|include)$/i.test(k)) delete env[k];
  }
  // Let tools choose their own mode: next build defaults to production,
  // while next dev/Vite default to development. npm include handles installs.
  delete env.NODE_ENV;
  env.npm_config_include = "dev";
  // Per-session override: the session owner's PAT takes precedence over the
  // legacy server-wide token so git operations run as the right account.
  if (githubToken) env.GITHUB_TOKEN = githubToken;
  return env;
}

/**
 * Stateful redactor for streamed output. Redacting chunk-by-chunk can leak a
 * secret split across two chunks, so complete lines are redacted and emitted
 * while the trailing partial line is held back until it completes (or flush).
 */
export function makeStreamRedactor(extraSecrets?: readonly string[]) {
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
      return emit ? redactSecrets(emit, extraSecrets) : "";
    },
    flush(): string {
      const rest = carry;
      carry = "";
      return rest ? redactSecrets(rest, extraSecrets) : "";
    },
  };
}

/** Redact first (so truncation can never split a secret), then truncate. */
function sanitize(s: string, extraSecrets?: readonly string[]) {
  const clean = redactSecrets(s, extraSecrets);
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
  opts?: { githubToken?: string | null },
): Promise<{ result: string; isError: boolean }> {
  // The owner's PAT must be scrubbed from every tool result the model sees.
  const extra = opts?.githubToken ? [opts.githubToken] : [];
  try {
    switch (name) {
      case "search_web": {
        return { result: JSON.stringify(await searchWeb(String(args.query ?? ""), signal)), isError: false };
      }
      case "project_database": {
        const database = await import("./project-database");
        let result;
        if (args.action === "status") result = await database.projectDatabaseStatus(workspaceDir);
        else if (args.action === "create") result = await database.createProjectDatabase(workspaceDir);
        else if (args.action === "query" && typeof args.sql === "string") result = await database.queryProjectDatabase(workspaceDir, args.sql);
        else return { result: "Choose status, create or query (with a SQL statement).", isError: true };
        return { result: JSON.stringify(result), isError: false };
      }
      case "get_platform_capabilities":
        return { result: JSON.stringify(platformCapabilities(Boolean(opts?.githubToken))), isError: false };
      case "manage_runtime": {
        const action = String(args.action);
        if (!["run", "stop", "restart", "install", "build"].includes(action)) return { result: "Invalid runtime action", isError: true };
        const id = Number(path.basename(workspaceDir));
        if (!Number.isInteger(id) || id <= 0) return { result: "Runtime requires a session workspace", isError: true };
        const { controlRuntime, runtimeStatus } = await import("./runtime");
        const { makePreviewToken } = await import("../routes/preview");
        await controlRuntime(workspaceDir, action as "run" | "stop" | "restart" | "install" | "build", `/api/sessions/${id}/preview/${makePreviewToken(id)}`);
        const status = await runtimeStatus(workspaceDir);
        const { runtimeToolResult } = await import("./agent-verification");
        return { result: JSON.stringify(runtimeToolResult(status)), isError: status.state === "error" };
      }
      case "configure_runtime": {
        const { runtimeBusy, stopRuntime } = await import("./runtime");
        const { saveRuntimeConfig } = await import("./runtime-settings");
        if (runtimeBusy(workspaceDir)) return { result: "Stop the runtime operation before changing settings.", isError: true };
        const settings = { command: String(args.command ?? ""), backendCommand: String(args.backendCommand ?? ""), backendDirectory: String(args.backendDirectory ?? ".") };
        if (settings.command.length > 2000 || settings.backendCommand.length > 2000 || settings.backendDirectory.length > 500) return { result: "Runtime settings too long", isError: true };
        await saveRuntimeConfig(workspaceDir, settings);
        stopRuntime(workspaceDir);
        return { result: "Runtime configured and stopped. Use manage_runtime run, then get_runtime_status.", isError: false };
      }
      case "get_runtime_status": {
        const { runtimeStatus } = await import("./runtime");
        const status = await runtimeStatus(workspaceDir);
        const { runtimeToolResult } = await import("./agent-verification");
        return { result: JSON.stringify(runtimeToolResult(status)), isError: status.state === "error" };
      }
      case "verify_runtime": {
        const { verifyApplication } = await import("./agent-verification");
        const evidence = await verifyApplication(workspaceDir, signal);
        return { result: JSON.stringify(evidence), isError: !evidence.ok };
      }
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
        return { result: sanitize(filePage(content, args), extra), isError: false };
      }
      case "list_files": {
        const files = await listFilesRecursive(workspaceDir, workspaceDir);
        return {
          // Sanitized: file NAMES can carry secrets too (e.g. a file named
          // after a token value by a misbehaving command).
          result: sanitize(files.length ? files.join("\n") : "(workspace is empty)", extra),
          isError: false,
        };
      }
      case "run_command": {
        return await new Promise((resolve) => {
          const child = spawn("/bin/bash", ["-c", String(args.command)], {
            cwd: workspaceDir,
            env: workspaceEnv(opts?.githubToken), // server-only secrets stripped; owner's GitHub token injected for git
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
              result: sanitize(parts.join("\n") || "(no output)", extra),
              isError: Boolean(spawnErr) || code !== 0,
            });
          };
          child.on("close", (code) => finish(code));
          child.on("error", (err) => finish(null, err));
        });
      }
      case "generate_image": {
        if (args.model !== undefined && !["default", "flux2-klein", "sdxl"].includes(String(args.model))) {
          return { result: "Unsupported image model. Choose default, flux2-klein or sdxl.", isError: true };
        }
        const rel = String(args.path ?? "").trim();
        if (!rel || !/\.png$/i.test(rel)) {
          return {
            result: `Provide a workspace-relative output path ending in .png (got "${rel || "nothing"}")`,
            isError: true,
          };
        }
        const prompt = String(args.prompt ?? "").trim();
        if (!prompt) {
          return { result: "Provide a prompt describing the image to generate", isError: true };
        }
        const p = await resolveInWorkspace(workspaceDir, rel);
        const { png, width, height, provider, model } = await generateImage(
          {
            prompt,
            model: ["default", "flux2-klein", "sdxl"].includes(String(args.model)) ? args.model as "default" | "flux2-klein" | "sdxl" : "default",
            negativePrompt: args.negative_prompt ? String(args.negative_prompt) : undefined,
            width: clampDimension(args.width),
            height: clampDimension(args.height),
          },
          signal,
        );
        const artifact = await saveGeneratedImage(workspaceDir, rel, png);
        return {
          result: `Generated ${width}x${height} image via ${provider} (${model}) → ${rel} (${Math.max(1, Math.round(png.length / 1024))} KB). Inspect the saved version ${artifact.path} with analyze_image and check the brief before using it. ${artifact.identicalToPrevious ? "WARNING: these bytes are identical to the previous output; this is NOT a new design." : ""} ${model === "flux2-klein" && args.negative_prompt ? "This distilled model does not apply negative prompts; describe the desired result in the positive prompt." : ""}\nImage artifact: ${JSON.stringify(artifact)}`,
          isError: false,
        };
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
        return { result: sanitize(out, extra), isError: false };
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
        const imageBytes = await fs.readFile(p);
        const b64 = imageBytes.toString("base64");
        const question = String(
          args.question ??
            "Describe the visible subject, colors, layout, and whether it looks photographic, illustrated, or abstract. Identify visible defects or uncertainty. Do not judge it against a brief you have not been given.",
        );
        // Ollama's native chat API takes base64 images directly.
        const resp = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: VISION_MODEL,
            stream: false,
            options: { temperature: 0 },
            messages: [{ role: "user", content: `Describe only what is visible in the attached pixels. Do not infer a car make/model, materials, readable text, or photorealism from the filename or a requested style. Say when uncertain. ${question}`, images: [b64] }],
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
        return { result: sanitize(`[${VISION_MODEL} looked at ${rel}; SHA-256 ${imageFingerprint(imageBytes)}]\nVision-model interpretation, not independent proof of quality or brief compliance:\n${answer}`, extra), isError: false };
      }
      case "consult_architect": {
        const question = String(args.question ?? "").trim();
        if (!question) return { result: "question is required", isError: true };
        const rawPaths = Array.isArray(args.paths) ? args.paths.slice(0, 8) : [];
        const MAX_FILE = 24_000;
        const MAX_TOTAL = 96_000;
        let attached = "";
        for (const rp of rawPaths) {
          const rel = String(rp).trim();
          if (!rel) continue;
          try {
            const p = await resolveInWorkspace(workspaceDir, rel);
            // Cap before reading so a huge file never fully loads into memory.
            const fh = await fs.open(p, "r");
            try {
              const st = await fh.stat();
              const cap = Math.min(st.size, MAX_FILE);
              const chunk = Buffer.alloc(cap);
              await fh.read(chunk, 0, cap, 0);
              const clipped =
                chunk.toString("utf8") + (st.size > MAX_FILE ? "\n...[truncated]" : "");
              attached += `\n\n--- ${rel} ---\n${clipped}`;
            } finally {
              await fh.close();
            }
          } catch {
            attached += `\n\n--- ${rel} ---\n[could not read this file]`;
          }
          if (attached.length > MAX_TOTAL) {
            attached = attached.slice(0, MAX_TOTAL) + "\n...[context truncated]";
            break;
          }
        }
        // Native /api/chat handles thinking models more reliably than the
        // OpenAI-compat endpoint (same reason analyze_image uses it).
        const resp = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: ARCHITECT_MODEL,
            stream: false,
            options: { num_ctx: Number(process.env.OLLAMA_NUM_CTX) > 0 ? Number(process.env.OLLAMA_NUM_CTX) : 32768 },
            messages: [
              {
                role: "system",
                content:
                  "You are a senior software architect advising the Forge coding agent inside ForgeOS. Give a concrete, actionable answer: a step-by-step plan, a specific diagnosis, or a focused review. Reference the provided files by name. Be direct and keep it under ~600 words. You cannot run tools — reason from what is given." + platformContext(Boolean(opts?.githubToken), "architect"),
              },
              {
                role: "user",
                content: question + (attached ? `\n\nRelevant files:${attached}` : ""),
              },
            ],
          }),
          // Reasoning models think for a while before answering.
          signal: withTimeout(signal, 600_000),
        });
        if (resp.status === 404) {
          return {
            result: `Architect model "${ARCHITECT_MODEL}" is not installed on the Ollama host. The user must run: ollama pull ${ARCHITECT_MODEL} (or set OLLAMA_ARCHITECT_MODEL to an installed model).`,
            isError: true,
          };
        }
        if (!resp.ok) {
          const detail = await resp.text().then((t) => t.slice(0, 300)).catch(() => "");
          return { result: `Architect request failed: HTTP ${resp.status} ${detail}`, isError: true };
        }
        const data = (await resp.json()) as { message?: { content?: string } };
        // Thinking models put reasoning in message.thinking (ignored here) or
        // inline <think> tags (stripped) — only the final answer goes back.
        const answer = (data?.message?.content ?? "")
          .replace(/<think>[\s\S]*?<\/think>/g, "")
          .trim();
        if (!answer) return { result: "Architect model returned no content", isError: true };
        return { result: sanitize(`[architect ${ARCHITECT_MODEL}]\n${answer}`, extra), isError: false };
      }
      default:
        return { result: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { result: sanitize(err instanceof Error ? err.message : String(err), extra), isError: true };
  }
}
