import {
  checkAndSendLevel2Alerts,
  checkAndSendLevel3Alerts,
} from '../alerts/index.js';
import { checkAndRunDailyMaterialRuler } from '../materials/daily-ruler.js';
import { checkAndSendCampaignMaterialAlerts } from '../materials/rule-engine.js';
import {
  getRuntimeSettingsSnapshot,
  RUNTIME_SETTING_DEFAULTS,
} from '../settings/runtime.js';
import type { Telegraf } from 'telegraf';

type SchedulerLevel = 'level1' | 'level2' | 'level3';

interface SchedulerLevelState {
  running: boolean;
  intervalMinutes: number;
  timeoutMs: number;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastDurationMs?: number;
  lastError?: string;
  consecutiveFailures: number;
  runCount: number;
  successCount: number;
}

export interface SchedulerHealthSnapshot {
  generation: number;
  restartRequested: boolean;
  levels: Record<SchedulerLevel, SchedulerLevelState>;
}

let botInstance: Telegraf | undefined;
let level1SchedulerHandle: NodeJS.Timeout | undefined;
let level2SchedulerHandle: NodeJS.Timeout | undefined;
let level3SchedulerHandle: NodeJS.Timeout | undefined;
let level1InitialHandle: NodeJS.Timeout | undefined;
let level2InitialHandle: NodeJS.Timeout | undefined;
let level3InitialHandle: NodeJS.Timeout | undefined;
let watchdogHandle: NodeJS.Timeout | undefined;
let schedulerGeneration = 0;
let restartRequested = false;

const LEVEL1_INITIAL_DELAY_MS = 2 * 60 * 1000;
const LEVEL2_INITIAL_DELAY_MS = 5 * 60 * 1000;
const LEVEL3_INITIAL_DELAY_MS = 8 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;

const DEFAULT_JOB_TIMEOUT_MINUTES: Record<SchedulerLevel, number> = {
  level1: 10,
  level2: 20,
  level3: 30,
};

const levelStates: Record<SchedulerLevel, SchedulerLevelState> = {
  level1: {
    running: false,
    intervalMinutes: RUNTIME_SETTING_DEFAULTS.level1IntervalMinutes,
    timeoutMs: DEFAULT_JOB_TIMEOUT_MINUTES.level1 * 60 * 1000,
    consecutiveFailures: 0,
    runCount: 0,
    successCount: 0,
  },
  level2: {
    running: false,
    intervalMinutes: RUNTIME_SETTING_DEFAULTS.level2IntervalMinutes,
    timeoutMs: DEFAULT_JOB_TIMEOUT_MINUTES.level2 * 60 * 1000,
    consecutiveFailures: 0,
    runCount: 0,
    successCount: 0,
  },
  level3: {
    running: false,
    intervalMinutes: RUNTIME_SETTING_DEFAULTS.level3IntervalMinutes,
    timeoutMs: DEFAULT_JOB_TIMEOUT_MINUTES.level3 * 60 * 1000,
    consecutiveFailures: 0,
    runCount: 0,
    successCount: 0,
  },
};

class SchedulerJobTimeoutError extends Error {
  constructor(level: SchedulerLevel, timeoutMs: number) {
    super(`${level} exceeded hard timeout of ${Math.round(timeoutMs / 60_000)} minutes`);
    this.name = 'SchedulerJobTimeoutError';
  }
}

function parsePositiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getJobTimeoutMs(level: SchedulerLevel): number {
  const envName = `SCHEDULER_${level.toUpperCase()}_TIMEOUT_MINUTES`;
  const minutes = parsePositiveEnvNumber(envName, DEFAULT_JOB_TIMEOUT_MINUTES[level]);
  return Math.max(1, minutes) * 60 * 1000;
}

