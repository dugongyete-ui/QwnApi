/**
 * bx-umidtoken pool with Python sidecar-backed refresh.
 * Uses curl_cffi (Chrome impersonation) to bypass Alibaba TLS fingerprinting
 * — the same technique we use for Qwen chat requests.
 *
 * Manual seeding is also available via addToken() for tokens extracted directly
 * from a browser session.
 */

import { spawnSync } from "child_process";
import path from "path";
import { logger } from "./logger";

// process.cwd() is the artifact directory (artifacts/api-server/) when the server runs.
// This works in both dev (src/) and prod (dist/) because CWD never changes.
const SIDECAR_PATH = path.resolve(process.cwd(), "qwen_engine.py");
const PYTHON_BIN = "python3";

interface Token {
  value: string;
  healthy: boolean;
  failCount: number;
  lastUsed: number;
  source: "auto" | "manual";
}

class TokenPool {
  private tokens: Token[] = [];
  private currentIndex = 0;
  private lastRefreshed: Date | null = null;
  private nextRefresh: Date | null = null;
  private rotationCount = 0;
  private refreshInterval: NodeJS.Timeout | null = null;
  private refreshing = false;

  constructor() {
    this.startAutoRefresh();
  }

  private startAutoRefresh() {
    void this.refreshTokens();
    this.refreshInterval = setInterval(() => {
      void this.refreshTokens();
    }, 5 * 60 * 1000);
  }

  /** Call the Python sidecar with fetch_token action. */
  async refreshTokens() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const input = JSON.stringify({ action: "fetch_token" });
      const result = spawnSync(PYTHON_BIN, [SIDECAR_PATH], {
        input,
        encoding: "utf-8",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });

      if (result.error) {
        logger.warn({ err: result.error }, "Token sidecar spawn error");
        return;
      }

      const stdout = result.stdout?.trim();
      if (!stdout) {
        logger.warn({ stderr: result.stderr }, "Token sidecar empty output");
        return;
      }

      let data: { success: boolean; token?: string; error?: string; source?: string };
      try {
        data = JSON.parse(stdout);
      } catch {
        logger.warn({ stdout }, "Token sidecar non-JSON output");
        return;
      }

      if (!data.success || !data.token) {
        logger.warn({ error: data.error }, "Token sidecar: fetch failed");
        return;
      }

      this._upsertToken(data.token, "auto");
      this.lastRefreshed = new Date();
      this.nextRefresh = new Date(Date.now() + 5 * 60 * 1000);
      logger.info({ poolSize: this.tokens.length, source: data.source }, "Token pool refreshed via sidecar");
    } catch (err) {
      logger.warn({ err }, "Token refresh unexpected error");
    } finally {
      this.refreshing = false;
    }
  }

  /** Add a token manually (e.g. extracted from browser session). */
  addToken(token: string): void {
    this._upsertToken(token.trim(), "manual");
    logger.info({ poolSize: this.tokens.length }, "Token manually seeded");
  }

  private _upsertToken(value: string, source: Token["source"]) {
    const existing = this.tokens.find((t) => t.value === value);
    if (existing) {
      existing.healthy = true;
      existing.failCount = 0;
    } else {
      this.tokens.push({ value, healthy: true, failCount: 0, lastUsed: 0, source });
      if (this.tokens.length > 30) {
        // Evict oldest auto-generated token first
        const idx = this.tokens.findIndex((t) => t.source === "auto");
        if (idx !== -1) this.tokens.splice(idx, 1);
        else this.tokens.shift();
      }
    }
  }

  getToken(): string | null {
    const healthy = this.tokens.filter((t) => t.healthy);
    // If all tokens are marked unhealthy, reset and retry
    if (healthy.length === 0 && this.tokens.length > 0) {
      this.tokens.forEach((t) => { t.healthy = true; t.failCount = 0; });
    }
    const available = this.tokens.filter((t) => t.healthy);
    if (available.length === 0) return null;
    // Round-robin by least recently used
    available.sort((a, b) => a.lastUsed - b.lastUsed);
    const token = available[0]!;
    token.lastUsed = Date.now();
    this.rotationCount++;
    return token.value;
  }

  markFailed(tokenValue: string) {
    const token = this.tokens.find((t) => t.value === tokenValue);
    if (token) {
      token.failCount++;
      if (token.failCount >= 3) {
        token.healthy = false;
        logger.warn({ preview: tokenValue.slice(0, 8) }, "Token marked unhealthy");
      }
    }
    void this.refreshTokens();
  }

  getStatus() {
    return {
      total: this.tokens.length,
      healthy: this.tokens.filter((t) => t.healthy).length,
      exhausted: this.tokens.filter((t) => !t.healthy).length,
      lastRefreshed: this.lastRefreshed?.toISOString() ?? null,
      nextRefresh: this.nextRefresh?.toISOString() ?? null,
      rotationCount: this.rotationCount,
    };
  }

  destroy() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }
}

export const tokenPool = new TokenPool();
