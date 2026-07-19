---
name: Forge agent decisions
description: Durable decisions for the Forge local coding-agent app (Ollama, SSE contract, workspace security)
---

- No cloud LLM APIs — user explicitly requires local models via Ollama on their DGX Spark (128GB unified memory). Backend uses the `openai` npm package pointed at `${OLLAMA_BASE_URL}/v1` (default `http://localhost:11434`).
- Default model: `qwen3-coder-next` (July 2026 community consensus for DGX Spark agentic coding). Overridable via `OLLAMA_MODEL` env var and per-session model field. User rejected 2025-era models (Qwen2.5-Coder, Devstral) as outdated — always research current models, mind the actual date.
- SSE chat contract: `data:` lines with JSON `{type: "text"|"thinking"|"tool_call"|"tool_result"|"checkpoint"|"done"|"error", ...}`; `tool_call.arguments` is a JSON **string** (frontend typing expects string). `thinking` is architect-mode reasoning — display-only, never persisted. Chat body flag `architect: true` routes the turn to the reasoning model (no tools). Streaming routes (chat/review/exec) also emit `: hb` SSE comment heartbeats every 10s (defeats idle-connection middleboxes during long silent stretches, e.g. Ollama cold loads); client parsers must only consume `data: ` lines, and new streaming endpoints must keep the heartbeat.
- Error payloads must be `{ error: string }` per OpenAPI `ApiError` — not `{ message }`.
- Workspace paths: per-session dirs under `/tmp/agent-workspaces/<id>` (env `AGENT_WORKSPACES_DIR`). `resolveInWorkspace` is async and does realpath-based symlink containment — keep it that way; lexical prefix checks alone are bypassable via symlinks.

**Why:** captured after a code-review round found route/error-schema drift and a symlink escape; these contracts are easy to re-break when adding endpoints.

