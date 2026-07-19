import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import sessionsRouter from "./sessions";
import previewRouter from "./preview";
import usersRouter from "./users";
import githubRouter from "./github";
import modelsRouter from "./models";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(previewRouter); // token-authenticated (sandboxed iframes drop cookies)
router.use(requireAuth); // everything below requires a logged-in user
router.use(sessionsRouter);
router.use(githubRouter);
router.use(usersRouter);
router.use(modelsRouter);

export default router;
