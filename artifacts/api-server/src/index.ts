import app from "./app";
import { ensureSessionTable, seedAdminUser } from "./lib/auth";
import { logger } from "./lib/logger";

// Make sure the session store table and the admin account exist before
// accepting traffic.
await ensureSessionTable;
await seedAdminUser();

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
