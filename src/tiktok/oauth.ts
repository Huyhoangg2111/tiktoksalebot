import axios from 'axios';

/**
 * TikTok Marketing API OAuth (long-lived access token).
 * https://business-api.tiktok.com/portal/docs?id=1738373164380162
 *
 * The access token does not use a refresh_token. "Lấy token" means a new
 * authorization: open the portal, exchange the one-time auth_code, and
 * replace the token the bot already reads from the dashboard.
 */

const TIKTOK_AUTH_URL = 'https://business-api.tiktok.com/portal/auth';
const TIKTOK_ACCESS_TOKEN_URL = 'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/';

function resolveAccessTokenUrl(): string {
  // Test-only override so local checks can stub TikTok without shipping a configurable token endpoint.
  if (process.env.NODE_ENV === 'test') {
    const override = String(process.env.TIKTOK_OAUTH_TOKEN_URL || '').trim();
    if (override) return override;
  }
  return TIKTOK_ACCESS_TOKEN_URL;
}

export type TikTokTokenTarget = 'read' | 'write' | 'both';

export interface TikTokAppCredentials {
  appId: string;
  secret: string;
  /** Which env pair was selected. */
  slot: 'read' | 'write';
}

export interface ExchangedTikTokToken {
  accessToken: string;
  advertiserIds: string[];
  scopes: string[];
}

const TARGETS = new Set<TikTokTokenTarget>(['read', 'write', 'both']);

export function isTikTokTokenTarget(value: unknown): value is TikTokTokenTarget {
  return typeof value === 'string' && TARGETS.has(value as TikTokTokenTarget);
}

/** Show only the ends of a secret. Empty and short values stay fully hidden. */
export function maskToken(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function readEnv(name: string): string {
  return String(process.env[name] ?? '').trim();
}

export function isWriteAppSeparate(): boolean {
  const writeAppId = readEnv('TIKTOK_WRITE_APP_ID');
  const readAppId = readEnv('TIKTOK_APP_ID');
  return Boolean(writeAppId) && writeAppId !== readAppId;
}

export function getConfiguredRedirectUri(): string | undefined {
  const value = readEnv('TIKTOK_OAUTH_REDIRECT_URI');
  return value || undefined;
}

function credentialsFrom(appIdName: string, secretName: string, slot: 'read' | 'write'): TikTokAppCredentials {
  const appId = readEnv(appIdName);
  const secret = readEnv(secretName);
  if (!appId || !secret) {
    throw new Error(
      `Thiếu ${appIdName} hoặc ${secretName}. Đặt cặp app id/secret của TikTok Marketing API rồi khởi động lại bot.`
    );
  }
  return { appId, secret, slot };
}

/**
 * Read app is TIKTOK_APP_ID / TIKTOK_APP_SECRET.
 * Write app falls back to the same pair unless TIKTOK_WRITE_APP_ID is set.
 * "both" is only valid when one app issues the token for both slots.
 */
export function getTikTokOAuthApp(target: TikTokTokenTarget): TikTokAppCredentials {
  if (target === 'write') {
    if (readEnv('TIKTOK_WRITE_APP_ID') || readEnv('TIKTOK_WRITE_APP_SECRET')) {
      return credentialsFrom('TIKTOK_WRITE_APP_ID', 'TIKTOK_WRITE_APP_SECRET', 'write');
    }
    return credentialsFrom('TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'read');
  }

  if (target === 'both' && isWriteAppSeparate()) {
    throw new Error(
      'App ghi (TIKTOK_WRITE_APP_ID) khác app đọc. Hãy lấy token đọc và token ghi từng cái một.'
    );
  }

  return credentialsFrom('TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'read');
}

export function tiktokOAuthAppReady(target: TikTokTokenTarget = 'read'): boolean {
  try {
    getTikTokOAuthApp(target);
    return true;
  } catch {
    return false;
  }
}

export function buildTikTokAuthorizeUrl(params: {
  appId: string;
  state: string;
  redirectUri?: string;
}): string {
  const url = new URL(TIKTOK_AUTH_URL);
  url.searchParams.set('app_id', params.appId);
  url.searchParams.set('state', params.state);
  if (params.redirectUri) {
    url.searchParams.set('redirect_uri', params.redirectUri);
  }
  return url.toString();
}

function normalizeScopes(scope: unknown): string[] {
  if (Array.isArray(scope)) {
    return scope.map(item => String(item)).filter(Boolean);
  }
  if (scope === undefined || scope === null || scope === '') return [];
  return [String(scope)];
}

function scrubSecrets(message: string, secrets: string[]): string {
  let text = message.replace(/\s+/g, ' ').trim().slice(0, 300);
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length >= 6) {
      text = text.split(value).join('(ẩn)');
    }
  }
  return text || 'TikTok từ chối yêu cầu';
}

export async function exchangeTikTokAuthCode(
  credentials: TikTokAppCredentials,
  authCode: string
): Promise<ExchangedTikTokToken> {
  const code = authCode.trim();
  if (!code || code.length > 2048) {
    throw new Error('auth_code không hợp lệ. Hãy dán mã TikTok vừa cấp (dùng một lần, hiệu lực ngắn).');
  }

  let status = 0;
  let body: {
    code?: number;
    message?: string;
    data?: {
      access_token?: string;
      advertiser_ids?: unknown;
      scope?: unknown;
    };
  } | undefined;

  try {
    const response = await axios.post(
      resolveAccessTokenUrl(),
      {
        app_id: credentials.appId,
        secret: credentials.secret,
        auth_code: code,
      },
      {
        timeout: 20_000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      }
    );
    status = response.status;
    body = response.data && typeof response.data === 'object' ? response.data : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network_error';
    throw new Error(`Không gọi được TikTok OAuth: ${scrubSecrets(reason, [credentials.secret, code, credentials.appId])}`);
  }

  const accessToken = String(body?.data?.access_token || '').trim();
  if (!body || body.code !== 0 || !accessToken) {
    const reason = scrubSecrets(String(body?.message || `HTTP ${status}`), [
      credentials.secret,
      code,
      accessToken,
    ]);
    throw new Error(`TikTok từ chối auth_code: ${reason}`);
  }

  const advertiserIds = Array.isArray(body.data?.advertiser_ids)
    ? body.data.advertiser_ids.map(item => String(item).trim()).filter(Boolean)
    : [];

  return {
    accessToken,
    advertiserIds,
    scopes: normalizeScopes(body.data?.scope),
  };
}
