/**
 * Auto Login - Tự động đăng nhập TikTok Ads Manager
 * - Đọc tài khoản bot từ SQLite/dashboard
 * - Tự tạo mã TOTP từ secret
 * - Gọi BrowserManager để login + xử lý 2FA
 */

import { getAccountBotCredentials, type AccountBotCredentials } from '../google-sheets/api.js';
import { generateTOTP, waitForFreshTOTP } from './totp.js';
import type { BrowserManager } from './browser-manager.js';

// ============================================================
// Types
// ============================================================

export interface AutoLoginResult {
  success: boolean;
  stage: string;
  reason: string;
  credentials?: {
    email: string;
    hasTotpSecret: boolean;
  };
  attempts: number;
}

// ============================================================
// Auto Login
// ============================================================

const MAX_LOGIN_ATTEMPTS = 3;
const WAIT_BETWEEN_ATTEMPTS_MS = 3000;

/**
 * Tự động đăng nhập TikTok Ads Manager:
 * 1. Đọc tài khoản bot từ SQLite/dashboard
 * 2. Kiểm tra login status
 * 3. Nếu chưa login → nhập credentials
 * 4. Nếu cần 2FA → generate TOTP code và nhập
 */
export async function autoLogin(
  browserManager: BrowserManager,
  onStatus?: (msg: string) => void,
): Promise<AutoLoginResult> {
  const log = (msg: string) => {
    console.log(`[auto-login] ${msg}`);
    onStatus?.(msg);
  };

  // Step 1: Đọc credentials từ SQLite/dashboard
  log('Dang doc tai khoan TikTok tu SQLite/dashboard...');
  let credentials: AccountBotCredentials | undefined;

  try {
    credentials = await getAccountBotCredentials();
  } catch (error) {
    log(`Loi doc cau hinh dang nhap: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      stage: 'read_credentials',
      reason: 'Khong doc duoc tai khoan TikTok tu SQLite/dashboard.',
      attempts: 0,
    };
  }

  if (!credentials) {
    log('Khong tim thay tai khoan TikTok day du trong dashboard hoac bien moi truong.');
    return {
      success: false,
      stage: 'read_credentials',
      reason: 'ACCOUNT_BOT khong ton tai hoac format sai (can: email|password|totp_secret).',
      attempts: 0,
    };
  }

  log(`Da doc credentials: email=${credentials.email}, 2FA=${credentials.totpSecret ? 'CO' : 'KHONG'}`);

  // Step 2: Kiểm tra login status hiện tại
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    log(`--- Lan thu ${attempt}/${MAX_LOGIN_ATTEMPTS} ---`);

    const status = await browserManager.getLoginStatus();
    log(`Trang thai hien tai: ${status.stage} - ${status.reason}`);

    // Đã đăng nhập
    if (status.stage === 'logged_in') {
      log('Da dang nhap thanh cong!');
      return {
        success: true,
        stage: 'logged_in',
        reason: status.reason,
        credentials: {
          email: credentials.email,
          hasTotpSecret: Boolean(credentials.totpSecret),
        },
        attempts: attempt,
      };
    }

    // Cần nhập credentials
    if (status.stage === 'needs_credentials' || status.stage === 'unknown') {
      log('Dang nhap credentials...');
      const loginResult = await browserManager.submitCredentials({
        username: credentials.email,
        password: credentials.password,
      });

      log(`Ket qua login: ${loginResult.stage} - ${loginResult.reason}`);

      if (loginResult.stage === 'logged_in') {
        log('Da dang nhap thanh cong sau khi nhap credentials!');
        return {
          success: true,
          stage: 'logged_in',
          reason: loginResult.reason,
          credentials: {
            email: credentials.email,
            hasTotpSecret: Boolean(credentials.totpSecret),
          },
          attempts: attempt,
        };
      }

      // Nếu cần 2FA → tiếp tục xử lý bên dưới
      if (loginResult.stage === 'needs_2fa') {
        log('Can nhap ma 2FA...');
        const twoFaResult = await handle2FA(browserManager, credentials, log);
        if (twoFaResult.success) {
          return { ...twoFaResult, attempts: attempt };
        }
      }

      // Nếu gặp captcha
      if (loginResult.stage === 'captcha') {
        log('Dang gap captcha, doi xu ly...');
        await sleep(5000);
        // Captcha handler sẽ được gọi tự động trong browserManager
      }
    }

    // Cần 2FA
    if (status.stage === 'needs_2fa') {
      log('Can nhap ma 2FA...');
      const twoFaResult = await handle2FA(browserManager, credentials, log);
      if (twoFaResult.success) {
        return { ...twoFaResult, attempts: attempt };
      }
    }

    // Captcha
    if (status.stage === 'captcha') {
      log('Dang gap captcha, thu doi...');
      await sleep(5000);
    }

    // Chờ giữa các lần thử
    if (attempt < MAX_LOGIN_ATTEMPTS) {
      log(`Doi ${WAIT_BETWEEN_ATTEMPTS_MS / 1000}s truoc khi thu lai...`);
      await sleep(WAIT_BETWEEN_ATTEMPTS_MS);
    }
  }

  return {
    success: false,
    stage: 'max_attempts',
    reason: `Da het ${MAX_LOGIN_ATTEMPTS} lan thu dang nhap.`,
    credentials: {
      email: credentials.email,
      hasTotpSecret: Boolean(credentials.totpSecret),
    },
    attempts: MAX_LOGIN_ATTEMPTS,
  };
}

/**
 * Xử lý 2FA: Generate TOTP và submit
 */
async function handle2FA(
  browserManager: BrowserManager,
  credentials: AccountBotCredentials,
  log: (msg: string) => void,
): Promise<AutoLoginResult> {
  if (!credentials.totpSecret) {
    log('Khong co TOTP secret de tao ma 2FA!');
    return {
      success: false,
      stage: 'needs_2fa',
      reason: 'ACCOUNT_BOT thieu TOTP secret (cot thu 3).',
      credentials: {
        email: credentials.email,
        hasTotpSecret: false,
      },
      attempts: 0,
    };
  }

  // Chờ mã TOTP mới (ít nhất 5 giây trước khi hết hạn)
  log('Dang tao ma TOTP...');
  const totpCode = await waitForFreshTOTP(credentials.totpSecret, 5);
  // Không log nguyên mã TOTP vào console — chỉ log dạng che.
  log(`Ma TOTP: ******${String(totpCode || '').slice(-2)} (6 chu so)`);

  // Submit 2FA
  log('Dang nhap ma 2FA...');
  const result = await browserManager.submitTwoFactor({ code: totpCode });
  log(`Ket qua 2FA: ${result.stage} - ${result.reason}`);

  if (result.stage === 'logged_in') {
    log('Da dang nhap thanh cong sau 2FA!');
    return {
      success: true,
      stage: 'logged_in',
      reason: result.reason,
      credentials: {
        email: credentials.email,
        hasTotpSecret: true,
      },
      attempts: 1,
    };
  }

  return {
    success: false,
    stage: result.stage,
    reason: result.reason,
    credentials: {
      email: credentials.email,
      hasTotpSecret: true,
    },
    attempts: 1,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
