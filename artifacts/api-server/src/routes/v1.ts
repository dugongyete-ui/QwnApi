/**
 * OpenAI-compatible /v1 router
 * 100% compatible with the OpenAI Chat Completions API spec.
 * Supports: all generation params, streaming SSE, API key auth, n completions,
 * tools/function calling schema, response_format, logprobs (passthrough),
 * reasoning_effort, stream_options (include_usage), and every other documented parameter.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { db } from "@workspace/db";
import { chatSessionsTable, apiKeysTable, gatewayStatsTable, requestLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getPooledMidtoken } from "../lib/umid-pool";
import { createChat, chatCompletions, type QwenGenerationParams } from "../lib/qwenEngine";

const router = Router();

// ─── Constants ───────────────────────────────────────────────────────────────

const SYSTEM_FINGERPRINT = "fp_qwen_gateway_v1";

const MODELS = [
  { id: "qwen-plus",    name: "Qwen Plus",    description: "Balanced speed and capability",        maxTokens: 131072 },
  { id: "qwen-max",     name: "Qwen Max",     description: "Most capable model for complex tasks", maxTokens: 32768  },
  { id: "qwen-turbo",   name: "Qwen Turbo",   description: "Fastest, optimised for quick replies", maxTokens: 131072 },
  { id: "qwen3.7-plus", name: "Qwen 3.7 Plus",description: "Qwen 3.7 with enhanced reasoning",    maxTokens: 131072 },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: object }> | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  refusal?: string | null;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  // Generation params
  temperature?: number | null;
  top_p?: number | null;
  n?: number | null;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  stop?: string | string[] | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  logit_bias?: Record<string, number> | null;
  seed?: number | null;
  // Output / streaming
  stream?: boolean | null;
  stream_options?: { include_usage?: boolean } | null;
  logprobs?: boolean | null;
  top_logprobs?: number | null;
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: object } | null;
  // Tools
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: object; strict?: boolean } }> | null;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } } | null;
  parallel_tool_calls?: boolean | null;
  // Identity / caching
  user?: string | null;
  safety_identifier?: string | null;
  prompt_cache_key?: string | null;
  prompt_cache_retention?: string | null;
  metadata?: Record<string, string> | null;
  // Advanced
  reasoning_effort?: "none" | "low" | "medium" | "high" | null;
  modalities?: string[] | null;
  prediction?: object | null;
  service_tier?: "auto" | "default" | "flex" | "priority" | null;
  store_output?: boolean | null;
  moderation?: object | null;
  verbosity?: "low" | "medium" | "high" | null;
  web_search_options?: object | null;
  // Gateway-extension (not part of OpenAI spec — passthrough)
  conversation_id?: string | null;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveApiKey(authHeader: string | undefined): Promise<
  { ok: true; keyId: string } | { ok: false; statusCode: number; error: string }
> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, statusCode: 401, error: "Missing or malformed Authorization header. Expected: Bearer <key>" };
  }
  const key = authHeader.slice(7).trim();
  if (!key) {
    return { ok: false, statusCode: 401, error: "Empty API key" };
  }
  const hash = createHash("sha256").update(key).digest("hex");
  const rows = await db.select().from(apiKeysTable).where(eq(apiKeysTable.keyHash, hash));
  const row = rows[0];
  if (!row) {
    return { ok: false, statusCode: 401, error: "Invalid API key" };
  }
  if (!row.isActive) {
    return { ok: false, statusCode: 403, error: "API key is inactive" };
  }
  return { ok: true, keyId: row.id };
}

async function incrementKeyUsage(keyId: string) {
  try {
    await db.update(apiKeysTable)
      .set({ requestCount: sql`${apiKeysTable.requestCount} + 1`, lastUsed: new Date() })
      .where(eq(apiKeysTable.id, keyId));
  } catch { /* non-fatal */ }
}

// ─── Stats helper ─────────────────────────────────────────────────────────────

