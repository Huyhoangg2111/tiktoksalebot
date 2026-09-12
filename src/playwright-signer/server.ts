/**
 * HTTP Server - API server cho Playwright Signer
 * Cung cấp REST API tương thích với ads-signer.ts nhưng chạy trên Playwright
 *
 * Endpoints:
 *   GET  /                    - Danh sách endpoints
 *   GET  /health              - Health check
 *   GET  /login-status        - Kiểm tra trạng thái đăng nhập
 *   GET  /login/start         - Mở trang login
 *   GET  /session             - Lấy session hiện tại (cookies, tokens)
 *   GET  /session/save        - Lưu session ra file
 *   GET  /session/clear       - Xóa session
 *   GET  /tokens              - Lấy token snapshot (msToken, X-Bogus, etc.)
 *   GET  /tokens/refresh      - Refresh tokens bằng cách reload page
 *   GET  /restart             - Restart browser
 *   GET  /auto-login          - Tự động login từ cấu hình SQLite/dashboard
 *   GET  /debug/exchanges     - Xem request/response gần đây mà signer bắt được
 *   POST /debug/exchanges/clear - Xóa exchange log để trace lượt mới
 *   POST /import-cookies      - Import cookies
 *   POST /login/credentials   - Đăng nhập bằng username/password
 *   POST /login/2fa           - Nhập mã 2FA
 *   POST /sign-request        - Ký request qua browser context
 *   POST /draft/publish       - Mở Ads Manager và publish một draft campaign
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BrowserManager } from './browser-manager.js';
import { autoLogin } from './auto-login.js';
import type { SimpleCookie } from './session-store.js';

// ============================================================
// Types
// ============================================================

type JsonRecord = Record<string, unknown>;

export interface SignerServerRuntime {
  host: string;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

export interface StartServerOptions {
  installSignalHandlers?: boolean;
  autoLoginOnStartup?: boolean;
}

// ============================================================
// Config
// ============================================================

const PORT = Number(process.env.PW_SIGNER_PORT || '8092');
const HOST = process.env.PW_SIGNER_HOST || '127.0.0.1';
const ENTRY_URL = process.env.PW_SIGNER_ENTRY_URL || 'https://ads.tiktok.com/i18n/manage/campaign';
const LOGIN_URL = process.env.PW_SIGNER_LOGIN_URL || 'https://ads.tiktok.com/i18n/login';
const EXECUTABLE_PATH = process.env.PW_SIGNER_EXECUTABLE_PATH || undefined;
const USER_DATA_DIR = process.env.PW_SIGNER_USER_DATA_DIR || undefined;
const PROXY_SERVER = process.env.PW_SIGNER_PROXY_SERVER || undefined;
const OMO_CAPTCHA_API_KEY = process.env.OMO_CAPTCHA_API_KEY || '';
const STATE_PATH = process.env.PW_SIGNER_STATE_PATH || 'artifacts/playwright-signer/session.json';
const AUTO_LOGIN_ON_STARTUP = process.env.PW_SIGNER_AUTO_LOGIN_ON_STARTUP !== 'false';
const EXTRA_CHROMIUM_ARGS = parseChromiumArgs(process.env.PW_SIGNER_CHROMIUM_ARGS);
const HEADLESS = resolveHeadlessMode();

// ============================================================
// Server
// ============================================================

let browserManager: BrowserManager;

function parseChromiumArgs(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function resolveHeadlessMode(): boolean {
  const rawValue = String(process.env.PW_SIGNER_HEADLESS || '').trim().toLowerCase();
  const wantsHeadful = rawValue === 'false';
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

  if (wantsHeadful && process.platform === 'linux' && !hasDisplay) {
    console.warn(
      '[playwright-signer] PW_SIGNER_HEADLESS=false nhung khong co DISPLAY tren Linux. Tu dong chuyen sang headless=true de phu hop VPS/Docker.'
    );
    return true;
  }

  return rawValue !== 'false';
}

function printHelp(): void {
  console.log(`playwright-signer

Muc dich:
- Dung Playwright browser de ky request ads.tiktok.com
- Thu thap msToken, X-Bogus, X-Gnarly, tt-ticket-*, x-csrftoken
- Tu dong giai captcha TikTok qua OMO Captcha API
- Tach rieng khoi bot Telegram de tich hop linh hoat

Lenh chay:
  npx ts-node src/playwright-signer/index.ts
  # hoac
  npm run pw:signer

Bien moi truong:
  PW_SIGNER_HOST=127.0.0.1
  PW_SIGNER_PORT=8092
  PW_SIGNER_ENTRY_URL=https://ads.tiktok.com/i18n/manage/campaign
  PW_SIGNER_LOGIN_URL=https://ads.tiktok.com/i18n/login
  PW_SIGNER_HEADLESS=true
  PW_SIGNER_AUTO_LOGIN_ON_STARTUP=true
  PW_SIGNER_CHROMIUM_ARGS=--disable-dev-shm-usage,--no-zygote
  PW_SIGNER_EXECUTABLE_PATH=/path/to/chromium
  PW_SIGNER_USER_DATA_DIR=/path/to/profile
  PW_SIGNER_PROXY_SERVER=http://host:port
  PW_SIGNER_STATE_PATH=artifacts/playwright-signer/session.json
  OMO_CAPTCHA_API_KEY=your_omo_api_key

API Endpoints:
  GET  /                    Danh sach endpoints
  GET  /health              Health check
  GET  /login-status        Kiem tra trang thai dang nhap
  GET  /login/start         Mo trang login
  GET  /session             Lay session hien tai
  GET  /session/save        Luu session ra file
  GET  /session/clear       Xoa session
  GET  /tokens              Lay token snapshot
  GET  /tokens/refresh      Refresh tokens
  GET  /restart             Restart browser
  GET  /auto-login          Tu dong login tu SQLite/dashboard
  GET  /debug/exchanges     Xem request/response gan day
  POST /debug/exchanges/clear Xoa exchange log
  POST /import-cookies      Import cookies
  POST /login/credentials   Dang nhap
  POST /login/2fa           Nhap ma 2FA
  POST /sign-request        Ky request qua browser
  POST /draft/publish       Publish draft campaign bang UI Playwright
`);
}

async function readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve());
    req.on('error', reject);
  });

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  return JSON.parse(raw) as JsonRecord;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    writeJson(res, 200, { status: 'ok' });
    return;
  }

  try {
    // ---- GET endpoints ----

    if (req.method === 'GET' && requestUrl.pathname === '/') {
      writeJson(res, 200, {
        status: 'ok',
        service: 'playwright-signer',
        description: 'TikTok Ads Manager request signer using Playwright',
        endpoints: [
          'GET  /health',
          'GET  /login-status',
          'GET  /login/start',
          'GET  /session',
          'GET  /session/save',
          'GET  /session/clear',
          'GET  /tokens',
          'GET  /tokens/refresh',
          'GET  /restart',
          'GET  /auto-login',
          'GET  /debug/exchanges',
          'POST /debug/exchanges/clear',
          'POST /import-cookies',
          'POST /login/credentials',
          'POST /login/2fa',
          'POST /sign-request',
          'POST /draft/publish',
        ],
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      writeJson(res, 200, browserManager.getHealth());
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/login-status') {
      writeJson(res, 200, await browserManager.getLoginStatus());
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/login/start') {
      writeJson(res, 200, await browserManager.navigateToLogin());
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/session') {
      const session = await browserManager.getSession();
      writeJson(res, 200, {
        status: 'ok',
        ...session,
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/session/save') {
      const result = await browserManager.saveSession();
      writeJson(res, 200, { status: 'ok', ...result });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/session/clear') {
      const result = await browserManager.clearSession();
      writeJson(res, 200, { status: 'ok', ...result });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/tokens') {
      const tokens = browserManager.getTokenSnapshot();
      writeJson(res, 200, { status: 'ok', tokens });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/tokens/refresh') {
      const tokens = await browserManager.refreshTokens();
      writeJson(res, 200, { status: 'ok', tokens });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/restart') {
      await browserManager.restart();
      writeJson(res, 200, {
        status: 'ok',
        restarted: true,
        health: browserManager.getHealth(),
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/auto-login') {
      const result = await autoLogin(browserManager);
      writeJson(res, 200, { status: 'ok', ...result });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/debug/exchanges') {
      const limit = Number(requestUrl.searchParams.get('limit') || '20');
      const pathIncludes = requestUrl.searchParams.get('path') || undefined;
      const exchanges = browserManager.getRecentExchanges({ limit, pathIncludes });
      writeJson(res, 200, { status: 'ok', exchanges });
      return;
    }

    // ---- POST endpoints ----

    if (req.method === 'POST' && requestUrl.pathname === '/debug/exchanges/clear') {
      browserManager.clearRecentExchanges();
      writeJson(res, 200, { status: 'ok', cleared: true });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/import-cookies') {
      const body = await readJsonBody(req);
      const result = await browserManager.importCookies({
        cookies: Array.isArray(body.cookies) ? (body.cookies as SimpleCookie[]) : undefined,
        cookieHeader:
          typeof body.cookieHeader === 'string'
            ? body.cookieHeader
            : typeof body.cookie_header === 'string'
              ? (body.cookie_header as string)
              : undefined,
        domain: typeof body.domain === 'string' ? body.domain : undefined,
      });
      writeJson(res, 200, { status: 'ok', ...result });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/login/credentials') {
      const body = await readJsonBody(req);
      const result = await browserManager.submitCredentials({
        username:
          typeof body.username === 'string'
            ? body.username
            : typeof body.email === 'string'
              ? (body.email as string)
              : '',
        password: typeof body.password === 'string' ? body.password : '',
      });
      writeJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/login/2fa') {
      const body = await readJsonBody(req);
      const result = await browserManager.submitTwoFactor({
        code:
          typeof body.code === 'string'
            ? body.code
            : typeof body.otp === 'string'
              ? (body.otp as string)
              : '',
      });
      writeJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/sign-request') {
      const body = await readJsonBody(req);
      const result = await browserManager.signRequest({
        method: typeof body.method === 'string' ? body.method : 'GET',
        url: typeof body.url === 'string' ? body.url : '',
        body: typeof body.body === 'string' ? body.body : undefined,
        formData:
          body.formData && typeof body.formData === 'object'
            ? Object.fromEntries(
                Object.entries(body.formData as Record<string, unknown>).map(([key, value]) => [key, String(value)])
              )
            : body.form_data && typeof body.form_data === 'object'
              ? Object.fromEntries(
                  Object.entries(body.form_data as Record<string, unknown>).map(([key, value]) => [key, String(value)])
                )
              : undefined,
        headers:
          body.headers && typeof body.headers === 'object'
            ? (body.headers as Record<string, string>)
            : undefined,
        referrer: typeof body.referrer === 'string' ? body.referrer : undefined,
        prepareUrl:
          typeof body.prepareUrl === 'string'
            ? body.prepareUrl
            : typeof body.prepare_url === 'string'
              ? (body.prepare_url as string)
              : undefined,
        timeoutMs:
          typeof body.timeoutMs === 'number'
            ? body.timeoutMs
            : typeof body.timeout_ms === 'number'
              ? (body.timeout_ms as number)
              : undefined,
      });
      writeJson(res, 200, { status: 'ok', data: result });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/draft/publish') {
      const body = await readJsonBody(req);
      const result = await browserManager.publishCampaignDraft({
        advertiserId:
          typeof body.advertiserId === 'string'
            ? body.advertiserId
            : typeof body.advertiser_id === 'string'
              ? (body.advertiser_id as string)
              : '',
        campaignName:
          typeof body.campaignName === 'string'
            ? body.campaignName
            : typeof body.campaign_name === 'string'
              ? (body.campaign_name as string)
              : undefined,
        campaignId:
          typeof body.campaignId === 'string'
            ? body.campaignId
            : typeof body.campaign_id === 'string'
              ? (body.campaign_id as string)
              : undefined,
        timeoutMs:
          typeof body.timeoutMs === 'number'
            ? body.timeoutMs
            : typeof body.timeout_ms === 'number'
              ? (body.timeout_ms as number)
              : undefined,
      });
      writeJson(res, 200, { status: 'ok', ...result });
      return;
    }

    writeJson(res, 404, { status: 'error', message: 'Not found' });
  } catch (error) {
    writeJson(res, 500, {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================
// Main
// ============================================================

async function runAutoLoginIfEnabled(shouldAutoLogin: boolean): Promise<void> {
  if (!shouldAutoLogin) {
    console.log('[playwright-signer] Auto-login on startup is disabled.');
    return;
  }

  console.log('[playwright-signer] Dang tu dong dang nhap tu ACCOUNT_BOT...');
  autoLogin(browserManager)
    .then((result) => {
      if (result.success) {
        console.log(`[playwright-signer] Auto-login thanh cong! (${result.credentials?.email})`);
      } else {
        console.log(`[playwright-signer] Auto-login: ${result.stage} - ${result.reason}`);
      }
    })
    .catch((error) => {
      console.error('[playwright-signer] Auto-login loi:', error instanceof Error ? error.message : error);
    });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await browserManager.close();
}

export async function startServer(options: StartServerOptions = {}): Promise<SignerServerRuntime> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return {
      host: HOST,
      port: PORT,
      baseUrl: `http://${HOST}:${PORT}`,
      close: async () => {},
    };
  }

  browserManager = new BrowserManager({
    omoCaptchaApiKey: OMO_CAPTCHA_API_KEY,
    entryUrl: ENTRY_URL,
    loginUrl: LOGIN_URL,
    headless: HEADLESS,
    executablePath: EXECUTABLE_PATH,
    userDataDir: USER_DATA_DIR,
    proxyServer: PROXY_SERVER,
    statePath: STATE_PATH,
    chromiumArgs: EXTRA_CHROMIUM_ARGS,
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, HOST, () => resolve());
  });

  const baseUrl = `http://${HOST}:${PORT}`;
  console.log(
    `[playwright-signer] listening on ${baseUrl} entry=${ENTRY_URL} headless=${String(HEADLESS)}`,
  );
  if (OMO_CAPTCHA_API_KEY) {
    console.log('[playwright-signer] OMO Captcha API key configured.');
  } else {
    console.log('[playwright-signer] WARNING: OMO_CAPTCHA_API_KEY not set, captcha solving disabled.');
  }
  if (EXTRA_CHROMIUM_ARGS.length > 0) {
    console.log(`[playwright-signer] Extra Chromium args: ${EXTRA_CHROMIUM_ARGS.join(' ')}`);
  }

  await runAutoLoginIfEnabled(options.autoLoginOnStartup ?? AUTO_LOGIN_ON_STARTUP);

  if (options.installSignalHandlers !== false) {
    const shutdown = async (): Promise<void> => {
      console.log('[playwright-signer] Shutting down...');
      await closeServer(server);
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  }

  return {
    host: HOST,
    port: PORT,
    baseUrl,
    close: async () => {
      await closeServer(server);
    },
  };
}
