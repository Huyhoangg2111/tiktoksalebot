import { Markup, Telegraf, type Context } from 'telegraf';
import { config } from 'dotenv';
import { connectDB } from './db/index.js';
import { setupBotHandlers } from './bot/handlers.js';
import { initializeAlertRules } from './alerts/index.js';
import { getSchedulerHealthSnapshot, startScheduler } from './scheduler/index.js';
import { startServer, type SignerServerRuntime } from './playwright-signer/server.js';
import { configureHttpResilience } from './runtime/http-resilience.js';
import {
  getSmartPlusAdsByCampaignId,
  setSmartPlusAdStatus,
  type SmartPlusAdInfo,
  type SmartPlusOperationStatus,
} from './tiktok/smartplus-ad-test.js';

// Load environment variables
config();

let bot: Telegraf | undefined;
let signerRuntime: SignerServerRuntime | undefined;
let fatalExitScheduled = false;

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value || value.startsWith('your_') || value.endsWith('_here')) {
    throw new Error(`Missing ${name} in .env`);
  }

  return value;
}

function isEmbeddedSignerEnabled(): boolean {
  const rawValue = String(process.env.PW_SIGNER_INTERNAL_ENABLED || '')
    .trim()
    .toLowerCase();

  return ['true', '1', 'yes', 'on'].includes(rawValue);
}

function isAdminChat(ctx: Context): boolean {
  const adminChatId = process.env.ADMIN_CHAT_ID?.trim();
  return adminChatId ? String(ctx.chat?.id || '') === adminChatId : false;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSmartPlusAdStatus(ad?: SmartPlusAdInfo): string {
  if (!ad) return 'không đọc lại được';

  const parts = [
    ad.operationStatus ? `operation=${ad.operationStatus}` : '',
    ad.primaryStatus ? `primary=${ad.primaryStatus}` : '',
    ad.secondaryStatus ? `secondary=${ad.secondaryStatus}` : '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' · ') : 'không có trường status trong response';
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return '-';

  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return '-';
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${(durationMs / 60_000).toFixed(1)}m`;
}

function scheduleFatalExit(source: string, error: unknown): void {
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;

  console.error(`[FATAL] ${source}:`, error);
  console.error('[FATAL] Exiting process so Docker can restart the service.');
  setTimeout(() => process.exit(1), 1_000);
}

function registerSmartPlusAdTestHandlers(telegramBot: Telegraf): void {
  telegramBot.command('testsmartad', async (ctx) => {
    if (!isAdminChat(ctx)) {
      await ctx.reply('❌ Chỉ admin mới có thể chạy test Smart+ Ad.');
      return;
    }

    const args = ctx.message?.text.trim().split(/\s+/) || [];
    const campaignId = args[1]?.trim();

    if (!campaignId) {
      await ctx.reply(
        'Dùng: /testsmartad <campaign_id>\n\nLệnh chỉ ĐỌC danh sách Smart+ Ad. Muốn OFF/ON phải bấm nút xác nhận dưới kết quả.'
      );
      return;
    }

    const waitMessage = await ctx.reply(
      `🔎 Đang gọi API chính thức /smart_plus/ad/get/ cho campaign ${campaignId}...`
    );

    try {
      const result = await getSmartPlusAdsByCampaignId(campaignId);
      const visibleAds = result.ads.slice(0, 10);
      const lines = [
        '✅ <b>SMART+ AD API TEST</b>',
        `Campaign: <code>${escapeHtml(result.campaignId)}</code>`,
        result.campaignName ? `Tên camp: ${escapeHtml(result.campaignName)}` : '',
        `Advertiser: <code>${escapeHtml(result.advertiserId)}</code>`,
        `Smart+ Ads tìm thấy: <b>${result.ads.length}</b>`,
        '',
      ].filter(Boolean);

      visibleAds.forEach((ad, index) => {
        lines.push(
          `<b>#${index + 1}</b> ${escapeHtml(ad.adName || 'Không rõ tên')}`,
          `ID: <code>${escapeHtml(ad.smartPlusAdId)}</code>`,
          `Status: ${escapeHtml(formatSmartPlusAdStatus(ad))}`,
          ''
        );
      });

      if (result.ads.length > visibleAds.length) {
        lines.push(`ℹ️ Chỉ hiển thị ${visibleAds.length}/${result.ads.length} ads đầu tiên để test.`);
      }

      lines.push(
        '⚠️ Nút dưới đây gọi trực tiếp <code>/smart_plus/ad/status/update/</code> trên quảng cáo thật.'
      );

      const keyboard = visibleAds.map((ad, index) => [
        Markup.button.callback(
          `⏸ OFF #${index + 1}`,
          `spt:D:${result.advertiserId}:${ad.smartPlusAdId}`
        ),
        Markup.button.callback(
          `▶️ ON #${index + 1}`,
          `spt:E:${result.advertiserId}:${ad.smartPlusAdId}`
        ),
      ]);

      await ctx.telegram.editMessageText(
        waitMessage.chat.id,
        waitMessage.message_id,
        undefined,
        lines.join('\n'),
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(keyboard),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.telegram.editMessageText(
        waitMessage.chat.id,
        waitMessage.message_id,
        undefined,
        `❌ Smart+ API test thất bại:\n\n${message.slice(0, 3500)}`
      );
    }
  });

  telegramBot.action(/^spt:([ED]):(\d+):(\d+)$/, async (ctx) => {
    if (!isAdminChat(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.', { show_alert: true });
      return;
    }

    const operationStatus: SmartPlusOperationStatus = ctx.match[1] === 'E' ? 'ENABLE' : 'DISABLE';
    const advertiserId = ctx.match[2];
    const smartPlusAdId = ctx.match[3];
    const actionLabel = operationStatus === 'ENABLE' ? 'BẬT' : 'TẮT';

    await ctx.answerCbQuery(`Đang ${actionLabel.toLowerCase()} Smart+ Ad...`);

    try {
      const result = await setSmartPlusAdStatus(advertiserId, smartPlusAdId, operationStatus);
      const verifiedStatus = formatSmartPlusAdStatus(result.verifiedAd);
      const lines = [
        `✅ TikTok đã nhận lệnh <b>${actionLabel}</b> Smart+ Ad`,
        `Advertiser: <code>${escapeHtml(advertiserId)}</code>`,
        `Smart+ Ad ID: <code>${escapeHtml(smartPlusAdId)}</code>`,
        `Endpoint: <code>/smart_plus/ad/status/update/</code>`,
        result.requestId ? `request_id: <code>${escapeHtml(result.requestId)}</code>` : '',
        `Đọc lại sau 1.5s: ${escapeHtml(verifiedStatus)}`,
        '',
        operationStatus === 'DISABLE'
          ? '👉 Nếu Ads Manager đã OFF đúng ad này, bấm nút ON tương ứng ở tin nhắn trước để bật lại.'
          : '👉 Kiểm tra Ads Manager để xác nhận ad đã ON trở lại.',
      ].filter(Boolean);

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(
        `❌ <b>${actionLabel} Smart+ Ad thất bại</b>\nAd: <code>${escapeHtml(smartPlusAdId)}</code>\n\n${escapeHtml(message.slice(0, 3000))}`,
        { parse_mode: 'HTML' }
      );
    }
  });
}

