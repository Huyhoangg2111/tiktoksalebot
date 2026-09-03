import { db } from '../db/index.js';

export const RUNTIME_SETTING_DEFAULTS = {
  level1IntervalMinutes: 1,
  level2IntervalMinutes: 59,
  exchangeRate: 28119,
  balanceThresholdUsd: 10,
  level2CpAdsThreshold: 40,
} as const;

export type RuntimeSettingKey =
  | 'level1_interval_minutes'
  | 'level2_interval_minutes'
  | 'exchange_rate'
  | 'balance_threshold_usd'
  | 'level2_cp_ads_threshold';

interface BotSettingRow {
  value: string;
}

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

  return parsed ?? fallback;
}

export async function setRuntimeSettingNumber(
  key: RuntimeSettingKey,
  value: number
): Promise<void> {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Giá trị phải là số lớn hơn 0.');
  }

  await ensureSettingsTable();
  await db.run(
    `INSERT INTO bot_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key)
     DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, String(value)]
  );
}

export async function getRuntimeSettingsSnapshot() {
  const [
    level1IntervalMinutes,
    level2IntervalMinutes,
    exchangeRate,
    balanceThresholdUsd,
    level2CpAdsThreshold,
  ] = await Promise.all([
    getRuntimeSettingNumber('level1_interval_minutes', RUNTIME_SETTING_DEFAULTS.level1IntervalMinutes),
    getRuntimeSettingNumber('level2_interval_minutes', RUNTIME_SETTING_DEFAULTS.level2IntervalMinutes),
    getRuntimeSettingNumber('exchange_rate', RUNTIME_SETTING_DEFAULTS.exchangeRate),
    getRuntimeSettingNumber('balance_threshold_usd', RUNTIME_SETTING_DEFAULTS.balanceThresholdUsd),
    getRuntimeSettingNumber('level2_cp_ads_threshold', RUNTIME_SETTING_DEFAULTS.level2CpAdsThreshold),
  ]);

  return {
    level1IntervalMinutes,
    level2IntervalMinutes,
    exchangeRate,
    balanceThresholdUsd,
    level2CpAdsThreshold,
  };
}
