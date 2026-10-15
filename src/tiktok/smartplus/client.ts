import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { TikTokApiError, TikTokNetworkError, TikTokProtocolError, TikTokRateLimitError } from './errors.js';

export const DEFAULT_BASE_URL = 'https://business-api.tiktok.com/open_api/v1.3';
export const RATE_LIMIT_CODE = 40100;

/** TikTok response envelope: HTTP is usually 200 even on logical errors; `code === 0` means OK. */
export interface TikTokEnvelope<T = unknown> {
  code: number;
  message: string;
  data: T;
  request_id: string;
}

export interface Logger {
  debug?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
}

export type SleepFn = (ms: number) => Promise<void>;
export const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ rate limiting */

/** Classic token bucket. Time and sleep are injectable so tests never wait for real. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number,
    private readonly sleep: SleepFn,
  ) {
    this.tokens = capacity;
    this.last = now();
  }
  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
    this.last = t;
  }
  /** Milliseconds until one token is available (0 if available now). Does not consume. */
  peekWaitMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
  }
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  async acquire(): Promise<void> {
    while (!this.tryTake()) await this.sleep(Math.max(1, this.peekWaitMs()));
  }
}

export interface BucketSpec {
  qps: number;
  qpm: number;
}

/** A request must pass BOTH the per-second and the per-minute bucket. */
export class RateLimiter {
  private readonly perSecond: TokenBucket;
  private readonly perMinute: TokenBucket;
  constructor(spec: BucketSpec, now: () => number, sleep: SleepFn) {
    this.perSecond = new TokenBucket(Math.max(1, spec.qps), spec.qps / 1000, now, sleep);
    this.perMinute = new TokenBucket(Math.max(1, spec.qpm), spec.qpm / 60_000, now, sleep);
  }
  async acquire(): Promise<void> {
    // Take the slower bucket first so we never burn a per-second token while waiting on the minute bucket.
    await this.perMinute.acquire();
    await this.perSecond.acquire();
  }
}

/** Named buckets. `copy_create` has its own limit (1 QPS / 30 QPM per app, global limits do not apply). */
export type BucketName = 'global' | 'copy_create';

/* ------------------------------------------------------------------ client */

export interface TikTokClientOptions {
  accessToken: string;
  baseUrl?: string;
  /** Inject an axios instance (tests / custom proxy). Default: `axios.create()`. */
  http?: AxiosInstance;
  timeoutMs?: number;
  /**
   * Local limiter. Documented Basic limits are 10 QPS / 600 QPM; defaults keep ~20% headroom.
   * TODO(UNVERIFIED): your app tier may differ (check your developer app in the portal).
   */
  limits?: Partial<Record<BucketName, BucketSpec>>;
  /** Max retries for network errors / HTTP 5xx (only on safe requests, see `idempotent`). Default 3. */
  maxRetries?: number;
  /** Base for exponential backoff of network errors. Default 1000 ms (1s, 2s, 4s...). */
  baseDelayMs?: number;
  /**
   * Waits applied on consecutive 40100 / HTTP 429 answers: short, medium, then 5 minutes
   * (docs: wait 5 min after a QPM breach). After the list is exhausted a TikTokRateLimitError is thrown.
   */
  rateLimitDelaysMs?: number[];
  sleep?: SleepFn;
  now?: () => number;
  logger?: Logger;
}

export interface RequestOptions {
  /** Which local limiter to use. Default 'global'. */
  bucket?: BucketName;
  /**
   * True when re-sending the same POST is safe (request_id based idempotency).
   * Only then are POSTs retried after network errors / 5xx. 40100 is always retried:
   * a rate-limited request was rejected, so re-sending cannot duplicate anything.
   */
  idempotent?: boolean;
}

export class TikTokClient {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly rateLimitDelaysMs: number[];
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly limiters: Record<BucketName, RateLimiter>;
  /** When a 40100 happens, ALL callers of this client pause until this timestamp. */
  private pausedUntil = 0;

  constructor(opts: TikTokClientOptions) {
    if (!opts.accessToken) throw new Error('TikTokClient: accessToken is required');
    this.token = opts.accessToken;
    this.http = opts.http ?? axios.create();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.rateLimitDelaysMs = opts.rateLimitDelaysMs ?? [2_000, 15_000, 5 * 60_000];
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? {};
    const g = opts.limits?.global ?? { qps: 8, qpm: 480 };
    const c = opts.limits?.copy_create ?? { qps: 1, qpm: 25 };
    this.limiters = {
      global: new RateLimiter(g, this.now, this.sleep),
      copy_create: new RateLimiter(c, this.now, this.sleep),
    };
  }

