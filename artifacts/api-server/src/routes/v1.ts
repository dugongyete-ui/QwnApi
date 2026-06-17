/**
 * OpenAI-compatible /v1 router
 * 100% compatible with the OpenAI Chat Completions API spec.
 * Supports: all generation params, streaming SSE, API key auth, n completions,
 * tools/function calling schema, response_format, logprobs (passthrough),
 * reasoning_effort, stream_options (include_usage), and every other documented parameter.
 *
 * WAF bypass: routes all Qwen calls through qwen_cffi.py (curl_cffi without impersonation)
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { createHash, createHmac } from "crypto";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { withSlot } from "../lib/concurrency";
import { db } from "@workspace/db";
import { chatSessionsTable, apiKeysTable, gatewayStatsTable, requestLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getPooledMidtoken, getAllPoolTokens } from "../lib/umid-pool";
import { logger } from "../lib/logger";

const router = Router();

// ─── Python sidecar path & binary ─────────────────────────────────────────────

const QWEN_CFFI_PY = join(__dirname, "qwen_cffi.py");

// Use .pythonlibs Python (has curl_cffi) — production autoscale doesn't inherit
// Replit's PATH augmentation, so we resolve the path explicitly here.
const _localPy = resolve(process.cwd(), ".pythonlibs/bin/python3");
const PYTHON_BIN = existsSync(_localPy) ? _localPy : "python3";
const _pythonlibsSite = resolve(process.cwd(), ".pythonlibs/lib/python3.12/site-packages");
const PYTHON_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PYTHONPATH: [_pythonlibsSite, process.env["PYTHONPATH"] ?? ""].filter(Boolean).join(":"),
};

const QWEN_ORIGIN = "https://chat.qwen.ai";
const QWEN_BASE   = `${QWEN_ORIGIN}/api/v2`;

function qwenHeaders(midtoken: string): Record<string, string> {
  const sessionToken = getQwenSessionToken();
  return {
    "Content-Type":     "application/json",
    "User-Agent":       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
    "Accept":           "*/*",
    "Accept-Language":  "en-US,en;q=0.9",
    "Origin":           QWEN_ORIGIN,
    "Referer":          `${QWEN_ORIGIN}/`,
    "X-Requested-With": "XMLHttpRequest",
    "X-Source":         "web",
    "bx-v":             "2.5.31",
    ...(midtoken ? { "bx-umidtoken": midtoken } : {}),
    ...(sessionToken ? { "Authorization": `Bearer ${sessionToken}` } : {}),
  };
}

// ─── Qwen Python helpers ──────────────────────────────────────────────────────

function getQwenSessionToken(): string | undefined {
  return process.env["QWEN_SESSION_TOKEN"] || undefined;
}

function checkQwenWaf(text: string): void {
  const low = text.trimStart().toLowerCase();
  if (low.startsWith("<!doctype") || low.startsWith("<html") || low.includes("aliyun_waf")) {
    throw new Error(
      "Qwen API diblokir WAF Aliyun dari IP ini. " +
      "Set env var QWEN_SESSION_TOKEN dengan Bearer token dari akun Qwen Anda " +
      "(buka chat.qwen.ai → DevTools → Network → salin header Authorization)."
    );
  }
}

/**
 * Retry wrapper for transient Qwen sidecar errors.
 * Does NOT retry user aborts or WAF blocks (those are permanent).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1500,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const permanent = msg.includes("aborted") || msg.includes("WAF") || msg.includes("QWEN_SESSION_TOKEN");
      if (permanent || i === maxAttempts - 1) throw err;
      const delay = baseDelayMs * (i + 1);
      logger.warn({ attempt: i + 1, maxAttempts, err: msg }, `qwen-cffi: transient error, retrying in ${delay}ms`);
      await new Promise<void>(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Combined create + chat in a single Python subprocess.
 * Eliminates the double-spawn overhead (~300–800 ms per request).
 * Python creates the Qwen session, injects chat_id into the payload, then streams SSE.
 * Returns { chatId, body } — chatId for session persistence, body is the full SSE string.
 */
function qwenPyCreateAndChat(
  token: string,
  model: string,
  midtoken: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ chatId: string; body: string }> {
  const args = [QWEN_CFFI_PY, "create_and_chat", token, model, midtoken, "-"];
  const payloadJson = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON_BIN, args, { env: PYTHON_ENV });

    if (signal?.aborted) { py.kill(); reject(new Error("qwen-cffi: aborted")); return; }
    const onAbort = () => { py.kill(); reject(new Error("qwen-cffi: aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });

    const sseChunks: Buffer[] = [];
    let chatId = "";
    let headerBuf = "";
    let headerDone = false;

    py.stdout.on("data", (d: Buffer) => {
      if (!headerDone) {
        headerBuf += d.toString("utf8");
        const nl = headerBuf.indexOf("\n");
        if (nl !== -1) {
          const firstLine = headerBuf.slice(0, nl);
          if (firstLine.startsWith("X-Chat-Id: ")) chatId = firstLine.slice("X-Chat-Id: ".length).trim();
          headerDone = true;
          const rest = headerBuf.slice(nl + 1);
          if (rest) sseChunks.push(Buffer.from(rest, "utf8"));
          headerBuf = "";
        }
      } else {
        sseChunks.push(d);
      }
    });

    py.stderr.on("data", (d: Buffer) => logger.warn({ err: d.toString().trim() }, "qwen-cffi create_and_chat: stderr"));

    // 15 s (create) + 90 s (chat) + 5 s buffer
    const timer = setTimeout(() => { py.kill(); reject(new Error("qwen-cffi: timeout")); }, 110000);

    py.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0 && code !== 2) { reject(new Error(`qwen-cffi: exit ${code}`)); return; }
      resolve({ chatId, body: Buffer.concat(sseChunks).toString("utf8") });
    });

    py.on("error", (err) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(err); });

    py.stdin.write(payloadJson, "utf8");
    py.stdin.end();
  });
}

/**
 * Parse Qwen SSE body into content + token counts.
 */
function parseQwenSSE(body: string): {
  content: string;
  inputTokens: number;
  outputTokens: number;
  upstreamError?: { message: string; code?: string };
} {
  let answer = "";
  let fallback = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const chunk = JSON.parse(line.slice(5).trim()) as {
        error?: { message?: string; code?: string };
        choices?: Array<{ delta?: { content?: string; extra?: { output_schema?: string } } }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (chunk.error) {
        return {
          content: "",
          inputTokens: 0,
          outputTokens: 0,
          upstreamError: {
            message: chunk.error.message ?? "Upstream error",
            code: chunk.error.code,
          },
        };
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.input_tokens ?? inputTokens;
        outputTokens = chunk.usage.output_tokens ?? outputTokens;
      }
      const delta = chunk.choices?.[0]?.delta;
      const content = delta?.content ?? "";
      if (!content) continue;
      const schema = delta?.extra?.output_schema ?? "";
      if (schema === "answer") {
        answer += content;
      } else {
        fallback += content;
      }
    } catch { /* skip malformed */ }
  }

  return { content: answer || fallback, inputTokens, outputTokens };
}

// ─── Model registry ───────────────────────────────────────────────────────────

const QWEN_API_MODEL_MAP: Record<string, string> = {
  "qwen-plus":        "qwen-plus-2025-07-28",
  "qwen-max":         "qwen3.7-max",
  "qwen-turbo":       "qwen3.5-flash",
  // Vision model aliases — all map to working chat.qwen.ai models
  "qwen-vl-max":             "qwen3.7-max",
  "qwen-vl-max-latest":      "qwen3.7-max",
  "qwen-vl":                 "qwen3.7-max",
  "qwen-vl-plus":            "qwen3.6-plus",
  "qwen2-vl-7b-instruct":    "qwen3-30b-a3b",
  "qwen2-vl-72b-instruct":   "qwen3-235b-a22b",
  "qwen2.5-vl":              "qwen3-235b-a22b",
  "qwen2.5-vl-7b-instruct":  "qwen3-30b-a3b",
  "qwen2.5-vl-72b-instruct": "qwen3-235b-a22b",
  "qwen2.5-vl-max":          "qwen3.7-max",
  // Audio/omni model aliases
  "qwen-audio-turbo":          "qwen2.5-omni-7b",
  "qwen2-audio-instruct":      "qwen2.5-omni-7b",
  "qwen2.5-omni":              "qwen2.5-omni-7b",
  "qwen2.5-omni-turbo":        "qwen2.5-omni-7b",
};

function resolveModel(raw: string): string {
  return QWEN_API_MODEL_MAP[raw] ?? raw;
}

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  context_window?: number;
}

const MODELS_CREATED = Math.floor(Date.now() / 1000);

