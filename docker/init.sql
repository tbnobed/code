-- Schema initialization for Forge (runs once on a fresh Postgres volume).
-- NOTE: the app also applies this schema idempotently at startup
-- (artifacts/api-server/src/lib/schema-init.ts), which covers EXISTING volumes
-- when a new build adds tables/columns. Keep both in sync with
-- lib/db/src/schema/*.ts (drizzle is the source of truth in dev).

CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY,
  "username" text NOT NULL UNIQUE,
  "password_hash" text NOT NULL,
  "is_admin" boolean NOT NULL DEFAULT false,
  "github_token" text,
  "github_login" text,
  "github_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" serial PRIMARY KEY,
  "title" text NOT NULL,
  "model" text NOT NULL DEFAULT 'qwen3-coder-next',
  "workspace_path" text NOT NULL,
  "message_count" integer NOT NULL DEFAULT 0,
  "github_repo" text,
  "github_autopush" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "messages" (
  "id" serial PRIMARY KEY,
  "session_id" integer NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "tool_calls" text,
  "tool_call_id" text,
  "mode" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Express session store (also created by the app at startup; harmless duplicate)
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
