import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { waitForFirstBatch } from "./lib/umid-pool";

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

// Warn if QWEN_SESSION_TOKEN is not set — gateway will run in guest mode.
if (!process.env["QWEN_SESSION_TOKEN"]) {
  logger.warn(
    "QWEN_SESSION_TOKEN is not set. Running in guest/token-pool mode. " +
    "Vision image uploads are disabled. Set QWEN_SESSION_TOKEN (Bearer token from chat.qwen.ai) " +
    "for larger quota, vision support, and more stable throughput."
  );
}

// Run DB migrations before accepting any traffic.
// Idempotent — safe on every startup, handles fresh and existing databases.
try {
  await runMigrations();
} catch (err) {
  logger.error({ err }, "DB migration failed — server will not start");
  process.exit(1);
}

// Wait for token pool first batch to be ready before accepting traffic.
// If token_cache.json exists this resolves instantly (sync disk read).
// If no cache, waits ~2–3s for first 10 network tokens.
await waitForFirstBatch();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
