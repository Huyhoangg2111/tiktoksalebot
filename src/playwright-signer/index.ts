/**
 * Playwright Signer - Entry Point
 *
 * Bộ công cụ Playwright cho TikTok Ads Manager:
 * - Thu thập msToken, X-Bogus, X-Gnarly, tt-ticket-*, x-csrftoken, cookies
 * - Tự động giải captcha TikTok qua OMO Captcha API
 * - HTTP API server để tích hợp vào dự án
 *
 * Chạy:
 *   npx ts-node src/playwright-signer/index.ts
 *   # hoặc thêm vào package.json:
 *   # "pw:signer": "npm run build && node dist/playwright-signer/index.js"
 *
 * Biến môi trường:
 *   PW_SIGNER_PORT=8092
 *   PW_SIGNER_HEADLESS=true|false
 *   OMO_CAPTCHA_API_KEY=your_key
 *   (xem thêm trong server.ts)
 */

import 'dotenv/config';
import { startServer } from './server.js';

void startServer();