  /** Never expose the token via console.log / JSON.stringify of the client. */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, accessToken: '[REDACTED]' };
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `TikTokClient { baseUrl: '${this.baseUrl}', accessToken: [REDACTED] }`;
  }

  get<T>(path: string, params: Record<string, unknown> = {}, opts: RequestOptions = {}): Promise<TikTokEnvelope<T>> {
    return this.request<T>('GET', path, { params }, opts);
  }

  post<T>(path: string, body: Record<string, unknown>, opts: RequestOptions = {}): Promise<TikTokEnvelope<T>> {
    return this.request<T>('POST', path, { body }, opts);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    payload: { params?: Record<string, unknown>; body?: Record<string, unknown> },
    opts: RequestOptions,
  ): Promise<TikTokEnvelope<T>> {
    const endpoint = path;
    const safeToRetry = method === 'GET' || opts.idempotent === true;
    const limiter = this.limiters[opts.bucket ?? 'global'];
    let netAttempt = 0;
    let rlAttempt = 0;

    for (;;) {
      await this.waitIfPaused();
      await limiter.acquire();

      const config: AxiosRequestConfig = {
        method,
        url: path,
        baseURL: this.baseUrl,
        timeout: this.timeoutMs,
        headers: { 'Access-Token': this.token, 'Content-Type': 'application/json' },
        validateStatus: () => true, // we classify HTTP + envelope errors ourselves
      };
      if (method === 'GET') {
        config.params = payload.params ?? {};
        config.paramsSerializer = { serialize: serializeQuery };
      } else {
        config.data = payload.body ?? {};
      }

      let res: AxiosResponse<unknown>;
      try {
        this.logger.debug?.(`TikTok ${method} ${path}`, { attempt: netAttempt });
        res = await this.http.request(config);
      } catch (e) {
        if (safeToRetry && netAttempt < this.maxRetries) {
          const wait = this.baseDelayMs * 2 ** netAttempt;
          netAttempt++;
          this.logger.warn?.(`Network error on ${path}, retry in ${wait}ms`, { err: String(e) });
          await this.sleep(wait);
          continue;
        }
        throw new TikTokNetworkError(endpoint, e);
      }

      const httpStatus = res.status;
      const env = asEnvelope<T>(res.data);

      // ---- rate limit: envelope 40100 or HTTP 429
      if (httpStatus === 429 || env?.code === RATE_LIMIT_CODE) {
        if (rlAttempt < this.rateLimitDelaysMs.length) {
          const wait = this.rateLimitDelaysMs[rlAttempt]!;
          rlAttempt++;
          this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
          this.logger.warn?.(`Rate limited (40100) on ${path}; pausing all calls ${wait}ms`, { attempt: rlAttempt });
          continue; // waitIfPaused() sleeps at the top of the loop
        }
        throw new TikTokRateLimitError({
          code: env?.code ?? RATE_LIMIT_CODE,
          message: env?.message ?? 'Too many requests',
          requestId: env?.request_id,
          endpoint,
          httpStatus,
          data: env?.data,
        });
      }

      // ---- transient server errors: only retry when re-sending is safe
      if (httpStatus >= 500 && safeToRetry && netAttempt < this.maxRetries) {
        const wait = this.baseDelayMs * 2 ** netAttempt;
        netAttempt++;
        this.logger.warn?.(`HTTP ${httpStatus} on ${path}, retry in ${wait}ms`);
        await this.sleep(wait);
        continue;
      }

      if (!env) {
        if (httpStatus >= 200 && httpStatus < 300) {
          throw new TikTokProtocolError(`Unexpected response shape from ${path} (HTTP ${httpStatus})`);
        }
        throw new TikTokApiError({ code: httpStatus, message: `HTTP ${httpStatus}`, endpoint, httpStatus });
      }
      if (env.code !== 0) {
        throw new TikTokApiError({
          code: env.code,
          message: env.message,
          requestId: env.request_id,
          endpoint,
          httpStatus,
          data: env.data,
        });
      }
      return env;
    }
  }

  private async waitIfPaused(): Promise<void> {
    for (;;) {
      const wait = this.pausedUntil - this.now();
      if (wait <= 0) return;
      await this.sleep(wait);
    }
  }
}

/* ------------------------------------------------------------------ helpers */

export function asEnvelope<T>(body: unknown): TikTokEnvelope<T> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.code !== 'number') return undefined;
  return {
    code: b.code,
    message: typeof b.message === 'string' ? b.message : '',
    data: b.data as T,
    request_id: typeof b.request_id === 'string' ? b.request_id : '',
  };
}

/** TikTok GET params: scalars as-is, arrays/objects as JSON (e.g. `filtering={"campaign_ids":["1"]}`). */
export function serializeQuery(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return usp.toString();
}