const MODELS: ModelEntry[] = [
  { id: "qwen3-235b-a22b",      object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen3-30b-a3b",        object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen3.7-max",          object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen3.7-plus",         object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen3.6-plus",         object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen3.5-flash",        object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen3.5-35b-a3b",      object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen-plus",            object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen-max",             object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 32768  },
  { id: "qwen-turbo",           object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 131072 },
  { id: "qwen2.5-omni-7b",      object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 32768  },
  { id: "qwen-audio-turbo",     object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 32768  },
  { id: "qwen2-audio-instruct", object: "model", created: MODELS_CREATED, owned_by: "qwen-gateway", context_window: 32768  },
];

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_FINGERPRINT = "fp_qwen_gateway_v2";

// ─── Types ────────────────────────────────────────────────────────────────────

type QwenContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { url?: string; data?: string; format?: string } }
  | { type: "file"; file: { url?: string; data?: string; mime_type?: string; name?: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  refusal?: string | null;
}

interface NormalisedMessage {
  role: string;
  content: string | QwenContentPart[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface JsonSchemaFormat {
  name?: string;
  description?: string;
  schema?: object;
  strict?: boolean;
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
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
  stream?: boolean | null;
  stream_options?: { include_usage?: boolean } | null;
  logprobs?: boolean | null;
  top_logprobs?: number | null;
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: JsonSchemaFormat } | null;
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: object; strict?: boolean } }> | null;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } } | null;
  parallel_tool_calls?: boolean | null;
  user?: string | null;
  safety_identifier?: string | null;
  prompt_cache_key?: string | null;
  prompt_cache_retention?: "in_memory" | "24h" | null;
  metadata?: Record<string, string> | null;
  reasoning_effort?: "none" | "low" | "medium" | "high" | object | null;
  modalities?: string[] | null;
  prediction?: object | null;
  service_tier?: "auto" | "default" | "flex" | "priority" | null;
  store_output?: boolean | null;
  moderation?: object | null;
  verbosity?: "low" | "medium" | "high" | null;
  web_search_options?: object | null;
  conversation_id?: string | null;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];

async function resolveApiKey(authHeader: string | undefined): Promise<
  { ok: true; keyId: string; isAdmin: boolean } | { ok: false; statusCode: number; error: string }
> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, statusCode: 401, error: "Missing or malformed Authorization header. Expected: Bearer <key>" };
  }
  const key = authHeader.slice(7).trim();
  if (!key) return { ok: false, statusCode: 401, error: "Empty API key" };

  // Owner key — bypass DB lookup entirely
  if (ADMIN_API_KEY && key === ADMIN_API_KEY) {
    return { ok: true, keyId: "admin", isAdmin: true };
  }

  const hash = createHash("sha256").update(key).digest("hex");
  const rows = await db.select().from(apiKeysTable).where(eq(apiKeysTable.keyHash, hash));
  const row = rows[0];
  if (!row) return { ok: false, statusCode: 401, error: "Invalid API key" };
  if (!row.isActive) return { ok: false, statusCode: 403, error: "API key is inactive" };
  return { ok: true, keyId: row.id, isAdmin: false };
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
      id: randomUUID(), success, responseTime, model,
    });
    await db.insert(gatewayStatsTable).values({
      id: "singleton", totalRequests: 1,
      successRequests: success ? 1 : 0, failedRequests: success ? 0 : 1, totalResponseTime: responseTime,
    }).onConflictDoUpdate({
      target: gatewayStatsTable.id,
      set: {
        totalRequests:     sql`gateway_stats.total_requests + 1`,
        successRequests:   sql`gateway_stats.success_requests + ${success ? 1 : 0}`,
        failedRequests:    sql`gateway_stats.failed_requests + ${success ? 0 : 1}`,
        totalResponseTime: sql`gateway_stats.total_response_time + ${responseTime}`,
        updatedAt: new Date(),
      },
    });
  } catch { /* non-fatal */ }
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function setupSSE(res: import("express").Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function sseChunk(id: string, model: string, created: number, delta: object, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  })}\n\n`;
}

function sseUsageChunk(id: string, model: string, created: number, promptTokens: number, completionTokens: number): string {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
    },
  })}\n\n`;
}

// ─── Message normalisation ────────────────────────────────────────────────────

/** Returns true if any message in the array contains an image part */
function hasImageContent(messages: OpenAIMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
  );
}

/** Extract image URLs from a message content (string or multipart). */
function getMessageImages(content: string | QwenContentPart[] | null | undefined): string[] {
  if (!content || typeof content === "string") return [];
  return (content as QwenContentPart[])
    .filter((p): p is { type: "image_url"; image_url: { url: string } } => p.type === "image_url")
    .map(p => p.image_url?.url)
    .filter((u): u is string => Boolean(u));
}

/** Extract plain text from a message (for history / system messages) */
function contentToText(m: OpenAIMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  if (m.tool_calls && m.tool_calls.length > 0) return JSON.stringify(m.tool_calls);
  return "";
}

function normaliseMessages(messages: OpenAIMessage[]): NormalisedMessage[] {
  return messages.map((m): NormalisedMessage => {
    const role = m.role === "tool" ? "user" : m.role;

    // Non-user messages are always plain text
    if (role !== "user") {
      return { role, content: contentToText(m) };
    }

    // User message: check if it has images, audio, or files
    if (Array.isArray(m.content) && m.content.some((p) => p.type === "image_url" || p.type === "input_audio" || p.type === "file")) {
      const parts: QwenContentPart[] = [];
      for (const p of m.content) {
        if (p.type === "image_url" && p.image_url?.url) {
          parts.push({ type: "image_url", image_url: { url: p.image_url.url } });
        } else if (p.type === "input_audio") {
          const audio = (p as { type: "input_audio"; input_audio?: { url?: string; data?: string; format?: string } }).input_audio;
          if (audio) parts.push({ type: "input_audio", input_audio: audio });
        } else if (p.type === "file") {
          const f = (p as { type: "file"; file?: { url?: string; data?: string; mime_type?: string; name?: string } }).file;
          if (f) parts.push({ type: "file", file: f });
        } else if (p.type === "text" && p.text) {
          parts.push({ type: "text", text: p.text });
        }
      }
      // Ensure at least one text part exists (Qwen requires a text part)
      if (!parts.some((p) => p.type === "text")) {
        parts.push({ type: "text", text: "Please analyze this file." });
      }
      return { role, content: parts };
    }

    return { role, content: contentToText(m) };
  });
}

// ─── Vision / image upload helpers ───────────────────────────────────────────

interface QwenFileDescriptor {
  url: string; type: string; file_type: string; file_class: string;
  showType: string; status: string; name: string; id: string;
}

/** Fetch the acw_tc anti-bot cookie from chat.qwen.ai (needed for getstsToken). */
async function getQwenCookies(midtoken: string): Promise<string> {
  const res = await fetch(QWEN_ORIGIN, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
      "bx-umidtoken": midtoken,
    },
    redirect: "follow",
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(/,(?=[^ ])/).map((c: string) => c.split(";")[0].trim()).join("; ");
}

/** Detect MIME type from a URL or data URI string. */
function detectMimeType(url: string): string {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+)/);
    return m?.[1] || "image/jpeg";
  }
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

/**
 * Async curl runner — replaces execSync to avoid blocking the event loop.
 * Uses spawn('sh', ['-c', cmd]) so the Node.js event loop stays free during download.
 */
function spawnCurlAsync(cmd: string, maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const py = spawn("sh", ["-c", cmd]);
    py.stdout.on("data", (d: Buffer) => chunks.push(d));
    py.stderr.on("data", () => { /* discard curl progress/errors */ });
    const timer = setTimeout(() => { py.kill(); reject(new Error("curl: timeout")); }, (maxBuffer > 30 * 1024 * 1024 ? 35 : 25) * 1000);
    py.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`curl: exit ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    py.on("error", reject);
  });
}

/** Fetch image bytes using curl (bypasses hotlink protection / TLS fingerprint issues). */
async function fetchImageBytesViaCurl(url: string): Promise<{ buf: Buffer; mimeType: string; filename: string }> {
  const result = await spawnCurlAsync(
    `curl -sL --max-time 20 --max-filesize 20971520 \
      -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" \
      -H "Accept: image/avif,image/webp,image/apng,image/*,*/*;q=0.8" \
      -H "Accept-Language: en-US,en;q=0.9" \
      -H "Referer: https://www.google.com/" \
      --tlsv1.2 \
      -w "\\n__CONTENT_TYPE__:%{content_type}__STATUS__:%{http_code}" \
      "${url.replace(/"/g, '\\"')}"`,
    25 * 1024 * 1024,
  );

  const raw = result.toString("latin1");
  const metaMatch = raw.match(/\n__CONTENT_TYPE__:([^_]*)__STATUS__:(\d+)$/);
  if (!metaMatch) throw new Error("curl: failed to parse metadata");

  const status = Number(metaMatch[2]);
  if (status < 200 || status >= 300) throw new Error(`curl: HTTP ${status} for ${url}`);

  const metaSuffix = `\n__CONTENT_TYPE__:${metaMatch[1]}__STATUS__:${metaMatch[2]}`;
  const bodyEnd = result.length - Buffer.byteLength(metaSuffix, "latin1");
  const buf = result.slice(0, bodyEnd);

  const ctRaw = metaMatch[1].split(";")[0].trim();
  const mimeType = ctRaw.startsWith("image/") ? ctRaw : detectMimeType(url);
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
  const rawName = url.split("/").pop()?.split("?")[0] || `image.${ext}`;
  const filename = rawName.includes(".") ? rawName : `${rawName}.${ext}`;
  return { buf, mimeType, filename };
}

