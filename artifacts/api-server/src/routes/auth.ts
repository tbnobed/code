import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

function serializeUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    username: u.username,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt.toISOString(),
  };
}

function validCredentials(body: unknown): { username: string; password: string } | null {
  const { username, password } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof username !== "string" || username.length < 3 || username.length > 64 ||
    typeof password !== "string" || password.length < 8 || password.length > 256
  ) {
    return null;
  }
  return { username: username.trim(), password };
}

// Self-registration is intentionally disabled: the only account is the admin
// account seeded at startup from ADMIN_USERNAME/ADMIN_PASSWORD.

router.post("/auth/login", async (req, res) => {
  const creds = validCredentials(req.body);
  if (!creds) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, creds.username));
  if (!user || !(await bcrypt.compare(creds.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  return res.json(serializeUser(user));
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.status(204).end();
  });
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!));
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Not authenticated" });
  }
  return res.json(serializeUser(user));
});

export default router;