function minutesToMilliseconds(minutes: number, fallbackMinutes: number): number {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : fallbackMinutes;
  return Math.max(1, safeMinutes) * 60 * 1000;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function requestProcessRestart(reason: string): void {
  if (restartRequested) return;
  restartRequested = true;

  console.error(`[WATCHDOG] ${reason}`);
  console.error('[WATCHDOG] Exiting process so Docker restart policy can recover the bot.');

  setTimeout(() => process.exit(1), 1_000);
}

async function withHardTimeout<T>(
  level: SchedulerLevel,
  timeoutMs: number,
  task: () => Promise<T>
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      task(),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new SchedulerJobTimeoutError(level, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runLevelJob(
  level: SchedulerLevel,
  label: string,
  task: () => Promise<void>
): Promise<void> {
  if (!botInstance) {
    console.error(`Bot instance not available for ${level} scheduled task`);
    return;
  }

  const state = levelStates[level];
  if (state.running) {
    console.log(`Skipping ${level} scheduled task because the previous run is still in progress`);
    return;
  }

  state.running = true;
  state.runCount += 1;
  state.lastStartedAt = Date.now();
  state.timeoutMs = getJobTimeoutMs(level);
  state.lastError = undefined;

  console.log(`Running ${level} scheduled task: ${label}`);

  try {
    await withHardTimeout(level, state.timeoutMs, task);

    state.lastSuccessAt = Date.now();
    state.successCount += 1;
    state.consecutiveFailures = 0;
    console.log(`${level} scheduled task completed successfully`);
  } catch (error) {
    state.lastFailureAt = Date.now();
    state.consecutiveFailures += 1;
    state.lastError = formatError(error);
    console.error(`Error in ${level} scheduled task:`, error);

    if (error instanceof SchedulerJobTimeoutError) {
      requestProcessRestart(`${level} is stuck: ${error.message}`);
    }
  } finally {
    state.lastFinishedAt = Date.now();
    state.lastDurationMs = state.lastStartedAt
      ? state.lastFinishedAt - state.lastStartedAt
      : undefined;
    state.running = false;
  }
}

async function runScheduledCheck(): Promise<void> {
  await runLevelJob(
    'level1',
    'Check campaign notifications and material rules',
    async () => {
      await checkAndRunDailyMaterialRuler(botInstance!);
      await checkAndSendCampaignMaterialAlerts(botInstance!);
    }
  );
}

async function runLevel2ScheduledCheck(): Promise<void> {
  await runLevelJob(
    'level2',
    'Check product CP ads alerts (today)',
    async () => checkAndSendLevel2Alerts(botInstance!)
  );
}

async function runLevel3ScheduledCheck(): Promise<void> {
  await runLevelJob(
    'level3',
    'Check product CP ads alerts (month-to-date)',
    async () => checkAndSendLevel3Alerts(botInstance!)
  );
}

function startWatchdog(): void {
  if (watchdogHandle) return;

  watchdogHandle = setInterval(() => {
    if (restartRequested) return;

    const now = Date.now();
    for (const level of ['level1', 'level2', 'level3'] as SchedulerLevel[]) {
      const state = levelStates[level];
      if (!state.running || !state.lastStartedAt) continue;

      const runtimeMs = now - state.lastStartedAt;
      if (runtimeMs > state.timeoutMs + WATCHDOG_INTERVAL_MS) {
        requestProcessRestart(
          `${level} watchdog detected a stuck job after ${Math.round(runtimeMs / 1000)} seconds`
        );
        return;
      }
    }
  }, WATCHDOG_INTERVAL_MS);

  watchdogHandle.unref();
}

function clearSchedulerTimers(): void {
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
}

export function startScheduler(bot: Telegraf): void {
  botInstance = bot;
  startWatchdog();
  void restartScheduler();
}

export async function restartScheduler(): Promise<void> {
  schedulerGeneration += 1;
  const generation = schedulerGeneration;

  clearSchedulerTimers();

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

  levelStates.level1.intervalMinutes = settings.level1IntervalMinutes;
  levelStates.level2.intervalMinutes = settings.level2IntervalMinutes;
  levelStates.level3.intervalMinutes = settings.level3IntervalMinutes;
  levelStates.level1.timeoutMs = getJobTimeoutMs('level1');
  levelStates.level2.timeoutMs = getJobTimeoutMs('level2');
  levelStates.level3.timeoutMs = getJobTimeoutMs('level3');

  level1InitialHandle = setTimeout(() => {
    if (generation !== schedulerGeneration) return;
    level1InitialHandle = undefined;
    level1SchedulerHandle = setInterval(() => {
      void runScheduledCheck();
    }, level1IntervalMs);
    void runScheduledCheck();
  }, LEVEL1_INITIAL_DELAY_MS);

  level2InitialHandle = setTimeout(() => {
    if (generation !== schedulerGeneration) return;
    level2InitialHandle = undefined;
    level2SchedulerHandle = setInterval(() => {
      void runLevel2ScheduledCheck();
    }, level2IntervalMs);
    void runLevel2ScheduledCheck();
  }, LEVEL2_INITIAL_DELAY_MS);

  level3InitialHandle = setTimeout(() => {
    if (generation !== schedulerGeneration) return;
    level3InitialHandle = undefined;
    level3SchedulerHandle = setInterval(() => {
      void runLevel3ScheduledCheck();
    }, level3IntervalMs);
    void runLevel3ScheduledCheck();
  }, LEVEL3_INITIAL_DELAY_MS);

  console.log(
    `Scheduler armed independently: level 1 starts after 2m then every ${settings.level1IntervalMinutes}m, ` +
    `level 2 starts after 5m then every ${settings.level2IntervalMinutes}m, ` +
    `level 3 starts after 8m then every ${settings.level3IntervalMinutes}m`
  );
  console.log(
    `Scheduler hard timeouts: L1=${Math.round(levelStates.level1.timeoutMs / 60_000)}m, ` +
    `L2=${Math.round(levelStates.level2.timeoutMs / 60_000)}m, ` +
    `L3=${Math.round(levelStates.level3.timeoutMs / 60_000)}m`
  );
}

export function getSchedulerHealthSnapshot(): SchedulerHealthSnapshot {
  return {
    generation: schedulerGeneration,
    restartRequested,
    levels: {
      level1: { ...levelStates.level1 },
      level2: { ...levelStates.level2 },
      level3: { ...levelStates.level3 },
    },
  };
}

export async function manualTriggerDataFetch(): Promise<void> {
  await runScheduledCheck();
}
