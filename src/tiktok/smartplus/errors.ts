/** Typed errors thrown by the client. */

export class TikTokError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API answered, but with a non-zero envelope `code` (or a non-2xx HTTP status). */
export class TikTokApiError extends TikTokError {
  readonly code: number;
  readonly apiMessage: string;
  /** `request_id` returned by TikTok (log id) - quote it when contacting TikTok support. */
  readonly requestId?: string;
  readonly endpoint: string;
  readonly httpStatus?: number;
  readonly data?: unknown;

  constructor(init: {
    code: number;
    message: string;
    requestId?: string | undefined;
    endpoint: string;
    httpStatus?: number | undefined;
    data?: unknown;
  }) {
    super(`TikTok API error ${init.code} on ${init.endpoint}: ${init.message}` + (init.requestId ? ` (request_id=${init.requestId})` : ''));
    this.code = init.code;
    this.apiMessage = init.message;
    this.requestId = init.requestId;
    this.endpoint = init.endpoint;
    this.httpStatus = init.httpStatus;
    this.data = init.data;
  }
}

/** Code 40100 / HTTP 429 and all local retries were exhausted. */
export class TikTokRateLimitError extends TikTokApiError {}

/** No usable HTTP response (timeout, DNS, connection reset...). */
export class TikTokNetworkError extends TikTokError {
  readonly endpoint: string;
  constructor(endpoint: string, cause: unknown) {
    super(`Network error calling ${endpoint}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.endpoint = endpoint;
  }
}

/** The response body was not a TikTok envelope `{code, message, data, request_id}`. */
export class TikTokProtocolError extends TikTokError {}

/**
 * Heuristic: does this error look like "your app / advertiser is not allowed to use this API"
 * (e.g. the copy API is allowlist-only)?
 *
 * TODO(UNVERIFIED): TikTok does not publish an official error code for "not on the allowlist".
 * Third-party sources disagree about the meaning of 40001/40002/40003. We therefore require BOTH a
 * permission-ish HTTP status/code AND a message that looks like a permission/allowlist complaint.
 * Pass your own `isAllowlistDenied` to `copyCampaign` once you see the real response from your app.
 */
export function looksLikeAllowlistOrPermissionDenied(err: unknown): boolean {
  if (!(err instanceof TikTokApiError)) return false;
  if (err instanceof TikTokRateLimitError || err.code === 40100) return false;
  const msg = err.apiMessage.toLowerCase();
  const messageHint =
    /allow-?list|white-?list|not (been )?(allowed|authorized|authorised|enabled|supported|available)|no (access|permission)|permission|unauthori[sz]ed|forbidden|not eligible|contact your (tiktok )?representative/.test(
      msg,
    );
  const codeHint = err.httpStatus === 403 || [40001, 40002, 40003, 40300, 40301].includes(err.code);
  return messageHint && (codeHint || err.httpStatus === undefined || err.httpStatus === 200);
}
