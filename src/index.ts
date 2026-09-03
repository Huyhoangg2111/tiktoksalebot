import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import { connectDB } from './db/index.js';
import { setupBotHandlers } from './bot/handlers.js';
import { initializeAlertRules } from './alerts/index.js';
import { startScheduler } from './scheduler/index.js';
import { startServer, type SignerServerRuntime } from './playwright-signer/server.js';

// Load environment variables
config();

let bot: Telegraf | undefined;
let signerRuntime: SignerServerRuntime | undefined;

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

async function main() {
  const botToken = getRequiredEnv('TELEGRAM_BOT_TOKEN');

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

// Start the application
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