Auth/deployment decisions (July 2026):
- Self-registration is disabled by explicit user request — the only account is the admin seeded at startup from ADMIN_USERNAME/ADMIN_PASSWORD env (upsert, so rotating the env password + restart rotates the login). Never re-add a register endpoint/UI.
- Local username/password auth only (bcrypt + express-session, pg store) — cloud auth providers contradict the self-hosted requirement. App is accessed from browsers on other LAN machines: cookies use `sameSite: lax`, `secure: "auto"` with `trust proxy`; prod Docker serves frontend + API same-origin so cookies just work.
- connect-pg-simple's `createTableIfMissing` breaks under esbuild bundling (reads table.sql from its package dir) — the app creates `user_sessions` itself at startup instead.
- `/api/healthz` is intentionally unauthenticated (Docker healthcheck uses it); everything else under /api except /auth/* requires login via router-level middleware.
- GitHub sync: optional GITHUB_TOKEN enables git push/pull via the agent's run_command; git installed in Docker runtime, credentials via a git credential helper reading $GITHUB_TOKEN at use time (never in URLs/files); all tool output is redacted-then-truncated so the token can't leak or be split; setupGit() must never crash boot (guarded, logs and disables sync on failure); Dockerfile sets HOME=/home/forge so `git config --global` is deterministic under the non-root user.
- The api-server is esbuild-bundled into dist/index.mjs for the Docker image: never load deps via createRequire/dynamic require — the bundler can't see them and prod crashes with MODULE_NOT_FOUND (node_modules absent at runtime). Use static ESM imports; named imports from CJS packages typecheck fine even without esModuleInterop.
- Ollama /v1 + qwen3-coder quirks: the chat template can drop prior assistant text when tool_calls are present, making the model repeat its plan verbatim after each tool result (mitigated via system-prompt instruction); streaming can emit multiple tool_calls all with index=0 (ollama#16212 — accumulator must split on fresh id/complete-JSON args); assistant content must be null, never "", alongside tool_calls (ollama#14181). Keeping host Ollama updated matters.
- The deployment target (DGX Spark) is linux-arm64 while the Replit dev workspace is x64: the template's pnpm-workspace.yaml overrides exclude non-x64 native binaries, which breaks Docker builds on the DGX. linux-arm64-gnu binaries for rollup/esbuild/lightningcss/tailwind-oxide must stay included in the lockfile. Deployed successfully July 2026.
- Schema is applied idempotently by the server at startup (CREATE TABLE/ADD COLUMN IF NOT EXISTS) so existing Docker volumes self-migrate on rebuild; docker/init.sql only covers fresh volumes.
- Docker: fresh Postgres volumes are provisioned by `docker/init.sql` (must stay in sync with drizzle schema); vite build needs `PORT` and `BASE_PATH=/` env at build time; frontend build lands in `dist/public`.

## ForgeOS brand identity (July 2026)
Brand kit applied: name "ForgeOS", ember orange primary #FF7A18 (hsl 25 100% 55%), gradient to #E23E1C, dark base #0E1116 (hsl 217 22% 7%).
**Why:** user-supplied brand kit; WCAG — white on #FF7A18 fails AA (~2.6:1), so primary/sidebar-primary foregrounds are the dark base color (dark-on-orange, matching the mark's glyph).
**How to apply:** any new UI accent/glow uses rgba(255,122,24,…) not the old rgba(255,87,34,…); keep dark text on orange buttons.

## Checkpoints, stop, terminal (July 2026)
- Checkpoints ARE git history: commits labeled `forge: <label>` in each session workspace; pre-turn commit "manual changes" isolates user edits/uploads from the agent's diff; revert never rewrites history (hard reset + soft reset back + commit forward as "revert to <short>"). **Why:** no DB schema changes → no prod migration on the DGX; forward-commits keep every state recoverable. **How to apply:** new features must not `push --force`/rebase workspace repos, and any new workspace-mutating route should rely on the next turn's pre-commit rather than committing itself.
- Stop is client-driven: UI aborts the SSE fetch; the chat route's `res.on("close")` (guarded by `!res.writableEnded`) fires an AbortController threaded into the agent loop (OpenAI SDK request option → drops the Ollama HTTP conn and frees the GPU) and tool execution. Transcript consistency on abort: half-streamed tool_calls are dropped (text-only assistant message ending `[Stopped by user]`); abort between tools writes synthetic tool results `[cancelled by user before execution]` for every pending tool_call — Ollama rejects transcripts with unanswered tool_calls.
- Killing a `bash -c` child alone leaves its background grandchildren alive (reparented). Any spawned shell that users can cancel must use `detached: true` + `process.kill(-pid, "SIGKILL")` (kill the process group). **How to apply:** both the terminal exec route and the agent's run_command do this; copy that pattern for any new process-spawning surface.
- Secret hygiene for user-facing shells (terminal + run_command): spawn with `workspaceEnv()` (strips SESSION_SECRET/ADMIN_PASSWORD/DATABASE_URL/PG*/REPL* — GITHUB_TOKEN intentionally kept for the git credential helper), and stream output through `makeStreamRedactor()` (line-boundary holdback) because chunk-by-chunk redaction leaks secrets split across chunk boundaries. **How to apply:** never pass raw `process.env` to a user-triggered process; never redact SSE output chunk-by-chunk.
- React SSE-hook rule: callbacks passed into the stream hook go into refs, `stopStream`/`sendChat` must be referentially stable, and a request's `finally` may only clear shared state if it is still the active request (identity check on its AbortController). **Why:** inline callbacks otherwise re-trigger the unmount-cleanup effect every render and abort live streams; a stopped request's late finally clobbered the next stream's state.
- Vision goes through Ollama's native `/api/chat` with a base64 `images` array (the OpenAI-compat vision path is flaky); model from `OLLAMA_VISION_MODEL`, default `qwen2.5vl`; a 404 from Ollama means the model isn't pulled — surface the `ollama pull` hint.

