/**
 * Browser Manager - Quản lý Playwright browser instance
 * - Khởi tạo browser với anti-detection
 * - Login TikTok Ads Manager
 * - Tự động giải captcha
 * - Thu thập tokens
 * - Sign requests thông qua browser context
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { TokenInterceptor, type TokenSnapshot } from './token-interceptor.js';
import { CaptchaHandler } from './captcha-handler.js';
import {
  type PersistedSessionState,
  type SimpleCookie,
  loadSessionState,
  saveSessionState,
  normalizeStatePath,
  removeSessionState,
  buildCookieHeader,
} from './session-store.js';

// ============================================================
// Types
// ============================================================

export interface BrowserManagerConfig {
  /** OMO Captcha API Key */
  omoCaptchaApiKey?: string;
  /** TikTok Ads Manager entry URL */
  entryUrl?: string;
  /** TikTok Login URL */
  loginUrl?: string;
  /** Run headless */
  headless?: boolean;
  /** Path to Chrome/Chromium executable */
  executablePath?: string;
  /** User data directory for persistent profile */
  userDataDir?: string;
  /** Proxy server */
  proxyServer?: string;
  /** Extra Chromium launch args, useful on VPS/Docker */
  chromiumArgs?: string[];
  /** Session state file path */
  statePath?: string;
  /** Cookie domain */
  cookieDomain?: string;
  /** Timeout for page navigation (ms) */
  navigationTimeoutMs?: number;
  /** Timeout for login actions (ms) */
  loginActionTimeoutMs?: number;
  /** Session refresh interval (minutes) */
  sessionRefreshMinutes?: number;
  /** Viewport width */
  viewportWidth?: number;
  /** Viewport height */
  viewportHeight?: number;
}

export interface LoginStatusPayload {
  status: 'ok';
  stage: 'logged_in' | 'needs_credentials' | 'needs_2fa' | 'captcha' | 'unknown';
  loggedInLikely: boolean;
  currentUrl: string | null;
  title: string | null;
  reason: string;
  cookieCount: number;
}

export interface SignRequestInput {
  method: string;
  url: string;
  body?: string;
  formData?: Record<string, string>;
  headers?: Record<string, string>;
  referrer?: string;
  prepareUrl?: string;
  timeoutMs?: number;
}

export interface SignRequestResult {
  /** Headers chứa X-Bogus, X-Gnarly, msToken, cookie, etc. */
  signedHeaders: Record<string, string>;
  /** URL đã được sign (có thể chứa msToken, X-Bogus trong query) */
  signedUrl: string;
  /** Response data nếu có */
  responseData?: unknown;
  /** Response status */
  responseStatus?: number;
}

export interface PublishCampaignDraftInput {
  advertiserId: string;
  campaignName?: string;
  campaignId?: string;
  timeoutMs?: number;
}

export interface PublishCampaignDraftResult {
  published: boolean;
  reason: string;
  matchedRowText?: string;
  publishButtonText?: string;
  confirmButtonText?: string;
  capturedCreationUrls?: string[];
  capturedCreationStatuses?: Array<{
    url: string;
    status?: number;
  }>;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_ENTRY_URL = 'https://ads.tiktok.com/i18n/manage/campaign';
const DEFAULT_LOGIN_URL = 'https://ads.tiktok.com/i18n/login';
const DEFAULT_COOKIE_DOMAIN = '.ads.tiktok.com';
const DEFAULT_NAVIGATION_TIMEOUT = 30000;
const DEFAULT_LOGIN_ACTION_TIMEOUT = 45000;
const DEFAULT_SESSION_REFRESH_MINUTES = 30;
const DEFAULT_STATE_PATH = 'artifacts/playwright-signer/session.json';

const USERNAME_SELECTORS = [
  // TikTok Ads Manager specific (highest priority)
  'input[placeholder="Enter your email address"]',
  'input[placeholder*="email address"]',
  'input[placeholder*="Enter your email"]',
  'input[placeholder*="Enter your phone"]',
  // Generic fallbacks
  'input[name="username"]',
  'input[name="email"]',
  'input[type="email"]',
  'input[placeholder*="Email"]',
  'input[placeholder*="email"]',
  'input[placeholder*="Phone"]',
  'input[placeholder*="phone"]',
  'input[autocomplete="username"]',
];

const PASSWORD_SELECTORS = [
  // TikTok Ads Manager specific
  'input[placeholder="Enter your password"]',
  'input[placeholder*="Enter your password"]',
  'input[placeholder*="password"]',
  // Generic fallbacks
  'input[name="password"]',
  'input[type="password"]',
  'input[autocomplete="current-password"]',
];

const SUBMIT_SELECTORS = [
  // TikTok Ads Manager specific - "Log in" button
  'button:has-text("Log in")',
  'button:has-text("Log In")',
  'button:has-text("Đăng nhập")',
  // Generic fallbacks
  'button[type="submit"]',
  'button[data-e2e*="login"]',
  'button[data-testid*="login"]',
  'button[class*="login"]',
  'button[class*="submit"]',
];

const OTP_SELECTORS = [
  // TikTok-specific 2FA/OTP
  'input[placeholder*="Enter 6-digit code"]',
  'input[placeholder*="verification code"]',
  'input[placeholder*="Verification code"]',
  'input[placeholder*="Enter code"]',
  'input[placeholder*="enter code"]',
  // Generic fallbacks
  'input[name="code"]',
  'input[name="otp"]',
  'input[inputmode="numeric"]',
  'input[autocomplete="one-time-code"]',
  'input[placeholder*="code"]',
];

const OTP_SUBMIT_SELECTORS = [
  // TikTok 2FA submit buttons
  'button:has-text("Submit")',
  'button:has-text("Verify")',
  'button:has-text("Confirm")',
  'button:has-text("Next")',
  'button:has-text("Xác minh")',
  'button:has-text("Tiếp")',
  'button[type="submit"]',
  'button[data-e2e*="verify"]',
  'button[data-e2e*="confirm"]',
];

const CAPTCHA_MARKERS = [
  'captcha',
  'verify you are human',
  'verify to continue',
  'security verification',
  'drag the slider',
  'slide to verify',
  'puzzle',
  'select 2 objects',
  'select two objects',
  'same shape',
  'same object',
  'rotate the',
];

const TWO_FA_MARKERS = [
  'verification code',
  'enter 6-digit code',
  'enter the code',
  '2-step verification',
  'two-factor',
  'authenticator',
  'one-time code',
  'verify your identity',
  'security code',
];

// ============================================================
// BrowserManager
// ============================================================

export class BrowserManager {
  private config: Required<BrowserManagerConfig>;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private tokenInterceptor: TokenInterceptor;
  private captchaHandler: CaptchaHandler | null = null;
  private isReady = false;
  private lastInitTime: number | null = null;

