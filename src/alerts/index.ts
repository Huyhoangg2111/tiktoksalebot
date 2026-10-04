import type { Telegraf } from 'telegraf';
import { db } from '../db/index.js';
import {
  type AlertAction,
  type AlertCampaignStatus,
  type AlertComparisonOperator,
  type AlertMetric,
} from '../google-sheets/api.js';
import {
  getTikTokAccountBalance,
  getActiveCampaigns,
  getTodaySpentCampaigns,
  setCampaignStatusesBatch,
  type TikTokCampaign,
  type TikTokSpentAd,
  type TikTokSpentCampaign,
} from '../tiktok/api.js';
import {
  buildBcProductMarketSummaries,
  getMonthBcReportPeriod,
  getTodayBcReportPeriod,
  type ProductMarketSummary,
} from '../sales/bc-report.js';
import {
  getRuntimeSettingNumber,
  RUNTIME_SETTING_DEFAULTS,
} from '../settings/runtime.js';

type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

interface BalanceAlertRule {
  id?: number;
  metric: string;
  threshold: number;
  comparison_operator: AlertComparisonOperator;
  is_active: boolean;
}

interface AlertActionRule {
  id: number;
  entity: 'campaign' | 'ad';
  name_contains?: string;
  metric: AlertMetric;
  metric_operator: AlertComparisonOperator;
  metric_threshold: number;
  metric_min_threshold?: number | null;
  conversions_operator: AlertComparisonOperator;
  conversions_threshold: number;
  action: AlertAction;
  campaign_status?: AlertCampaignStatus;
  is_active: boolean;
  note?: string;
}

interface AlertActionStateRow {
  subject_key: string;
  updated_at: string;
}

interface EnrichedSpentAd extends TikTokSpentAd {
  campaign_name?: string;
}

export interface AlertInitializationResult {
  actionRuleCount: number;
  balanceThreshold: number;
  sheetCreated: boolean;
  clearedLegacyDemo: boolean;
}

export interface StoredAlert {
  id: number;
  type: string;
  message: string;
  severity: AlertSeverity;
  createdAt: string;
}

interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

interface AlertSendOptions {
  telegramHtml?: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

interface CampaignAlertContent {
  plainText: string;
  htmlText: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

interface QualifiedCampaignCandidate {
  campaign: TikTokSpentCampaign;
  severity: AlertSeverity;
}

interface CampaignDailyAlertTrackingRow {
  advertiser_id: string;
  campaign_id: string;
}

const BALANCE_RULE_METRIC = 'balance';
const LEVEL2_PRODUCT_CP_ADS_RULE_ID = -200;
const LEVEL3_PRODUCT_CP_ADS_MONTH_RULE_ID = -300;
const GROUPED_CAMPAIGN_ACTION_BUTTONS_PER_ROW = 5;
const ALERT_TELEGRAM_COOLDOWN_MS = 10 * 60 * 1000;
const LEVEL2_PRODUCT_CP_ADS_COOLDOWN_MS = 30 * 60 * 1000;
const LEVEL3_PRODUCT_CP_ADS_COOLDOWN_MS = 60 * 60 * 1000;
/** Callback tắt toàn bộ camp của 1 SP trong alert cấp 2/3. */
export const PRODUCT_PAUSE_CALLBACK_PREFIX = 'ppause';
export const PRODUCT_PAUSE_DONE_CALLBACK_PREFIX = 'ppause_done';
const PRODUCT_PAUSE_CALLBACK_TTL_MS = 6 * 60 * 60 * 1000;
const PRODUCT_PAUSE_BUTTONS_MAX = 10;

export interface ProductPauseCampaignRef {
  advertiserId: string;
  campaignId: string;
}

export interface ProductPausePayload {
  createdAt: number;
  productShortName: string;
  marketCode: string;
  targetMktCode?: string;
  level: 'level2' | 'level3';
  itemNumber: number;
}

export interface ProductPauseResult {
  productLabel: string;
  itemNumber: number;
  token: string;
  total: number;
  success: number;
  failed: number;
  allPaused: boolean;
  errors: string[];
}

interface ProductPauseCallbackRow {
  token: string;
  created_at_ms: number;
  product_short_name: string;
  market_code: string;
  target_mkt_code?: string;
  alert_level: 'level2' | 'level3';
  item_number: number;
}

const productPauseCallbacksInFlight = new Set<string>();

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}
function formatCompactVnd(amount: number): string {
  const roundedAmount = Math.round(amount);
  const sign = roundedAmount < 0 ? '-' : '';
  const absoluteAmount = Math.abs(roundedAmount);

  if (absoluteAmount >= 1_000_000) {
    const roundedMillions = Math.round(absoluteAmount / 100_000) / 10;
    const [millions, decimal] = roundedMillions.toFixed(1).split('.');
    return `${sign}${decimal === '0' ? millions : `${millions}.${decimal}`}tr`;
  }

  if (absoluteAmount >= 1_000) {
    return `${sign}${Math.floor(absoluteAmount / 1_000)}k`;
  }

  return `${sign}${absoluteAmount.toLocaleString('vi-VN')}đ`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function calculateAlertSeverity(currentValue: number, threshold: number): AlertSeverity {
  if (threshold === 0) {
    return currentValue === 0 ? 'low' : 'critical';
  }

  const ratio = Math.abs(currentValue - threshold) / Math.abs(threshold);

  if (ratio >= 0.5) return 'critical';
  if (ratio >= 0.25) return 'high';
  if (ratio >= 0.1) return 'medium';
  return 'low';
}
function normalizeSearchValue(value: string | undefined): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+-\s+/g, ' - ')
    .trim()
    .toLocaleUpperCase('vi-VN');
}
function getDateKey(timeZone = 'Asia/Ho_Chi_Minh'): string {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const year = dateParts.find(part => part.type === 'year')?.value || '1970';
  const month = dateParts.find(part => part.type === 'month')?.value || '01';
  const day = dateParts.find(part => part.type === 'day')?.value || '01';

  return `${year}-${month}-${day}`;
}

