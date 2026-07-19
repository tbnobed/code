import { Router, type IRouter } from "express";
import { OLLAMA_BASE_URL } from "../lib/ollama";
import { REVIEW_MODEL, reviewAvailable } from "../lib/anthropic";
import { imageGenAvailable } from "../lib/image-gen";

const router: IRouter = Router();

router.get("/models", async (_req, res) => {
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!r.ok) throw new Error(`Ollama responded ${r.status}`);
    const data = (await r.json()) as {
      models?: { name: string; size: number; modified_at: string }[];
    };
    res.json(
      (data.models ?? []).map((m) => ({
        name: m.name,
        size: m.size,
        modifiedAt: m.modified_at,
      })),
    );
  } catch {
    // Ollama not reachable (e.g. app not running on the DGX yet) — return empty list
    res.json([]);
  }
});

// Feature flags the UI relies on (e.g. hide "Send for review" when the
// server has no Anthropic credentials — review is opt-in cloud access).
router.get("/capabilities", (_req, res) => {
  res.json({
    review: reviewAvailable(),
    ...(reviewAvailable() ? { reviewModel: REVIEW_MODEL } : {}),
    imageGen: imageGenAvailable(),
  });
});

export default router;
