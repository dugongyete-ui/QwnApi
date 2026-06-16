import { Router } from "express";
import { db } from "@workspace/db";
import { chatSessionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { count } from "drizzle-orm";
import { GetConversationParams, DeleteConversationParams } from "@workspace/api-zod";

const router = Router();

router.get("/history", async (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  const offset = Number(req.query["offset"] ?? 0);

  try {
    const [sessions, totalRows] = await Promise.all([
      db.select().from(chatSessionsTable).orderBy(desc(chatSessionsTable.updatedAt)).limit(limit).offset(offset),
      db.select({ cnt: count() }).from(chatSessionsTable),
    ]);

    res.json({
      sessions,
      total: Number(totalRows[0]?.cnt ?? 0),
      offset,
      limit,
    });
  } catch (err) {
    req.log.error({ err }, "History list error");
    res.status(500).json({ error: { message: "Failed to fetch history", type: "server_error", code: "internal_error" } });
  }
});

router.get("/history/:conversationId", async (req, res) => {
  const parsed = GetConversationParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "Invalid conversation ID", type: "invalid_request_error", code: "invalid_value" } });
    return;
  }

  try {
    const rows = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.conversationId, parsed.data.conversationId));
    if (!rows[0]) {
      res.status(404).json({ error: { message: "Conversation not found", type: "invalid_request_error", code: "not_found" } });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    req.log.error({ err }, "Get conversation error");
    res.status(500).json({ error: { message: "Failed to fetch conversation", type: "server_error", code: "internal_error" } });
  }
});

router.delete("/history/:conversationId", async (req, res) => {
  const parsed = DeleteConversationParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "Invalid conversation ID", type: "invalid_request_error", code: "invalid_value" } });
    return;
  }

  try {
    await db.delete(chatSessionsTable).where(eq(chatSessionsTable.conversationId, parsed.data.conversationId));
    res.json({ success: true, message: "Conversation deleted" });
  } catch (err) {
    req.log.error({ err }, "Delete conversation error");
    res.status(500).json({ error: { message: "Failed to delete conversation", type: "server_error", code: "internal_error" } });
  }
});

export default router;
