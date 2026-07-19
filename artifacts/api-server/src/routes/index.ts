import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import sessionsRouter from "./sessions";
import modelsRouter from "./models";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(requireAuth); // everything below requires a logged-in user
router.use(sessionsRouter);
router.use(modelsRouter);

export default router;