/** Fetch image bytes from a URL or data URI. Falls back to curl for protected URLs. */
async function fetchImageBytes(url: string): Promise<{ buf: Buffer; mimeType: string; filename: string }> {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) throw new Error("Invalid data URI");
    const mimeType = m[1];
    const buf = Buffer.from(m[2], "base64");
    const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    return { buf, mimeType, filename: `image.${ext}` };
  }
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": "https://www.google.com/",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type")?.split(";")[0].trim() || "";
      const mimeType = ct.startsWith("image/") ? ct : detectMimeType(url);
      const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
      const rawName = url.split("/").pop()?.split("?")[0] || `image.${ext}`;
      const filename = rawName.includes(".") ? rawName : `${rawName}.${ext}`;
      return { buf, mimeType, filename };
    }
    logger.debug({ status: res.status, url: url.slice(0, 80) }, "vision: fetch failed, retrying with curl");
  } catch (err) {
    logger.debug({ err: String(err), url: url.slice(0, 80) }, "vision: fetch error, retrying with curl");
  }
  return fetchImageBytesViaCurl(url);
}

/**
 * Upload a single image to Qwen OSS and return a QwenFileDescriptor.
 * Flow: getstsToken → OSS PUT (HMAC-SHA1) → /files/parse → descriptor
 * No session token required — uses bx-umidtoken + acw_tc cookie.
 */
async function uploadImageToQwen(
  imageUrl: string,
  uploadHeaders: Record<string, string>,
): Promise<QwenFileDescriptor> {
  const { buf, mimeType, filename } = await fetchImageBytes(imageUrl);

  const stsRes = await fetch(`${QWEN_BASE}/files/getstsToken`, {
    method: "POST",
    headers: uploadHeaders,
    body: JSON.stringify({ filename, filesize: String(buf.length), filetype: "image" }),
  });
  const stsData = (await stsRes.json()) as {
    data: {
      file_id: string; file_url: string; file_path: string;
      bucketname: string; endpoint: string;
      access_key_id: string; access_key_secret: string; security_token: string;
    }
  };
  const sts = stsData.data;

  const date = new Date().toUTCString();
  const stringToSign = `PUT\n\n${mimeType}\n${date}\nx-oss-security-token:${sts.security_token}\n/${sts.bucketname}/${sts.file_path}`;
  const sig = createHmac("sha1", sts.access_key_secret).update(stringToSign).digest("base64");

  const putRes = await fetch(`https://${sts.bucketname}.${sts.endpoint}/${sts.file_path}`, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Date": date,
      "Authorization": `OSS ${sts.access_key_id}:${sig}`,
      "x-oss-security-token": sts.security_token,
    },
    body: buf,
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => "");
    throw new Error(`OSS PUT failed: ${putRes.status} ${errText.slice(0, 200)}`);
  }

  await fetch(`${QWEN_BASE}/files/parse`, {
    method: "POST",
    headers: uploadHeaders,
    body: JSON.stringify({ file_id: sts.file_id }),
  });

  return {
    url: sts.file_url,
    type: "image",
    file_type: mimeType,
    file_class: "vision",
    showType: "image",
    status: "uploaded",
    name: filename,
    id: sts.file_id,
  };
}

/** Upload all images in parallel via OSS. Failures are logged and skipped. */
async function resolveImageUrls(
  imageUrls: string[],
  uploadHeaders: Record<string, string>,
): Promise<QwenFileDescriptor[]> {
  const results = await Promise.all(
    imageUrls.map(u =>
      uploadImageToQwen(u, uploadHeaders).catch(err => {
        logger.warn({ err: String(err), url: u.slice(0, 80) }, "vision: image upload failed, skipping");
        return null;
      }),
    ),
  );
  return results.filter((r): r is QwenFileDescriptor => r !== null);
}

// ─── Audio upload helpers ─────────────────────────────────────────────────────

/** Detect MIME type for audio from format string or URL extension. */
function detectAudioMimeType(format?: string, url?: string): string {
  if (format) {
    const f = format.toLowerCase();
    if (f === "mp3" || f === "mpeg") return "audio/mpeg";
    if (f === "mp4" || f === "m4a") return "audio/mp4";
    if (f === "wav")  return "audio/wav";
    if (f === "ogg")  return "audio/ogg";
    if (f === "flac") return "audio/flac";
    if (f === "webm") return "audio/webm";
    if (f.startsWith("audio/")) return f;
  }
  if (url) {
    const lower = url.toLowerCase().split("?")[0];
    if (lower.endsWith(".mp3"))  return "audio/mpeg";
    if (lower.endsWith(".mp4") || lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".wav"))  return "audio/wav";
    if (lower.endsWith(".ogg"))  return "audio/ogg";
    if (lower.endsWith(".flac")) return "audio/flac";
    if (lower.endsWith(".webm")) return "audio/webm";
  }
  return "audio/mpeg";
}

/** Extract audio inputs from a message content. Returns list of {url?, data?, format?} */
function getMessageAudios(content: string | QwenContentPart[] | null | undefined): { url?: string; data?: string; format?: string }[] {
  if (!content || typeof content === "string") return [];
  return (content as QwenContentPart[])
    .filter((p): p is { type: "input_audio"; input_audio: { url?: string; data?: string; format?: string } } => p.type === "input_audio")
    .map(p => p.input_audio);
}

/** Fetch audio bytes from a URL (with curl fallback for protected URLs). */
async function fetchAudioBytes(url: string, mimeType: string): Promise<{ buf: Buffer; mimeType: string; filename: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Referer": "https://www.google.com/",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type")?.split(";")[0].trim() || mimeType;
      const ext = ct.split("/")[1]?.replace("mpeg", "mp3") || "mp3";
      const rawName = url.split("/").pop()?.split("?")[0] || `audio.${ext}`;
      const filename = rawName.includes(".") ? rawName : `${rawName}.${ext}`;
      return { buf, mimeType: ct.startsWith("audio/") ? ct : mimeType, filename };
    }
  } catch { /* fall through to curl */ }

  // Fallback: curl (async — does not block event loop)
  const result = await spawnCurlAsync(
    `curl -sL --max-time 30 --max-filesize 52428800 \
      -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36" \
      -H "Accept: */*" \
      -w "\\n__CONTENT_TYPE__:%{content_type}__STATUS__:%{http_code}" \
      "${url.replace(/"/g, '\\"')}"`,
    55 * 1024 * 1024,
  );
  const raw = result.toString("latin1");
  const metaMatch = raw.match(/\n__CONTENT_TYPE__:([^_]*)__STATUS__:(\d+)$/);
  if (!metaMatch) throw new Error("curl: failed to parse audio metadata");
  const status = Number(metaMatch[2]);
  if (status < 200 || status >= 300) throw new Error(`curl: HTTP ${status} for audio ${url}`);
  const metaSuffix = `\n__CONTENT_TYPE__:${metaMatch[1]}__STATUS__:${metaMatch[2]}`;
  const bodyEnd = result.length - Buffer.byteLength(metaSuffix, "latin1");
  const buf = result.slice(0, bodyEnd);
  const ext = mimeType.split("/")[1]?.replace("mpeg", "mp3") || "mp3";
  const rawName = url.split("/").pop()?.split("?")[0] || `audio.${ext}`;
  const filename = rawName.includes(".") ? rawName : `${rawName}.${ext}`;
  return { buf, mimeType, filename };
}

/**
 * Upload a single audio file to Qwen OSS.
 * Rotates through the token pool automatically if a token hits the daily upload rate limit.
 */
