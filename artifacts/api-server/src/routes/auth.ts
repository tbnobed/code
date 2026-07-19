import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

function serializeUser(u: typeof usersTable.$inferSelect) {
  return { id: u.id, username: u.username, createdAt: u.createdAt.toISOString() };
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

router.post("/auth/register", async (req, res) => {
  const creds = validCredentials(req.body);
  if (!creds) {
    return res.status(400).json({
      error: "Username must be 3-64 characters and password at least 8 characters",
    });
  }
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, creds.username));
  if (existing) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const passwordHash = await bcrypt.hash(creds.password, 12);
  const [user] = await db
    .insert(usersTable)
    .values({ username: creds.username, passwordHash })
    .returning();
  req.session.userId = user.id;
  req.session.username = user.username;
  return res.status(201).json(serializeUser(user));
});

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
