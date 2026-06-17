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

// Start listening IMMEDIATELY so Autoscale health check (GET /) can pass.
// The dashboard static files are served at / without needing the token pool,
// so the health check returns 200 right away regardless of pool status.
// Token pool initialization continues in the background — chat requests that
// arrive before the pool is ready will receive a 503 "token pool empty" response
// (same as when the pool is exhausted at runtime), which is correct behavior.
app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

// Initialize token pool in background — does NOT block server startup.
// waitForFirstBatch() triggers initPool() if not already running, then
// resolves once the first 10 tokens are fetched (or instantly if cache exists).
waitForFirstBatch().then(() => {
  logger.info("Token pool ready — gateway accepting chat requests");
}).catch((err) => {
  logger.warn({ err }, "Token pool initialization warning (pool will retry automatically)");
});
