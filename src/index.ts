import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import { connectDB } from './db/index.js';
import { setupBotHandlers } from './bot/handlers.js';
import { initializeAlertRules } from './alerts/index.js';
import { getSchedulerHealthSnapshot, startScheduler } from './scheduler/index.js';
import { startServer, type SignerServerRuntime } from './playwright-signer/server.js';
import { configureHttpResilience } from './runtime/http-resilience.js';

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
  
  // Setup bot command handlers
  setupBotHandlers(bot);

  // Lightweight runtime diagnostics that do not expose credentials.
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
