import { Router } from "express";
import { getSessionOr404 } from "./sessions";
import { saveVisualDesign, visualStatus } from "../lib/visual-design";
import { SaveVisualDesignBody } from "@workspace/api-zod";

const router = Router();
router.get("/sessions/:id/design", async (req, res) => {
  const session = await getSessionOr404(req as any, res);
  if (!session) return;
  res.json(await visualStatus(session.workspacePath));
});
router.post("/sessions/:id/design", async (req, res) => {
  const session = await getSessionOr404(req as any, res);
  if (!session) return;
  const parsed = SaveVisualDesignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide an element selector and CSS style values." }); return;
  }
  try { res.json(await saveVisualDesign(session.workspacePath, parsed.data)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Visual edit failed" }); }
});
router.delete("/sessions/:id/design", async (req, res) => {
  const session = await getSessionOr404(req as any, res);
  if (!session) return;
  try { res.json(await saveVisualDesign(session.workspacePath, null)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Reset failed" }); }
});
export default router;