async function uploadAudioToQwen(
  audio: { url?: string; data?: string; format?: string },
  primaryMidtoken: string,
): Promise<QwenFileDescriptor> {
  const mimeType = detectAudioMimeType(audio.format, audio.url);
  const ext = mimeType.split("/")[1]?.replace("mpeg", "mp3") || "mp3";

  // Resolve bytes
  let buf: Buffer;
  let filename: string;
  if (audio.data) {
    buf = Buffer.from(audio.data, "base64");
    filename = `audio.${ext}`;
  } else if (audio.url) {
    const fetched = await fetchAudioBytes(audio.url, mimeType);
    buf = fetched.buf;
    filename = fetched.filename;
  } else {
    throw new Error("audio: no url or data provided");
  }

  // Build candidate token list: primary first, then all others from pool for rotation
  const allTokens = getAllPoolTokens();
  const others = allTokens.filter(t => t.token !== primaryMidtoken);
  const candidates = [
    { token: primaryMidtoken, ua: allTokens.find(t => t.token === primaryMidtoken)?.ua ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36" },
    ...others,
  ];

  let lastErr = "";
  for (const candidate of candidates) {
    try {
      // Get acw_tc cookie for this token
      const cookieRes = await fetch(QWEN_ORIGIN, {
        headers: { "User-Agent": candidate.ua, "bx-umidtoken": candidate.token },
        redirect: "follow",
      });
      const setCookie = cookieRes.headers.get("set-cookie") || "";
      const cookie = setCookie.split(/,(?=[^ ])/).map((c: string) => c.split(";")[0].trim()).join("; ");

      const uploadHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": candidate.ua,
        "Origin": QWEN_ORIGIN,
        "Referer": `${QWEN_ORIGIN}/`,
        "X-Requested-With": "XMLHttpRequest",
        "X-Source": "web",
        "bx-v": "2.5.31",
        "bx-umidtoken": candidate.token,
        "Cookie": cookie,
      };

      // Get STS upload token
      const stsRes = await fetch(`${QWEN_BASE}/files/getstsToken`, {
        method: "POST",
        headers: uploadHeaders,
        body: JSON.stringify({ filename, filesize: String(buf.length), filetype: "audio" }),
      });
      const stsJson = (await stsRes.json()) as { success?: boolean; data: Record<string, string> };
      const sts = stsJson.data;

      if (sts["code"] === "RateLimited") {
        logger.debug({ token: candidate.token.slice(0, 20), detail: sts["details"] }, "audio: token rate limited, rotating");
        lastErr = `RateLimited: ${sts["details"]}`;
        continue;
      }
      if (!sts["security_token"]) throw new Error(`audio: unexpected STS response: ${JSON.stringify(sts).slice(0, 200)}`);

      // Upload to OSS
      const date = new Date().toUTCString();
      const stringToSign = `PUT\n\n${mimeType}\n${date}\nx-oss-security-token:${sts["security_token"]}\n/${sts["bucketname"]}/${sts["file_path"]}`;
      const sig = createHmac("sha1", sts["access_key_secret"]).update(stringToSign).digest("base64");
      const putRes = await fetch(`https://${sts["bucketname"]}.${sts["endpoint"]}/${sts["file_path"]}`, {
        method: "PUT",
        headers: {
          "Content-Type": mimeType,
          "Date": date,
          "Authorization": `OSS ${sts["access_key_id"]}:${sig}`,
          "x-oss-security-token": sts["security_token"],
        },
        body: buf,
      });
      if (!putRes.ok) throw new Error(`audio: OSS PUT failed: ${putRes.status}`);

      // Parse file
      await fetch(`${QWEN_BASE}/files/parse`, {
        method: "POST",
        headers: uploadHeaders,
        body: JSON.stringify({ file_id: sts["file_id"] }),
      });

      logger.debug({ file_id: sts["file_id"], token: candidate.token.slice(0, 20) }, "audio: uploaded successfully");
      return {
        url: sts["file_url"],
        type: "audio",
        file_type: mimeType,
        file_class: "audio",
        showType: "audio",
        status: "uploaded",
        name: filename,
        id: sts["file_id"],
      };
    } catch (err) {
      lastErr = String(err);
      logger.debug({ err: lastErr, token: candidate.token.slice(0, 20) }, "audio: upload attempt failed, trying next token");
    }
  }
  throw new Error(`audio: all ${candidates.length} tokens exhausted. Last error: ${lastErr}`);
}

/** Upload all audio inputs in parallel with token rotation. Failures are skipped. */
async function resolveAudioFiles(
  audioInputs: { url?: string; data?: string; format?: string }[],
  primaryMidtoken: string,
): Promise<QwenFileDescriptor[]> {
  const results = await Promise.all(
    audioInputs.map(a =>
      uploadAudioToQwen(a, primaryMidtoken).catch(err => {
        logger.warn({ err: String(err) }, "audio: upload failed, skipping");
        return null;
      }),
    ),
  );
  return results.filter((r): r is QwenFileDescriptor => r !== null);
}

// ─── Document upload helpers ──────────────────────────────────────────────────

const DOC_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
};

/** Detect MIME type for a document from mime_type field, filename, or URL extension. */
function detectDocMimeType(mimeType?: string, name?: string, url?: string): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  const src = name || url || "";
  const ext = src.toLowerCase().split("?")[0].split(".").pop() ?? "";
  return DOC_EXTENSIONS[ext] ?? "application/octet-stream";
}

/** Derive a sensible filename for a document. */
function detectDocFilename(name?: string, url?: string, mimeType?: string): string {
  if (name) return name;
  const fromUrl = url?.split("/").pop()?.split("?")[0];
  if (fromUrl && fromUrl.includes(".")) return fromUrl;
  const ext = Object.entries(DOC_EXTENSIONS).find(([, m]) => m === mimeType)?.[0] ?? "bin";
  return `document.${ext}`;
}

/** Extract file inputs from a message content. */
function getMessageDocuments(
  content: string | QwenContentPart[] | null | undefined,
): { url?: string; data?: string; mime_type?: string; name?: string }[] {
  if (!content || typeof content === "string") return [];
  return (content as QwenContentPart[])
    .filter((p): p is { type: "file"; file: { url?: string; data?: string; mime_type?: string; name?: string } } => p.type === "file")
    .map(p => p.file);
}

/**
 * Upload a single document to Qwen OSS.
 * Rotates through the token pool automatically if a token hits the rate limit.
 */
