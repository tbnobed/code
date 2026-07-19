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