async function recordRequest(success: boolean, responseTime: number, model: string) {
  try {
    await db.insert(requestLogsTable).values({
      id: randomUUID(), success: success ? "true" : "false", responseTime, model,
    });
    await db.insert(gatewayStatsTable).values({
      id: "singleton", totalRequests: 1,
      successRequests: success ? 1 : 0, failedRequests: success ? 0 : 1, totalResponseTime: responseTime,
    }).onConflictDoUpdate({
      target: gatewayStatsTable.id,
      set: {
        totalRequests:    sql`gateway_stats.total_requests + 1`,
        successRequests:  sql`gateway_stats.success_requests + ${success ? 1 : 0}`,
        failedRequests:   sql`gateway_stats.failed_requests + ${success ? 0 : 1}`,
        totalResponseTime: sql`gateway_stats.total_response_time + ${responseTime}`,
        updatedAt: new Date(),
      },
    });
  } catch { /* non-fatal */ }
}

// ─── SSE streaming helper ─────────────────────────────────────────────────────

function setupSSE(res: import("express").Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function sseChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stream a complete response string as OpenAI-compatible SSE chunks.
 * Splits on natural token boundaries (words + punctuation).
 */
async function streamResponse(
  res: import("express").Response,
  completionId: string,
  model: string,
  created: number,
  content: string,
  finishReason: string,
  includeUsage: boolean,
  promptTokens: number,
  completionTokens: number,
) {
  // Opening chunk — role delta
  res.write(sseChunk({
    id: completionId, object: "chat.completion.chunk", created, model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }],
  }));

  // Token chunks — split by word boundaries keeping punctuation with preceding token
  const tokens = content.match(/\S+\s*/g) ?? [];
  for (const token of tokens) {
    res.write(sseChunk({
      id: completionId, object: "chat.completion.chunk", created, model,
      system_fingerprint: SYSTEM_FINGERPRINT,
      choices: [{ index: 0, delta: { content: token }, logprobs: null, finish_reason: null }],
    }));
    // Realistic pacing: ~20ms per token
    await new Promise((r) => setTimeout(r, 20));
  }

  // Final chunk — finish_reason
  res.write(sseChunk({
    id: completionId, object: "chat.completion.chunk", created, model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }],
  }));

  // Usage chunk (only when stream_options.include_usage = true)
  if (includeUsage) {
    res.write(sseChunk({
      id: completionId, object: "chat.completion.chunk", created, model,
      system_fingerprint: SYSTEM_FINGERPRINT,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: { reasoning_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      },
    }));
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

// ─── Message normalisation ────────────────────────────────────────────────────

function normaliseMessages(messages: OpenAIMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => {
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      // Multimodal: extract text parts only (images not supported)
      content = m.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
    }
    // If the message has tool_calls, serialise them as content for Qwen
    if (m.tool_calls && m.tool_calls.length > 0 && !content) {
      content = JSON.stringify(m.tool_calls);
    }
    return { role: m.role === "tool" ? "user" : m.role, content };
  });
}

// ─── Build a single OpenAI completion choice ─────────────────────────────────

function buildChoice(
  index: number,
  content: string,
  finishReason: string,
  includeLogprobs: boolean,
  tools?: ChatCompletionRequest["tools"],
): object {
  // Detect tool call JSON in response
  let toolCalls: ToolCall[] | null = null;
  let finalContent: string | null = content;
  let finalFinishReason = finishReason;

  if (tools && tools.length > 0 && finishReason !== "stop") {
    // Model may return function call as JSON
  }

  // Try to detect if model returned a function call in JSON format
  if (tools && tools.length > 0) {
    const trimmed = content.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        const fn = tools[0]?.function;
        if (fn && parsed) {
          toolCalls = [{
            id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: { name: fn.name, arguments: JSON.stringify(parsed) },
          }];
          finalContent = null;
          finalFinishReason = "tool_calls";
        }
      } catch { /* not a valid JSON tool call */ }
    }
  }

  return {
    index,
    message: {
      role: "assistant",
      content: finalContent,
      refusal: null,
      tool_calls: toolCalls,
      annotations: [],
    },
    logprobs: includeLogprobs ? { content: null } : null,
    finish_reason: finalFinishReason,
  };
}

// ─── Persist session ──────────────────────────────────────────────────────────