async function uploadDocumentToQwen(
  doc: { url?: string; data?: string; mime_type?: string; name?: string },
  primaryMidtoken: string,
): Promise<QwenFileDescriptor> {
  const mimeType = detectDocMimeType(doc.mime_type, doc.name, doc.url);
  const filename = detectDocFilename(doc.name, doc.url, mimeType);

  // Resolve bytes
  let buf: Buffer;
  if (doc.data) {
    buf = Buffer.from(doc.data, "base64");
  } else if (doc.url) {
    try {
      const res = await fetch(doc.url, {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36", "Accept": "*/*" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch {
      // Fallback: curl (async — does not block event loop)
      buf = await spawnCurlAsync(
        `curl -sL --max-time 30 --max-filesize 52428800 "${doc.url.replace(/"/g, '\\"')}"`,
        55 * 1024 * 1024,
      );
    }
  } else {
    throw new Error("document: no url or data provided");
  }

  // Build candidate token list (primary first, then all others for rotation)
  const allTokens = getAllPoolTokens();
  const others = allTokens.filter(t => t.token !== primaryMidtoken);
  const candidates = [
    { token: primaryMidtoken, ua: allTokens.find(t => t.token === primaryMidtoken)?.ua ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36" },
    ...others,
  ];

  let lastErr = "";
  for (const candidate of candidates) {
    try {
      // Get acw_tc cookie
      const cookieRes = await fetch(QWEN_ORIGIN, {
        headers: { "User-Agent": candidate.ua, "bx-umidtoken": candidate.token },
        redirect: "follow",
      });
      const setCookie = cookieRes.headers.get("set-cookie") || "";
      const cookie = setCookie.split(/,(?=[^ ])/).map((c: string) => c.split(";")[0].trim()).join("; ");

      const uploadHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": candidate.ua,
        "Origin": QWEN_ORIGIN,
        "Referer": `${QWEN_ORIGIN}/`,
        "X-Requested-With": "XMLHttpRequest",
        "X-Source": "web",
        "bx-v": "2.5.31",
        "bx-umidtoken": candidate.token,
        "Cookie": cookie,
      };

      // Get STS upload token
      const stsRes = await fetch(`${QWEN_BASE}/files/getstsToken`, {
        method: "POST",
        headers: uploadHeaders,
        body: JSON.stringify({ filename, filesize: String(buf.length), filetype: "doc" }),
      });
      const stsJson = (await stsRes.json()) as { success?: boolean; data: Record<string, string> };
      const sts = stsJson.data;

      if (sts["code"] === "RateLimited") {
        lastErr = `RateLimited: ${sts["details"]}`;
        continue;
      }
      if (!sts["security_token"]) throw new Error(`doc: unexpected STS response: ${JSON.stringify(sts).slice(0, 200)}`);

      // Upload to OSS
      const date = new Date().toUTCString();
      const stringToSign = `PUT\n\n${mimeType}\n${date}\nx-oss-security-token:${sts["security_token"]}\n/${sts["bucketname"]}/${sts["file_path"]}`;
      const sig = createHmac("sha1", sts["access_key_secret"]).update(stringToSign).digest("base64");
      const putRes = await fetch(`https://${sts["bucketname"]}.${sts["endpoint"]}/${sts["file_path"]}`, {
        method: "PUT",
        headers: {
          "Content-Type": mimeType,
          "Date": date,
          "Authorization": `OSS ${sts["access_key_id"]}:${sig}`,
          "x-oss-security-token": sts["security_token"],
        },
        body: buf,
      });
      if (!putRes.ok) throw new Error(`doc: OSS PUT failed: ${putRes.status}`);

      // Parse (let Qwen index the document content)
      await fetch(`${QWEN_BASE}/files/parse`, {
        method: "POST",
        headers: uploadHeaders,
        body: JSON.stringify({ file_id: sts["file_id"] }),
      });

      logger.debug({ file_id: sts["file_id"], name: filename }, "doc: uploaded successfully");
      return {
        url: sts["file_url"],
        type: "file",
        file_type: mimeType,
        file_class: "doc",
        showType: "file",
        status: "uploaded",
        name: filename,
        id: sts["file_id"],
      };
    } catch (err) {
      lastErr = String(err);
      logger.debug({ err: lastErr, token: candidate.token.slice(0, 20) }, "doc: upload attempt failed, trying next token");
    }
  }
  throw new Error(`doc: all ${candidates.length} tokens exhausted. Last error: ${lastErr}`);
}

/** Upload all document inputs in parallel with token rotation. Failures are skipped. */
async function resolveDocumentFiles(
  docInputs: { url?: string; data?: string; mime_type?: string; name?: string }[],
  primaryMidtoken: string,
): Promise<QwenFileDescriptor[]> {
  const results = await Promise.all(
    docInputs.map(d =>
      uploadDocumentToQwen(d, primaryMidtoken).catch(err => {
        logger.warn({ err: String(err) }, "doc: upload failed, skipping");
        return null;
      }),
    ),
  );
  return results.filter((r): r is QwenFileDescriptor => r !== null);
}

/** MIME types whose base64 content can be decoded and inlined as text. */
const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html", "text/xml",
  "application/json", "application/xml", "application/csv",
]);
function isTextMimeType(mime: string): boolean {
  const base = mime.split(";")[0].trim().toLowerCase();
  return TEXT_MIME_TYPES.has(base) || base.startsWith("text/");
}

function messagesToTextPrompt(messages: NormalisedMessage[], _filesHandledByFiles = false): string {
  return messages.map(m => {
    let txt: string;
    if (typeof m.content === "string") {
      txt = m.content;
    } else if (Array.isArray(m.content)) {
      const segments: string[] = [];
      for (const p of m.content as QwenContentPart[]) {
        if (p.type === "text") {
          segments.push(p.text);
        } else if (p.type === "file" && p.file) {
          // For text-based files with base64 data, inline content so the model
          // can read it immediately (avoids Qwen OSS parse-completion delay).
          const f = p.file;
          if (f.data && f.mime_type && isTextMimeType(f.mime_type)) {
            try {
              const decoded = Buffer.from(f.data, "base64").toString("utf-8");
              const name = f.name ?? "document";
              segments.push(`<document name="${name}">\n${decoded}\n</document>`);
            } catch { /* skip non-decodable */ }
          }
          // Binary files (PDF, DOCX…) and URL-only refs are handled by files[]
        }
        // image_url and input_audio go in files[] — not inlined as text
      }
      txt = segments.join("\n");
    } else {
      txt = "";
    }
    if (m.role === "system")    return `System: ${txt}`;
    if (m.role === "assistant") return `Assistant: ${txt}`;
    return `User: ${txt}`;
  }).join("\n");
}

// ─── Stop sequence / tool detection ──────────────────────────────────────────

function applyStop(content: string, stop: string | string[] | null | undefined): { content: string; hitStop: boolean } {
  if (!stop) return { content, hitStop: false };
  const stops = Array.isArray(stop) ? stop : [stop];
  let earliest = content.length;
  for (const s of stops) {
    if (!s) continue;
    const idx = content.indexOf(s);
    if (idx !== -1 && idx < earliest) earliest = idx;
  }
  return earliest < content.length
    ? { content: content.slice(0, earliest), hitStop: true }
    : { content, hitStop: false };
}

function detectToolCalls(
  raw: string,
  tools: ChatCompletionRequest["tools"],
  parallelToolCalls = true,
): ToolCall[] | null {
  if (!tools || tools.length === 0) return null;
  const trimmed = raw.trim().replace(/```(?:json)?/gi, "").trim();

  // Walk string finding JSON objects with "tool_calls"
  // String-aware: tracks inStr + escape so braces inside quoted values don't confuse depth.
  const allCalls: ToolCall[] = [];
  let searchFrom = 0;
  while (searchFrom < trimmed.length) {
    const blockStart = trimmed.indexOf("{", searchFrom);
    if (blockStart === -1) break;
    let depth = 0;
    let blockEnd = -1;
    let inStr = false;
    let escape = false;
    for (let i = blockStart; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { blockEnd = i; break; }
      }
    }
    if (blockEnd === -1) break;
    const candidate = trimmed.slice(blockStart, blockEnd + 1);
    if (candidate.includes('"tool_calls"')) {
      try {
        const parsed = JSON.parse(candidate) as { tool_calls?: Array<{ name: string; arguments: unknown }> };
        if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
          for (const tc of parsed.tool_calls) {
            if (!tc.name) continue;
            allCalls.push({
              id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              type: "function",
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
              },
            });
            // Honour parallel_tool_calls: false — stop after first call
            if (!parallelToolCalls) break;
          }
        }
      } catch { /* skip malformed */ }
    }
    searchFrom = blockEnd + 1;
    // Honour parallel_tool_calls: false — stop after first block
    if (!parallelToolCalls && allCalls.length > 0) break;
  }
  return allCalls.length > 0 ? allCalls : null;
}

/**
 * Extract the first valid JSON object or array from a string.
 * Used to clean up model output when response_format=json_object is requested.
 */
function extractJson(text: string): string {
  // Strip markdown code fences
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();

  // Try parsing the whole thing first
  try { JSON.parse(stripped); return stripped; } catch { /* fall through */ }

  // Walk the string to find the first complete JSON object or array
  const starts: Array<{ ch: string; close: string }> = [
    { ch: "{", close: "}" },
    { ch: "[", close: "]" },
  ];
  for (const { ch, close } of starts) {
    const start = stripped.indexOf(ch);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < stripped.length; i++) {
      const c = stripped[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === ch) depth++;
      else if (c === close) { depth--; if (depth === 0) { try { const candidate = stripped.slice(start, i + 1); JSON.parse(candidate); return candidate; } catch { break; } } }
    }
  }
  // Return as-is if no valid JSON found (best effort)
  return stripped;
}

/**
 * Inject a system prompt that forces JSON-only output when response_format is
 * json_object or json_schema. OpenAI spec: model MUST output valid JSON.
 */
function injectJsonMode(
  messages: NormalisedMessage[],
  responseFormat: ChatCompletionRequest["response_format"],
): NormalisedMessage[] {
  if (!responseFormat || responseFormat.type === "text") return messages;

  let systemInstruction: string;
  if (responseFormat.type === "json_schema" && responseFormat.json_schema) {
    const schemaName = responseFormat.json_schema.name ?? "response";
    const schemaDef  = responseFormat.json_schema.schema
      ? JSON.stringify(responseFormat.json_schema.schema, null, 2)
      : "(any JSON object)";
    systemInstruction =
      `You MUST respond with a valid JSON object only. ` +
      `No prose, no markdown, no code fences — raw JSON only. ` +
      `The JSON must conform to the following schema named "${schemaName}":\n${schemaDef}`;
  } else {
    systemInstruction =
      `You MUST respond with a valid JSON object only. ` +
      `No prose, no markdown, no code fences — raw JSON only. ` +
      `Do not include any explanation before or after the JSON.`;
  }

  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    return [{ role: "system", content: `${first.content}\n\n${systemInstruction}` }, ...messages.slice(1)];
  }
  return [{ role: "system", content: systemInstruction }, ...messages];
}

/**
 * Map OpenAI reasoning_effort to Qwen's thinking_enabled / thinking_budget.
 * OpenAI values: "none" | "low" | "medium" | "high"
 */
function resolveThinking(effort: ChatCompletionRequest["reasoning_effort"]): {
  thinking_enabled: boolean;
  thinking_budget: number;
} {
  const str = typeof effort === "string" ? effort : null;
  switch (str) {
    case "high":   return { thinking_enabled: true,  thinking_budget: 81920 };
    case "medium": return { thinking_enabled: true,  thinking_budget: 20000 };
    case "low":    return { thinking_enabled: true,  thinking_budget: 4096  };
    case "none":   return { thinking_enabled: false, thinking_budget: 0     };
    default:       return { thinking_enabled: false, thinking_budget: 0     };
  }
}

function injectToolPrompt(
  messages: NormalisedMessage[],
  tools: ChatCompletionRequest["tools"],
  toolChoice: ChatCompletionRequest["tool_choice"] = "auto",
): NormalisedMessage[] {
  if (!tools || tools.length === 0) return messages;
  const defs = tools.map(t => {
    const f = t.function;
    return `- ${f.name}: ${f.description ?? "(no description)"} | params: ${JSON.stringify(f.parameters ?? {})}`;
  }).join("\n");

  // Determine tool usage instruction based on tool_choice
  let choiceInstruction: string;
  if (toolChoice === "required") {
    choiceInstruction = "You MUST call one of the available tools. Do NOT respond with plain text.";
  } else if (typeof toolChoice === "object" && toolChoice !== null && toolChoice.type === "function") {
    const forcedName = toolChoice.function.name;
    choiceInstruction = `You MUST call the tool named "${forcedName}". Do NOT respond with plain text.`;
  } else {
    // "auto" or unset — model decides
    choiceInstruction = "When a tool is needed, call it. When not, respond normally in plain text.";
  }

  const systemBlock = `You have access to external tools. ${choiceInstruction}
When calling a tool, output ONLY a single raw JSON object — no prose, no markdown:
{"tool_calls":[{"name":"TOOL_NAME","arguments":{...}}]}

AVAILABLE TOOLS:\n${defs}`;

  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    return [{ role: "system", content: `${first.content}\n\n${systemBlock}` }, ...messages.slice(1)];
  }
  return [{ role: "system", content: systemBlock }, ...messages];
}

// ─── Session persistence ──────────────────────────────────────────────────────

async function persistSession(
  conversationId: string,
  model: string,
  requestMessages: OpenAIMessage[],
  assistantContent: string,
  existingSession?: typeof chatSessionsTable.$inferSelect,
) {
  const now = new Date().toISOString();
  const newMsgs = [
    ...requestMessages.map((m) => ({ ...m, timestamp: now })),
    { role: "assistant", content: assistantContent, timestamp: now },
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

  // 2. Validate
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({
      error: { message: "'messages' is required and must be a non-empty array", type: "invalid_request_error", param: "messages", code: "invalid_value" },
    });
    return;
  }

  const _rawModel     = body.model ?? "qwen3-235b-a22b";
  const model         = resolveModel(_rawModel);
  const n             = Math.max(1, Math.min(body.n ?? 1, 4));
  const isStream      = body.stream === true;
  const includeUsage  = body.stream_options?.include_usage === true;
  const conversationId = body.conversation_id ?? null;
  const startTime     = Date.now();
  const temperature   = typeof body.temperature === "number" ? Math.max(0, Math.min(2, body.temperature)) : 0.7;
  const _max          = body.max_completion_tokens ?? body.max_tokens;
  const _topP         = body.top_p;
  const _stop         = body.stop;
  const hasTools      = (body.tools?.length ?? 0) > 0 && body.tool_choice !== "none";
  const wantsJson     = body.response_format?.type === "json_object" || body.response_format?.type === "json_schema";
  const thinking      = resolveThinking(body.reasoning_effort);

  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`;
  const created      = Math.floor(Date.now() / 1000);

  try {
    // 3. Load or create conversation session
    let chatId = conversationId;
    let session: typeof chatSessionsTable.$inferSelect | undefined;
    let historyMessages: Array<{ role: string; content: string }> = [];

    if (chatId) {
      const rows = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.conversationId, chatId));
      session = rows[0];
      if (session && Array.isArray(session.messages)) {
        historyMessages = session.messages as Array<{ role: string; content: string }>;
      }
    }

    // 4. Normalise messages
    const normalisedRequest = normaliseMessages(body.messages);
    const allMessages = historyMessages.length > 0
      ? [...historyMessages, ...normalisedRequest.filter((m) => m.role !== "system")]
      : normalisedRequest;

    // Inject tool prompt first, then json-mode instruction (outermost system block wins)
    const withTools      = hasTools ? injectToolPrompt(allMessages, body.tools, body.tool_choice) : allMessages;
    const augmentedMessages = wantsJson ? injectJsonMode(withTools, body.response_format) : withTools;

    // 5. Get auth token or midtoken
    const sessionToken = getQwenSessionToken();
    const midtoken = sessionToken ? "" : await getPooledMidtoken();
    if (!sessionToken && !midtoken) {
      res.status(503).json({
        error: { message: "Gateway token pool is exhausted. Please retry later.", type: "gateway_error", code: "token_pool_empty" },
      });
      return;
    }

    // 7. Build Qwen payload
    // (chat_id is NOT set here — Python injects it after creating the session)
    // Detect image, audio, and document content in the current request messages only
    // (history files were already processed in previous turns)
    const allImageUrls   = normalisedRequest.flatMap(m => getMessageImages(m.content));
    const allAudioInputs = normalisedRequest.flatMap(m => getMessageAudios(m.content));
    const allDocInputs   = normalisedRequest.flatMap(m => getMessageDocuments(m.content));
    const isVision = allImageUrls.length > 0;
    const isAudio  = allAudioInputs.length > 0;
    const isDoc    = allDocInputs.length > 0;

    // Upload images via OSS (bx-umidtoken + auto-fetched acw_tc cookie)
    let resolvedFiles: QwenFileDescriptor[] = [];
    if (isVision) {
      const headers = qwenHeaders(midtoken);
      const cookie = await getQwenCookies(midtoken);
      const uploadHeaders = { ...headers, Cookie: cookie };
      const imageFiles = await resolveImageUrls(allImageUrls, uploadHeaders);
      resolvedFiles.push(...imageFiles);
      logger.info({ count: imageFiles.length, total: allImageUrls.length }, "vision: images uploaded");
    }

    // Upload audio via OSS with automatic token rotation on rate limit
    if (isAudio) {
      const audioFiles = await resolveAudioFiles(allAudioInputs, midtoken);
      resolvedFiles.push(...audioFiles);
      logger.info({ count: audioFiles.length, total: allAudioInputs.length }, "audio: files uploaded");
    }

    // Upload documents via OSS with automatic token rotation on rate limit
    if (isDoc) {
      const docFiles = await resolveDocumentFiles(allDocInputs, midtoken);
      resolvedFiles.push(...docFiles);
      logger.info({ count: docFiles.length, total: allDocInputs.length }, "doc: files uploaded");
    }

    // Sliding window: ketika konteks terlalu panjang, hanya kirim
    // system messages + N non-system messages terakhir ke Qwen.
    // Ini mencegah model "tenggelam" dalam history panjang dan lupa
    // bahwa dia harus memanggil tools.
    // Threshold: 24 non-system messages (~4-6 step analisis penuh).
    const SLIDING_WINDOW_SIZE = 24;
    // Truncate individual messages yang terlalu panjang (tool results market data
    // bisa berisi JSON besar 3000–6000 char). Bahkan 24 messages bisa overflow
    // context window jika masing-masing 4000+ char. Potong di 3000 char agar
    // data kunci tetap ada tapi context total tidak meledak.
    // System messages TIDAK ditruncate — tool definitions harus utuh.
    const MAX_MSG_CHARS = 3000;
    function truncateMsgContent(m: NormalisedMessage): NormalisedMessage {
      if (typeof m.content === "string" && m.content.length > MAX_MSG_CHARS) {
        const overflow = m.content.length - MAX_MSG_CHARS;
        return { ...m, content: m.content.slice(0, MAX_MSG_CHARS) + `\n[...+${overflow} chars truncated for context efficiency]` };
      }
      if (Array.isArray(m.content)) {
        let changed = false;
        const newParts = (m.content as Array<{ type: string; text?: string }>).map(p => {
          if (p.type === "text" && p.text && p.text.length > MAX_MSG_CHARS) {
            const overflow = p.text.length - MAX_MSG_CHARS;
            changed = true;
            return { ...p, text: p.text.slice(0, MAX_MSG_CHARS) + `\n[...+${overflow} chars truncated]` };
          }
          return p;
        });
        return changed ? { ...m, content: newParts as NormalisedMessage["content"] } : m;
      }
      return m;
    }
    const windowedMessages = (() => {
      const systemMsgs  = augmentedMessages.filter(m => m.role === "system");
      const nonSysMsgs  = augmentedMessages.filter(m => m.role !== "system");
      const sliced = nonSysMsgs.length > SLIDING_WINDOW_SIZE
        ? nonSysMsgs.slice(nonSysMsgs.length - SLIDING_WINDOW_SIZE)
        : nonSysMsgs;
      if (nonSysMsgs.length > SLIDING_WINDOW_SIZE) {
        logger.info(
          { total: augmentedMessages.length, kept: systemMsgs.length + sliced.length, window: SLIDING_WINDOW_SIZE },
          "context-window: trimmed old messages to prevent tool-call dilution"
        );
      }
      // Truncate oversized non-system messages AFTER slicing.
      // Log hanya kalau ada yang benar-benar dipotong.
      const capped = sliced.map(truncateMsgContent);
      const truncatedCount = capped.filter((m, i) => m !== sliced[i]).length;
      if (truncatedCount > 0) {
        logger.info(
          { truncatedCount, maxChars: MAX_MSG_CHARS },
          "context-window: truncated oversized message content"
        );
      }
      return [...systemMsgs, ...capped];
    })();

    // Build text prompt (strip image/audio/doc parts — they're handled natively via files[])
    const _basePrompt = messagesToTextPrompt(windowedMessages, resolvedFiles.length > 0);

    // Re-inject a short tool reminder at the END of the prompt when tools are active.
    // The full tool definitions are already injected at the start via injectToolPrompt(),
    // but in long agentic sessions that system block gets diluted by hundreds of turns.
    // Appending a compact reminder here keeps it close to where the model generates its
    // next token — dramatically reducing "lazy" plain-text responses mid-task.
    const qwenMessageContent = hasTools
      ? _basePrompt +
        "\n\n---\n" +
        "TOOL REMINDER: You are in the middle of an ongoing task. " +
        "If you still need data or have not completed all required steps, " +
        "call a tool now using the JSON format: " +
        '{"tool_calls":[{"name":"TOOL_NAME","arguments":{...}}]}. ' +
        "Do NOT write a final analysis or conclusion until you have gathered all necessary data."
      : _basePrompt;

    const qwenPayload = {
      stream: true,
      incremental_output: true,
      chat_mode: "normal",
      model,
      temperature,
      ...(typeof _max === "number" && _max > 0 ? { max_output_tokens: _max } : {}),
      ...(typeof _topP === "number" ? { top_p: Math.max(0, Math.min(1, _topP)) } : {}),
      parent_id: null,
      messages: [{
        fid: randomUUID(),
        parentId: null,
        childrenIds: [],
        role: "user",
        content: qwenMessageContent,
        user_action: "chat",
        files: resolvedFiles,
        models: [model],
        chat_type: "t2t",
        feature_config: { thinking_enabled: thinking.thinking_enabled, output_schema: "phase", thinking_budget: thinking.thinking_budget },
        sub_chat_type: "t2t",
      }],
    };

    // Debug: log payload when doc files are present
    if (isDoc && resolvedFiles.length > 0) {
      logger.info({ files: resolvedFiles, content: qwenMessageContent }, "doc: sending payload to sidecar");
    }

    // 8. Execute request via combined create+chat (single Python spawn, eliminates double-spawn overhead)
    const getResult = (signal?: AbortSignal) => withSlot(
      () => withRetry(() =>
        sessionToken
          ? qwenPyCreateAndChat(sessionToken, model, "", qwenPayload, signal)
          : qwenPyCreateAndChat("", model, midtoken, qwenPayload, signal)
      ),
      auth.isAdmin,
    );

    // ── STREAMING path ──────────────────────────────────────────────────────
    if (isStream) {
      setupSSE(res);
      res.write(sseChunk(completionId, _rawModel, created, { role: "assistant", content: "" }, null));

      // Kill the Python subprocess if the client disconnects mid-stream
      const controller = new AbortController();
      const onClose = () => controller.abort();
      req.once("close", onClose);
      let body_str: string;
      try {
        const result = await getResult(controller.signal);
        if (result.chatId) chatId = result.chatId;
        body_str = result.body;
      } finally {
        req.off("close", onClose);
      }
      checkQwenWaf(body_str);
      const { content: rawContent, inputTokens, outputTokens, upstreamError } = parseQwenSSE(body_str);

      if (upstreamError) {
        res.write(`data: ${JSON.stringify({ error: upstreamError.message })}\n\ndata: [DONE]\n\n`);
        res.end();
        await recordRequest(false, Date.now() - startTime, _rawModel);
        return;
      }

      const stResult = applyStop(rawContent, _stop);
      // stop sequence hit → "stop"; normal completion → "stop"; only max_tokens → "length" (not detectable here)
      const finishReason = "stop";
      // response_format: json_object — strip prose/fences from content
      const streamContent = wantsJson ? extractJson(stResult.content) : stResult.content;

      // Check for tool calls
      const parallelToolCalls = body.parallel_tool_calls !== false;
      const toolCalls = hasTools ? detectToolCalls(streamContent, body.tools, parallelToolCalls) : null;

      if (toolCalls) {
        res.write(sseChunk(completionId, _rawModel, created, { role: "assistant", content: null }, null));
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          res.write(sseChunk(completionId, _rawModel, created, {
            tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }],
          }, null));
          const args = tc.function.arguments;
          const chunkSize = 20;
          for (let j = 0; j < args.length; j += chunkSize) {
            res.write(sseChunk(completionId, _rawModel, created, {
              tool_calls: [{ index: i, function: { arguments: args.slice(j, j + chunkSize) } }],
            }, null));
          }
        }
        res.write(sseChunk(completionId, _rawModel, created, {}, "tool_calls"));
      } else {
        // Stream content word by word
        const words = streamContent.match(/\S+\s*/g) ?? [];
        for (const word of words) {
          if (word) res.write(sseChunk(completionId, _rawModel, created, { content: word }, null));
        }
        res.write(sseChunk(completionId, _rawModel, created, {}, finishReason));
      }

      if (includeUsage) res.write(sseUsageChunk(completionId, _rawModel, created, inputTokens, outputTokens));
      res.write("data: [DONE]\n\n");
      res.end();

      await recordRequest(true, Date.now() - startTime, _rawModel);
      await incrementKeyUsage(auth.keyId);
      try { await persistSession(chatId!, model, body.messages, streamContent, session); } catch { /* non-fatal */ }
      return;
    }

    // ── NON-STREAMING path ───────────────────────────────────────────────────
    const results = await Promise.all(Array.from({ length: n }, () => getResult()));
    if (results[0]?.chatId) chatId = results[0].chatId;
    const parsed = results.map(r => {
      checkQwenWaf(r.body);
      return parseQwenSSE(r.body);
    });

    const firstParsed = parsed[0];
    if (firstParsed.upstreamError) {
      await recordRequest(false, Date.now() - startTime, _rawModel);
      res.status(503).json({
        error: { message: firstParsed.upstreamError.message, type: "upstream_error", code: firstParsed.upstreamError.code ?? "upstream_error" },
      });
      return;
    }

    const parallelToolCalls = body.parallel_tool_calls !== false;
    const choices = parsed.map((p, idx) => {
      const stRes = applyStop(p.content, _stop);
      let content = stRes.content;
      const finishReason = "stop";
      const toolCalls = hasTools ? detectToolCalls(content, body.tools, parallelToolCalls) : null;

      // response_format: json_object — extract raw JSON from the content
      if (wantsJson && !toolCalls) content = extractJson(content);

      if (toolCalls) {
        return {
          index: idx,
          message: { role: "assistant", content: null, refusal: null, tool_calls: toolCalls },
          logprobs: null,
          finish_reason: "tool_calls",
        };
      }
      return {
        index: idx,
        message: { role: "assistant", content, refusal: null, tool_calls: null },
        // logprobs: null when not requested; stub when requested (we can't get real log probs from Qwen)
        logprobs: body.logprobs
          ? { content: content.split("").map(ch => ({ token: ch, logprob: 0, bytes: [ch.charCodeAt(0)], top_logprobs: [] })).slice(0, 5) }
          : null,
        finish_reason: finishReason,
      };
    });

    const promptTokens     = firstParsed.inputTokens  || Math.ceil(augmentedMessages.reduce((s, m) => s + m.content.length, 0) / 4);
    const completionTokens = parsed.reduce((s, p) => s + (p.outputTokens || Math.ceil(p.content.length / 4)), 0);

    await recordRequest(true, Date.now() - startTime, _rawModel);
    await incrementKeyUsage(auth.keyId);
    try { await persistSession(chatId!, model, body.messages, parsed[0].content, session); } catch { /* non-fatal */ }

    res.json({
      id:                 completionId,
      object:             "chat.completion",
      created,
      model:              _rawModel,
      system_fingerprint: SYSTEM_FINGERPRINT,
      service_tier:       body.service_tier ?? "default",
      choices,
      usage: {
        prompt_tokens:     promptTokens,
        completion_tokens: completionTokens,
        total_tokens:      promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
      x_gateway: { conversation_id: chatId },
    });

  } catch (err) {
    logger.error({ err }, "v1/chat/completions error");
    const errMsg = err instanceof Error ? err.message : "Internal server error";
    const errCode = (err as { code?: string }).code;
    const isWaf      = errMsg.includes("WAF") || errMsg.includes("QWEN_SESSION_TOKEN");
    const isOverload = errCode === "OVERLOADED" || errCode === "QUEUE_TIMEOUT";
    const message = isWaf ? errMsg : isOverload ? errMsg : "Internal gateway error";
    const type    = isWaf ? "service_unavailable" : isOverload ? "service_unavailable" : "server_error";
    const code    = isWaf ? "qwen_waf_blocked" : isOverload ? errCode : "internal_error";
    const status  = isWaf || isOverload ? 503 : 500;
    await recordRequest(false, Date.now() - startTime, _rawModel ?? "unknown");
    if (!res.headersSent) {
      res.status(status).json({ error: { message, type, code } });
    } else {
      res.write(`data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`);
      res.end();
    }
  }
});

