import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes";
import v1Router from "./routes/v1";
import { logger } from "./lib/logger";
import { warmPool } from "./lib/umid-pool";

const app: Express = express();

const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];

const v1RateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  skip: (req) => {
    if (!ADMIN_API_KEY) return false;
    const auth = req.headers["authorization"] ?? "";
    return auth === `Bearer ${ADMIN_API_KEY}`;
  },
  keyGenerator: (req) => {
    const auth = req.headers["authorization"] ?? "";
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      return `key:${auth.slice(7, 47)}`;
    }
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";
    return `ip:${ip}`;
  },
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        message: "Rate limit exceeded. Max 60 requests per minute per API key.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
  },
});

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
app.use("/v1", v1RateLimit, v1Router);

// Warm the bx-umidtoken pool at startup (non-blocking)
warmPool();

export default app;
