import { spawn } from "child_process";
import path from "path";
import { logger } from "./logger";

// process.cwd() is the artifact directory (artifacts/api-server/) at runtime.
const PYTHON_SCRIPT = path.resolve(process.cwd(), "qwen_engine.py");
const PYTHON_BIN = "python3";

export interface QwenGenerationParams {
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  stop?: string | string[] | null;
  presencePenalty?: number | null;
  frequencyPenalty?: number | null;
  seed?: number | null;
  responseFormat?: { type: string; json_schema?: object } | null;
  tools?: Array<{ type: string; function: object }> | null;
  toolChoice?: string | object | null;
  reasoningEffort?: string | null;
}

interface QwenInput extends QwenGenerationParams {
  action: "create_chat" | "chat_completions";
  midtoken: string;
  model: string;
  messages?: Array<{ role: string; content: string }>;
  chatId?: string;
}

export interface QwenResult {
  success: boolean;
  error?: string;
  code?: string;
  status?: number;
  chatId?: string;
  response?: string;
  thinking?: string | null;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

async function callPython(input: QwenInput): Promise<QwenResult> {
  return new Promise((resolve) => {
    const py = spawn(PYTHON_BIN, [PYTHON_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d) => { stdout += d.toString(); });
    py.stderr.on("data", (d) => { stderr += d.toString(); });

    py.on("close", (code) => {
      if (stderr) logger.debug({ stderr }, "Python stderr");
      if (code !== 0) {
        resolve({ success: false, error: `Python exited ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ success: false, error: "Failed to parse Python output", code: "PARSE_ERROR" });
      }
    });

    py.on("error", (err) => {
      resolve({ success: false, error: `Python spawn error: ${err.message}` });
    });

    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

export async function createChat(midtoken: string, model: string): Promise<QwenResult> {
  return callPython({ action: "create_chat", midtoken, model });
}

export async function chatCompletions(
  midtoken: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  chatId: string,
  params: QwenGenerationParams = {},
): Promise<QwenResult> {
  return callPython({ action: "chat_completions", midtoken, model, messages, chatId, ...params });
}
