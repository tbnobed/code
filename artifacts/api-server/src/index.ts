import app from "./app";
import { seedAdminUser } from "./lib/auth";
import { ensureSchema } from "./lib/schema-init";
import { setupGit } from "./lib/git-setup";
import { logger } from "./lib/logger";

// Apply the schema (idempotent) and seed the admin account before accepting
// traffic — this also migrates existing databases on updated builds.
await ensureSchema();
await seedAdminUser();
await setupGit();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
