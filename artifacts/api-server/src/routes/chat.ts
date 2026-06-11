import { Router } from "express";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { chatSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { tokenPool } from "../lib/tokenPool";
import { createChat, chatCompletions } from "../lib/qwenEngine";
import { gatewayStatsTable, requestLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { SendChatBody } from "@workspace/api-zod";

const router = Router();

const MODELS = [
  { id: "qwen-plus", name: "Qwen Plus", description: "Balanced speed and capability", maxTokens: 131072 },
  { id: "qwen-max", name: "Qwen Max", description: "Most capable model for complex tasks", maxTokens: 32768 },
  { id: "qwen-turbo", name: "Qwen Turbo", description: "Fastest, optimized for quick responses", maxTokens: 131072 },
  { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", description: "Latest Qwen 3.7 with enhanced reasoning", maxTokens: 131072 },
];

router.post("/chat", async (req, res) => {
  const parsed = SendChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { prompt, model = "qwen-plus", conversationId } = parsed.data;
  const startTime = Date.now();

  const midtoken = tokenPool.getToken();
  if (!midtoken) {
    res.status(503).json({ error: "No available tokens in pool", code: "TOKEN_POOL_EMPTY" });
    return;
  }

  try {
    let chatId = conversationId;
    let session: typeof chatSessionsTable.$inferSelect | undefined;
    let messages: Array<{ role: string; content: string }> = [];

    if (chatId) {
      const rows = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.conversationId, chatId));
      session = rows[0];
      if (session && Array.isArray(session.messages)) {
        messages = session.messages as Array<{ role: string; content: string }>;
      }
    } else {
      const createResult = await createChat(midtoken, model);
      chatId = createResult.chatId ?? randomUUID();
    }

    messages.push({ role: "user", content: prompt });

    const result = await chatCompletions(midtoken, model, messages, chatId!);

    if (!result.success) {
      if (result.code === "TOKEN_INVALID") {
        tokenPool.markFailed(midtoken);
      }
      await recordRequest(false, Date.now() - startTime, model);
      res.status(500).json({ error: result.error ?? "Gateway error", code: result.code });
      return;
    }

    const assistantMsg = {
      role: "assistant",
      content: result.response ?? "",
      thinking: result.thinking ?? undefined,
      timestamp: new Date().toISOString(),
    };

    const userMsg = {
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
    };

    const updatedMessages = session
      ? [...(session.messages as object[]), { ...userMsg }, assistantMsg]
      : [{ ...userMsg }, assistantMsg];

    if (session) {
      await db.update(chatSessionsTable)
        .set({
          messages: updatedMessages,
          messageCount: updatedMessages.length,
          updatedAt: new Date(),
        })
        .where(eq(chatSessionsTable.conversationId, chatId!));
    } else {
      await db.insert(chatSessionsTable).values({
        conversationId: chatId!,
        model,
        messages: updatedMessages,
        messageCount: updatedMessages.length,
      }).onConflictDoUpdate({
        target: chatSessionsTable.conversationId,
        set: {
          messages: updatedMessages,
          messageCount: updatedMessages.length,
          updatedAt: new Date(),
        },
      });
    }

    await recordRequest(true, Date.now() - startTime, model);

    res.json({
      response: result.response,
      thinking: result.thinking ?? null,
      model,
      conversationId: chatId,
      tokenUsage: result.tokenUsage ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Chat error");
    await recordRequest(false, Date.now() - startTime, model);
    res.status(500).json({ error: "Internal gateway error" });
  }
});

router.get("/models", (_req, res) => {
  res.json({ models: MODELS });
});

async function recordRequest(success: boolean, responseTime: number, model: string) {
  try {
    await db.insert(requestLogsTable).values({
      id: randomUUID(),
      success: success ? "true" : "false",
      responseTime,
      model,
    });

    await db.insert(gatewayStatsTable).values({
      id: "singleton",
      totalRequests: 1,
      successRequests: success ? 1 : 0,
      failedRequests: success ? 0 : 1,
      totalResponseTime: responseTime,
    }).onConflictDoUpdate({
      target: gatewayStatsTable.id,
      set: {
        totalRequests: sql`gateway_stats.total_requests + 1`,
        successRequests: sql`gateway_stats.success_requests + ${success ? 1 : 0}`,
        failedRequests: sql`gateway_stats.failed_requests + ${success ? 0 : 1}`,
        totalResponseTime: sql`gateway_stats.total_response_time + ${responseTime}`,
        updatedAt: new Date(),
      },
    });
  } catch {
    // non-fatal
  }
}

export default router;