## Architect model (July 2026)
- Second model role: `OLLAMA_ARCHITECT_MODEL`, default `qwen3-next:80b-a3b-thinking` (50GB Q4 — co-resident with the 52GB coder in 128GB unified memory, so no swap latency; gpt-oss:120b is the max-quality alternative but forces model swapping). **Why:** researched July 2026 — frontier open reasoners (GLM-5.2 744B, DeepSeek V4, Kimi K3) don't fit 128GB; R1-era distills lack reliable tool calling and are stale.
- Two surfaces: `consult_architect` tool (coder passes question + file paths; 600s timeout; answer only, thinking dropped) and `architect: true` chat turns (no tools, history flattened to user/assistant text because reasoning-model chat templates may not accept tool messages; thinking streamed as `thinking` SSE events, never persisted; `<think>` tags stripped before persisting).
- Both use Ollama's native /api/chat (same rationale as vision: OpenAI-compat handling of thinking models is inconsistent).

## Dev-env quirks (Replit workspace)
- No `python3` in the shell — use `node` for scripted multi-edit jobs. A failed heredoc command does NOT stop subsequent newline-separated commands, so a later typecheck can "pass" against unedited files; make edit scripts assert and check their output line.
- `pkill -f` matches the ShellExec shell's own command line and self-kills — use `pkill -x`.

## File uploads & workspace fragility
Uploads are raw-body PUTs (no multer — keeps esbuild static-import rule); name in URL, basename-flattened, control-chars/length rejected server-side; client caps at 3 concurrent PUTs because the server buffers bodies in memory.
**Why:** /tmp workspaces vanish on host/container restart, which silently broke the first upload attempt.
**How to apply:** any new route that writes into a session workspace must `mkdir -p` the workspace dir first (self-heal), and prefer the raw-body pattern over multipart for new upload surfaces.

## Per-user session ownership (July 2026)
- Authz choke point: every session-scoped route resolves via one `getSessionOr404(req,res)` helper that returns an identical 404 for "missing" and "not yours" (no existence leak). New session routes MUST go through it.
- **Why 404 not 403:** enumerable serial ids; a 403 confirms a session exists.
- Admins see all sessions (list left-joins users to attach owner `username`; UI shows @owner chip only when it differs from viewer).
- Legacy/orphan sessions are adopted by the first admin at boot (schema-init backfill); deleting a user cascades their sessions in DB, then rm's workspace dirs.
- Avoid `$$` dollar-quoting in schema-init SQL: plain statements only (see tool quirk below), and the boot migration runs through a semicolon-batched pool.query.

## Tool quirk: `$$` collapses to `$` in Edit-tool writes
- Writing `DO $$ ... END $$;` via the file-edit tool landed on disk as `DO $ ... END $;` → Postgres `syntax error at or near "$"` at boot, twice, and follow-up exact-match/regex edits targeting `$$` failed to find it.
- **How to apply:** after any tool-write containing `$` runs, grep the file to confirm; or write such content via `node -e` with escapes. Prefer SQL that needs no dollar-quoting in boot migrations.

