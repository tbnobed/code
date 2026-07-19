import { pool } from "@workspace/db";

/**
 * Idempotent schema initialization, run at startup before serving traffic.
 *
 * Why here and not only docker/init.sql: Postgres runs init.sql only when the
 * data volume is FRESH. Existing deployments that update to a build with new
 * tables/columns would otherwise be left with a stale schema. Everything below
 * is IF NOT EXISTS, so it is safe to run on every boot.
 *
 * Keep in sync with lib/db/src/schema/*.ts (drizzle is the source of truth in
 * dev, where `pnpm --filter @workspace/db run push` applies changes).
 */
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" serial PRIMARY KEY,
      "username" text NOT NULL UNIQUE,
      "password_hash" text NOT NULL,
      "is_admin" boolean NOT NULL DEFAULT false,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS "sessions" (
      "id" serial PRIMARY KEY,
      "title" text NOT NULL,
      "model" text NOT NULL DEFAULT 'qwen3-coder-next',
      "workspace_path" text NOT NULL,
      "message_count" integer NOT NULL DEFAULT 0,
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
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "user_sessions" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
  `);
}
