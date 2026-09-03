import { checkAndSendAlerts, checkAndSendLevel2Alerts } from '../alerts/index.js';
import {
  getRuntimeSettingsSnapshot,
  RUNTIME_SETTING_DEFAULTS,
} from '../settings/runtime.js';
import type { Telegraf } from 'telegraf';

let botInstance: Telegraf | undefined;
let level1SchedulerHandle: NodeJS.Timeout | undefined;
let level2SchedulerHandle: NodeJS.Timeout | undefined;
let isLevel1Running = false;
let isLevel2Running = false;

function minutesToMilliseconds(minutes: number, fallbackMinutes: number): number {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : fallbackMinutes;
  return Math.max(1, safeMinutes) * 60 * 1000;
}

async function runScheduledCheck(): Promise<void> {
  if (!botInstance) {
    console.error('Bot instance not available for scheduled task');
    return;
  }

  if (isLevel1Running) {
    console.log('Skipping level 1 scheduled task because the previous run is still in progress');
    return;
  }

  isLevel1Running = true;
  console.log('Running level 1 scheduled task: Fetch TikTok Ads data and check alerts');

  try {
    await checkAndSendAlerts(botInstance);
    console.log('Level 1 scheduled task completed successfully');
  } catch (error) {
    console.error('Error in level 1 scheduled task:', error);
  } finally {
    isLevel1Running = false;
  }
}

async function runLevel2ScheduledCheck(): Promise<void> {
  if (!botInstance) {
    console.error('Bot instance not available for level 2 scheduled task');
    return;
  }

  if (isLevel2Running) {
    console.log('Skipping level 2 scheduled task because the previous run is still in progress');
    return;
  }

  isLevel2Running = true;
  console.log('Running level 2 scheduled task: Check product CP ads alerts');

  try {
    await checkAndSendLevel2Alerts(botInstance);
    console.log('Level 2 scheduled task completed successfully');
  } catch (error) {
    console.error('Error in level 2 scheduled task:', error);
  } finally {
    isLevel2Running = false;
  }
}

export function startScheduler(bot: Telegraf) {
  botInstance = bot;
  void restartScheduler();
}

export async function restartScheduler(): Promise<void> {
  if (level1SchedulerHandle) {
    clearInterval(level1SchedulerHandle);
    level1SchedulerHandle = undefined;
  }

  if (level2SchedulerHandle) {
    clearInterval(level2SchedulerHandle);
    level2SchedulerHandle = undefined;
  }

  if (!botInstance) {
    return;
  }

  const settings = await getRuntimeSettingsSnapshot();
  const level1IntervalMs = minutesToMilliseconds(
    settings.level1IntervalMinutes,
    RUNTIME_SETTING_DEFAULTS.level1IntervalMinutes
  );
  const level2IntervalMs = minutesToMilliseconds(
    settings.level2IntervalMinutes,
    RUNTIME_SETTING_DEFAULTS.level2IntervalMinutes
  );

  void runScheduledCheck();
  void runLevel2ScheduledCheck();

  level1SchedulerHandle = setInterval(() => {
    void runScheduledCheck();
  }, level1IntervalMs);

  level2SchedulerHandle = setInterval(() => {
    void runLevel2ScheduledCheck();
  }, level2IntervalMs);

  console.log(`Scheduler started: level 1 every ${settings.level1IntervalMinutes} minute(s), level 2 every ${settings.level2IntervalMinutes} minute(s)`);
}

export async function manualTriggerDataFetch() {
  await runScheduledCheck();
}
