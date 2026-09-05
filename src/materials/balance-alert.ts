import type { Telegraf } from 'telegraf';
import { getTrackedAdvertiserIdSet } from '../accounts/tracking.js';
import { db } from '../db/index.js';
import { getRuntimeSettingNumber, RUNTIME_SETTING_DEFAULTS } from '../settings/runtime.js';
import { getTikTokAccountBalance, type TikTokAccountBalance } from '../tiktok/api.js';
import { saveAlertHistory, type StoredAlertSeverity } from './alert-store.js';

const BALANCE_COOLDOWN_MS = 10 * 60 * 1000;
const BALANCE_STATE_KEY = 'balance-low-global';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityForBalance(balance: number, threshold: number): StoredAlertSeverity {
  if (threshold <= 0) return 'low';
  const ratio = balance / threshold;
  if (ratio <= 0.1) return 'critical';
  if (ratio <= 0.35) return 'high';
  if (ratio <= 0.7) return 'medium';
  return 'low';
}

async function ensureStateTable(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_material_rule_notifications (
      subject_key TEXT PRIMARY KEY,
      last_sent_ms INTEGER NOT NULL
    )
  `);
}

async function canSend(): Promise<boolean> {
  await ensureStateTable();
  const row = await db.get<{ last_sent_ms: number }>(
    'SELECT last_sent_ms FROM campaign_material_rule_notifications WHERE subject_key = ?',
    [BALANCE_STATE_KEY]
  );
  return !row || Date.now() - Number(row.last_sent_ms || 0) >= BALANCE_COOLDOWN_MS;
}

async function markSent(): Promise<void> {
  await ensureStateTable();
  await db.run(
    `INSERT INTO campaign_material_rule_notifications(subject_key, last_sent_ms)
     VALUES (?, ?)
     ON CONFLICT(subject_key) DO UPDATE SET last_sent_ms = excluded.last_sent_ms`,
    [BALANCE_STATE_KEY, Date.now()]
  );
}

async function clearState(): Promise<void> {
  await ensureStateTable();
  await db.run(
    'DELETE FROM campaign_material_rule_notifications WHERE subject_key = ?',
    [BALANCE_STATE_KEY]
  );
}

function getAccountLabel(account: TikTokAccountBalance): string {
  return String(account.advertiser_name || account.advertiser_id).trim();
}

export async function checkAndSendLowBalanceAlert(bot: Telegraf): Promise<void> {
  const threshold = await getRuntimeSettingNumber(
    'balance_threshold_usd',
    RUNTIME_SETTING_DEFAULTS.balanceThresholdUsd
  );
  const balances = await getTikTokAccountBalance();
  const trackedAdvertiserIds = await getTrackedAdvertiserIdSet(
    balances.map(account => ({
      advertiserId: account.advertiser_id,
      advertiserName: account.advertiser_name,
    }))
  );
  const lowBalances = balances
    .filter(account => trackedAdvertiserIds.has(account.advertiser_id))
    .filter(account => Number(account.balance) < threshold)
    .sort((a, b) => a.balance - b.balance);

  if (lowBalances.length === 0) {
    await clearState();
    return;
  }
  if (!(await canSend())) return;

  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;

  const plainLines = [
    `⚠️ Số dư tài khoản thấp (${lowBalances.length})`,
    `Ngưỡng: $${threshold.toFixed(2)}`,
    '',
    ...lowBalances.map((account, index) =>
      `${index + 1}. ${getAccountLabel(account)} · ${account.advertiser_id} · $${Number(account.balance || 0).toFixed(2)}`
    ),
  ];
  const htmlLines = [
    `<b>⚠️ Số dư tài khoản thấp (${lowBalances.length})</b>`,
    `Ngưỡng: <b>$${threshold.toFixed(2)}</b>`,
    '',
    ...lowBalances.map((account, index) =>
      `${index + 1}. ${escapeHtml(getAccountLabel(account))} · <code>${escapeHtml(account.advertiser_id)}</code> · <b>$${Number(account.balance || 0).toFixed(2)}</b>`
    ),
  ];
  const lowest = Math.min(...lowBalances.map(account => Number(account.balance || 0)));
  const severity = severityForBalance(lowest, threshold);

  await bot.telegram.sendMessage(adminChatId, htmlLines.join('\n'), { parse_mode: 'HTML' });
  await saveAlertHistory('balance_low', plainLines.join('\n'), severity);
  await markSent();
}
