import { spawn } from "child_process";
import path from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger";

const QWEN_CFFI_PY = path.resolve(import.meta.dirname, "qwen_cffi.py");
const PYTHON_BIN = "python3";

export interface QwenResult {
  success: boolean;
  error?: string;
  code?: string;
  chatId?: string;
  response?: string;
  thinking?: string | null;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Create a new chat session. Returns the chatId. */
export async function createChat(midtoken: string, model: string): Promise<QwenResult> {
  const args = [QWEN_CFFI_PY, "create", "", model, midtoken];
  return new Promise<QwenResult>((resolve) => {
    const py = spawn(PYTHON_BIN, args);
    const chunks: Buffer[] = [];

    py.stdout.on("data", (d: Buffer) => chunks.push(d));
    py.stderr.on("data", (d: Buffer) => logger.warn({ err: d.toString().trim() }, "qwen-cffi create: stderr"));

    const timer = setTimeout(() => {
      py.kill();
      resolve({ success: false, error: "qwen-cffi create: timeout", code: "TIMEOUT" });
    }, 15000);

    py.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ success: false, error: `qwen-cffi create: exit ${code}`, code: "CREATE_ERROR" });
        return;
      }
      const out = Buffer.concat(chunks).toString("utf8");
      try {
        const data = JSON.parse(out) as { success: boolean; data?: { id: string } };
        if (!data.success || !data.data?.id) {
          resolve({ success: false, error: `createChat failed: ${out.slice(0, 200)}`, code: "CREATE_FAILED" });
        } else {
          resolve({ success: true, chatId: data.data.id });
        }
      } catch {
        resolve({ success: false, error: `createChat JSON parse error: ${out.slice(0, 200)}`, code: "CREATE_ERROR" });
      }
    });

    py.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `Python spawn error: ${err.message}`, code: "SPAWN_ERROR" });
    });
  });
}

function parseQwenSSE(body: string): { answer: string; thinking: string; inputTokens: number; outputTokens: number } {
  let answer = "";
  let thinking = "";
  let fallback = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (raw === "[DONE]") break;
    try {
      const chunk = JSON.parse(raw) as {
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string; extra?: { output_schema?: string } };
        }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (chunk.usage) {
        inputTokens = chunk.usage.input_tokens ?? inputTokens;
        outputTokens = chunk.usage.output_tokens ?? outputTokens;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const content = delta.content ?? "";
      const reasoning = delta.reasoning_content ?? "";
      if (reasoning) thinking += reasoning;
      if (!content) continue;
      const phase = delta.extra?.output_schema ?? "";
      if (phase === "answer") {
        answer += content;
      } else {
        fallback += content;
      }
    } catch {
      // skip malformed chunks
    }
  }
  return { answer: answer || fallback, thinking, inputTokens, outputTokens };
}

/** Send a chat message and return the response. */
export async function chatCompletions(
  midtoken: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  chatId: string,
): Promise<QwenResult> {
  const msgId = randomUUID();

  // Build the last user message as the content to send
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userContent = lastUser?.content ?? "";

  const payload = {
    stream: true,
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: null,
    messages: [
      {
        fid: msgId,
        parentId: null,
        childrenIds: [],
        role: "user",
        content: userContent,
        user_action: "chat",
        files: [],
        models: [model],
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: false,
          output_schema: "phase",
          thinking_budget: 81920,
        },
        sub_chat_type: "t2t",
      },
    ],
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  return new Promise<QwenResult>((resolve) => {
    const py = spawn(PYTHON_BIN, [QWEN_CFFI_PY, "chat", "", chatId, payloadB64, midtoken]);
    const chunks: Buffer[] = [];

    py.stdout.on("data", (d: Buffer) => chunks.push(d));
    py.stderr.on("data", (d: Buffer) => logger.warn({ err: d.toString().trim() }, "qwen-cffi: stderr"));

    const timer = setTimeout(() => {
      py.kill();
      resolve({ success: false, error: "qwen-cffi: timeout", code: "TIMEOUT" });
    }, 90000);

    py.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 2) {
        resolve({ success: false, error: `qwen-cffi: exit ${code}`, code: "PYTHON_ERROR" });
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const { answer, thinking, inputTokens, outputTokens } = parseQwenSSE(body);

      if (!answer) {
        // Try to extract structured error
        try {
          const errLine = body.split("\n").find((l) => l.startsWith("data:") && l.includes("error"));
          if (errLine) {
            const errJson = JSON.parse(errLine.slice(5).trim()) as {
              error?: { message?: string; code?: string };
            };
            return resolve({
              success: false,
              error: errJson.error?.message ?? "Unknown error",
              code: errJson.error?.code ?? "UPSTREAM_ERROR",
            });
          }
        } catch { /* ignore */ }
        resolve({ success: false, error: "Empty response from Qwen", code: "EMPTY_RESPONSE" });
        return;
      }

      resolve({
        success: true,
        response: answer,
        thinking: thinking || null,
        finishReason: "stop",
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      });
    });

    py.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `Python spawn error: ${err.message}`, code: "SPAWN_ERROR" });
    });
  });
}