export async function setCampaignDailyAlertTracking(
  advertiserId: string,
  campaignId: string,
  isTracked: boolean,
  dateKey = getDateKey()
): Promise<void> {
  await db.run(
    `INSERT INTO campaign_daily_alert_tracking (
      date_key,
      advertiser_id,
      campaign_id,
      is_tracked,
      updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(date_key, advertiser_id, campaign_id)
    DO UPDATE SET is_tracked = excluded.is_tracked, updated_at = CURRENT_TIMESTAMP`,
    [dateKey, advertiserId, campaignId, isTracked ? 1 : 0]
  );
}
function getRuleNotificationSubjectKey(ruleId: number): string {
  return `notification:${ruleId}`;
}

function shouldSendTelegramAlert(
  lastAlertedAt: number | undefined,
  now = Date.now(),
  cooldownMs = ALERT_TELEGRAM_COOLDOWN_MS
): boolean {
  return !lastAlertedAt || now - lastAlertedAt >= cooldownMs;
}
async function getLevel2ProductCpAdsThreshold(): Promise<number> {
  const rawValue = process.env.ALERT_LEVEL2_CP_ADS_THRESHOLD || process.env.LEVEL2_CP_ADS_THRESHOLD;
  const parsedValue = rawValue ? Number(rawValue) : 40;
  const envValue = Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : RUNTIME_SETTING_DEFAULTS.level2CpAdsThreshold;

  return getRuntimeSettingNumber('level2_cp_ads_threshold', envValue);
}

async function getLevel3ProductCpAdsThreshold(): Promise<number> {
  const rawValue = process.env.ALERT_LEVEL3_CP_ADS_THRESHOLD || process.env.LEVEL3_CP_ADS_THRESHOLD;
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  const envValue = Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : RUNTIME_SETTING_DEFAULTS.level3CpAdsThreshold;

  return getRuntimeSettingNumber('level3_cp_ads_threshold', envValue);
}

function isLevel2ProductCpAdsEnabled(): boolean {
  const rawValue = process.env.ALERT_LEVEL2_CP_ADS_ENABLED || process.env.LEVEL2_CP_ADS_ENABLED;

  return !rawValue || !['0', 'false', 'off', 'no'].includes(rawValue.trim().toLowerCase());
}