async function main() {
  const botToken = getRequiredEnv('TELEGRAM_BOT_TOKEN');

  // Configure a finite timeout for all Axios requests before any scheduled work starts.
  configureHttpResilience();

  if (isEmbeddedSignerEnabled()) {
    signerRuntime = await startServer({ installSignalHandlers: false });
    console.log(`Embedded Playwright signer started at ${signerRuntime.baseUrl}`);
  }

  // Connect to database
  await connectDB();
  await initializeAlertRules();

  // Initialize Telegram bot
  bot = new Telegraf(botToken);

  // Register diagnostics before setupBotHandlers(), because setupBotHandlers installs
  // a catch-all bot.on('text') fallback that intentionally does not call next().
  bot.command('health', async (ctx) => {
    const snapshot = getSchedulerHealthSnapshot();
    const uptimeSeconds = Math.round(process.uptime());
    const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const lines = [
      'BOT HEALTH',
      `Uptime: ${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
      `Memory RSS: ${memoryMb} MB`,
      `Scheduler generation: ${snapshot.generation}`,
      `Restart requested: ${snapshot.restartRequested ? 'YES' : 'no'}`,
    ];

    for (const [level, state] of Object.entries(snapshot.levels)) {
      const status = state.running
        ? 'RUNNING'
        : state.consecutiveFailures > 0
          ? `ERROR x${state.consecutiveFailures}`
          : state.lastSuccessAt
            ? 'OK'
            : 'WAITING';

      lines.push(
        '',
        `${level.toUpperCase()}: ${status}`,
        `Interval: ${state.intervalMinutes}m | Hard timeout: ${Math.round(state.timeoutMs / 60_000)}m`,
        `Last start: ${formatTimestamp(state.lastStartedAt)}`,
        `Last success: ${formatTimestamp(state.lastSuccessAt)}`,
        `Last duration: ${formatDuration(state.lastDurationMs)}`,
        state.lastError ? `Last error: ${state.lastError.slice(0, 300)}` : 'Last error: -'
      );
    }

    await ctx.reply(lines.join('\n'));
  });

  registerSmartPlusAdTestHandlers(bot);

  // Setup the rest of the bot command handlers and text fallbacks.
  setupBotHandlers(bot);

  // Start the scheduler before awaiting launch so periodic checks are always registered.
  startScheduler(bot);

  // Start the bot
  await bot.launch();

  console.log('Telegram bot is running...');
}

// Handle graceful shutdown
async function shutdown(signal: NodeJS.Signals) {
  console.log(`Received ${signal}, shutting down gracefully...`);

  // Force exit after 3 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error('Graceful shutdown timed out. Forcing exit...');
    process.exit(1);
  }, 3000).unref();

  try {
    bot?.stop(signal);
  } catch (e) {
    console.error('Error stopping bot:', e);
  }

  if (signerRuntime) {
    try {
      await signerRuntime.close();
    } catch (e) {
      console.error('Error closing signer:', e);
    }
  }

  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => scheduleFatalExit('Unhandled promise rejection', reason));
process.on('uncaughtException', (error) => scheduleFatalExit('Uncaught exception', error));

// Start the application
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
