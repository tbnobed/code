# ForgeOS

Self-hosted agentic coding assistant (a private "Replit Agent") that runs entirely on the user's own hardware — local LLMs via Ollama on an NVIDIA DGX Spark, multi-user, no cloud APIs.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/agent run dev` — run the React frontend (Vite, HMR)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only; prod migrates via schema-init at boot)
- Required env: `DATABASE_URL` — Postgres connection string; `SESSION_SECRET`; `ADMIN_PASSWORD` (first boot)
- Optional env: `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_ARCHITECT_MODEL`, `OLLAMA_VISION_MODEL`; `ANTHROPIC_API_KEY` (+ `ANTHROPIC_BASE_URL`, `ANTHROPIC_REVIEW_MODEL`) enables "Send for review"; `IMAGE_GEN_URL` (+ `IMAGE_GEN_PROVIDER`/`IMAGE_GEN_MODEL`/`IMAGE_GEN_STEPS`/`IMAGE_GEN_TIMEOUT_MS`) enables the local Stable Diffusion `generate_image` tool (A1111 `--api` or ComfyUI)
- Production: `docker compose up -d --build` on the DGX (app on port 3000)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/routes/` — HTTP API (auth, sessions, users, preview, models)
- `artifacts/api-server/src/lib/` — agent loop, agent tools, auth middleware, workspace + git helpers, boot schema init
- `artifacts/agent/src/` — React UI (ForgeLayout sidebar/shell, ForgeWorkspace chat + panels)
- `lib/db/src/schema/` — Drizzle schema (source of truth for tables)
- `lib/api-spec/openapi.yaml` — API contract source of truth (orval generates `lib/api-client-react` + zod)
- Agent workspaces live under `/tmp/agent-workspaces/<sessionId>` in dev (volume-mounted dir in prod)

## Architecture decisions

- Ollama-only LLM access through the native `/api/chat` endpoint (streaming NDJSON); no cloud fallbacks by design.
- Boot-time idempotent `ensureSchema()` (plain SQL, `IF NOT EXISTS`) is the production migration path — Docker's init.sql only runs on fresh volumes.
- Per-user session ownership is enforced at ONE choke point: `getSessionOr404` in `routes/sessions.ts` resolves the requester and returns an identical 404 for "missing" and "not yours" (serial ids must not leak existence). Admins bypass ownership and see everyone's sessions (list attaches owner username).
- Workspace preview is authorized by signed expiring HMAC tokens in the URL, because the sandboxed iframe has an opaque origin and drops cookies.
- Accounts are admin-managed only (no self-registration); the admin is seeded from env at boot.
- "Send for review" is the ONE opt-in cloud feature in an otherwise local-only app: the session diff goes to Anthropic (Claude) only when ANTHROPIC_* creds are set. The UI hides the button via GET /capabilities; the route 503s when unconfigured. Dev workspace uses the Replit AI-integration proxy vars as fallback; the DGX uses the user's own key.

## Product

- Multi-user login; each user has their own agent sessions and isolated workspaces; admins additionally see all sessions (labeled with owner) and manage users.
- Chat-driven coding agent with tool calling (file ops, shell exec, url fetch, image/vision input), streamed over SSE with stop/retry.
- Architect mode: a second, deep-reasoning model for whole-turn consultation (Brain toggle in the composer).
- Per-turn git checkpoints with diff view and revert; built-in terminal; editable file viewer; live site preview; workspace zip download.
- Send for review: one click ships the session's full diff to Claude for a structured external code review, streamed into chat and saved in history.
- Image generation: opt-in `generate_image` tool backed by a local Stable Diffusion server (AUTOMATIC1111 or ComfyUI, auto-detected); saves PNGs into the workspace, thumbnails render in chat and the file viewer displays images.

## User preferences

- Local-first / self-hosted: never add cloud LLM API dependencies.
- Brand: ember orange `#FF7A18`, dark text on orange.

## Gotchas

- Restart the API Server workflow after backend changes (it runs an esbuild bundle, not a watcher). The frontend is Vite HMR — no restart needed.
- After editing `lib/db` schema, run `npx tsc -b lib/db` (or root typecheck) — dependents typecheck against built `dist/` d.ts, which otherwise goes stale.
- After editing `openapi.yaml`, rerun codegen; transient Vite "file not found" errors during codegen self-heal.
- `ensureSchema()` runs as one semicolon-batched `pool.query` — keep it plain SQL (no `DO $$` blocks / dollar-quoting).
- Any new session-scoped route MUST load the session through `getSessionOr404` so ownership is enforced.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
