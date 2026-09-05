import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import { connectDB } from './db/index.js';
import { setupBotHandlers } from './bot/handlers.js';
import { setupSmartPlusAppealHandlers } from './bot/smartplus-appeal-handlers.js';
import { setupSettingsMenuHandlers } from './bot/settings-menu.js';
import { setupRetiredAlertActions } from './bot/retired-alert-actions.js';
import { initializeAlertRules } from './alerts/index.js';
import { startScheduler } from './scheduler/index.js';
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

  // Retire the old alert actions before any legacy callbacks are registered.
  // This also strips their buttons from all Telegram send/edit payloads.
  setupRetiredAlertActions(bot);

  // Register settings before the legacy handlers, because setupBotHandlers() contains
  // the old settings implementation and a catch-all text fallback. The new settings
  // module owns /settings, health, and all settings callbacks.
  setupSettingsMenuHandlers(bot);

  // Appeal handlers must also be registered before setupBotHandlers() because the
  // main handler installs a catch-all text fallback that does not call next().
  setupSmartPlusAppealHandlers(bot);

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