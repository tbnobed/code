---
name: Forge agent decisions
description: Durable decisions for the Forge local coding-agent app (Ollama, SSE contract, workspace security)
---

- No cloud LLM APIs — user explicitly requires local models via Ollama on their DGX Spark (128GB unified memory). Backend uses the `openai` npm package pointed at `${OLLAMA_BASE_URL}/v1` (default `http://localhost:11434`).
- Default model: `qwen3-coder-next` (July 2026 community consensus for DGX Spark agentic coding). Overridable via `OLLAMA_MODEL` env var and per-session model field. User rejected 2025-era models (Qwen2.5-Coder, Devstral) as outdated — always research current models, mind the actual date.
- SSE chat contract: `data:` lines with JSON `{type: "text"|"tool_call"|"tool_result"|"done"|"error", ...}`; `tool_call.arguments` is a JSON **string** (frontend typing expects string).
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
