/**
 * Token Interceptor - Chặn bắt msToken, X-Bogus, X-Gnarly, tt-ticket-*, x-csrftoken
 * từ các request đi ra TikTok Ads Manager qua Playwright.
 *
 * Cơ chế: Lắng nghe sự kiện request/response của trang để extract các header/param đã sign.
 */

import type { BrowserContext, Page, Request, Response } from 'playwright';
import type { CapturedTokens, SimpleCookie } from './session-store.js';

// ============================================================
// Types
// ============================================================

export interface InterceptedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  timestamp: number;
}

export interface InterceptedExchange {
  request: InterceptedRequest;
  response?: {
    status: number;
    headers: Record<string, string>;
    bodyJson?: unknown;
  };
}

export interface TokenSnapshot {
  /** msToken from cookies or query params */
  msToken: string;
  /** X-Bogus header from signed requests */
  xBogus: string;
  /** X-Gnarly header from signed requests */
  xGnarly: string;
  /** x-csrftoken header */
  xCsrfToken: string;
  /** tt-ticket-guard-* cookies */
  ttTicketEntries: Record<string, string>;
  /** Full cookie header string */
  cookieHeader: string;
  /** All cookies as array */
  cookies: SimpleCookie[];
  /** User-Agent */
  userAgent: string;
  /** Timestamp of last capture */
  lastCapturedAt: number;
  /** Raw captured headers from the latest signed request */
  lastSignedHeaders: Record<string, string>;
}

// ============================================================
// Sensitive header/param names to watch
// ============================================================

const WATCHED_HEADERS = new Set([
  'x-bogus',
  'x-gnarly',
  'x-csrftoken',
  'x-tt-token',
  'cookie',
  'user-agent',
  'mstoken',
]);

const WATCHED_QUERY_PARAMS = new Set([
  'msToken',
  'mstoken',
  'X-Bogus',
  'x-bogus',
  'X-Gnarly',
  'x-gnarly',
]);

const TT_TICKET_PREFIX = 'tt-ticket-';

// ============================================================
// TokenInterceptor
// ============================================================

export class TokenInterceptor {
  private snapshot: TokenSnapshot;
  private exchanges: InterceptedExchange[] = [];
  private maxExchanges: number;
  private filterPath: string;
  private onTokenUpdate?: (snapshot: TokenSnapshot) => void;

  constructor(options?: {
    maxExchanges?: number;
    filterPath?: string;
    onTokenUpdate?: (snapshot: TokenSnapshot) => void;
  }) {
    this.maxExchanges = options?.maxExchanges ?? 100;
    this.filterPath = options?.filterPath ?? '/api/';
    this.onTokenUpdate = options?.onTokenUpdate;
    this.snapshot = this.createEmptySnapshot();
  }

  /**
   * Attach interceptor to a Playwright page
   */
  attach(page: Page): void {
    page.on('request', (request) => this.onRequest(request));
    page.on('response', (response) => this.onResponse(response));
  }

  /**
   * Attach interceptor to a Playwright BrowserContext (captures all pages)
   */
  attachToContext(context: BrowserContext): void {
    context.on('request', (request) => this.onRequest(request));
    context.on('response', (response) => this.onResponse(response));
  }

  /**
   * Get current token snapshot
   */
  getSnapshot(): TokenSnapshot {
    return { ...this.snapshot };
  }

  /**
   * Get captured exchanges
   */
  getExchanges(): InterceptedExchange[] {
    return [...this.exchanges];
  }

  clearExchanges(): void {
    this.exchanges = [];
  }

  /**
   * Update snapshot with cookies from browser context
   */
  async updateFromContext(context: BrowserContext): Promise<void> {
    const cookies = await context.cookies();
    this.updateFromCookies(cookies);
  }