  constructor(config: BrowserManagerConfig = {}) {
    this.config = {
      omoCaptchaApiKey: config.omoCaptchaApiKey || '',
      entryUrl: config.entryUrl || DEFAULT_ENTRY_URL,
      loginUrl: config.loginUrl || DEFAULT_LOGIN_URL,
      headless: config.headless ?? true,
      executablePath: config.executablePath || '',
      userDataDir: config.userDataDir || '',
      proxyServer: config.proxyServer || '',
      chromiumArgs: config.chromiumArgs || [],
      statePath: config.statePath || DEFAULT_STATE_PATH,
      cookieDomain: config.cookieDomain || DEFAULT_COOKIE_DOMAIN,
      navigationTimeoutMs: config.navigationTimeoutMs || DEFAULT_NAVIGATION_TIMEOUT,
      loginActionTimeoutMs: config.loginActionTimeoutMs || DEFAULT_LOGIN_ACTION_TIMEOUT,
      sessionRefreshMinutes: config.sessionRefreshMinutes || DEFAULT_SESSION_REFRESH_MINUTES,
      viewportWidth: config.viewportWidth || 1366,
      viewportHeight: config.viewportHeight || 768,
    };

    this.tokenInterceptor = new TokenInterceptor({
      filterPath: '/api/',
      onTokenUpdate: (snapshot) => {
        console.log(
          `[browser-manager] Token updated: msToken=${snapshot.msToken ? 'YES' : 'NO'} X-Bogus=${snapshot.xBogus ? 'YES' : 'NO'} X-Gnarly=${snapshot.xGnarly ? 'YES' : 'NO'}`,
        );
      },
    });

    if (this.config.omoCaptchaApiKey) {
      this.captchaHandler = new CaptchaHandler({
        omoCaptchaApiKey: this.config.omoCaptchaApiKey,
      });
    }
  }

  // ----------------------------------------------------------
  // Browser Lifecycle
  // ----------------------------------------------------------

  async init(): Promise<void> {
    if (this.browser && this.page && this.isReady && !this.shouldRefreshSession()) {
      return;
    }

    await this.close();

    console.log('[browser-manager] Khoi tao Playwright browser...');

    const launchOptions: Record<string, unknown> = {
      headless: this.config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--window-size=1366,768',
        ...this.config.chromiumArgs,
      ],
    };

    if (this.config.executablePath) {
      launchOptions.executablePath = this.config.executablePath;
    }

    if (this.config.proxyServer) {
      launchOptions.proxy = { server: this.config.proxyServer };
    }

    this.browser = await chromium.launch(launchOptions);

    // Create context with anti-detection settings
    this.context = await this.browser.newContext({
      viewport: {
        width: this.config.viewportWidth,
        height: this.config.viewportHeight,
      },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Asia/Ho_Chi_Minh',
      permissions: [],
      javaScriptEnabled: true,
    });

