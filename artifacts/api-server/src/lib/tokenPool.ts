import { logger } from "./logger";

interface Token {
  value: string;
  healthy: boolean;
  failCount: number;
  lastUsed: number;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

class TokenPool {
  private tokens: Token[] = [];
  private currentIndex = 0;
  private lastRefreshed: Date | null = null;
  private nextRefresh: Date | null = null;
  private rotationCount = 0;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startAutoRefresh();
  }

  private startAutoRefresh() {
    this.refreshTokens().catch((err) =>
      logger.warn({ err }, "Initial token fetch failed"),
    );
    this.refreshInterval = setInterval(
      () => {
        this.refreshTokens().catch((err) =>
          logger.warn({ err }, "Token refresh failed"),
        );
      },
      5 * 60 * 1000,
    );
  }

  async refreshTokens() {
    const uaIndex = Math.floor(Math.random() * USER_AGENTS.length);
    const ua = USER_AGENTS[uaIndex];
    try {
      const res = await fetch(
        "https://sg-wum.alibaba.com/w/wu.json?_t=" + Date.now(),
        {
          headers: {
            "User-Agent": ua,
            Accept: "application/json",
            Referer: "https://chat.qwen.ai/",
            Origin: "https://chat.qwen.ai",
          },
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!res.ok) {
        logger.warn({ status: res.status }, "Token fetch returned non-200");
        return;
      }

      const data = (await res.json()) as { data?: { token?: string } };
      const token = data?.data?.token;
      if (!token) {
        logger.warn({ data }, "No token in response");
        return;
      }

      const existing = this.tokens.find((t) => t.value === token);
      if (!existing) {
        this.tokens.push({ value: token, healthy: true, failCount: 0, lastUsed: 0 });
        if (this.tokens.length > 20) {
          this.tokens.shift();
        }
      } else {
        existing.healthy = true;
        existing.failCount = 0;
      }

      this.lastRefreshed = new Date();
      this.nextRefresh = new Date(Date.now() + 5 * 60 * 1000);
      logger.info({ poolSize: this.tokens.length }, "Token pool refreshed");
    } catch (err) {
      logger.warn({ err }, "Token refresh error");
    }
  }

  getToken(): string | null {
    const healthy = this.tokens.filter((t) => t.healthy);
    if (healthy.length === 0) {
      this.tokens.forEach((t) => {
        t.healthy = true;
        t.failCount = 0;
      });
      if (this.tokens.length === 0) return null;
    }

    const available = this.tokens.filter((t) => t.healthy);
    if (available.length === 0) return null;

    available.sort((a, b) => a.lastUsed - b.lastUsed);
    const token = available[0];
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
        logger.warn({ tokenPreview: tokenValue.slice(0, 8) }, "Token marked unhealthy");
      }
    }
    this.refreshTokens().catch(() => {});
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
