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
- Local username/password auth only (bcrypt + express-session, pg store) — cloud auth providers contradict the self-hosted requirement. App is accessed from browsers on other LAN machines: cookies use `sameSite: lax`, `secure: "auto"` with `trust proxy`; prod Docker serves frontend + API same-origin so cookies just work.
- connect-pg-simple's `createTableIfMissing` breaks under esbuild bundling (reads table.sql from its package dir) — the app creates `user_sessions` itself at startup instead.
- `/api/healthz` is intentionally unauthenticated (Docker healthcheck uses it); everything else under /api except /auth/* requires login via router-level middleware.
- Docker: fresh Postgres volumes are provisioned by `docker/init.sql` (must stay in sync with drizzle schema); vite build needs `PORT` and `BASE_PATH=/` env at build time; frontend build lands in `dist/public`.