function isLevel3ProductCpAdsEnabled(): boolean {
  const rawValue = process.env.ALERT_LEVEL3_CP_ADS_ENABLED || process.env.LEVEL3_CP_ADS_ENABLED;

  return !rawValue || !['0', 'false', 'off', 'no'].includes(rawValue.trim().toLowerCase());
}
function getProductSummarySubjectKey(
  summary: ProductMarketSummary,
  level: 'level2' | 'level3' = 'level2'
): string {
  return `${level}:product_cp_ads:${normalizeSearchValue(summary.mktCode || 'ALL')}:${normalizeSearchValue(summary.productShortName)}:${normalizeSearchValue(summary.marketCode)}`;
}

function getProductSummaryCpAds(summary: ProductMarketSummary): number {
  if (summary.spendVnd > 0 && summary.grossSalesVnd <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return summary.grossSalesVnd > 0 ? (summary.spendVnd / summary.grossSalesVnd) * 100 : 0;
}

function getProductSummaryCpaVnd(summary: ProductMarketSummary): number {
  return summary.conversions > 0 ? summary.spendVnd / summary.conversions : 0;
}

function compareProductAccountLabels(labelA: string, labelB: string): number {
  const numberA = Number(labelA.match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);
  const numberB = Number(labelB.match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);

  if (numberA !== numberB) {
    return numberA - numberB;
  }

  return labelA.localeCompare(labelB, 'vi');
}

function formatProductCampaignSuffix(summary: ProductMarketSummary): string {
  const campaignCount = summary.campaignIds.size;
  const accountLabels = [...summary.advertiserLabels].sort(compareProductAccountLabels);
  const campaignText = `📊 ${campaignCount.toLocaleString('vi-VN')} camp`;

  return accountLabels.length > 0
    ? `${campaignText} · ${accountLabels.join(' - ')}`
    : campaignText;
}

function formatProductSummaryCpAds(summary: ProductMarketSummary): string {
  if (summary.spendVnd > 0 && summary.grossSalesVnd > 0) {
    return formatPercent((summary.spendVnd / summary.grossSalesVnd) * 100);
  }

  // Thiếu một trong hai dữ liệu chi tiêu/doanh số → cảnh báo dữ liệu chưa đủ.
  if (summary.spendVnd > 0 && summary.grossSalesVnd <= 0) {
    return '‼️';
  }

  if (summary.spendVnd <= 0 && summary.grossSalesVnd > 0) {
    return '‼️';
  }

  return '0%';
}

function formatSalesVndDisplay(amountVnd: number): string {
  // Luôn hiện số tiền; không DS = 0đ (không để trống / ❌).
  return formatCompactVnd(Number.isFinite(amountVnd) ? amountVnd : 0);
}

async function clearExpiredProductPauseCallbacks(): Promise<void> {
  await db.run(
    'DELETE FROM product_pause_callbacks WHERE created_at_ms < ?',
    [Date.now() - PRODUCT_PAUSE_CALLBACK_TTL_MS]
  );
}

async function loadProductPausePayload(token: string): Promise<ProductPausePayload | undefined> {
  const row = await db.get<ProductPauseCallbackRow>(
    `SELECT token, created_at_ms, product_short_name, market_code,
            target_mkt_code, alert_level, item_number
     FROM product_pause_callbacks
     WHERE token = ?`,
    [token]
  );

  if (!row) {
    return undefined;
  }

  return {
    createdAt: Number(row.created_at_ms),
    productShortName: row.product_short_name,
    marketCode: row.market_code,
    targetMktCode: row.target_mkt_code || undefined,
    level: row.alert_level,
    itemNumber: Number(row.item_number),
  };
}

async function createProductPauseToken(
  summary: ProductMarketSummary,
  level: 'level2' | 'level3',
  itemNumber: number
): Promise<string> {
  await clearExpiredProductPauseCallbacks();

  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await db.run(
    `INSERT INTO product_pause_callbacks (
       token, created_at_ms, product_short_name, market_code,
       target_mkt_code, alert_level, item_number, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      token,
      Date.now(),
      summary.productShortName,
      summary.marketCode,
      process.env.TARGET_MKT_CODE?.trim() || null,
      level,
      itemNumber,
    ]
  );

  return token;
}

/** Trước thao tác chỉ hiện 🟢; 🟡 chỉ được gắn sau khi đã xác nhận tất cả camp đều pause. */
function getProductAlertStatusIcon(summary: ProductMarketSummary): string {
  if (summary.spendVnd > 0) {
    return '\u{1F7E2}'; // green
  }

  return '\u26AA'; // white
}

function getProductPauseButtonText(itemNumber: number, state: 'active' | 'paused' | 'pending'): string {
  if (state === 'pending') {
    return `\u23F3 ${itemNumber}`;
  }

  if (state === 'paused') {
    return `\u{1F7E1} ${itemNumber}`; // yellow = paused (như /campaigns)
  }

  return `\u{1F7E2} ${itemNumber}`; // green = active
}

/** Nút dạng "🟢 1" như /campaigns, tối đa 5 nút / hàng. */
async function buildProductPauseReplyMarkup(
  summaries: ProductMarketSummary[],
  level: 'level2' | 'level3'
): Promise<TelegramInlineKeyboardMarkup | undefined> {
  const buttons: TelegramInlineKeyboardButton[] = [];
  const displaySummaries = summaries
    .filter(summary => summary.spendVnd > 0 || summary.grossSalesVnd > 0)
    .slice(0, PRODUCT_PAUSE_BUTTONS_MAX);

  for (const [index, summary] of displaySummaries.entries()) {
    const itemNumber = index + 1;
    const token = await createProductPauseToken(summary, level, itemNumber);
    buttons.push({
      text: getProductPauseButtonText(itemNumber, 'active'),
      callback_data: `${PRODUCT_PAUSE_CALLBACK_PREFIX}:${token}`,
    });
  }

  if (buttons.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: chunkArray(buttons, GROUPED_CAMPAIGN_ACTION_BUTTONS_PER_ROW),
  };
}

/**
 * Sau khi tắt SP thành công: đổi nút 🟢 N → 🟡 N (giống /campaigns paused).
 * callback chuyển sang noop để không bấm lại.
 */
export function updateProductPauseKeyboardAfterSuccess(
  replyMarkup: TelegramInlineKeyboardMarkup | undefined,
  token: string,
  itemNumber: number
): TelegramInlineKeyboardMarkup | undefined {
  if (!replyMarkup?.inline_keyboard) {
    return undefined;
  }

  const targetCallback = `${PRODUCT_PAUSE_CALLBACK_PREFIX}:${token}`;
  const doneCallback = `${PRODUCT_PAUSE_DONE_CALLBACK_PREFIX}:${itemNumber}`;
  let changed = false;

  const inline_keyboard = replyMarkup.inline_keyboard.map(row =>
    row.map(button => {
      if (button.callback_data !== targetCallback) {
        return button;
      }

      changed = true;
      return {
        text: getProductPauseButtonText(itemNumber, 'paused'),
        callback_data: doneCallback,
      };
    })
  );

  return changed ? { inline_keyboard } : undefined;
}

/**
 * Đồng bộ chấm màu trên dòng SP trong nội dung tin: "N. 🟢" → "N. 🟡".
 */
export function updateProductAlertMessageIconAfterPause(
  messageText: string,
  itemNumber: number
): string {
  // Khớp "1. 🟢" / "1. 🟡" / "1. ⚪" (emoji chấm màu).
  const pattern = new RegExp(
    `(^|\\n)(${itemNumber})\\.\\s*(?:\\u{1F7E2}|\\u{1F7E1}|\\u26AA|\\u{1F7E0})`,
    'gu'
  );

  return messageText.replace(pattern, `$1$2. \u{1F7E1}`);
}

function campaignMatchesProductPausePayload(
  campaign: Pick<TikTokCampaign, 'name'>,
  payload: ProductPausePayload
): boolean {
  const campaignParts = String(campaign.name || '')
    .split('-')
    .map(part => normalizeSearchValue(part))
    .filter(Boolean);
  const productKey = normalizeSearchValue(payload.productShortName);
  const marketKey = normalizeSearchValue(payload.marketCode);

  return campaignParts[0] === productKey && campaignParts.slice(1).includes(marketKey);
}

async function getActiveProductCampaignRefs(
  payload: ProductPausePayload
): Promise<ProductPauseCampaignRef[]> {
  const activeCampaigns = await getActiveCampaigns({ strict: true });

  return activeCampaigns
    .filter(campaign => campaignMatchesProductPausePayload(campaign, payload))
    .map(campaign => ({
      advertiserId: campaign.advertiser_id,
      campaignId: campaign.id,
    }));
}

/**
 * Tắt toàn bộ campaign thuộc 1 SP (token từ nút alert cấp 2/3).
 */
export async function executeProductPauseByToken(token: string): Promise<ProductPauseResult> {
  await clearExpiredProductPauseCallbacks();

  const payload = await loadProductPausePayload(token);
  if (!payload) {
    throw new Error('Nút đã hết hạn hoặc SP đã được tắt. Chờ cảnh báo cấp 2/3 mới.');
  }

  if (productPauseCallbacksInFlight.has(token)) {
    throw new Error('Sản phẩm này đang được xử lý. Vui lòng chờ kết quả.');
  }

  productPauseCallbacksInFlight.add(token);

  try {
    const productLabel = `${payload.productShortName} (${payload.marketCode})`;
    const activeBefore = await getActiveProductCampaignRefs(payload);

    if (activeBefore.length === 0) {
      await db.run('DELETE FROM product_pause_callbacks WHERE token = ?', [token]);
      return {
        productLabel,
        itemNumber: payload.itemNumber,
        token,
        total: 0,
        success: 0,
        failed: 0,
        allPaused: true,
        errors: [],
      };
    }

    const batchResult = await setCampaignStatusesBatch(activeBefore, 'DISABLE');

    // Chỉ hoàn tất sau khi đọc lại TikTok và xác nhận không còn campaign active.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const activeAfter = await getActiveProductCampaignRefs(payload);
    const remainingKeys = new Set(
      activeAfter.map(campaign => `${campaign.advertiserId}:${campaign.campaignId}`)
    );
    const allTargetKeys = new Set([
      ...activeBefore.map(campaign => `${campaign.advertiserId}:${campaign.campaignId}`),
      ...remainingKeys,
    ]);
    const failureByKey = new Map(
      batchResult.failed.map(failure => [
        `${failure.advertiserId}:${failure.campaignId}`,
        failure.error,
      ])
    );
    const errors = activeAfter.map(campaign => {
      const key = `${campaign.advertiserId}:${campaign.campaignId}`;
      return `${campaign.campaignId}: ${failureByKey.get(key) || 'vẫn đang active sau khi kiểm tra lại'}`;
    });
    const total = allTargetKeys.size;
    const failed = remainingKeys.size;
    const success = Math.max(0, total - failed);
    const allPaused = failed === 0;

    if (allPaused) {
      await db.run('DELETE FROM product_pause_callbacks WHERE token = ?', [token]);
    }

    return {
      productLabel,
      itemNumber: payload.itemNumber,
      token,
      total,
      success,
      failed,
      allPaused,
      errors,
    };
  } finally {
    productPauseCallbacksInFlight.delete(token);
  }
}

async function createProductCpAdsAlertContent(
  summaries: ProductMarketSummary[],
  threshold: number,
  options: {
    level: 'level2' | 'level3';
    levelLabel: string;
    periodLabel: string;
  }
): Promise<CampaignAlertContent> {
  // Cấp 2: ⚠️ · Cấp 3: 🚨
  const titleIcon = options.level === 'level3' ? '🚨' : '⚠️';
  const titleLine = `${titleIcon} Cảnh báo ${options.levelLabel} (${summaries.length} sản phẩm)`;
  const conditionLine = `📈 %CP ads vượt ngưỡng ${formatPercent(threshold)} · ${options.periodLabel}`;
  const plainLines = [
    titleLine,
    conditionLine,
    '',
  ];
  const htmlLines = [
    `<b>${escapeHtml(titleLine)}</b>`,
    `<b>${escapeHtml(conditionLine)}</b>`,
    '',
  ];

  const displaySummaries = summaries
    .filter(summary => summary.spendVnd > 0 || summary.grossSalesVnd > 0);

  // Tách phần theo mã MKT (gộp chung trong một tin); không có mã nào thì render phẳng như cũ.
  const mktGroups = new Map<string, ProductMarketSummary[]>();
  for (const summary of displaySummaries) {
    const mkt = summary.mktCode || 'ALL';
    const list = mktGroups.get(mkt) || [];
    list.push(summary);
    mktGroups.set(mkt, list);
  }

  let itemCount = 0;
  for (const [mkt, groupSummaries] of [...mktGroups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi'))) {
    if (mkt !== 'ALL') {
      const mktLabel = mkt === 'CHUA_GAN_MKT' ? 'Chưa gắn MKT' : mkt;
      const sectionHeader = `🏷️ ${mktLabel}`;
      plainLines.push(sectionHeader);
      htmlLines.push(`🏷️ <b>${escapeHtml(mktLabel)}</b>`);
    }

    groupSummaries.forEach(summary => {
    const cpaVnd = getProductSummaryCpaVnd(summary);
    const cpAdsText = formatProductSummaryCpAds(summary);
    const itemNumber = ++itemCount;
    const statusIcon = getProductAlertStatusIcon(summary);
    const productTitle =
      `${itemNumber}. ${statusIcon} ${summary.productShortName} (${summary.marketCode}) · ${formatProductCampaignSuffix(summary)}`;

    // Metrics theo cấp (icon thống nhất: 🧾 = doanh số, 📦 = số đơn):
    // - Cấp 2: spend · click/CTR · CV · CPA · DS · %CP (không số đơn)
    // - Cấp 3: spend · CV · CPA · DS · số đơn · %CP (không click/CTR)
    const metrics: string[] = [
      `💸 ${formatCompactVnd(summary.spendVnd)}`,
    ];

    if (options.level === 'level2') {
      metrics.push(
        `👆 ${summary.clicks.toLocaleString('vi-VN')}/${formatPercent(summary.impressions > 0 ? (summary.clicks / summary.impressions) * 100 : 0)}`
      );
    }

    metrics.push(
      `🎯 ${summary.conversions.toLocaleString('vi-VN')}`,
      `💰 ${formatCompactVnd(cpaVnd)}`,
      `🧾 ${formatSalesVndDisplay(summary.grossSalesVnd)}`,
    );

    if (options.level === 'level3') {
      metrics.push(`📦 ${summary.orders.toLocaleString('vi-VN')}`);
    }

    metrics.push(`📈 ${cpAdsText}`);

    const metricsLine = metrics.join(' · ');

    plainLines.push(productTitle, metricsLine);
    htmlLines.push(
      `${itemNumber}. ${statusIcon} <b>${escapeHtml(summary.productShortName)} (${escapeHtml(summary.marketCode)})</b> · ${escapeHtml(formatProductCampaignSuffix(summary))}`,
      escapeHtml(metricsLine)
    );
    });
  }

  return {
    plainText: plainLines.join('\n'),
    htmlText: htmlLines.join('\n'),
    replyMarkup: await buildProductPauseReplyMarkup(displaySummaries, options.level),
  };
}
function getAlertTitle(type: string): string {
  if (type.startsWith('balance')) {
    return 'Balance';
  }

  if (type.startsWith('campaign')) {
    return 'Campaign';
  }

  if (type.startsWith('ad')) {
    return 'Ad';
  }

  return 'Alert';
}

async function saveAndSendAlert(
  bot: Telegraf,
  type: string,
  message: string,
  severity: AlertSeverity,
  options?: AlertSendOptions
): Promise<boolean> {
  await db.run(
    'INSERT INTO alerts (type, message, severity) VALUES (?, ?, ?)',
    [type, message, severity]
  );

  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId) {
    return false;
  }

  try {
    if (options?.telegramHtml || options?.replyMarkup) {
      await bot.telegram.sendMessage(
        adminChatId,
        options?.telegramHtml || escapeHtml(message),
        {
          parse_mode: 'HTML',
          ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        }
      );
      console.log(`Alert sent: ${type}`);
      return true;
    }

    const alertTitle = getAlertTitle(type);
    await bot.telegram.sendMessage(
      adminChatId,
      `🔔 <b>${alertTitle}</b> - ${severity.toUpperCase()}\n${escapeHtml(message)}`,
      { parse_mode: 'HTML' }
    );
    console.log(`Alert sent: ${type}`);
    return true;
  } catch (error) {
    console.error(`Error sending ${type} alert via Telegram:`, error);
    return false;
  }
}

async function upsertBalanceAlertRule(): Promise<void> {
  await db.run(
    'UPDATE alert_rules SET is_active = 0 WHERE metric IN (?, ?)',
    ['campaign_spend', 'ad_spend']
  );

  const existing = await db.get<BalanceAlertRule>(
    'SELECT id FROM alert_rules WHERE metric = ?',
    [BALANCE_RULE_METRIC]
  );
  const balanceThreshold = await getRuntimeSettingNumber(
    'balance_threshold_usd',
    RUNTIME_SETTING_DEFAULTS.balanceThresholdUsd
  );

  if (existing?.id) {
    await db.run(
      'UPDATE alert_rules SET threshold = ?, comparison_operator = ?, is_active = 1 WHERE id = ?',
      [balanceThreshold, 'lt', existing.id]
    );
    return;
  }

  await db.run(
    'INSERT INTO alert_rules (metric, threshold, comparison_operator, is_active) VALUES (?, ?, ?, 1)',
    [BALANCE_RULE_METRIC, balanceThreshold, 'lt']
  );
}
async function getRuleStateKeys(ruleId: number): Promise<Map<string, number>> {
  const rows = await db.all<AlertActionStateRow>(
    'SELECT subject_key, updated_at FROM alert_action_state WHERE rule_id = ?',
    [ruleId]
  );

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.subject_key, new Date(row.updated_at + 'Z').getTime());
  }
  return map;
}

async function saveRuleState(ruleId: number, subjectKey: string): Promise<void> {
  await db.run(
    `INSERT INTO alert_action_state (rule_id, subject_key, state, updated_at)
     VALUES (?, ?, 'matched', CURRENT_TIMESTAMP)
     ON CONFLICT(rule_id, subject_key)
     DO UPDATE SET state = 'matched', updated_at = CURRENT_TIMESTAMP`,
    [ruleId, subjectKey]
  );
}

async function clearRuleStates(ruleId: number, matchedKeys: Set<string>): Promise<void> {
  const existingStates = await getRuleStateKeys(ruleId);

  for (const subjectKey of existingStates.keys()) {
    if (matchedKeys.has(subjectKey)) {
      continue;
    }

    await db.run(
      'DELETE FROM alert_action_state WHERE rule_id = ? AND subject_key = ?',
      [ruleId, subjectKey]
    );
  }
}
export async function initializeAlertRules(): Promise<AlertInitializationResult> {
  await upsertBalanceAlertRule();

  const existing = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM alert_action_rules');
  const actionRuleCount = Number(existing?.count || 0);
  console.log(`Alert rules loaded from SQLite (${actionRuleCount} action rules)`);

  return {
    actionRuleCount,
    balanceThreshold: await getRuntimeSettingNumber(
      'balance_threshold_usd',
      RUNTIME_SETTING_DEFAULTS.balanceThresholdUsd
    ),
    sheetCreated: false,
    clearedLegacyDemo: false,
  };
}

export async function getRecentAlerts(limit = 10): Promise<StoredAlert[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 10;
  const safeLimit = Math.min(Math.max(normalizedLimit || 10, 1), 50);

  return db.all<StoredAlert>(
    `SELECT
      id,
      type,
      message,
      severity,
      created_at AS createdAt
     FROM alerts
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT ?`,
    [safeLimit]
  );
}
async function checkProductCpAdsAlertsForPeriod(
  bot: Telegraf,
  options: {
    level: 'level2' | 'level3';
    ruleId: number;
    cooldownMs: number;
    period: { startDate: string; endDate: string; label: string };
    levelLabel: string;
    alertType: string;
    enabled: boolean;
    threshold: number;
  }
): Promise<void> {
  if (!options.enabled) {
    await clearRuleStates(options.ruleId, new Set());
    return;
  }

  const threshold = options.threshold;
  const summaries = await buildBcProductMarketSummaries({
    ...options.period,
  });
  const matchedSummaries = summaries
    .filter(summary => summary.spendVnd > 0)
    .filter(summary => getProductSummaryCpAds(summary) > threshold)
    .sort((summaryA, summaryB) =>
      Number.isFinite(getProductSummaryCpAds(summaryB)) === Number.isFinite(getProductSummaryCpAds(summaryA))
        ? getProductSummaryCpAds(summaryB) - getProductSummaryCpAds(summaryA) || summaryB.spendVnd - summaryA.spendVnd
        : Number.isFinite(getProductSummaryCpAds(summaryB)) ? -1 : 1
    );
  const matchedKeys = new Set(
    matchedSummaries.map(summary => getProductSummarySubjectKey(summary, options.level))
  );
  const notificationSubjectKey = getRuleNotificationSubjectKey(options.ruleId);

  if (matchedSummaries.length === 0) {
    await clearRuleStates(options.ruleId, new Set());
    return;
  }

  matchedKeys.add(notificationSubjectKey);
  const existingStates = await getRuleStateKeys(options.ruleId);
  const now = Date.now();

  if (!shouldSendTelegramAlert(
    existingStates.get(notificationSubjectKey),
    now,
    options.cooldownMs
  )) {
    await clearRuleStates(options.ruleId, matchedKeys);
    return;
  }

  const maxCpAds = Math.max(...matchedSummaries.map(getProductSummaryCpAds));
  const severity = calculateAlertSeverity(maxCpAds, threshold);
  // Chỉ hiện nhãn ngắn: "Hôm nay" / "Tháng này" — không kèm khoảng ngày.
  const periodLabel = options.period.label;
  const alertContent = await createProductCpAdsAlertContent(matchedSummaries, threshold, {
    level: options.level,
    levelLabel: options.levelLabel,
    periodLabel,
  });

  const wasSent = await saveAndSendAlert(bot, options.alertType, alertContent.plainText, severity, {
    telegramHtml: alertContent.htmlText,
    replyMarkup: alertContent.replyMarkup,
  });

  if (!wasSent) {
    return;
  }

  for (const summary of matchedSummaries) {
    await saveRuleState(options.ruleId, getProductSummarySubjectKey(summary, options.level));
  }
  await saveRuleState(options.ruleId, notificationSubjectKey);

  await clearRuleStates(options.ruleId, matchedKeys);
}

async function checkLevel2ProductCpAdsAlerts(bot: Telegraf): Promise<void> {
  await checkProductCpAdsAlertsForPeriod(bot, {
    level: 'level2',
    ruleId: LEVEL2_PRODUCT_CP_ADS_RULE_ID,
    cooldownMs: LEVEL2_PRODUCT_CP_ADS_COOLDOWN_MS,
    period: getTodayBcReportPeriod(),
    levelLabel: 'cấp 2',
    alertType: 'level2_product_cp_ads',
    enabled: isLevel2ProductCpAdsEnabled(),
    threshold: await getLevel2ProductCpAdsThreshold(),
  });
}

async function checkLevel3ProductCpAdsMonthAlerts(bot: Telegraf): Promise<void> {
  await checkProductCpAdsAlertsForPeriod(bot, {
    level: 'level3',
    ruleId: LEVEL3_PRODUCT_CP_ADS_MONTH_RULE_ID,
    cooldownMs: LEVEL3_PRODUCT_CP_ADS_COOLDOWN_MS,
    period: getMonthBcReportPeriod(),
    levelLabel: 'cấp 3',
    alertType: 'level3_product_cp_ads_month',
    enabled: isLevel3ProductCpAdsEnabled(),
    threshold: await getLevel3ProductCpAdsThreshold(),
  });
}

export async function checkAndSendLevel2Alerts(bot: Telegraf): Promise<void> {
  console.log('Checking level 2 product CP ads alerts (today)...');
  await checkLevel2ProductCpAdsAlerts(bot);
}

export async function checkAndSendLevel3Alerts(bot: Telegraf): Promise<void> {
  console.log('Checking level 3 product CP ads alerts (month-to-date)...');
  await checkLevel3ProductCpAdsMonthAlerts(bot);
}