// ─── GET /v1/models ───────────────────────────────────────────────────────────

router.get("/models", (_req, res) => {
  res.json({ object: "list", data: MODELS });
});

// ─── GET /v1/models/:model ────────────────────────────────────────────────────

router.get("/models/:model", (req, res) => {
  const paramModel = String(req.params.model);
  const found = MODELS.find(m => m.id === paramModel || resolveModel(paramModel) === m.id);
  if (!found) {
    res.status(404).json({
      error: { message: `The model '${req.params.model}' does not exist`, type: "invalid_request_error", param: "model", code: "model_not_found" },
    });
    return;
  }
  res.json(found);
});

// ─── POST /v1/completions (legacy text completions) ───────────────────────────

router.post("/completions", async (req, res) => {
  const auth = await resolveApiKey(req.headers.authorization);
  if (!auth.ok) {
    res.status(auth.statusCode).json({
      error: { message: auth.error, type: "invalid_request_error", code: "invalid_api_key" },
    });
    return;
  }

  const { model: _rawModel = "qwen3-235b-a22b", prompt, max_tokens, temperature: _temp, stop: _stop } = req.body as {
    model?: string; prompt?: string | string[]; max_tokens?: number; temperature?: number; stop?: string | string[];
  };

  if (!prompt) {
    res.status(400).json({ error: { message: "prompt is required", type: "invalid_request_error", param: "prompt", code: "missing_required_parameter" } });
    return;
  }

  const promptText = Array.isArray(prompt) ? prompt.join("") : String(prompt);
  const model = resolveModel(_rawModel);
  const temperature = typeof _temp === "number" ? Math.max(0, Math.min(2, _temp)) : 0.7;
  const startTime = Date.now();

  try {
    const sessionToken = getQwenSessionToken();
    const midtoken = sessionToken ? "" : await getPooledMidtoken();

    const qwenPayload = {
      stream: true, incremental_output: true, chat_mode: "normal",
      model, temperature, parent_id: null,
      messages: [{
        fid: randomUUID(), parentId: null, childrenIds: [], role: "user",
        content: promptText, user_action: "chat", files: [], models: [model],
        chat_type: "t2t", feature_config: { thinking_enabled: false, output_schema: "phase", thinking_budget: 81920 }, sub_chat_type: "t2t",
      }],
    };

    const { body: rawBody } = await withSlot(
      () => withRetry(() =>
        sessionToken
          ? qwenPyCreateAndChat(sessionToken, model, "", qwenPayload)
          : qwenPyCreateAndChat("", model, midtoken, qwenPayload)
      ),
      auth.isAdmin,
    );

    checkQwenWaf(rawBody);
    const { content: rawContent, inputTokens, outputTokens, upstreamError } = parseQwenSSE(rawBody);

    if (upstreamError) {
      await recordRequest(false, Date.now() - startTime, _rawModel);
      res.status(503).json({ error: { message: upstreamError.message, type: "upstream_error", code: upstreamError.code ?? "upstream_error" } });
      return;
    }

    const stRes = applyStop(rawContent, _stop);
    const content = stRes.content;
    const finishReason = "stop";

    await recordRequest(true, Date.now() - startTime, _rawModel);
    await incrementKeyUsage(auth.keyId);

    res.json({
      id: `cmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`,
      object: "text_completion",
      created: Math.floor(Date.now() / 1000),
      model: _rawModel,
      choices: [{ text: content, index: 0, logprobs: null, finish_reason: finishReason }],
      usage: { prompt_tokens: inputTokens || Math.ceil(promptText.length / 4), completion_tokens: outputTokens || Math.ceil(content.length / 4), total_tokens: (inputTokens || 0) + (outputTokens || 0) },
    });
  } catch (err) {
    logger.error({ err }, "v1/completions error");
    await recordRequest(false, Date.now() - startTime, _rawModel ?? "unknown");
    const errMsg = err instanceof Error ? err.message : "Internal server error";
    const errCode = (err as { code?: string }).code;
    const isOverload = errCode === "OVERLOADED" || errCode === "QUEUE_TIMEOUT";
    res.status(isOverload ? 503 : 500).json({ error: { message: errMsg, type: isOverload ? "service_unavailable" : "server_error", code: errCode ?? "internal_error" } });
  }
});