  /**
   * Update snapshot with cookies
   */
  updateFromCookies(cookies: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    expires?: number;
  }>): void {
    const simpleCookies: SimpleCookie[] = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expires: c.expires,
    }));

    this.snapshot.cookies = simpleCookies;
    this.snapshot.cookieHeader = simpleCookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    // Extract tokens from cookies
    for (const cookie of cookies) {
      const nameLower = cookie.name.toLowerCase();

      if (nameLower === 'mstoken') {
        this.snapshot.msToken = cookie.value;
      } else if (
        nameLower === 'csrftoken' ||
        nameLower === 'csrf_session_id' ||
        nameLower === 'tt_csrf_token'
      ) {
        this.snapshot.xCsrfToken = cookie.value;
      } else if (nameLower.startsWith(TT_TICKET_PREFIX)) {
        this.snapshot.ttTicketEntries[cookie.name] = cookie.value;
      }
    }

    this.snapshot.lastCapturedAt = Date.now();
  }

  /**
   * Reset snapshot
   */
  reset(): void {
    this.snapshot = this.createEmptySnapshot();
    this.exchanges = [];
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private onRequest(request: Request): void {
    const url = request.url();
    if (!url.includes(this.filterPath)) return;

    const headers = request.headers();
    const intercepted: InterceptedRequest = {
      url,
      method: request.method(),
      headers: this.filterHeaders(headers),
      postData: request.postData() ?? undefined,
      timestamp: Date.now(),
    };

    // Extract tokens from request headers
    this.extractTokensFromHeaders(headers);

    // Extract tokens from URL query params
    this.extractTokensFromUrl(url);

    // Store exchange
    if (this.exchanges.length >= this.maxExchanges) {
      this.exchanges.shift();
    }
    this.exchanges.push({ request: intercepted });
  }

  private async onResponse(response: Response): Promise<void> {
    const url = response.url();
    if (!url.includes(this.filterPath)) return;

    // Find matching exchange
    const exchange = this.exchanges
      .slice()
      .reverse()
      .find((e) => e.request.url === url && !e.response);

    if (!exchange) return;

    try {
      const responseHeaders = response.headers();
      let bodyJson: unknown;

      const contentType = responseHeaders['content-type'] || '';
      if (contentType.includes('application/json')) {
        try {
          bodyJson = await response.json();
        } catch {
          // ignore
        }
      }

      exchange.response = {
        status: response.status(),
        headers: responseHeaders,
        bodyJson,
      };

      // Check response for msToken refresh
      if (bodyJson && typeof bodyJson === 'object') {
        const data = bodyJson as Record<string, unknown>;
        if (typeof data.msToken === 'string' && data.msToken) {
          this.snapshot.msToken = data.msToken;
        }
      }
    } catch {
      // ignore response parsing errors
    }
  }

  private extractTokensFromHeaders(headers: Record<string, string>): void {
    let updated = false;

    for (const [key, value] of Object.entries(headers)) {
      const keyLower = key.toLowerCase();

      if (keyLower === 'x-bogus' && value) {
        this.snapshot.xBogus = value;
        updated = true;
      } else if (keyLower === 'x-gnarly' && value) {
        this.snapshot.xGnarly = value;
        updated = true;
      } else if (keyLower === 'x-csrftoken' && value) {
        this.snapshot.xCsrfToken = value;
        updated = true;
      } else if (keyLower === 'user-agent' && value) {
        this.snapshot.userAgent = value;
      }
    }

    if (updated) {
      this.snapshot.lastSignedHeaders = { ...headers };
      this.snapshot.lastCapturedAt = Date.now();
      this.onTokenUpdate?.(this.getSnapshot());
    }
  }

  private extractTokensFromUrl(url: string): void {
    try {
      const parsed = new URL(url);
      for (const paramName of WATCHED_QUERY_PARAMS) {
        const value = parsed.searchParams.get(paramName);
        if (!value) continue;

        const keyLower = paramName.toLowerCase();
        if (keyLower === 'mstoken') {
          this.snapshot.msToken = value;
        } else if (keyLower === 'x-bogus') {
          this.snapshot.xBogus = value;
        } else if (keyLower === 'x-gnarly') {
          this.snapshot.xGnarly = value;
        }
      }
    } catch {
      // ignore invalid URLs
    }
  }

  private filterHeaders(headers: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (WATCHED_HEADERS.has(key.toLowerCase()) || key.toLowerCase().startsWith('tt-')) {
        filtered[key] = value;
      }
    }
    return filtered;
  }

  private createEmptySnapshot(): TokenSnapshot {
    return {
      msToken: '',
      xBogus: '',
      xGnarly: '',
      xCsrfToken: '',
      ttTicketEntries: {},
      cookieHeader: '',
      cookies: [],
      userAgent: '',
      lastCapturedAt: 0,
      lastSignedHeaders: {},
    };
  }
}
