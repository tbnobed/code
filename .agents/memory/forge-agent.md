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
- The deployment target (DGX Spark) is linux-arm64 while the Replit dev workspace is x64: the template's pnpm-workspace.yaml overrides exclude non-x64 native binaries, which breaks Docker builds on the DGX. linux-arm64-gnu binaries for rollup/esbuild/lightningcss/tailwind-oxide must stay included in the lockfile. Deployed successfully July 2026.
- Schema is applied idempotently by the server at startup (CREATE TABLE/ADD COLUMN IF NOT EXISTS) so existing Docker volumes self-migrate on rebuild; docker/init.sql only covers fresh volumes.
- Docker: fresh Postgres volumes are provisioned by `docker/init.sql` (must stay in sync with drizzle schema); vite build needs `PORT` and `BASE_PATH=/` env at build time; frontend build lands in `dist/public`.
