import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = join(__dirname, "..", "..", "qwen_engine.py");

interface QwenInput {
  action: "create_chat" | "chat_completions";
  midtoken: string;
  model: string;
  messages?: Array<{ role: string; content: string }>;
  chatId?: string;
}

interface QwenResult {
  success: boolean;
  error?: string;
  code?: string;
  chatId?: string;
  response?: string;
  thinking?: string | null;
  tokenUsage?: number | null;
}

async function callPython(input: QwenInput): Promise<QwenResult> {
  return new Promise((resolve) => {
    const py = spawn("python3", [PYTHON_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    py.stderr.on("data", (d) => {
      stderr += d.toString();
    });

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
): Promise<QwenResult> {
  return callPython({ action: "chat_completions", midtoken, model, messages, chatId });
}