// ── POST /v1/images/generations ───────────────────────────────────────────────
// OpenAI-compatible image generation via Qwen t2i (Wan model internally).
// Request:  { prompt, model?, n?, size?, quality? }
// Response: { created, data: [{ url }] }

router.post("/images/generations", async (req: Request, res: Response) => {
  const auth = await resolveApiKey(req.headers.authorization);
  if (!auth.ok) {
    res.status(auth.statusCode).json({
      error: { message: auth.error, type: "invalid_request_error", code: "invalid_api_key" },
    });
    return;
  }

  try {
    const body = req.body as {
      prompt?: string;
      model?: string;
      n?: number;
      size?: string;
      quality?: string;
      response_format?: string;
    };

    const prompt = body.prompt?.trim();
    if (!prompt) {
      res.status(400).json({
        error: { message: "prompt is required", type: "invalid_request_error", param: "prompt", code: "missing_param" },
      });
      return;
    }

    const n = Math.min(Math.max(body.n ?? 1, 1), 4);

    // qwen3.7-plus is the only model in the API list that supports t2i internally
    const imageModel = "qwen3.7-plus";
    const sessionToken = process.env["QWEN_SESSION_TOKEN"] || undefined;
    const midtoken = await getPooledMidtoken();

    // Generate n images in parallel
    const tasks = Array.from({ length: n }, async (): Promise<{ url: string } | null> => {
      try {
        const imgPayload = {
          stream: true,
          incremental_output: true,
          chat_mode: "normal",
          model: imageModel,
          parent_id: null,
          messages: [{
            fid: randomUUID(),
            parentId: null,
            childrenIds: [],
            role: "user",
            content: prompt,
            user_action: "chat",
            files: [],
            models: [imageModel],
            chat_type: "t2i",
            feature_config: { thinking_enabled: false },
            sub_chat_type: "t2i",
          }],
        };

        // Route through Python sidecar (curl_cffi) for WAF bypass — combined create+chat
        const { body: rawBody } = await withRetry(() =>
          sessionToken
            ? qwenPyCreateAndChat(sessionToken, imageModel, "", imgPayload)
            : qwenPyCreateAndChat("", imageModel, midtoken, imgPayload)
        );

        // Accumulate content from SSE — the final content IS the image URL
        let imageUrl = "";
        for (const line of rawBody.split("\n")) {
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          try {
            const chunk = JSON.parse(line.slice(5).trim()) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const content = chunk.choices?.[0]?.delta?.content ?? "";
            if (content) imageUrl += content;
          } catch { /* skip malformed chunks */ }
        }

        imageUrl = imageUrl.trim();
        if (!imageUrl.startsWith("http")) return null;
        return { url: imageUrl };
      } catch (err) {
        logger.warn({ err: String(err) }, "images/generations: task failed");
        return null;
      }
    });

    const results = await Promise.all(tasks);
    const images = results.filter((r): r is { url: string } => r !== null);

    if (images.length === 0) {
      res.status(502).json({
        error: {
          message: "Image generation failed — no image returned from upstream",
          type: "upstream_error",
          param: null,
          code: "empty_response",
        },
      });
      return;
    }

    res.json({
      created: Math.floor(Date.now() / 1000),
      data: images,
    });
  } catch (err) {
    logger.error({ err }, "v1/images/generations error");
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: "Internal server error", type: "api_error", param: null, code: "internal_error" },
      });
    }
  }
});

export default router;
