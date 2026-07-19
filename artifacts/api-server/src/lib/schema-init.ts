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
      "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "title" text NOT NULL,
      "model" text NOT NULL DEFAULT 'qwen3-coder-next',
      "workspace_path" text NOT NULL,
      "message_count" integer NOT NULL DEFAULT 0,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    );

    -- Ownership migration for pre-existing deployments: adopt orphan sessions
    -- to the first admin (they were created before per-user ownership existed).
    ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "user_id" integer REFERENCES "users"("id") ON DELETE CASCADE;
    UPDATE "sessions" SET "user_id" = COALESCE(
      (SELECT "id" FROM "users" WHERE "is_admin" = true ORDER BY "id" LIMIT 1),
      (SELECT "id" FROM "users" ORDER BY "id" LIMIT 1)
    ) WHERE "user_id" IS NULL;

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
    -- 'architect' for architect-turn responses; null for normal turns.
    ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mode" text;

    CREATE TABLE IF NOT EXISTS "user_sessions" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
  `);

  // Enforce NOT NULL only when no orphan rows remain. Normally the backfill
  // above adopts everything (sessions cannot exist without users), but a
  // manually tampered DB — sessions present, users empty — must degrade to a
  // warning instead of crash-looping the boot. (Would be a DO $ block, but
  // this script must stay plain SQL — no dollar-quoting.)
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM "sessions" WHERE "user_id" IS NULL',
  );
  if (rows[0]?.n === 0) {
    await pool.query('ALTER TABLE "sessions" ALTER COLUMN "user_id" SET NOT NULL');
  } else {
    console.warn(
      `[schema-init] ${rows[0]?.n} session(s) have no owner and no user exists to adopt them; leaving sessions.user_id nullable until a user exists`,
    );
  }
}
