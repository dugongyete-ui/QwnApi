import { Router } from "express";
import { db } from "@workspace/db";
import { gatewayStatsTable, requestLogsTable, apiKeysTable } from "@workspace/db";
import { eq, gte, count } from "drizzle-orm";
import { getPoolStatus, warmPool } from "../lib/umid-pool";

const router = Router();

router.get("/stats", async (req, res) => {
  try {
    const statsRows = await db.select().from(gatewayStatsTable).where(eq(gatewayStatsTable.id, "singleton"));
    const stats = statsRows[0];

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);

    const [todayRows, hourRows] = await Promise.all([
      db.select({ cnt: count() }).from(requestLogsTable).where(gte(requestLogsTable.createdAt, todayStart)),
      db.select({ cnt: count() }).from(requestLogsTable).where(gte(requestLogsTable.createdAt, hourStart)),
    ]);

    const activeKeysRows = await db.select({ cnt: count() }).from(apiKeysTable).where(eq(apiKeysTable.isActive, true));

    const totalRequests = stats?.totalRequests ?? 0;
    const successRequests = stats?.successRequests ?? 0;
    const failedRequests = stats?.failedRequests ?? 0;
    const totalResponseTime = stats?.totalResponseTime ?? 0;
    const successRate = totalRequests > 0 ? successRequests / totalRequests : 0;
    const avgResponseTime = totalRequests > 0 ? totalResponseTime / totalRequests : 0;

    const poolStatus = getPoolStatus();

    res.json({
      totalRequests,
      successRequests,
      failedRequests,
      successRate: Math.round(successRate * 10000) / 100,
      requestsToday: Number(todayRows[0]?.cnt ?? 0),
      requestsThisHour: Number(hourRows[0]?.cnt ?? 0),
      averageResponseTime: Math.round(avgResponseTime),
      activeApiKeys: Number(activeKeysRows[0]?.cnt ?? 0),
      tokenPoolSize: poolStatus.size,
      tokenPoolHealthy: poolStatus.entries.filter((e) => e.hasToken).length,
    });
  } catch (err) {
    req.log.error({ err }, "Stats error");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

router.get("/token-pool", (_req, res) => {
  res.json(getPoolStatus());
});

/** POST /api/token-pool/refresh — trigger a background re-warm of the pool */
router.post("/token-pool/refresh", (_req, res) => {
  warmPool();
  res.json({ ok: true, message: "Pool re-warm triggered", status: getPoolStatus() });
});

export default router;
