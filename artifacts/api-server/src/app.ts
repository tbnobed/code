import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { sessionMiddleware } from "./lib/auth";
import { logger } from "./lib/logger";

const app: Express = express();

// Behind a reverse proxy (Replit preview, nginx, traefik) — needed for
// secure:"auto" cookies and correct client IPs.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
// 5mb: the in-app file editor saves whole files as JSON.
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

app.use("/api", router);

// In production (Docker), serve the built frontend from the same origin so
// the app is reachable from any browser on the network with working cookies.
const staticDir = process.env.STATIC_DIR ?? path.resolve(process.cwd(), "public");
if (process.env.NODE_ENV === "production" && fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
