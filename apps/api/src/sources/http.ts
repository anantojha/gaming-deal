// The ONLY place that talks to the outside world. Every source client goes through this:
// User-Agent, throttling, Retry-After handling, retries on 5xx, and a per-call budget hook.
//
// NOTE: throttle + circuit-breaker state is in-memory (per Worker isolate). The durable,
// cross-invocation guard is the `reserve` hook, which should call bump_usage() in Postgres.

export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, message?: string) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

export class RateLimitedError extends Error {
  retryAfterMs: number;
  constructor(provider: string, retryAfterMs: number) {
    super(`${provider} is rate limited; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class BudgetExceededError extends Error {
  constructor(provider: string) {
    super(`${provider} daily request budget exhausted`);
    this.name = "BudgetExceededError";
  }
}

export interface HttpClientOptions {
  provider: string;
  userAgent: string;
  /** Minimum spacing between request starts. */
  minIntervalMs: number;
  /** Retries for 5xx / network errors (not for 429 or other 4xx). Default 2. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Return false when the daily budget is spent. Called before every attempt. */
  reserve?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestInitLite {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown; // JSON-serialised if present
}

const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 60 * 1000;

export function parseRetryAfter(value: string | null, nowMs: number): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - nowMs, 0), MAX_RETRY_AFTER_MS);
  return DEFAULT_RETRY_AFTER_MS;
}

export class HttpClient {
  private provider: string;
  private userAgent: string;
  private minIntervalMs: number;
  private maxRetries: number;
  private timeoutMs: number;
  private reserve?: () => Promise<boolean>;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private nextSlot = 0;
  private blockedUntil = 0;

  constructor(opts: HttpClientOptions) {
    this.provider = opts.provider;
    this.userAgent = opts.userAgent;
    this.minIntervalMs = opts.minIntervalMs;
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.reserve = opts.reserve;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** True while a previous 429 is still being honoured. */
  isBlocked(): boolean {
    return this.now() < this.blockedUntil;
  }

  async getJson<T = unknown>(url: string, init: RequestInitLite = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (this.now() < this.blockedUntil) {
        throw new RateLimitedError(this.provider, this.blockedUntil - this.now());
      }

      // Claim a start slot synchronously so concurrent callers queue instead of bursting.
      const slot = Math.max(this.now(), this.nextSlot);
      this.nextSlot = slot + this.minIntervalMs;
      if (slot > this.now()) await this.sleep(slot - this.now());

      if (this.reserve && !(await this.reserve())) throw new BudgetExceededError(this.provider);

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: init.method ?? "GET",
          headers: {
            "User-Agent": this.userAgent,
            Accept: "application/json",
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new HttpError(0, url, `network error: ${(err as Error).message}`);
      }

      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get("retry-after"), this.now());
        this.blockedUntil = this.now() + wait; // circuit breaker: stop ALL calls to this provider
        throw new RateLimitedError(this.provider, wait);
      }
      if (res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new HttpError(res.status, url);
      }
      if (!res.ok) {
        // Short snippet only; never echo headers (they may carry API keys).
        const snippet = (await res.text().catch(() => "")).slice(0, 200);
        throw new HttpError(res.status, url, `HTTP ${res.status} for ${url}: ${snippet}`);
      }
      try {
        return (await res.json()) as T;
      } catch {
        throw new HttpError(res.status, url, `invalid JSON from ${url}`);
      }
    }
  }
}
