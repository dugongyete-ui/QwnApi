import { Router } from "express";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { chatSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { tokenPool } from "../lib/tokenPool";
import { createChat, chatCompletions } from "../lib/qwenEngine";
import { gatewayStatsTable, requestLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

const MODELS = [
  { id: "qwen-plus", name: "Qwen Plus", description: "Balanced speed and capability", maxTokens: 131072 },
  { id: "qwen-max", name: "Qwen Max", description: "Most capable model", maxTokens: 32768 },
  { id: "qwen-turbo", name: "Qwen Turbo", description: "Fastest responses", maxTokens: 131072 },
  { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", description: "Latest Qwen 3.7 with reasoning", maxTokens: 131072 },
];

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint.
 * Accepts the same request format as OpenAI's API and returns an identical response schema.
 */
router.post("/chat/completions", async (req, res) => {
  const body = req.body as {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    conversation_id?: string;
  };

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({
      error: {
        message: "messages is required and must be a non-empty array",
        type: "invalid_request_error",
        code: "invalid_messages",
      },
    });
    return;
  }

  const model = body.model ?? "qwen-plus";
  const conversationId = body.conversation_id ?? null;
  const startTime = Date.now();

  // Extract last user message as the prompt
  const userMessages = body.messages.filter((m) => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];
  if (!lastUserMessage) {
    res.status(400).json({
      error: {
        message: "At least one user message is required",
        type: "invalid_request_error",
        code: "missing_user_message",
      },
    });
    return;
  }

  const midtoken = tokenPool.getToken();
  if (!midtoken) {
    res.status(503).json({
      error: {
        message: "Gateway token pool is empty, please retry later",
        type: "gateway_error",
        code: "token_pool_empty",
      },
    });
    return;
  }

  try {
    let chatId = conversationId;
    let session: typeof chatSessionsTable.$inferSelect | undefined;
    let historyMessages: Array<{ role: string; content: string }> = [];

    if (chatId) {
      const rows = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.conversationId, chatId));
      session = rows[0];
      if (session && Array.isArray(session.messages)) {
        historyMessages = (session.messages as Array<{ role: string; content: string }>);
      }
    } else {
      const createResult = await createChat(midtoken, model);
      chatId = createResult.chatId ?? randomUUID();
    }

    // Build messages array: include system messages from request + history + new messages
    const systemMessages = body.messages.filter((m) => m.role === "system");
    const allMessages = historyMessages.length > 0
      ? [...historyMessages, ...body.messages.filter((m) => m.role !== "system")]
      : body.messages;

    const result = await chatCompletions(midtoken, model, allMessages, chatId!);

    if (!result.success) {
      if (result.code === "TOKEN_INVALID") tokenPool.markFailed(midtoken);
      await recordRequest(false, Date.now() - startTime, model);
      res.status(500).json({
        error: {
          message: result.error ?? "Gateway error",
          type: "gateway_error",
          code: result.code ?? "internal_error",
        },
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`;

    // Persist session
    const userMsg = { role: "user", content: lastUserMessage.content, timestamp: new Date().toISOString() };
    const assistantMsg = { role: "assistant", content: result.response ?? "", thinking: result.thinking ?? undefined, timestamp: new Date().toISOString() };
    const updatedMessages = session
      ? [...(session.messages as object[]), userMsg, assistantMsg]
      : [...body.messages.map((m) => ({ ...m, timestamp: new Date().toISOString() })), assistantMsg];

    if (session) {
      await db.update(chatSessionsTable)
        .set({ messages: updatedMessages, messageCount: updatedMessages.length, updatedAt: new Date() })
        .where(eq(chatSessionsTable.conversationId, chatId!));
    } else {
      await db.insert(chatSessionsTable).values({
        conversationId: chatId!,
        model,
        messages: updatedMessages,
        messageCount: updatedMessages.length,
      }).onConflictDoUpdate({
        target: chatSessionsTable.conversationId,
        set: { messages: updatedMessages, messageCount: updatedMessages.length, updatedAt: new Date() },
      });
    }

    await recordRequest(true, Date.now() - startTime, model);

    // Return OpenAI-compatible response
    res.json({
      id: completionId,
      object: "chat.completion",
      created: now,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.response ?? "",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: result.tokenUsage ?? 0,
      },
      // Non-standard extension: expose reasoning and conversation tracking
      x_gateway: {
        conversationId: chatId,
        thinking: result.thinking ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "v1 chat completions error");
    await recordRequest(false, Date.now() - startTime, model);
    res.status(500).json({
      error: {
        message: "Internal gateway error",
        type: "gateway_error",
        code: "internal_error",
      },
    });
  }
});

/**
 * GET /v1/models
 * OpenAI-compatible models list endpoint.
 */
router.get("/models", (_req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: now,
      owned_by: "qwen-gateway",
      permission: [],
      root: m.id,
      parent: null,
    })),
  });
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
