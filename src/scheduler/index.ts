import {
  checkAndSendAlerts,
  checkAndSendLevel2Alerts,
  checkAndSendLevel3Alerts,
} from '../alerts/index.js';
import {
  getRuntimeSettingsSnapshot,
  RUNTIME_SETTING_DEFAULTS,
} from '../settings/runtime.js';
import type { Telegraf } from 'telegraf';

let botInstance: Telegraf | undefined;
let level1SchedulerHandle: NodeJS.Timeout | undefined;
let level2SchedulerHandle: NodeJS.Timeout | undefined;
let level3SchedulerHandle: NodeJS.Timeout | undefined;
let level1InitialHandle: NodeJS.Timeout | undefined;
let level2InitialHandle: NodeJS.Timeout | undefined;
let level3InitialHandle: NodeJS.Timeout | undefined;
let isLevel1Running = false;
let isLevel2Running = false;
let isLevel3Running = false;
let schedulerGeneration = 0;
let scheduledTaskQueue: Promise<void> = Promise.resolve();
const queuedSchedulerTasks = new Set<string>();

const LEVEL1_INITIAL_DELAY_MS = 2 * 60 * 1000;
const LEVEL2_INITIAL_DELAY_MS = 5 * 60 * 1000;
const LEVEL3_INITIAL_DELAY_MS = 8 * 60 * 1000;

function enqueueScheduledTask(
  level: 'level1' | 'level2' | 'level3',
  generation: number,
  task: () => Promise<void>
): void {
  const queueKey = `${generation}:${level}`;
  if (queuedSchedulerTasks.has(queueKey)) {
    console.log(`Skipping ${level} enqueue because it is already running or queued`);
    return;
  }

  queuedSchedulerTasks.add(queueKey);
  scheduledTaskQueue = scheduledTaskQueue
    .catch(() => undefined)
    .then(async () => {
      if (generation !== schedulerGeneration) {
        return;
      }
      await task();
    })
    .finally(() => {
      queuedSchedulerTasks.delete(queueKey);
    });
}

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
  console.log('Running level 2 scheduled task: Check product CP ads alerts (today)');

  try {
    await checkAndSendLevel2Alerts(botInstance);
    console.log('Level 2 scheduled task completed successfully');
  } catch (error) {
    console.error('Error in level 2 scheduled task:', error);
  } finally {
    isLevel2Running = false;
  }
}

async function runLevel3ScheduledCheck(): Promise<void> {
  if (!botInstance) {
    console.error('Bot instance not available for level 3 scheduled task');
    return;
  }

  if (isLevel3Running) {
    console.log('Skipping level 3 scheduled task because the previous run is still in progress');
    return;
  }

  isLevel3Running = true;
  console.log('Running level 3 scheduled task: Check product CP ads alerts (month-to-date)');

  try {
    await checkAndSendLevel3Alerts(botInstance);
    console.log('Level 3 scheduled task completed successfully');
  } catch (error) {
    console.error('Error in level 3 scheduled task:', error);
  } finally {
    isLevel3Running = false;
  }
}

export function startScheduler(bot: Telegraf) {
  botInstance = bot;
  void restartScheduler();
}

export async function restartScheduler(): Promise<void> {
  schedulerGeneration += 1;
  const generation = schedulerGeneration;

  if (level1InitialHandle) {
    clearTimeout(level1InitialHandle);
    level1InitialHandle = undefined;
  }

  if (level2InitialHandle) {
    clearTimeout(level2InitialHandle);
    level2InitialHandle = undefined;
  }

  if (level3InitialHandle) {
    clearTimeout(level3InitialHandle);
    level3InitialHandle = undefined;
  }

  if (level1SchedulerHandle) {
    clearInterval(level1SchedulerHandle);
    level1SchedulerHandle = undefined;
  }

  if (level2SchedulerHandle) {
    clearInterval(level2SchedulerHandle);
    level2SchedulerHandle = undefined;
  }

  if (level3SchedulerHandle) {
    clearInterval(level3SchedulerHandle);
    level3SchedulerHandle = undefined;
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
  const level3IntervalMs = minutesToMilliseconds(
    settings.level3IntervalMinutes,
    RUNTIME_SETTING_DEFAULTS.level3IntervalMinutes
  );

  level1InitialHandle = setTimeout(() => {
    if (generation !== schedulerGeneration) return;
    level1InitialHandle = undefined;
    level1SchedulerHandle = setInterval(() => {
      enqueueScheduledTask('level1', generation, runScheduledCheck);
    }, level1IntervalMs);
    enqueueScheduledTask('level1', generation, runScheduledCheck);
  }, LEVEL1_INITIAL_DELAY_MS);

  level2InitialHandle = setTimeout(() => {
    if (generation !== schedulerGeneration) return;
    level2InitialHandle = undefined;
    level2SchedulerHandle = setInterval(() => {
      enqueueScheduledTask('level2', generation, runLevel2ScheduledCheck);
    }, level2IntervalMs);
    enqueueScheduledTask('level2', generation, runLevel2ScheduledCheck);
  }, LEVEL2_INITIAL_DELAY_MS);

  level3InitialHandle = setTimeout(() => {
    if (generation !== schedulerGeneration) return;
    level3InitialHandle = undefined;
    level3SchedulerHandle = setInterval(() => {
      enqueueScheduledTask('level3', generation, runLevel3ScheduledCheck);
    }, level3IntervalMs);
    enqueueScheduledTask('level3', generation, runLevel3ScheduledCheck);
  }, LEVEL3_INITIAL_DELAY_MS);

  console.log(
    `Scheduler armed: level 1 starts after 2m then every ${settings.level1IntervalMinutes}m, ` +
    `level 2 starts after 5m then every ${settings.level2IntervalMinutes}m, ` +
    `level 3 starts after 8m then every ${settings.level3IntervalMinutes}m`
  );
}

export async function manualTriggerDataFetch() {
  await runScheduledCheck();
}