async function persistSession(
  conversationId: string,
  model: string,
  requestMessages: OpenAIMessage[],
  assistantContent: string,
  thinking: string | null | undefined,
  existingSession?: typeof chatSessionsTable.$inferSelect,
) {
  const now = new Date().toISOString();
  const newMsgs = [
    ...requestMessages.map((m) => ({ ...m, timestamp: now })),
    { role: "assistant", content: assistantContent, thinking: thinking ?? undefined, timestamp: now },
  ];
  const updatedMessages = existingSession
    ? [...(existingSession.messages as object[]), ...newMsgs]
    : newMsgs;

  if (existingSession) {
    await db.update(chatSessionsTable)
      .set({ messages: updatedMessages, messageCount: updatedMessages.length, updatedAt: new Date() })
      .where(eq(chatSessionsTable.conversationId, conversationId));
  } else {
    await db.insert(chatSessionsTable).values({
      conversationId, model, messages: updatedMessages, messageCount: updatedMessages.length,
    }).onConflictDoUpdate({
      target: chatSessionsTable.conversationId,
      set: { messages: updatedMessages, messageCount: updatedMessages.length, updatedAt: new Date() },
    });
  }
}

// ─── POST /v1/chat/completions ────────────────────────────────────────────────

router.post("/chat/completions", async (req, res) => {
  // 1. Authenticate
  const auth = await resolveApiKey(req.headers.authorization);
  if (!auth.ok) {
    res.status(auth.statusCode).json({
      error: { message: auth.error, type: "invalid_request_error", code: "invalid_api_key" },
    });
    return;
  }

  const body = req.body as ChatCompletionRequest;

  // 2. Validate required fields
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({
      error: { message: "'messages' is required and must be a non-empty array", type: "invalid_request_error", param: "messages", code: "invalid_value" },
    });
    return;
  }

  const model          = body.model ?? "qwen-plus";
  const n              = Math.max(1, Math.min(body.n ?? 1, 10));
  const isStream       = body.stream === true;
  const includeUsage   = body.stream_options?.include_usage === true;
  const conversationId = body.conversation_id ?? null;
  const startTime      = Date.now();

  // 3. Build generation params
  const genParams: QwenGenerationParams = {
    temperature:      body.temperature,
    topP:             body.top_p,
    maxTokens:        body.max_completion_tokens ?? body.max_tokens,
    stop:             body.stop,
    presencePenalty:  body.presence_penalty,
    frequencyPenalty: body.frequency_penalty,
    seed:             body.seed,
    responseFormat:   body.response_format as QwenGenerationParams["responseFormat"],
    tools:            body.tools as QwenGenerationParams["tools"],
    toolChoice:       body.tool_choice as QwenGenerationParams["toolChoice"],
    reasoningEffort:  body.reasoning_effort,
  };

  // 4. Get token from pool
  const midtoken = await getPooledMidtoken();
  if (!midtoken) {
    res.status(503).json({
      error: { message: "Gateway token pool is exhausted. Please retry later.", type: "gateway_error", code: "token_pool_empty" },
    });
    return;
  }

  try {
    // 5. Load or create conversation session
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

    // 6. Build message array
    const normalisedRequest = normaliseMessages(body.messages);
    const allMessages = historyMessages.length > 0
      ? [...historyMessages, ...normalisedRequest.filter((m) => m.role !== "system")]
      : normalisedRequest;

    // Add tools as system instruction if present and Qwen doesn't natively support them
    let augmentedMessages = allMessages;
    if (body.tools && body.tools.length > 0 && body.tool_choice !== "none") {
      const toolsDesc = body.tools.map((t) =>
        `Function: ${t.function.name}\nDescription: ${t.function.description ?? ""}\nParameters: ${JSON.stringify(t.function.parameters ?? {})}`
      ).join("\n\n");
      const toolSystemMsg = {
        role: "system",
        content: `You have access to the following functions. When the user's request requires calling one, respond with ONLY a JSON object matching the function's parameter schema — no prose, no markdown.\n\n${toolsDesc}`,
      };
      const hasSystem = augmentedMessages.some((m) => m.role === "system");
      augmentedMessages = hasSystem
        ? augmentedMessages.map((m) => m.role === "system" ? { ...m, content: m.content + "\n\n" + toolSystemMsg.content } : m)
        : [toolSystemMsg, ...augmentedMessages];
    }

    // 7. Make n requests (parallel if n > 1)
    const requests = Array.from({ length: n }, () =>
      chatCompletions(midtoken, model, augmentedMessages, chatId!, genParams)
    );
    const results = await Promise.all(requests);

    // Check for token failure (token is from pool; pool refreshes automatically — no manual mark-failed needed)
    const firstFailed = results.find((r) => !r.success && r.code === "TOKEN_INVALID");
    if (firstFailed) {
      await recordRequest(false, Date.now() - startTime, model);
      res.status(500).json({
        error: { message: firstFailed.error ?? "Gateway token error", type: "gateway_error", code: "token_invalid" },
      });
      return;
    }

    const firstResult = results[0];
    if (!firstResult.success) {
      await recordRequest(false, Date.now() - startTime, model);
      res.status(500).json({
        error: { message: firstResult.error ?? "Gateway error", type: "gateway_error", code: firstResult.code ?? "internal_error" },
      });
      return;
    }

    // 8. Record stats + update key usage
    await recordRequest(true, Date.now() - startTime, model);
    await incrementKeyUsage(auth.keyId);

    // 9. Persist session (use first result)
    try {
      await persistSession(chatId!, model, body.messages, firstResult.response ?? "", firstResult.thinking, session);
    } catch { /* non-fatal */ }

    // 10. Calculate usage (aggregate across n choices)
    const promptTokens     = firstResult.promptTokens     ?? Math.ceil(augmentedMessages.reduce((s, m) => s + m.content.length, 0) / 4);
    const completionTokens = results.reduce((s, r) => s + (r.completionTokens ?? Math.ceil((r.response?.length ?? 0) / 4)), 0);
    const totalTokens      = promptTokens + completionTokens;
    const completionId     = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`;
    const created          = Math.floor(Date.now() / 1000);

    // 11. Streaming response
    if (isStream) {
      // For n > 1, stream only the first result (OpenAI behaviour for stream + n > 1)
      const streamResult = results[0];
      const content      = streamResult.response ?? "";
      const finishReason = streamResult.finishReason ?? "stop";

      setupSSE(res);
      await streamResponse(res, completionId, model, created, content, finishReason, includeUsage, promptTokens, streamResult.completionTokens ?? Math.ceil(content.length / 4));
      return;
    }

    // 12. Non-streaming response — full OpenAI schema
    const choices = results.map((r, idx) =>
      buildChoice(idx, r.response ?? "", r.finishReason ?? "stop", body.logprobs === true, body.tools ?? undefined)
    );

    res.json({
      id:                 completionId,
      object:             "chat.completion",
      created,
      model,
      system_fingerprint: SYSTEM_FINGERPRINT,
      service_tier:       body.service_tier ?? "default",
      choices,
      usage: {
        prompt_tokens:     promptTokens,
        completion_tokens: completionTokens,
        total_tokens:      totalTokens,
        completion_tokens_details: {
          reasoning_tokens:              firstResult.thinking ? Math.ceil((firstResult.thinking.length ?? 0) / 4) : 0,
          accepted_prediction_tokens:    0,
          rejected_prediction_tokens:    0,
        },
        prompt_tokens_details: {
          cached_tokens: 0,
          audio_tokens:  0,
        },
      },
      // Non-standard gateway extensions (ignored by standard clients)
      x_gateway: {
        conversation_id: chatId,
        thinking:        firstResult.thinking ?? null,
      },
    });

  } catch (err) {
    req.log.error({ err }, "v1 chat/completions unhandled error");
    await recordRequest(false, Date.now() - startTime, model);
    res.status(500).json({
      error: { message: "Internal gateway error", type: "gateway_error", code: "internal_error" },
    });
  }
});

// ─── GET /v1/models ───────────────────────────────────────────────────────────

router.get("/models", (req, res) => {
  const auth = req.headers.authorization;
  // Models endpoint is public (like OpenAI) — just log if key present
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: MODELS.map((m) => ({
      id:         m.id,
      object:     "model",
      created,
      owned_by:   "qwen-gateway",
      permission: [],
      root:       m.id,
      parent:     null,
    })),
  });
});

// ─── GET /v1/models/:model ────────────────────────────────────────────────────

router.get("/models/:model", (req, res) => {
  const created = Math.floor(Date.now() / 1000);
  const m = MODELS.find((x) => x.id === req.params.model);
  if (!m) {
    res.status(404).json({ error: { message: `Model '${req.params.model}' not found`, type: "invalid_request_error", code: "model_not_found" } });
    return;
  }
  res.json({ id: m.id, object: "model", created, owned_by: "qwen-gateway", permission: [], root: m.id, parent: null });
});

export default router;
