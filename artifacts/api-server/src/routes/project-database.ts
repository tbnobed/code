import { Router } from "express";
import { getSessionOr404 } from "./sessions";
import { createProjectDatabase, deleteProjectDatabase, projectDatabaseStatus, queryProjectDatabase } from "../lib/project-database";
import { DeleteProjectDatabaseBody, QueryProjectDatabaseBody } from "@workspace/api-zod";
const router = Router();
for (const method of ["get", "post", "delete"] as const) {
  router[method]("/sessions/:id/database", async (req, res) => {
    const session = await getSessionOr404(req as any, res);
    if (!session) return;
    if (method === "delete" && !DeleteProjectDatabaseBody.safeParse(req.body).success) { res.status(400).json({ error: "Confirm permanent database deletion." }); return; }
    try {
      const fn = method === "get" ? projectDatabaseStatus : method === "post" ? createProjectDatabase : deleteProjectDatabase;
      res.json(await fn(session.workspacePath));
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Database operation failed" }); }
  });
}
router.post("/sessions/:id/database/query", async (req, res) => {
  const session = await getSessionOr404(req as any, res);
  if (!session) return;
  const parsed = QueryProjectDatabaseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Provide one SQL statement, up to 20,000 characters." }); return; }
  try { res.json(await queryProjectDatabase(session.workspacePath, parsed.data.sql)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Query failed" }); }
});
export default router;