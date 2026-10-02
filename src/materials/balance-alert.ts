import type { Telegraf } from 'telegraf';
import { getTrackedAdvertiserIdSet } from '../accounts/tracking.js';
import { db } from '../db/index.js';
import { getAdvertiserPermissions } from '../google-sheets/api.js';
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

/** Giữ cách tính severity của cảnh báo số dư bản Level 1 cũ. */
function severityForBalance(balance: number, threshold: number): StoredAlertSeverity {
  if (threshold === 0) {
    return balance === 0 ? 'low' : 'critical';
  }

  const ratio = Math.abs(balance - threshold) / Math.abs(threshold);
  if (ratio >= 0.5) return 'critical';
  if (ratio >= 0.25) return 'high';
  if (ratio >= 0.1) return 'medium';
  return 'low';
}

function formatUsd(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
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

function getMktGroupKey(mktCode: string | undefined | null): string {
  const value = String(mktCode || '').trim();
  return value || 'CHUA_GAN_MKT';
}

function getMktSectionLabel(mkt: string): string {
  return mkt === 'CHUA_GAN_MKT' ? 'Chưa gắn MKT' : mkt;
}

/** Gom các tài khoản sắp hết tiền theo mã MKT để gửi chung một tin, mỗi mã một phần. */
async function groupLowBalancesByMkt(
  lowBalances: TikTokAccountBalance[]
): Promise<Array<{ mkt: string; accounts: TikTokAccountBalance[] }>> {
  const permissions = await getAdvertiserPermissions({ includeAllMkt: true }).catch(() => []);
  const mktByAdvertiser = new Map(permissions.map(permission => [permission.advertiserId, permission.mktCode]));
  const groups = new Map<string, TikTokAccountBalance[]>();
  for (const account of lowBalances) {
    const mkt = getMktGroupKey(mktByAdvertiser.get(account.advertiser_id));
    const list = groups.get(mkt) || [];
    list.push(account);
    groups.set(mkt, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'vi'))
    .map(([mkt, accounts]) => ({ mkt, accounts }));
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

  // Format bản cũ: mỗi tài khoản một dòng "- tên: $số dư"; khi có nhiều mã MKT
  // thì tách phần theo mã nhưng vẫn gửi chung một tin.
  const mktGroups = await groupLowBalancesByMkt(lowBalances);
  const useMktSections = !(mktGroups.length === 1 && mktGroups[0].mkt === 'CHUA_GAN_MKT');
  const htmlLines: string[] = [];
  const plainLines: string[] = [];
  for (const group of mktGroups) {
    if (useMktSections) {
      htmlLines.push(`— <b>${escapeHtml(getMktSectionLabel(group.mkt))}</b> —`);
      plainLines.push(`— ${getMktSectionLabel(group.mkt)} —`);
    }
    for (const account of group.accounts) {
      const line = `- ${getAccountLabel(account)}: ${formatUsd(Number(account.balance || 0), account.currency)}`;
      htmlLines.push(escapeHtml(line));
      plainLines.push(line);
    }
  }

  const lowest = Math.min(...lowBalances.map(account => Number(account.balance || 0)));
  const severity = severityForBalance(lowest, threshold);
  const telegramText = `🔔 <b>Balance</b> - ${severity.toUpperCase()}\n${htmlLines.join('\n')}`;

  await bot.telegram.sendMessage(adminChatId, telegramText, { parse_mode: 'HTML' });
  await saveAlertHistory('balance_low', plainLines.join('\n'), severity);
  await markSent();
}