## "Send for review" (Claude) design
- The ONLY cloud call in the app; opt-in by env. Precedence `ANTHROPIC_*` || `AI_INTEGRATIONS_ANTHROPIC_*` (Replit dev proxy fallback) — use `||` not `??` because compose passes empty strings for unset vars.
- Feature gating pattern: server capability endpoint (`/capabilities`) drives UI visibility; route double-checks and 503s. Reuse this pattern for future optional features.
- Review turns reuse the chat SSE contract (`text`/`error`/`done`) so the frontend stream pump stays single-path (`startStream` in use-chat-stream).
- SECURITY INVARIANT: every new server-side secret env var must match `STRIP_ENV` in agent-tools, or it inherits into user terminals/run_command shells. Verify empirically with `env | grep` via the exec route (values masked). Output redaction alone is NOT protection.
- Workspace git repos can exist with ZERO commits (legacy/interrupted init) — every rev-list/log/diff consumer must tolerate unborn HEAD. ensureRepo self-heals by committing current state as the baseline ("initial checkpoint").
- The session diff baseline is git's EMPTY TREE, not the root commit: workspaces always start empty, and healed legacy repos fold all pre-heal work into their root commit (root..HEAD showed "nothing to review" for a session full of work — bug found on the DGX July 2026). The root `.gitignore` is seeded by ensureRepo, so a diff touching only it counts as "no changes" — keep that filter if the seed ever changes, and never add more seeded files without extending it.
- Server-side git (workspace-git) injects GIT_AUTHOR_*/GIT_COMMITTER_* + LC_ALL=C per call: containers may lack writable HOME, so boot-time `git config --global` can fail (only logged) and every commit would die silently. Never rely on global git config or English-locale git messages without LC_ALL=C.
- Compose env footgun (bit TWICE): `${VAR:-}` in docker-compose delivers SET-BUT-EMPTY vars, so `??` fallbacks forward "" (empty git ident made every DGX checkpoint commit fail with "empty ident name", July 2026; same class as the ANTHROPIC_* precedence fix). Every env read with a default must be empty-string-safe: `(process.env.X || "").trim() || default`.

## Local image generation (July 2026)
- generate_image tool is local Stable Diffusion ONLY (user explicitly chose this over cloud image APIs — consistent with local-first). IMAGE_GEN_URL points at an A1111-compatible WebUI (needs `--api`) or ComfyUI; provider auto-detected by probing `/sdapi/v1/options` vs `/system_stats` (IMAGE_GEN_PROVIDER overrides). Reuses the review-feature gating pattern: tool schema only registered when configured, `/capabilities` (`imageGen`) drives any UI.
- ComfyUI has no simple txt2img endpoint: POST a full node graph to `/prompt`, poll `/history/{id}`, download via `/view`. A checkpoint name is mandatory in the graph — auto-pick the first from `/object_info/CheckpointLoaderSimple` when IMAGE_GEN_MODEL is unset.
- Orval gotcha: an endpoint with query params generates a zod const and a TS type with the SAME PascalCase name (`XxxParams`), which breaks the api-zod barrel with TS2308; fix with an explicit `export type { XxxParams }` re-export. The barrel `index.ts` is hand-maintained (orval `clean` only wipes `generated/`).
- `esbuild` binary lives in artifacts/api-server, not the repo root — `pnpm exec esbuild` must run from that package dir.
- `res.sendFile`'s `root` option is a LEXICAL check only — never use it as the workspace jail (symlinks created via run_command/terminal escape it; a review round caught this). Always `resolveInWorkspace` + stat, then sendFile the resolved absolute path with `dotfiles: "allow"` (default "ignore" 404s legit workspace dotfiles like .env).
- DGX host quirk (July 2026): Ollama on the user's DGX Spark is NOT a systemd service ("No files found for ollama.service") — NVIDIA's Spark playbooks run it via Docker, or it's a manual `ollama serve`. Diagnose with `ss -ltnp | grep 11434` / `docker ps` before giving systemctl instructions; OLLAMA_CONTEXT_LENGTH/OLLAMA_KEEP_ALIVE must be applied to however it actually runs, and any migration to systemd must set OLLAMA_HOST=0.0.0.0:11434 or the forge container loses connectivity (systemd install default binds 127.0.0.1).
- Ollama truncates the FRONT of over-context prompts: system prompt + tool schemas die first, so the coder model "forgets" its tools and narrates plans instead of building. ForgeOS trims history itself (context-budget lib, oldest-first, current message never cut, orphaned tool msgs dropped); budget from OLLAMA_NUM_CTX which must match the Ollama server's OLLAMA_CONTEXT_LENGTH (Ollama default is only 4096).
- Architect mode is no-tools BY DESIGN (handoff plan → coder agent builds it). The UI has a one-click "BUILD THIS PLAN" button after architect turns — never tell users to re-paste plans back into chat; a short "implement the plan above" is enough, the plan is already in context.
