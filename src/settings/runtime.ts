import { db } from '../db/index.js';

export const RUNTIME_SETTING_DEFAULTS = {
  level1IntervalMinutes: 1,
  level2IntervalMinutes: 59,
  /** Cấp 3: %CP SP/market theo tháng (MTD), mặc định 3 giờ. */
  level3IntervalMinutes: 180,
  exchangeRate: 28119,
  balanceThresholdUsd: 10,
  /** %CP ngưỡng cấp 2 (hôm nay). */
  level2CpAdsThreshold: 40,
  /** %CP ngưỡng cấp 3 (tháng MTD). */
  level3CpAdsThreshold: 40,
  /** Concurrent Google Sheets source readers for /bc. */
  sheetsConcurrency: 4,
  /** Concurrent TikTok advertiser report workers for /bc. */
  tiktokConcurrency: 5,
  materialRulerRunTime: '00:05',
} as const;

export type RuntimeTextSettingKey = 'material_ruler_run_time';

export type RuntimeSettingKey =
  | 'level1_interval_minutes'
  | 'level2_interval_minutes'
  | 'level3_interval_minutes'
  | 'exchange_rate'
  | 'balance_threshold_usd'
  | 'level2_cp_ads_threshold'
  | 'level3_cp_ads_threshold'
  | 'sheets_concurrency'
  | 'tiktok_concurrency';

interface BotSettingRow {
  value: string;
}

const CONCURRENCY_SETTING_KEYS = new Set<RuntimeSettingKey>([
  'sheets_concurrency',
  'tiktok_concurrency',
]);

const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 8;

async function ensureSettingsTable(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clampConcurrency(value: number): number {
  return Math.max(CONCURRENCY_MIN, Math.min(CONCURRENCY_MAX, Math.trunc(value)));
}

export async function getRuntimeSettingNumber(
  key: RuntimeSettingKey,
  fallback: number
): Promise<number> {
  await ensureSettingsTable();

  const row = await db.get<BotSettingRow>(
    'SELECT value FROM bot_settings WHERE key = ?',
    [key]
  );
  const parsed = parsePositiveNumber(row?.value);

  if (parsed === undefined) {
    return fallback;
  }

  if (CONCURRENCY_SETTING_KEYS.has(key)) {
    return clampConcurrency(parsed);
  }

  return parsed;
}

export async function setRuntimeSettingNumber(
  key: RuntimeSettingKey,
  value: number
): Promise<void> {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Giá trị phải là số lớn hơn 0.');
  }

  let storedValue = value;

  if (CONCURRENCY_SETTING_KEYS.has(key)) {
    if (value < CONCURRENCY_MIN || value > CONCURRENCY_MAX) {
      throw new Error(`Số luồng phải từ ${CONCURRENCY_MIN} đến ${CONCURRENCY_MAX}.`);
    }
    storedValue = clampConcurrency(value);
  }

  await ensureSettingsTable();
  await db.run(
    `INSERT INTO bot_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key)
     DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, String(storedValue)]
  );
}

export async function getRuntimeSettingText(
  key: RuntimeTextSettingKey,
  fallback: string
): Promise<string> {
  await ensureSettingsTable();
  const row = await db.get<BotSettingRow>('SELECT value FROM bot_settings WHERE key = ?', [key]);
  return String(row?.value || '').trim() || fallback;
}

export async function setRuntimeSettingText(
  key: RuntimeTextSettingKey,
  value: string
): Promise<void> {
  const normalized = String(value || '').trim();
  if (key === 'material_ruler_run_time' && !/^([01]\\d|2[0-3]):[0-5]\\d$/.test(normalized)) {
    throw new Error('Giờ chạy phải theo định dạng HH:mm, ví dụ 00:05 hoặc 06:30.');
  }
  await ensureSettingsTable();
  await db.run(`INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`, [key, normalized]);
}

export async function getRuntimeSettingsSnapshot() {
  const [
    level1IntervalMinutes,
    level2IntervalMinutes,
    level3IntervalMinutes,
    exchangeRate,
    balanceThresholdUsd,
    level2CpAdsThreshold,
    level3CpAdsThreshold,
    sheetsConcurrency,
    tiktokConcurrency,
    materialRulerRunTime,
  ] = await Promise.all([
    getRuntimeSettingNumber('level1_interval_minutes', RUNTIME_SETTING_DEFAULTS.level1IntervalMinutes),
    getRuntimeSettingNumber('level2_interval_minutes', RUNTIME_SETTING_DEFAULTS.level2IntervalMinutes),
    getRuntimeSettingNumber('level3_interval_minutes', RUNTIME_SETTING_DEFAULTS.level3IntervalMinutes),
    getRuntimeSettingNumber('exchange_rate', RUNTIME_SETTING_DEFAULTS.exchangeRate),
    getRuntimeSettingNumber('balance_threshold_usd', RUNTIME_SETTING_DEFAULTS.balanceThresholdUsd),
    getRuntimeSettingNumber('level2_cp_ads_threshold', RUNTIME_SETTING_DEFAULTS.level2CpAdsThreshold),
    getRuntimeSettingNumber('level3_cp_ads_threshold', RUNTIME_SETTING_DEFAULTS.level3CpAdsThreshold),
    getRuntimeSettingNumber('sheets_concurrency', RUNTIME_SETTING_DEFAULTS.sheetsConcurrency),
    getRuntimeSettingNumber('tiktok_concurrency', RUNTIME_SETTING_DEFAULTS.tiktokConcurrency),
    getRuntimeSettingText('material_ruler_run_time', RUNTIME_SETTING_DEFAULTS.materialRulerRunTime),
  ]);

  return {
    level1IntervalMinutes,
    level2IntervalMinutes,
    level3IntervalMinutes,
    exchangeRate,
    balanceThresholdUsd,
    level2CpAdsThreshold,
    level3CpAdsThreshold,
    sheetsConcurrency,
    tiktokConcurrency,
    materialRulerRunTime,
  };
}
