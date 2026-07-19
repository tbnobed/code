import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { RequestHandler } from "express";
import { pool } from "@workspace/db";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    username?: string;
  }
}

const PgStore = connectPgSimple(session);

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set");
}

// connect-pg-simple's createTableIfMissing reads table.sql from its package
// dir, which breaks when the server is bundled (esbuild). Create it ourselves.
export const ensureSessionTable = pool.query(`
  CREATE TABLE IF NOT EXISTS "user_sessions" (
    "sid" varchar NOT NULL COLLATE "default",
    "sess" json NOT NULL,
    "expire" timestamp(6) NOT NULL,
    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
  );
  CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
`);

/**
 * Seed (or rotate) the admin account. Self-registration is disabled, so this
 * is the only way accounts are created.
 * - ADMIN_PASSWORD set: upsert the admin user with that password (rotating
 *   the password in .env + restart updates it).
 * - ADMIN_PASSWORD unset: fine if users already exist; otherwise fail fast,
 *   since nobody would be able to log in.
 */
export async function seedAdminUser(): Promise<void> {
  const bcrypt = (await import("bcryptjs")).default;
  const { db, usersTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");

  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    const [anyUser] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    if (!anyUser) {
      throw new Error(
        "No users exist and ADMIN_PASSWORD is not set — set ADMIN_PASSWORD so the admin account can be seeded.",
      );
    }
    return;
  }
  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username));
  if (existing) {
    await db
      .update(usersTable)
      .set({ passwordHash, isAdmin: true })
      .where(eq(usersTable.id, existing.id));
  } else {
    await db.insert(usersTable).values({ username, passwordHash, isAdmin: true });
  }
}

export const sessionMiddleware = session({
  store: new PgStore({ pool, tableName: "user_sessions", createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    // "auto": secure over HTTPS (behind a proxy with trust proxy set),
    // plain over HTTP on a LAN — both work for multi-system browser access.
    secure: "auto",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const { db, usersTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const [user] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId));
  if (!user?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
};
