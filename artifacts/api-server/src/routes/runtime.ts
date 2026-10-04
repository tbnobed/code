import { Router } from "express";
import { getSessionOr404 } from "./sessions";
import { makePreviewToken } from "./preview";
import { runtimeStatus, runtimeBusy, controlRuntime, stopRuntime } from "../lib/runtime";
import { saveRuntimeConfig } from "../lib/runtime-settings";
import { SaveRuntimeBody, ControlRuntimeBody, GetRuntimeResponse } from "@workspace/api-zod";

const router = Router();
router.get("/sessions/:id/runtime", async (req, res) => {
  const session = await getSessionOr404(req as any, res);
  if (!session) return;
  const status = await runtimeStatus(session.workspacePath);
  // Renew a running application's signed prefix before it expires.
  const token = status.previewPath.split("/preview/")[1]?.split("/")[0];
  const expiry = Number(token?.split("~")[0]);
  if (status.state === "running" && expiry < Date.now() + 10 * 60_000) {
    await controlRuntime(session.workspacePath, "restart", `${req.baseUrl}/sessions/${session.id}/preview/${makePreviewToken(session.id)}`);
  }
  res.json(GetRuntimeResponse.parse(await runtimeStatus(session.workspacePath)));
});
router.put("/sessions/:id/runtime", async (req, res) => {
  const session = await getSessionOr404(req as any, res);
  if (!session) return;
  const parsed = SaveRuntimeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (runtimeBusy(session.workspacePath)) { res.status(409).json({ error: "Stop the current operation before changing settings." }); return; }
  try {
    await saveRuntimeConfig(session.workspacePath, parsed.data);
    stopRuntime(session.workspacePath);
    res.json(GetRuntimeResponse.parse(await runtimeStatus(session.workspacePath)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid runtime settings" });
  }
});
router.post("/sessions/:id/runtime/action", async (req, res) => {
  const session = await getSessionOr404(req as any, res);
  if (!session) return;
  const parsed = ControlRuntimeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    await controlRuntime(session.workspacePath, parsed.data.action, `${req.baseUrl}/sessions/${session.id}/preview/${makePreviewToken(session.id)}`);
    res.status(202).json(GetRuntimeResponse.parse(await runtimeStatus(session.workspacePath)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Runtime operation failed" });
  }
});
export default router;