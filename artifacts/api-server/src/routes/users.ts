import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import fs from "node:fs/promises";
import { eq, asc } from "drizzle-orm";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { requireAdmin } from "../lib/auth";

const router: IRouter = Router();

router.use("/users", requireAdmin);

function serializeUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    username: u.username,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt.toISOString(),
  };
}

router.get("/users", async (_req, res) => {
  const users = await db.select().from(usersTable).orderBy(asc(usersTable.id));
  res.json(users.map(serializeUser));
});

router.post("/users", async (req, res) => {
  const { username, password } = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof username !== "string" || username.trim().length < 3 || username.trim().length > 64 ||
    typeof password !== "string" || password.length < 8 || password.length > 256
  ) {
    return res.status(400).json({
      error: "Username must be 3-64 characters and password at least 8 characters",
    });
  }
  const name = username.trim();
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, name));
  if (existing) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db
    .insert(usersTable)
    .values({ username: name, passwordHash, isAdmin: false })
    .returning();
  return res.status(201).json(serializeUser(user));
});

router.delete("/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: "User not found" });
  }
  if (id === req.session.userId) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!target) {
    return res.status(404).json({ error: "User not found" });
  }
  if (target.isAdmin) {
    return res.status(400).json({ error: "The admin account cannot be deleted" });
  }
  // Their sessions cascade-delete with the user row; the workspace dirs on
  // disk need explicit cleanup.
  const orphaned = await db
    .select({ workspacePath: sessionsTable.workspacePath })
    .from(sessionsTable)
    .where(eq(sessionsTable.userId, id));
  await db.delete(usersTable).where(eq(usersTable.id, id));
  for (const s of orphaned) {
    await fs.rm(s.workspacePath, { recursive: true, force: true }).catch((err) => {
      console.warn(`[users] failed to remove workspace ${s.workspacePath}: ${err?.message ?? err}`);
    });
  }
  return res.status(204).end();
});

router.put("/users/:id/password", async (req, res) => {
  const id = Number(req.params.id);
  const { password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const [target] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, Number.isInteger(id) ? id : -1));
  if (!target) {
    return res.status(404).json({ error: "User not found" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, target.id));
  return res.status(204).end();
});

export default router;