    // Anti-detection scripts
    await this.context.addInitScript(() => {
      // Override navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Override navigator.plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override navigator.languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Override chrome runtime
      (window as any).chrome = { runtime: {} };

      // Override permissions
      const originalQuery = window.navigator.permissions?.query?.bind(
        window.navigator.permissions,
      );
      if (originalQuery) {
        window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: 'denied' } as PermissionStatus)
            : originalQuery(parameters);
      }
    });

    // Load saved session
    await this.loadPersistedSession();

    // Attach token interceptor
    this.tokenInterceptor.attachToContext(this.context);

    // Create page
    this.page = await this.context.newPage();

    // Navigate to entry URL
    await this.page.goto(this.config.entryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.navigationTimeoutMs,
    });

    // Wait for page to settle
    await this.page.waitForTimeout(2000);

    // Update tokens from cookies
    await this.tokenInterceptor.updateFromContext(this.context);

    this.isReady = true;
    this.lastInitTime = Date.now();

    console.log('[browser-manager] Browser da san sang.');
  }

  async close(): Promise<void> {
    const closeWithTimeout = async (task: Promise<void>, name: string) => {
      try {
        await Promise.race([
          task,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
        ]);
      } catch (e) {
        console.warn(`[browser-manager] ${name} close timeout/error`);
      }
    };

    if (this.page) await closeWithTimeout(this.page.close(), 'page');
    if (this.context) await closeWithTimeout(this.context.close(), 'context');
    if (this.browser) await closeWithTimeout(this.browser.close(), 'browser');

    this.browser = null;
    this.context = null;
    this.page = null;
    this.isReady = false;
  }

  async restart(): Promise<void> {
    await this.close();
    await this.init();
  }

  // ----------------------------------------------------------
  // Session Management
  // ----------------------------------------------------------

  async getSession(): Promise<{
    cookies: SimpleCookie[];
    tokens: TokenSnapshot;
    cookieHeader: string;
    csrfToken: string;
    ready: boolean;
  }> {
    await this.ensureReady();

    const cookies = await this.context!.cookies();
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

    await this.tokenInterceptor.updateFromContext(this.context!);
    const tokenSnapshot = this.tokenInterceptor.getSnapshot();

    const csrfCookie = cookies.find((c) =>
      ['csrftoken', 'csrf_session_id', 'tt_csrf_token'].includes(c.name),
    );

    return {
      cookies: simpleCookies,
      tokens: tokenSnapshot,
      cookieHeader: buildCookieHeader(simpleCookies),
      csrfToken: csrfCookie?.value || tokenSnapshot.xCsrfToken || '',
      ready: this.isReady,
    };
  }

  async saveSession(): Promise<{ path: string; cookieCount: number; savedAt: string }> {
    const session = await this.getSession();
    const state: PersistedSessionState = {
      version: 2,
      savedAt: new Date().toISOString(),
      entryUrl: this.config.entryUrl,
      cookies: session.cookies,
      tokens: {
        msToken: session.tokens.msToken,
        xBogus: session.tokens.xBogus,
        xGnarly: session.tokens.xGnarly,
        xCsrfToken: session.tokens.xCsrfToken,
      },
      cookieHeader: session.cookieHeader,
      userAgent: session.tokens.userAgent,
    };

    const result = await saveSessionState(this.config.statePath, state);
    return { ...result, savedAt: state.savedAt };
  }

  async clearSession(): Promise<{ clearedCookies: number; removedStatePath: string }> {
    await this.ensureReady();

    const cookies = await this.context!.cookies();
    await this.context!.clearCookies();
    await removeSessionState(this.config.statePath);
    this.tokenInterceptor.reset();

    return {
      clearedCookies: cookies.length,
      removedStatePath: normalizeStatePath(this.config.statePath),
    };
  }

  async importCookies(payload: {
    cookies?: SimpleCookie[];
    cookieHeader?: string;
    domain?: string;
  }): Promise<{ imported: number }> {
    await this.ensureReady();

    let cookies = payload.cookies || [];

    if (!cookies.length && payload.cookieHeader) {
      cookies = payload.cookieHeader
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const eqIndex = part.indexOf('=');
          if (eqIndex < 0) throw new Error(`Cookie header khong hop le: ${part}`);
          return {
            name: part.slice(0, eqIndex).trim(),
            value: part.slice(eqIndex + 1).trim(),
            domain: payload.domain || this.config.cookieDomain,
            path: '/',
            secure: true,
          };
        });
    }

    if (!cookies.length) {
      throw new Error('Khong co cookie nao de import.');
    }

    const normalized = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || payload.domain || this.config.cookieDomain,
      path: c.path || '/',
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: (c.sameSite || 'None') as 'Strict' | 'Lax' | 'None',
      expires: c.expires,
    }));

    await this.context!.addCookies(normalized);

    // Navigate to reload with new cookies
    await this.page!.goto(this.config.entryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.navigationTimeoutMs,
    });

    await this.tokenInterceptor.updateFromContext(this.context!);
    await this.saveSession();

    return { imported: normalized.length };
  }

  // ----------------------------------------------------------
  // Login Flow
  // ----------------------------------------------------------

  async getLoginStatus(): Promise<LoginStatusPayload> {
    await this.ensureReady();

    const cookies = await this.context!.cookies();
    const currentUrl = this.page!.url();
    const title = await this.page!.title().catch(() => null);
    const bodyText = await this.page!.evaluate(() =>
      (document.body?.innerText || '').toLowerCase(),
    );
    const lowerUrl = (currentUrl || '').toLowerCase();

    const hasPasswordField = await this.hasVisibleSelector(PASSWORD_SELECTORS);
    const hasOtpField = await this.hasVisibleSelector(OTP_SELECTORS);
    const hasCaptchaMarker = CAPTCHA_MARKERS.some(
      (marker) => lowerUrl.includes(marker) || bodyText.includes(marker),
    );
    const hasTwoFaMarker = TWO_FA_MARKERS.some((marker) => bodyText.includes(marker));

    let stage: LoginStatusPayload['stage'] = 'unknown';
    let reason = 'Khong xac dinh duoc trang thai dang nhap.';
    let loggedInLikely = false;

    if (hasCaptchaMarker) {
      stage = 'captcha';
      reason = 'Dang gap buoc captcha hoac security verification.';
    } else if (hasOtpField || hasTwoFaMarker) {
      stage = 'needs_2fa';
      reason = 'Dang o buoc nhap ma xac thuc 2FA.';
    } else if (hasPasswordField) {
      stage = 'needs_credentials';
      reason = 'Dang o man hinh nhap tai khoan/mat khau.';
    } else if (
      cookies.length > 0 &&
      !lowerUrl.includes('login') &&
      !lowerUrl.includes('passport') &&
      !lowerUrl.includes('signin')
    ) {
      stage = 'logged_in';
      loggedInLikely = true;
      reason = 'Session hien tai co ve da dang nhap vao Ads.';
    } else if (!cookies.length) {
      stage = 'needs_credentials';
      reason = 'Khong co cookie trong session hien tai.';
    } else if (
      lowerUrl.includes('login') ||
      lowerUrl.includes('passport') ||
      lowerUrl.includes('signin')
    ) {
      stage = 'needs_credentials';
      reason = `Page hien tai dang o man login: ${currentUrl}`;
    }

    return {
      status: 'ok',
      stage,
      loggedInLikely,
      currentUrl,
      title,
      reason,
      cookieCount: cookies.length,
    };
  }

  async navigateToLogin(): Promise<LoginStatusPayload> {
    await this.ensureReady();
    await this.page!.goto(this.config.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.navigationTimeoutMs,
    });
    return this.getLoginStatus();
  }

  async submitCredentials(payload: {
    username: string;
    password: string;
  }): Promise<LoginStatusPayload> {
    if (!payload.username || !payload.password) {
      throw new Error('Thieu username hoac password.');
    }

    await this.ensureReady();

    const statusBefore = await this.getLoginStatus();
    if (statusBefore.stage === 'needs_2fa') {
      return statusBefore;
    }

    // Nếu đang ở captcha → xử lý captcha trước
    if (statusBefore.stage === 'captcha') {
      console.log('[browser-manager] Phat hien captcha truoc khi login, dang giai...');
      if (this.captchaHandler) {
        await this.captchaHandler.handleCaptcha(this.page!);
        await this.waitAfterLoginAction();
      }
      return this.getLoginStatus();
    }

    // Nếu cookie die hoặc chưa ở trang login → navigate về trang login
    if (statusBefore.stage !== 'needs_credentials') {
      console.log('[browser-manager] Chuyen huong den trang login...');
      try {
        await this.page!.goto(this.config.loginUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.config.navigationTimeoutMs,
        });
      } catch {
        // ERR_ABORTED hoặc redirect - wait rồi kiểm tra
        console.log('[browser-manager] Navigation aborted (redirect), dang doi page settle...');
      }
      await this.page!.waitForTimeout(3000);
    }

    // Đóng mọi overlay/modal popup (cookie consent, etc.)
    await this.dismissOverlayModals();

    // Đợi form login xuất hiện (tối đa 10s)
    console.log('[browser-manager] Doi form login xuat hien...');
    try {
      await this.page!.waitForSelector(
        USERNAME_SELECTORS.map(s => s).join(', '),
        { state: 'visible', timeout: 10000 },
      );
    } catch {
      console.log('[browser-manager] Khong thay form login, thu reload...');
      try {
        await this.page!.goto(this.config.loginUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.config.navigationTimeoutMs,
        });
      } catch {
        console.log('[browser-manager] Reload aborted, doi page settle...');
      }
      await this.page!.waitForTimeout(3000);
      await this.dismissOverlayModals();
    }

    // Fill username
    console.log('[browser-manager] Dang nhap email...');
    await this.fillInput(USERNAME_SELECTORS, payload.username);
    await this.page!.waitForTimeout(500);

    // Fill password
    console.log('[browser-manager] Dang nhap password...');
    await this.fillInput(PASSWORD_SELECTORS, payload.password);
    await this.page!.waitForTimeout(500);

    // Submit
    console.log('[browser-manager] Click Log in...');
    await this.submitForm();

    // Sau khi click login, chờ 3s cho captcha hoặc redirect
    await this.page!.waitForTimeout(3000);

    // Kiểm tra captcha modal xuất hiện
    const postClickStatus = await this.getLoginStatus();
    if (postClickStatus.stage === 'captcha') {
      console.log('[browser-manager] Captcha xuat hien sau khi click Login!');
      if (this.captchaHandler) {
        const solved = await this.captchaHandler.handleCaptcha(this.page!);
        console.log(`[browser-manager] Ket qua giai captcha: ${solved ? 'THANH CONG' : 'THAT BAI'}`);
      } else {
        console.log('[browser-manager] Khong co captcha handler, vui long giai captcha thu cong.');
      }
    }

    // Chờ thêm cho navigation sau captcha/login
    await this.waitAfterLoginAction();

    const status = await this.getLoginStatus();
    if (status.stage === 'logged_in') {
      console.log('[browser-manager] Dang nhap thanh cong, dang luu session...');
      await this.saveSession();
    }

    return status;
  }

  async submitTwoFactor(payload: { code: string }): Promise<LoginStatusPayload> {
    if (!payload.code) {
      throw new Error('Thieu ma 2FA.');
    }

    await this.ensureReady();

    // Bước 1: Click "Switch to 2-step verification by authenticator app" nếu có
    console.log('[browser-manager] Tim link "Switch to authenticator app"...');
    const switchSelectors = [
      'a:has-text("Switch to 2-step verification by authenticator app")',
      'a:has-text("Switch to 2-step verification")',
      'a:has-text("authenticator app")',
      'a:has-text("authenticator")',
      ':text("Switch to 2-step verification by authenticator app")',
    ];

    let switched = false;
    for (const selector of switchSelectors) {
      try {
        const link = await this.page!.$(selector);
        if (link) {
          const visible = await link.evaluate((el) => {
            const rect = (el as HTMLElement).getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (visible) {
            console.log('[browser-manager] Click "Switch to authenticator app"...');
            await link.click({ force: true });
            switched = true;
            await this.page!.waitForTimeout(2000);
            break;
          }
        }
      } catch {
        continue;
      }
    }

    if (!switched) {
      console.log('[browser-manager] Khong tim thay link switch, co the da o trang authenticator.');
    }

    // Bước 2: Nhập mã TOTP
    // TikTok dùng 6 ô input riêng biệt cho mỗi chữ số
    // Không log nguyên mã 2FA vào console — chỉ log dạng che.
    console.log(`[browser-manager] Dang nhap ma 2FA: ******${String(payload.code || '').slice(-2)}`);
    const digits = payload.code.split('');

    // Cách 1: Tìm 6 ô input riêng biệt
    const otpInputs = await this.page!.$$('input[type="tel"], input[inputmode="numeric"], input[maxlength="1"]');
    if (otpInputs.length >= 6) {
      console.log(`[browser-manager] Tim thay ${otpInputs.length} o input rieng biet.`);
      for (let i = 0; i < Math.min(digits.length, otpInputs.length); i++) {
        await otpInputs[i].click({ force: true });
        await otpInputs[i].fill(digits[i]);
        await this.page!.waitForTimeout(100);
      }
    } else {
      // Cách 2: Tìm input OTP đơn hoặc click vào ô đầu tiên rồi gõ
      console.log('[browser-manager] Thu tim input OTP don hoac click vao o dau...');

      // Tìm bất kỳ ô input nào visible trên trang 2FA
      const allInputs = await this.page!.$$('input:visible');
      let found = false;
      for (const input of allInputs) {
        const inputType = await input.getAttribute('type');
        const isHidden = inputType === 'hidden' || inputType === 'checkbox';
        if (isHidden) continue;

        try {
          await input.click({ force: true });
          // Gõ từng số, mỗi input sẽ tự focus sang ô tiếp theo
          for (const digit of digits) {
            await this.page!.keyboard.type(digit, { delay: 80 });
            await this.page!.waitForTimeout(100);
          }
          found = true;
          break;
        } catch {
          continue;
        }
      }

      if (!found) {
        // Cách 3: Fallback - focus bất kỳ đâu và gõ
        console.log('[browser-manager] Fallback: go truc tiep ma OTP...');
        await this.page!.keyboard.type(payload.code, { delay: 80 });
      }
    }

    await this.page!.waitForTimeout(1000);

    // Bước 3: Click Submit/Verify nếu cần
    console.log('[browser-manager] Click Submit/Verify...');
    let submitted = false;
    for (const selector of OTP_SUBMIT_SELECTORS) {
      try {
        const button = await this.page!.$(selector);
        if (button) {
          const visible = await button.evaluate((el) => {
            const htmlEl = el as HTMLElement;
            const rect = htmlEl.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (visible) {
            await button.click({ force: true });
            submitted = true;
            break;
          }
        }
      } catch {
        // ignore
      }
    }
    if (!submitted) {
      // Nhấn Enter để submit thay vì chờ auto-submit (vì đôi khi TikTok không tự submit)
      console.log('[browser-manager] Khong tim thay nut submit, an Enter de xac nhan...');
      await this.page!.keyboard.press('Enter');
    }

    await this.waitAfterLoginAction();

    const status = await this.getLoginStatus();
    if (status.stage === 'logged_in') {
      console.log('[browser-manager] 2FA thanh cong, dang luu session...');
      await this.saveSession();
    }

    return status;
  }

  // ----------------------------------------------------------
  // Sign Request - Ký request thông qua browser context
  // ----------------------------------------------------------

  /**
   * Gửi request thông qua browser context để tự động sign
   * Browser sẽ tự thêm X-Bogus, X-Gnarly, msToken, cookies
   */
  async signRequest(input: SignRequestInput): Promise<SignRequestResult> {
    await this.ensureReady();

    if (!input.url) {
      throw new Error('Thieu url.');
    }

    const method = (input.method || 'GET').toUpperCase();
    const headers = { ...(input.headers || {}) };
    const timeoutMs = input.timeoutMs || this.config.navigationTimeoutMs;

    if (input.prepareUrl) {
      await this.page!.goto(input.prepareUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      await this.page!.waitForTimeout(2500);
      await this.tokenInterceptor.updateFromContext(this.context!);
      const tokenSnapshot = this.tokenInterceptor.getSnapshot();
      const hasHeader = (name: string) =>
        Object.keys(headers).some((headerName) => headerName.toLowerCase() === name.toLowerCase());

      for (const [name, value] of Object.entries(tokenSnapshot.lastSignedHeaders || {})) {
        const lowerName = name.toLowerCase();
        if ((lowerName.startsWith('tt-ticket-') || lowerName === 'x-tt-token') && value && !hasHeader(name)) {
          headers[name] = value;
        }
      }

      if (tokenSnapshot.xCsrfToken && !hasHeader('x-csrftoken')) {
        headers['x-csrftoken'] = tokenSnapshot.xCsrfToken;
      }

      const ticketHeaderCount = Object.keys(headers).filter((name) =>
        name.toLowerCase().startsWith('tt-ticket-')
      ).length;
      console.log(
        `[browser-manager] signRequest context ready: tt-ticket headers=${ticketHeaderCount} csrf=${hasHeader('x-csrftoken') ? 'YES' : 'NO'}`
      );
    }

    // Capture the signed request
    const capturedPromise = new Promise<{
      url: string;
      headers: Record<string, string>;
    }>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.page!.off('request', onRequest);
          reject(new Error('Khong bat duoc request da ky trong thoi gian cho.'));
        }
      }, timeoutMs);

      const onRequest = (request: any): void => {
        try {
          const requestUrl: string = request.url();
          if (!requestUrl.includes(new URL(input.url).pathname)) return;
          if (settled) return;

          settled = true;
          clearTimeout(timer);
          this.page!.off('request', onRequest);

          resolve({
            url: requestUrl,
            headers: request.headers(),
          });
        } catch {
          // ignore
        }
      };

      this.page!.on('request', onRequest);
    });

    // Execute fetch in browser context with a hard timeout to prevent infinite hangs.
    // page.evaluate() has no built-in timeout — if TikTok's server never responds,
    // it blocks forever and makes the signer (and therefore the bot) unresponsive.
    const rawFetchPromise = this.page!.evaluate(
      async ({ url, method, headers, body, formData, referrer }) => {
        try {
          if (formData && typeof formData === 'object') {
            const data = new FormData();
            for (const [key, value] of Object.entries(formData)) {
              data.append(key, String(value));
            }

            const xhrResult = await new Promise<{
              ok: boolean;
              status: number;
              statusText: string;
              bodyText: string;
              bodyJson?: unknown;
            }>((resolve) => {
              const xhr = new XMLHttpRequest();
              xhr.open(method, url, true);
              xhr.withCredentials = true;
              for (const [key, value] of Object.entries(headers || {})) {
                if (key.toLowerCase() === 'content-type') continue;
                xhr.setRequestHeader(key, String(value));
              }
              xhr.onload = () => {
                const bodyText = String(xhr.responseText || '');
                let bodyJson: unknown;
                try {
                  bodyJson = JSON.parse(bodyText);
                } catch {
                  // not json
                }
                resolve({
                  ok: xhr.status >= 200 && xhr.status < 300,
                  status: xhr.status,
                  statusText: xhr.statusText,
                  bodyText: bodyText.slice(0, 50000),
                  bodyJson,
                });
              };
              xhr.onerror = () => {
                resolve({
                  ok: false,
                  status: xhr.status || 0,
                  statusText: xhr.statusText || 'XHR error',
                  bodyText: String(xhr.responseText || '').slice(0, 50000),
                });
              };
              xhr.send(data);
            });

            return xhrResult;
          }

          const response = await fetch(url, {
            method,
            headers,
            body: body || undefined,
            credentials: 'include',
            referrer: referrer || undefined,
          });

          const bodyText = await response.text();
          let bodyJson: unknown;
          try {
            bodyJson = JSON.parse(bodyText);
          } catch {
            // not json
          }

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            bodyText: bodyText.slice(0, 50000),
            bodyJson,
          };
        } catch (error) {
          return { fetchError: String(error) };
        }
      },
      {
        url: input.url,
        method,
        headers,
        body: input.body,
        formData: input.formData,
        referrer: input.referrer,
      },
    );

    // Hard timeout: if page.evaluate never resolves, return an error instead of hanging.
    const fetchTimeoutMs = timeoutMs + 5000;
    const fetchPromise = Promise.race([
      rawFetchPromise,
      new Promise<{ fetchError: string }>((_, reject) =>
        setTimeout(
          () => reject(new Error(`signRequest page.evaluate timeout sau ${fetchTimeoutMs}ms cho ${input.url}`)),
          fetchTimeoutMs,
        ),
      ),
    ]);

    const [captured, fetchResult] = await Promise.all([
      capturedPromise.catch(() => null),
      fetchPromise.catch((err) => ({ fetchError: String(err instanceof Error ? err.message : err) })),
    ]);

    // Update tokens
    await this.tokenInterceptor.updateFromContext(this.context!);

    return {
      signedHeaders: captured?.headers || {},
      signedUrl: captured?.url || input.url,
      responseData: (fetchResult as any)?.bodyJson || (fetchResult as any)?.bodyText,
      responseStatus: (fetchResult as any)?.status,
    };
  }

  // ----------------------------------------------------------
  // Token Access
  // ----------------------------------------------------------

  getTokenSnapshot(): TokenSnapshot {
    return this.tokenInterceptor.getSnapshot();
  }

  getRecentExchanges(options?: {
    limit?: number;
    pathIncludes?: string;
  }) {
    const exchanges = this.tokenInterceptor.getExchanges();
    const pathIncludes = String(options?.pathIncludes || '').trim().toLowerCase();
    const filtered = pathIncludes
      ? exchanges.filter((exchange) =>
          exchange.request.url.toLowerCase().includes(pathIncludes)
        )
      : exchanges;
    const limit = Math.max(1, Number(options?.limit || filtered.length || 20));
    return filtered.slice(-limit);
  }

  clearRecentExchanges(): void {
    this.tokenInterceptor.clearExchanges();
  }

  async refreshTokens(): Promise<TokenSnapshot> {
    await this.ensureReady();
    await this.tokenInterceptor.updateFromContext(this.context!);

    // Navigate to trigger token refresh
    await this.page!.reload({ waitUntil: 'domcontentloaded' });
    await this.page!.waitForTimeout(3000);
    await this.tokenInterceptor.updateFromContext(this.context!);

    return this.tokenInterceptor.getSnapshot();
  }

  /**
   * Lấy health status
   */
  getHealth(): {
    status: 'ok';
    ready: boolean;
    headless: boolean;
    entryUrl: string;
    sessionAgeMinutes: number | null;
    statePath: string;
  } {
    return {
      status: 'ok',
      ready: this.isReady,
      headless: this.config.headless,
      entryUrl: this.config.entryUrl,
      sessionAgeMinutes: this.lastInitTime
        ? Math.round((Date.now() - this.lastInitTime) / 60000)
        : null,
      statePath: normalizeStatePath(this.config.statePath),
    };
  }

  async publishCampaignDraft(
    input: PublishCampaignDraftInput,
  ): Promise<PublishCampaignDraftResult> {
    await this.ensureReady();
    this.clearRecentExchanges();

    if (!input.advertiserId) {
      throw new Error('Thieu advertiserId de publish draft.');
    }

    const timeoutMs = input.timeoutMs || Math.max(this.config.loginActionTimeoutMs, 60000);
    const navigationUrl = new URL(this.config.entryUrl);
    navigationUrl.searchParams.set('aadvid', input.advertiserId);

    console.log(
      `[browser-manager] Dang thu publish draft campaign "${input.campaignName || input.campaignId || 'unknown'}"...`,
    );

    await this.page!.goto(navigationUrl.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: this.config.navigationTimeoutMs,
    });
    await this.page!.waitForTimeout(4000);
    await this.page!.waitForLoadState('networkidle').catch(() => undefined);
    await this.dismissOverlayModals();
    await this.expandDraftSections();
    await this.applyCampaignListSearch(input.campaignName || input.campaignId || '');

    const selectedRow = await this.selectCampaignDraftRow({
      campaignId: input.campaignId,
      campaignName: input.campaignName,
      timeoutMs,
    });

    if (!selectedRow.matched) {
      return {
        published: false,
        reason: 'Khong tim thay dong draft tren giao dien Ads Manager.',
      };
    }

    const publishClick = await this.clickVisibleButtonByText(
      [
        'publish',
        'publish draft',
        'review and publish',
        'xuat ban',
        'xuat ban nhap',
        'hoan tat',
      ],
      false,
    );

    let effectivePublishClick = publishClick;
    if (!effectivePublishClick.clicked) {
      await this.openActionMenu();
      effectivePublishClick = await this.clickVisibleButtonByText(
        [
          'publish',
          'publish draft',
          'review and publish',
          'xuat ban',
          'xuat ban nhap',
          'hoan tat',
        ],
        false,
      );
    }

    if (!effectivePublishClick.clicked) {
      const capturedCreationExchanges = this.getRecentExchanges({
        limit: 20,
        pathIncludes: '/api/v4/i18n/creation',
      });
      return {
        published: false,
        reason: 'Da tim thay draft nhung khong tim thay nut publish.',
        matchedRowText: selectedRow.rowText,
        capturedCreationUrls: capturedCreationExchanges.map(exchange => exchange.request.url),
        capturedCreationStatuses: capturedCreationExchanges.map(exchange => ({
          url: exchange.request.url,
          status: exchange.response?.status,
        })),
      };
    }

    await this.page!.waitForTimeout(1500);

    const confirmClick = await this.clickVisibleButtonByText(
      [
        'publish',
        'confirm',
        'submit',
        'ok',
        'xac nhan',
        'dong y',
        'xuat ban',
      ],
      true,
    );

    await this.page!.waitForTimeout(5000);
    await this.tokenInterceptor.updateFromContext(this.context!);
    await this.saveSession().catch(() => undefined);
    const capturedCreationExchanges = this.getRecentExchanges({
      limit: 30,
      pathIncludes: '/api/v4/i18n/creation',
    });

    return {
      published: true,
      reason: confirmClick.clicked
        ? 'Da click publish va xac nhan tren Ads Manager.'
        : 'Da click publish tren Ads Manager.',
      matchedRowText: selectedRow.rowText,
      publishButtonText: effectivePublishClick.text,
      confirmButtonText: confirmClick.text,
      capturedCreationUrls: capturedCreationExchanges.map(exchange => exchange.request.url),
      capturedCreationStatuses: capturedCreationExchanges.map(exchange => ({
        url: exchange.request.url,
        status: exchange.response?.status,
      })),
    };
  }

  // ----------------------------------------------------------
  // Private Helpers
  // ----------------------------------------------------------

  private async ensureReady(): Promise<void> {
    await this.init();
    if (!this.page) {
      throw new Error('Browser page chua san sang.');
    }
  }

  private shouldRefreshSession(): boolean {
    if (!this.lastInitTime) return false;
    return Date.now() - this.lastInitTime > this.config.sessionRefreshMinutes * 60 * 1000;
  }

  private async loadPersistedSession(): Promise<void> {
    if (!this.context) return;

    const state = await loadSessionState(this.config.statePath);
    if (!state || !state.cookies.length) return;

    const normalized = state.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || this.config.cookieDomain,
      path: c.path || '/',
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: (c.sameSite || 'None') as 'Strict' | 'Lax' | 'None',
      expires: c.expires,
    }));

    await this.context.addCookies(normalized);
    console.log(`[browser-manager] Da load ${normalized.length} cookies tu session.`);
  }

  private async hasVisibleSelector(selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      const element = await this.page!.$(selector);
      if (element) {
        const visible = await element.evaluate((el) => {
          const htmlEl = el as HTMLElement;
          const style = window.getComputedStyle(htmlEl);
          const rect = htmlEl.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
        if (visible) return true;
      }
    }
    return false;
  }

  private async fillInput(selectors: string[], value: string): Promise<void> {
    for (const selector of selectors) {
      try {
        const element = await this.page!.$(selector);
        if (!element) continue;

        const visible = await element.evaluate((el) => {
          const htmlEl = el as HTMLElement;
          const style = window.getComputedStyle(htmlEl);
          const rect = htmlEl.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
        if (!visible) continue;

        // Thử click bình thường trước
        try {
          await element.click({ clickCount: 3, timeout: 3000 });
        } catch {
          // Nếu bị overlay chặn → dùng force click
          console.log(`[browser-manager] Force click vao ${selector} (overlay chan)...`);
          await element.click({ clickCount: 3, force: true });
        }
        await this.page!.keyboard.press('Backspace');
        await element.type(value, { delay: 30 });
        return;
      } catch {
        continue;
      }
    }
    throw new Error(`Khong tim thay o input phu hop: ${selectors.join(', ')}`);
  }

  private async submitForm(): Promise<void> {
    for (const selector of SUBMIT_SELECTORS) {
      try {
        const button = await this.page!.$(selector);
        if (!button) continue;

        const visible = await button.evaluate((el) => {
          const htmlEl = el as HTMLElement;
          const style = window.getComputedStyle(htmlEl);
          const rect = htmlEl.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
        if (!visible) continue;

        try {
          await button.click({ timeout: 3000 });
        } catch {
          console.log(`[browser-manager] Force click vao button (overlay chan)...`);
          await button.click({ force: true });
        }
        return;
      } catch {
        continue;
      }
    }
    await this.page!.keyboard.press('Enter');
  }

  /**
   * Đóng mọi overlay/modal popup (cookie consent, quảng cáo, etc.)
   * TikTok dùng TUXModal-overlay cho các popup
   */
  private async dismissOverlayModals(): Promise<void> {
    // Chỉ đóng các modal overlay dạng popup/dialog
    // KHÔNG click các button generic trên trang login
    const dismissSelectors = [
      // TikTok modal close X button
      '.TUXModal-overlay button[aria-label="Close"]',
      '.TUXModal-overlay button[aria-label="close"]',
      // Cookie consent specific
      '[class*="cookie"] button:has-text("Accept")',
      '[class*="cookie"] button:has-text("Accept All")',
      '[class*="consent"] button:has-text("Accept")',
    ];

    for (const selector of dismissSelectors) {
      try {
        const el = await this.page!.$(selector);
        if (el) {
          const visible = await el.evaluate((e) => {
            const r = (e as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (visible) {
            // Kiểm tra xem đây có phải captcha modal không
            // Nếu là captcha thì KHÔNG đóng
            const parentText = await el.evaluate((e) => {
              const modal = e.closest('.TUXModal-overlay, [class*="modal"]');
              return (modal?.textContent || '').toLowerCase();
            });
            const isCaptchaModal = CAPTCHA_MARKERS.some(m => parentText.includes(m));
            if (isCaptchaModal) {
              console.log('[browser-manager] Tim thay captcha modal, khong dong.');
              continue;
            }

            await el.click({ force: true });
            console.log(`[browser-manager] Da dong modal: ${selector}`);
            await this.page!.waitForTimeout(500);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  private async expandDraftSections(): Promise<void> {
    await this.page!.evaluate(() => {
      const normalize = (value: string) =>
        value
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[đĐ]/g, 'd')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();

      const isVisible = (element: Element) => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const looksLikeDraftToggle = (text: string) => {
        const normalized = normalize(text);
        return (
          (normalized.includes('draft') && normalized.includes('campaign')) ||
          normalized.includes('draft campaigns') ||
          normalized.includes('chien dich nhap') ||
          (normalized.includes('ban co') && normalized.includes('nhap'))
        );
      };

      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], summary, [aria-expanded]'),
      );

      let clicked = 0;
      for (const candidate of candidates) {
        if (!isVisible(candidate)) continue;
        if (!looksLikeDraftToggle(candidate.textContent || '')) continue;
        const expanded = candidate.getAttribute('aria-expanded');
        if (expanded === 'true') continue;
        (candidate as HTMLElement).click();
        clicked += 1;
        if (clicked >= 2) break;
      }
    });

    await this.page!.waitForTimeout(1000);
  }

  private async applyCampaignListSearch(term: string): Promise<void> {
    const trimmedTerm = String(term || '').trim();
    if (!trimmedTerm) {
      return;
    }

    const applied = await this.page!.evaluate((searchTerm) => {
      const isVisible = (element: Element) => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const selectors = [
        'input[type="search"]',
        'input[role="searchbox"]',
        'input[placeholder*="Search"]',
        'input[placeholder*="search"]',
        'input[placeholder*="campaign"]',
        'input[placeholder*="Campaign"]',
        'input[aria-label*="Search"]',
        'input[aria-label*="search"]',
      ];

      for (const selector of selectors) {
        const input = document.querySelector(selector) as HTMLInputElement | null;
        if (!input || !isVisible(input)) continue;

        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.value = searchTerm;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        return true;
      }

      return false;
    }, trimmedTerm);

    if (applied) {
      await this.page!.waitForTimeout(2000);
    }
  }

  private async selectCampaignDraftRow(params: {
    campaignId?: string;
    campaignName?: string;
    timeoutMs: number;
  }): Promise<{ matched: boolean; rowText?: string }> {
    const deadline = Date.now() + params.timeoutMs;

    while (Date.now() < deadline) {
      const result = await this.page!.evaluate(({ campaignId, campaignName }) => {
        const normalize = (value: string) =>
          value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[đĐ]/g, 'd')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();

        const isVisible = (element: Element) => {
          const htmlElement = element as HTMLElement;
          const style = window.getComputedStyle(htmlElement);
          const rect = htmlElement.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const targets = [campaignId, campaignName]
          .map(value => normalize(String(value || '')))
          .filter(Boolean);

        if (targets.length === 0) {
          return { matched: false };
        }

        const rowSelectors = ['tr', '[role="row"]', 'li', '[data-row-key]'];
        const rows = rowSelectors.flatMap(selector => Array.from(document.querySelectorAll(selector)));

        for (const row of rows) {
          if (!isVisible(row)) continue;

          const rowText = normalize(
            [
              row.textContent || '',
              row.getAttribute('aria-label') || '',
              row.getAttribute('title') || '',
              row.getAttribute('data-row-key') || '',
            ].join(' ')
          );
          if (!rowText) continue;
          if (!targets.some(target => rowText.includes(target))) continue;

          const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
          if (checkbox && isVisible(checkbox)) {
            checkbox.scrollIntoView({ block: 'center' });
            checkbox.click();
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            (row as HTMLElement).scrollIntoView({ block: 'center' });
            (row as HTMLElement).click();
          }

          return {
            matched: true,
            rowText: (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          };
        }

        return { matched: false };
      }, params);

      if (result.matched) {
        return result;
      }

      await this.expandDraftSections();
      await this.page!.waitForTimeout(1500);
    }

    return { matched: false };
  }

  private async openActionMenu(): Promise<void> {
    await this.clickVisibleButtonByText(
      ['more', 'actions', 'more actions', 'hanh dong', 'them'],
      false,
    );
    await this.page!.waitForTimeout(1000);
  }

  private async clickVisibleButtonByText(
    textPatterns: string[],
    preferDialog: boolean,
  ): Promise<{ clicked: boolean; text?: string }> {
    const result = await this.page!.evaluate(({ textPatterns, preferDialog }) => {
      const normalize = (value: string) =>
        value
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[đĐ]/g, 'd')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();

      const normalizedPatterns = textPatterns.map(normalize).filter(Boolean);

      const isVisible = (element: Element) => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const dialogCandidates = Array.from(
        document.querySelectorAll('[role="dialog"], .TUXModal, [class*="modal"], [class*="dialog"]'),
      );

      const scopes = preferDialog && dialogCandidates.length > 0
        ? dialogCandidates
        : [document.body];

      for (const scope of scopes) {
        const buttons = Array.from(
          scope.querySelectorAll(
            'button, [role="button"], [role="menuitem"], [type="button"], [type="submit"], a, [aria-label], [title]'
          ),
        );

        for (const button of buttons) {
          if (!isVisible(button)) continue;

          const text = [
            button.textContent || '',
            button.getAttribute('aria-label') || '',
            button.getAttribute('title') || '',
          ]
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          const normalizedText = normalize(text);
          if (!normalizedText) continue;
          if (!normalizedPatterns.some(pattern => normalizedText.includes(pattern))) continue;

          (button as HTMLElement).scrollIntoView({ block: 'center' });
          (button as HTMLElement).click();
          return { clicked: true, text };
        }
      }

      return { clicked: false };
    }, { textPatterns, preferDialog });

    return result;
  }

  private async waitAfterLoginAction(): Promise<void> {
    const timeout = this.config.loginActionTimeoutMs;
    await Promise.race([
      this.page!.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout,
      }).catch(() => null),
      this.page!.waitForTimeout(Math.min(timeout, 5000)),
    ]);
    await this.page!.waitForTimeout(2000);
  }
}
