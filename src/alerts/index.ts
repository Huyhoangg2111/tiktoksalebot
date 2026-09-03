import type { Telegraf } from 'telegraf';
import { db } from '../db/index.js';
import {
  ensureAlertsSheetTemplate,
  getAlertRulesConfig,
  type AlertAction,
  type AlertCampaignStatus,
  type AlertActionRuleSheetRow,
  type AlertComparisonOperator,
  type AlertMetric,
} from '../google-sheets/api.js';
import { getTrackedAdvertiserIdSet } from '../accounts/tracking.js';
import {
  getTikTokAccountBalance,
  getTodaySpentAds,
  getTodaySpentCampaigns,
  setCampaignAdsStatus,
  type TikTokAccountBalance,
  type TikTokSpentAd,
  type TikTokSpentCampaign,
} from '../tiktok/api.js';
import { getCampaignCloneCountMap } from '../campaigns/clone-tracking.js';
import {
  buildBcProductMarketSummaries,
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
const BALANCE_TRACKING_RULE_ID = 0;
const CAMPAIGN_ACTION_CALLBACK_PREFIX = 'campaign_action';
const CAMPAIGN_DAILY_ALERT_CALLBACK_PREFIX = 'cad';
const CAMPAIGN_QUALIFIED_NOTIFICATION_RULE_ID = -100;
const LEVEL2_PRODUCT_CP_ADS_RULE_ID = -200;
const GROUPED_CAMPAIGN_ACTION_BUTTONS_PER_ROW = 5;
const ALERT_TELEGRAM_COOLDOWN_MS = 10 * 60 * 1000;
const CAMPAIGN_QUALIFIED_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const LEVEL2_PRODUCT_CP_ADS_COOLDOWN_MS = 30 * 60 * 1000;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function formatUsd(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
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

function compareValues(
  currentValue: number,
  operator: AlertComparisonOperator,
  threshold: number
): boolean {
  if (operator === 'gt') {
    return currentValue > threshold;
  }

  if (operator === 'gte') {
    return currentValue >= threshold;
  }

  if (operator === 'lt') {
    return currentValue < threshold;
  }

  if (operator === 'lte') {
    return currentValue <= threshold;
  }

  return currentValue === threshold;
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

function getHigherAlertSeverity(
  currentSeverity: AlertSeverity | undefined,
  nextSeverity: AlertSeverity
): AlertSeverity {
  const severityRanks: Record<AlertSeverity, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };

  if (!currentSeverity) {
    return nextSeverity;
  }

  return severityRanks[nextSeverity] > severityRanks[currentSeverity]
    ? nextSeverity
    : currentSeverity;
}

function normalizeSearchValue(value: string | undefined): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+-\s+/g, ' - ')
    .trim()
    .toLocaleUpperCase('vi-VN');
}

function getCampaignRuleKey(campaignName: string | undefined): string {
  const parts = String(campaignName || '')
    .split(/\s+-\s+/)
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return normalizeSearchValue(`${parts[0]} - ${parts[1]}`);
  }

  return normalizeSearchValue(campaignName);
}

function matchesCampaignKey(rule: AlertActionRule, campaignName: string | undefined): boolean {
  if (!rule.name_contains) {
    return true;
  }

  const ruleMatch = normalizeSearchValue(rule.name_contains);

  if (!ruleMatch) {
    return false;
  }

  if (ruleMatch.includes(' - ')) {
    const campaignKey = getCampaignRuleKey(campaignName);
    return campaignKey === ruleMatch;
  }

  const campaignFullName = normalizeSearchValue(campaignName);

  return campaignFullName.includes(ruleMatch);
}

function getCampaignSubjectKey(campaign: TikTokSpentCampaign): string {
  return `campaign:${campaign.advertiser_id}:${campaign.campaign_id}`;
}

function getCampaignDailyAlertKey(
  campaign: Pick<TikTokSpentCampaign, 'advertiser_id' | 'campaign_id'>
): string {
  return `${campaign.advertiser_id}:${campaign.campaign_id}`;
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

async function getUntrackedCampaignDailyAlertKeys(dateKey = getDateKey()): Promise<Set<string>> {
  const rows = await db.all<CampaignDailyAlertTrackingRow>(
    `SELECT advertiser_id, campaign_id
     FROM campaign_daily_alert_tracking
     WHERE date_key = ? AND is_tracked = 0`,
    [dateKey]
  );

  return new Set(rows.map(row => `${row.advertiser_id}:${row.campaign_id}`));
}

function getAdSubjectKey(ad: TikTokSpentAd): string {
  return `ad:${ad.advertiser_id}:${ad.ad_id}`;
}

function getBalanceSubjectKey(account: TikTokAccountBalance): string {
  return `balance:${account.advertiser_id}`;
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

function getActionLabel(action: AlertAction): string {
  if (action === 'pause') {
    return 'pause';
  }

  if (action === 'enable') {
    return 'enable';
  }

  return 'notify';
}

function formatComparisonOperator(operator: AlertComparisonOperator): string {
  if (operator === 'gt') {
    return '>';
  }

  if (operator === 'gte') {
    return '>=';
  }

  if (operator === 'lt') {
    return '<';
  }

  if (operator === 'lte') {
    return '<=';
  }

  return '=';
}

function getRuleMetricLabel(metric: AlertMetric): string {
  return metric === 'spend' ? 'Spend' : 'CPA';
}

async function getLevel2ProductCpAdsThreshold(): Promise<number> {
  const rawValue = process.env.ALERT_LEVEL2_CP_ADS_THRESHOLD || process.env.LEVEL2_CP_ADS_THRESHOLD;
  const parsedValue = rawValue ? Number(rawValue) : 40;
  const envValue = Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : RUNTIME_SETTING_DEFAULTS.level2CpAdsThreshold;

  return getRuntimeSettingNumber('level2_cp_ads_threshold', envValue);
}

function isLevel2ProductCpAdsEnabled(): boolean {
  const rawValue = process.env.ALERT_LEVEL2_CP_ADS_ENABLED || process.env.LEVEL2_CP_ADS_ENABLED;

  return !rawValue || !['0', 'false', 'off', 'no'].includes(rawValue.trim().toLowerCase());
}

function getRuleMetricValue(
  metrics: Pick<TikTokSpentCampaign | TikTokSpentAd, 'spend' | 'cpa'>,
  metric: AlertMetric
): number {
  return metric === 'spend' ? metrics.spend : metrics.cpa;
}

function formatRuleMetricThreshold(rule: AlertActionRule): string {
  return `${getRuleMetricLabel(rule.metric)} ${formatComparisonOperator(rule.metric_operator)} ${formatUsd(rule.metric_threshold)}`;
}

function getCampaignAlertLabel(action: AlertAction): 'Ads' | 'Pause' | 'Active' {
  if (action === 'pause') {
    return 'Pause';
  }

  if (action === 'enable') {
    return 'Active';
  }

  return 'Ads';
}

function getCampaignActionResultLine(actionLabel: 'Pause' | 'Active', success: boolean): string {
  return `${actionLabel} ${success ? 'thành công' : 'thất bại'}`;
}

function getCampaignConditionLabel(rule: AlertActionRule): string {
  if (rule.metric_operator === 'gt' || rule.metric_operator === 'gte') {
    return 'vượt giới hạn';
  }

  return 'đạt điều kiện';
}

function getNotifySuggestedAction(rule: AlertActionRule): 'pause' | 'enable' | null {
  if (rule.action !== 'notify') {
    return null;
  }

  if (rule.metric_operator === 'gt' || rule.metric_operator === 'gte') {
    return 'pause';
  }

  if (rule.metric_operator === 'lt' || rule.metric_operator === 'lte') {
    return 'enable';
  }

  return null;
}

function isQualifiedCampaignNotifyRule(rule: AlertActionRule): boolean {
  return rule.entity === 'campaign' &&
    rule.action === 'notify' &&
    (rule.metric_operator === 'lt' || rule.metric_operator === 'lte');
}

function buildCampaignActionCallbackData(
  operationStatus: 'ENABLE' | 'DISABLE',
  campaignId: string
): string {
  return `${CAMPAIGN_ACTION_CALLBACK_PREFIX}:${operationStatus}:${campaignId}`;
}

function buildCampaignDailyAlertCallbackData(
  isTracked: boolean,
  advertiserId: string,
  campaignId: string
): string {
  return `${CAMPAIGN_DAILY_ALERT_CALLBACK_PREFIX}:${isTracked ? '1' : '0'}:${advertiserId}:${campaignId}`;
}

function buildCampaignDailyAlertButton(
  campaign: Pick<TikTokSpentCampaign, 'advertiser_id' | 'campaign_id'>,
  index?: number
): { text: string; callback_data: string } {
  return {
    text: index ? `🔕 ${index} Bỏ TD` : '🔕 Bỏ theo dõi hôm nay',
    callback_data: buildCampaignDailyAlertCallbackData(false, campaign.advertiser_id, campaign.campaign_id),
  };
}

function buildExplicitCampaignActionReplyMarkup(
  campaignId: string,
  action: 'pause' | 'enable'
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[{
      text: action === 'pause' ? 'Pause' : 'Active',
      callback_data: buildCampaignActionCallbackData(
        action === 'pause' ? 'DISABLE' : 'ENABLE',
        campaignId
      ),
    }]],
  };
}

function formatCampaignActionButtonText(
  icon: string,
  label: string,
  index?: number
): string {
  return index ? `${icon} ${index} ${label}` : `${icon} ${label}`;
}

function buildCampaignActionButtons(
  rule: AlertActionRule,
  campaign: Pick<TikTokSpentCampaign, 'advertiser_id' | 'campaign_id' | 'status'>,
  index?: number
): Array<{ text: string; callback_data: string }> {
  if (campaign.status === 'deleted') {
    return [];
  }

  const buttons: Array<{ text: string; callback_data: string }> = [];

  if (rule.action === 'notify') {
    const suggestedAction = getNotifySuggestedAction(rule);

    if (suggestedAction === 'pause' && campaign.status === 'active') {
      buttons.push({
        text: formatCampaignActionButtonText('⏸', 'Pause', index),
        callback_data: buildCampaignActionCallbackData('DISABLE', campaign.campaign_id),
      });
    }

    if (suggestedAction === 'enable' && campaign.status === 'paused') {
      buttons.push({
        text: formatCampaignActionButtonText('✅', 'Active', index),
        callback_data: buildCampaignActionCallbackData('ENABLE', campaign.campaign_id),
      });
    }
  } else if (campaign.status === 'active') {
    buttons.push({
      text: formatCampaignActionButtonText('⏸', 'Pause', index),
      callback_data: buildCampaignActionCallbackData('DISABLE', campaign.campaign_id),
    });
  } else if (campaign.status === 'paused') {
    buttons.push({
      text: formatCampaignActionButtonText('✅', 'Active', index),
      callback_data: buildCampaignActionCallbackData('ENABLE', campaign.campaign_id),
    });
  }

  if (rule.action === 'notify' && (rule.metric_operator === 'lt' || rule.metric_operator === 'lte')) {
    buttons.push({
      text: formatCampaignActionButtonText('🚀', 'X', index),
      callback_data: `duplicate_camp:${campaign.campaign_id}`,
    });
  }

  if (rule.action === 'notify') {
    buttons.push(buildCampaignDailyAlertButton(campaign, index));
  }

  return buttons;
}

function buildCampaignReplyMarkup(
  rule: AlertActionRule,
  campaign: Pick<TikTokSpentCampaign, 'advertiser_id' | 'campaign_id' | 'status'>
): TelegramInlineKeyboardMarkup | undefined {
  const buttons = buildCampaignActionButtons(rule, campaign);

  if (buttons.length > 0) {
    return { inline_keyboard: [buttons] };
  }

  return undefined;
}

function buildGroupedCampaignReplyMarkup(
  rule: AlertActionRule,
  campaigns: TikTokSpentCampaign[]
): TelegramInlineKeyboardMarkup | undefined {
  const buttons = campaigns.flatMap((campaign, index) =>
    buildCampaignActionButtons(rule, campaign, index + 1)
  );

  return buttons.length > 0
    ? { inline_keyboard: chunkArray(buttons, GROUPED_CAMPAIGN_ACTION_BUTTONS_PER_ROW) }
    : undefined;
}

function buildQualifiedCampaignReplyMarkup(
  campaigns: TikTokSpentCampaign[]
): TelegramInlineKeyboardMarkup | undefined {
  const buttons = campaigns.flatMap((campaign, index) => {
    if (campaign.status === 'deleted') {
      return [];
    }

    const campaignNumber = index + 1;
    const campaignButtons: Array<{ text: string; callback_data: string }> = [];

    if (campaign.status === 'paused') {
      campaignButtons.push({
        text: formatCampaignActionButtonText('✅', 'Active', campaignNumber),
        callback_data: buildCampaignActionCallbackData('ENABLE', campaign.campaign_id),
      });
    }

    campaignButtons.push(
      {
        text: formatCampaignActionButtonText('🚀', 'X', campaignNumber),
        callback_data: `duplicate_camp:${campaign.campaign_id}`,
      },
      buildCampaignDailyAlertButton(campaign, campaignNumber),
    );

    return campaignButtons;
  });

  return buttons.length > 0
    ? { inline_keyboard: chunkArray(buttons, GROUPED_CAMPAIGN_ACTION_BUTTONS_PER_ROW) }
    : undefined;
}

function getCampaignDisplayName(campaignName: string | undefined): string {
  const parts = String(campaignName || '')
    .split(' - ')
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]} - ${parts[1]}`;
  }

  return String(campaignName || '').trim() || 'Không rõ tên chiến dịch';
}

function getCampaignAccountLabel(
  campaign: Pick<TikTokSpentCampaign, 'advertiser_id' | 'advertiser_name'>
): string {
  const accountName = String(campaign.advertiser_name || '').trim();
  const aaNumberMatch = accountName.match(/\bAA\s*(\d+)\b/i);

  if (aaNumberMatch?.[1]) {
    return aaNumberMatch[1].padStart(2, '0');
  }

  return accountName || campaign.advertiser_id;
}

function getCampaignAccountSuffix(
  campaign: Pick<TikTokSpentCampaign, 'advertiser_id' | 'advertiser_name'>
): string {
  return ` · ${getCampaignAccountLabel(campaign)}`;
}

function createCampaignAlertContent(
  campaign: TikTokSpentCampaign,
  rule: AlertActionRule,
  options?: {
    result?: {
      actionLabel: 'Pause' | 'Active';
      success: boolean;
      reason?: string;
    };
  }
): CampaignAlertContent {
  const heading = getCampaignAlertLabel(rule.action);
  const conditionLabel = getCampaignConditionLabel(rule);
  const campaignDisplayName = getCampaignDisplayName(campaign.campaign_name);
  const accountSuffix = getCampaignAccountSuffix(campaign);
  const titleIcon =
    rule.action === 'enable'
      ? '✅'
      : '⚠️';
  const conditionIcon = conditionLabel === 'vượt giới hạn' ? '📈' : '✅';
  const metricThreshold = formatRuleMetricThreshold(rule);
  const conversionThreshold =
    `${formatComparisonOperator(rule.conversions_operator)} ${rule.conversions_threshold}`;
  const plainLines = [
    `${titleIcon} ${heading}: ${campaignDisplayName} - ${campaign.campaign_id}${accountSuffix}`,
    `💸 ${formatUsd(campaign.spend)} · 👆 ${campaign.clicks.toLocaleString()}/${formatPercent(campaign.ctr)} · 🎯 ${campaign.conversions.toLocaleString()} · 💰 ${formatUsd(campaign.cpa)}`,
    `${conditionIcon} ${conditionLabel}: 💰 ${metricThreshold} · 🎯 ${conversionThreshold}`,
  ];

  if (options?.result) {
    plainLines.push(
      `${options.result.success ? '✅' : '⛔'} ${getCampaignActionResultLine(options.result.actionLabel, options.result.success)}`
    );
    if (options.result.reason) {
      plainLines.push(`ℹ️ Lý do: ${options.result.reason}`);
    }
  }

  const htmlLines = [
    `<b>${escapeHtml(titleIcon)} ${escapeHtml(heading)}: ${escapeHtml(campaignDisplayName)}</b> - <code>${escapeHtml(campaign.campaign_id)}</code>${escapeHtml(accountSuffix)}`,
    escapeHtml(plainLines[1]),
    `${escapeHtml(conditionIcon)} <b>${escapeHtml(conditionLabel)}</b>: 💰 <b>${escapeHtml(metricThreshold)}</b> · 🎯 <b>${escapeHtml(conversionThreshold)}</b>`,
    ...(options?.result ? [escapeHtml(plainLines[3])] : []),
    ...(options?.result?.reason ? [escapeHtml(plainLines[4])] : []),
  ];

  return {
    plainText: plainLines.join('\n'),
    htmlText: htmlLines.join('\n'),
    replyMarkup: options?.result && !options.result.success
      ? undefined
      : buildCampaignReplyMarkup(rule, campaign),
  };
}

function createCampaignAlertGroupContent(
  campaigns: TikTokSpentCampaign[],
  rule: AlertActionRule
): CampaignAlertContent {
  const conditionLabel = getCampaignConditionLabel(rule);
  const titleIcon = conditionLabel === 'vượt giới hạn' ? '⚠️' : '✅';
  const conditionIcon = conditionLabel === 'vượt giới hạn' ? '📈' : '✅';
  const metricThreshold = formatRuleMetricThreshold(rule);
  const conversionThreshold =
    `${formatComparisonOperator(rule.conversions_operator)} ${rule.conversions_threshold}`;
  const titleLine = `${titleIcon} Ads ${conditionLabel} (${campaigns.length} camp)`;
  const conditionLine = `${conditionIcon} ${conditionLabel}: 💰 ${metricThreshold} · 🎯 ${conversionThreshold}`;
  const plainLines = [
    titleLine,
    conditionLine,
    '',
  ];
  const htmlLines = [
    `<b>${escapeHtml(titleLine)}</b>`,
    `${escapeHtml(conditionIcon)} <b>${escapeHtml(conditionLabel)}</b>: 💰 <b>${escapeHtml(metricThreshold)}</b> · 🎯 <b>${escapeHtml(conversionThreshold)}</b>`,
    '',
  ];

  campaigns.forEach((campaign, index) => {
    const campaignDisplayName = getCampaignDisplayName(campaign.campaign_name);
    const campaignNumber = index + 1;
    const accountSuffix = getCampaignAccountSuffix(campaign);
    const campaignTitle = `${campaignNumber}. ${campaignDisplayName} - ${campaign.campaign_id}${accountSuffix}`;
    const metricsLine =
      `💸 ${formatUsd(campaign.spend)} · ` +
      `👆 ${campaign.clicks.toLocaleString()}/${formatPercent(campaign.ctr)} · ` +
      `🎯 ${campaign.conversions.toLocaleString()} · ` +
      `💰 ${formatUsd(campaign.cpa)}`;

    plainLines.push(campaignTitle, metricsLine);
    htmlLines.push(
      `<b>${escapeHtml(`${campaignNumber}. ${campaignDisplayName}`)}</b> - <code>${escapeHtml(campaign.campaign_id)}</code>${escapeHtml(accountSuffix)}`,
      escapeHtml(metricsLine)
    );
  });

  return {
    plainText: plainLines.join('\n'),
    htmlText: htmlLines.join('\n'),
    replyMarkup: buildGroupedCampaignReplyMarkup(rule, campaigns),
  };
}

function createQualifiedCampaignAlertGroupContent(
  campaigns: TikTokSpentCampaign[],
  cloneCountByCampaignId: Map<string, number>
): CampaignAlertContent {
  const titleLine = `✅ ADS Đạt Điều Kiện (${campaigns.length} camp)`;
  const plainLines = [
    titleLine,
    '',
  ];
  const htmlLines = [
    `<b>${escapeHtml(titleLine)}</b>`,
    '',
  ];

  campaigns.forEach((campaign, index) => {
    const campaignDisplayName = getCampaignDisplayName(campaign.campaign_name);
    const campaignNumber = index + 1;
    const cloneCount = cloneCountByCampaignId.get(campaign.campaign_id) || 0;
    const accountSuffix = getCampaignAccountSuffix(campaign);
    const campaignTitle =
      `${campaignNumber}. ${campaignDisplayName} - ${campaign.campaign_id}${accountSuffix} · 🚀 x${cloneCount}`;
    const metricsLine =
      `💸 ${formatUsd(campaign.spend)} · ` +
      `👆 ${campaign.clicks.toLocaleString()}/${formatPercent(campaign.ctr)} · ` +
      `🎯 ${campaign.conversions.toLocaleString()} · ` +
      `💰 ${formatUsd(campaign.cpa)}`;

    plainLines.push(campaignTitle, metricsLine);
    htmlLines.push(
      `<b>${escapeHtml(`${campaignNumber}. ${campaignDisplayName}`)}</b> - ` +
      `<code>${escapeHtml(campaign.campaign_id)}</code>${escapeHtml(accountSuffix)} · 🚀 x${cloneCount}`,
      escapeHtml(metricsLine)
    );
  });

  return {
    plainText: plainLines.join('\n'),
    htmlText: htmlLines.join('\n'),
    replyMarkup: buildQualifiedCampaignReplyMarkup(campaigns),
  };
}

function getProductSummarySubjectKey(summary: ProductMarketSummary): string {
  return `level2:product_cp_ads:${normalizeSearchValue(summary.productShortName)}:${normalizeSearchValue(summary.marketCode)}`;
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

  if (summary.spendVnd > 0 && summary.grossSalesVnd <= 0) {
    return '🧾❌';
  }

  if (summary.spendVnd <= 0 && summary.grossSalesVnd > 0) {
    return '💸❌';
  }

  return '';
}

function createLevel2ProductCpAdsAlertContent(
  summaries: ProductMarketSummary[],
  threshold: number
): CampaignAlertContent {
  const titleLine = `⚠️ Cảnh báo cấp 2 (${summaries.length} sản phẩm)`;
  const conditionLine = `📈 %CP ads vượt ngưỡng ${formatPercent(threshold)}`;
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

  summaries
    .filter(summary => summary.spendVnd > 0 || summary.grossSalesVnd > 0)
    .forEach((summary, index) => {
    const cpaVnd = getProductSummaryCpaVnd(summary);
    const cpAdsText = formatProductSummaryCpAds(summary);
    const productTitle =
      `${index + 1}. ${summary.productShortName} (${summary.marketCode}) · ${formatProductCampaignSuffix(summary)}`;
    const metrics = [
      `💸 ${formatCompactVnd(summary.spendVnd)}`,
      `🎯 ${summary.conversions.toLocaleString('vi-VN')}`,
      `💰 ${formatCompactVnd(cpaVnd)}`,
      `🧾 ${formatCompactVnd(summary.grossSalesVnd)}`,
      `📦 ${summary.orders.toLocaleString('vi-VN')}`,
      ...(cpAdsText ? [`📈 ${cpAdsText}`] : []),
    ];
    const metricsLine = metrics.join(' · ');

    plainLines.push(productTitle, metricsLine);
    htmlLines.push(
      `<b>${escapeHtml(productTitle)}</b>`,
      escapeHtml(metricsLine)
    );
  });

  return {
    plainText: plainLines.join('\n'),
    htmlText: htmlLines.join('\n'),
  };
}

function ruleSummary(rule: AlertActionRule): string {
  const nameFilter = rule.name_contains ? ` | Match ${rule.name_contains}` : '';
  const statusFilter = rule.campaign_status ? ` | Status ${rule.campaign_status}` : '';
  return `${getRuleMetricLabel(rule.metric)} ${rule.metric_operator} ${formatUsd(rule.metric_threshold)} | CV ${rule.conversions_operator} ${rule.conversions_threshold}${nameFilter}${statusFilter}`;
}

function createLowBalanceAlertMessage(accounts: TikTokAccountBalance[]): string {
  return accounts
    .map(account => {
      const accountName = account.advertiser_name || account.advertiser_id;
      return `- ${accountName}: ${formatUsd(account.balance, account.currency)}`;
    })
    .join('\n');
}

function createCampaignActionAlertMessage(
  campaigns: TikTokSpentCampaign[],
  rule: AlertActionRule
): string {
  return campaigns
    .map(campaign => {
      const accountName = campaign.advertiser_name || campaign.advertiser_id;
      return `- ${accountName} | ${campaign.campaign_name} | ${campaign.campaign_id} | Spend ${formatUsd(campaign.spend)} | CPA ${formatUsd(campaign.cpa)} | CV ${campaign.conversions} | ${getActionLabel(rule.action).toUpperCase()} | ${ruleSummary(rule)}`;
    })
    .join('\n');
}

function createAdActionAlertMessage(
  ads: EnrichedSpentAd[],
  rule: AlertActionRule
): string {
  return ads
    .map(ad => {
      const accountName = ad.advertiser_name || ad.advertiser_id;
      const adName = ad.ad_name || ad.ad_id;
      const campaignName = ad.campaign_name || 'Unknown campaign';
      return `- ${accountName} | ${campaignName} | ${adName} | ${ad.ad_id} | Spend ${formatUsd(ad.spend)} | CPA ${formatUsd(ad.cpa)} | CV ${ad.conversions} | ${ruleSummary(rule)}`;
    })
    .join('\n');
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
): Promise<void> {
  await db.run(
    'INSERT INTO alerts (type, message, severity) VALUES (?, ?, ?)',
    [type, message, severity]
  );

  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId) {
    return;
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
      return;
    }

    const alertTitle = getAlertTitle(type);
    await bot.telegram.sendMessage(
      adminChatId,
      `🚨 <b>${alertTitle}</b> - ${severity.toUpperCase()}\n${escapeHtml(message)}`,
      { parse_mode: 'HTML' }
    );
    console.log(`Alert sent: ${type}`);
  } catch (error) {
    console.error(`Error sending ${type} alert via Telegram:`, error);
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

async function replaceActionRules(rules: AlertActionRuleSheetRow[]): Promise<void> {
  await db.run('DELETE FROM alert_action_state');
  await db.run('DELETE FROM alert_action_rules');

  for (const rule of rules) {
    await db.run(
      `INSERT INTO alert_action_rules (
        entity,
        name_contains,
        metric,
        metric_operator,
        metric_threshold,
        conversions_operator,
        conversions_threshold,
        action,
        campaign_status,
        is_active,
        note,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        rule.entity,
        rule.nameContains || null,
        rule.metric,
        rule.metricOperator,
        rule.metricThreshold,
        rule.conversionsOperator,
        rule.conversionsThreshold,
        rule.action,
        rule.campaignStatus || null,
        rule.isActive ? 1 : 0,
        rule.note || null,
      ]
    );
  }
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

function matchesCampaignRule(rule: AlertActionRule, campaign: TikTokSpentCampaign): boolean {
  if (!matchesCampaignKey(rule, campaign.campaign_name)) {
    return false;
  }

  if (rule.campaign_status && campaign.status !== rule.campaign_status) {
    return false;
  }

  return compareValues(getRuleMetricValue(campaign, rule.metric), rule.metric_operator, rule.metric_threshold) &&
    compareValues(campaign.conversions, rule.conversions_operator, rule.conversions_threshold);
}

function matchesAdRule(rule: AlertActionRule, ad: EnrichedSpentAd): boolean {
  if (!matchesCampaignKey(rule, ad.campaign_name)) {
    return false;
  }

  return compareValues(getRuleMetricValue(ad, rule.metric), rule.metric_operator, rule.metric_threshold) &&
    compareValues(ad.conversions, rule.conversions_operator, rule.conversions_threshold);
}

export async function initializeAlertRules(): Promise<AlertInitializationResult> {
  await upsertBalanceAlertRule();

  const sheetSetup = await ensureAlertsSheetTemplate();
  const sheetRules = await getAlertRulesConfig();
  await replaceActionRules(sheetRules);

  console.log(`Alert rules initialized from Alerts sheet (${sheetRules.length} action rules)`);

  return {
    actionRuleCount: sheetRules.length,
    balanceThreshold: await getRuntimeSettingNumber(
      'balance_threshold_usd',
      RUNTIME_SETTING_DEFAULTS.balanceThresholdUsd
    ),
    sheetCreated: sheetSetup.created,
    clearedLegacyDemo: sheetSetup.clearedLegacyDemo,
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

async function checkLowBalanceAlerts(
  bot: Telegraf,
  balances: TikTokAccountBalance[],
  rule: BalanceAlertRule
): Promise<void> {
  const lowBalances = balances
    .filter(account => compareValues(account.balance, rule.comparison_operator, rule.threshold))
    .sort((accountA, accountB) => accountA.balance - accountB.balance);
  const matchedKeys = new Set(lowBalances.map(getBalanceSubjectKey));
  const notificationSubjectKey = getRuleNotificationSubjectKey(BALANCE_TRACKING_RULE_ID);

  if (lowBalances.length === 0) {
    await clearRuleStates(BALANCE_TRACKING_RULE_ID, new Set());
    return;
  }

  const existingStates = await getRuleStateKeys(BALANCE_TRACKING_RULE_ID);
  const now = Date.now();
  matchedKeys.add(notificationSubjectKey);
  const shouldNotify = shouldSendTelegramAlert(existingStates.get(notificationSubjectKey), now);

  if (!shouldNotify) {
    await clearRuleStates(BALANCE_TRACKING_RULE_ID, matchedKeys);
    return;
  }

  const lowestBalance = Math.min(...lowBalances.map(account => account.balance));
  const severity = calculateAlertSeverity(lowestBalance, rule.threshold);
  const message = createLowBalanceAlertMessage(lowBalances);

  await saveAndSendAlert(bot, 'balance_low', message, severity);

  for (const account of lowBalances) {
    await saveRuleState(BALANCE_TRACKING_RULE_ID, getBalanceSubjectKey(account));
  }
  await saveRuleState(BALANCE_TRACKING_RULE_ID, notificationSubjectKey);

  await clearRuleStates(BALANCE_TRACKING_RULE_ID, matchedKeys);
}

async function processCampaignRule(
  bot: Telegraf,
  rule: AlertActionRule,
  campaigns: TikTokSpentCampaign[]
): Promise<void> {
  const matchedCampaigns = campaigns.filter(campaign => matchesCampaignRule(rule, campaign));
  const matchedKeys = new Set<string>();
  const existingStates = await getRuleStateKeys(rule.id);
  const now = Date.now();
  const notificationCampaigns: TikTokSpentCampaign[] = [];
  let notificationSeverity: AlertSeverity | undefined;
  const notificationSubjectKey = getRuleNotificationSubjectKey(rule.id);
  const canSendRuleNotification = shouldSendTelegramAlert(
    existingStates.get(notificationSubjectKey),
    now
  );

  if (rule.action === 'notify' && matchedCampaigns.length > 0) {
    matchedKeys.add(notificationSubjectKey);
  }

  for (const campaign of matchedCampaigns) {
    const subjectKey = getCampaignSubjectKey(campaign);
    const metricValue = getRuleMetricValue(campaign, rule.metric);
    const severity = calculateAlertSeverity(metricValue, rule.metric_threshold);
    const lastAlertedAt = existingStates.get(subjectKey);
    const isExceeding = rule.metric_operator === 'gt' || rule.metric_operator === 'gte';
    const shouldAlert = shouldSendTelegramAlert(lastAlertedAt, now);

    if (rule.action === 'notify') {
      if (isExceeding && campaign.status === 'paused') {
        continue;
      }

      if (!canSendRuleNotification || !shouldAlert) {
        matchedKeys.add(subjectKey);
        continue;
      }

      matchedKeys.add(subjectKey);
      await saveRuleState(rule.id, subjectKey);
      notificationCampaigns.push(campaign);
      notificationSeverity = getHigherAlertSeverity(notificationSeverity, severity);
      continue;
    }

    if (campaign.status === 'deleted') {
      matchedKeys.add(subjectKey);
      await saveRuleState(rule.id, subjectKey);
      continue;
    }

    const targetStatus = rule.action === 'pause' ? 'paused' : 'active';
    if (campaign.status === targetStatus) {
      matchedKeys.add(subjectKey);
      await saveRuleState(rule.id, subjectKey);
      continue;
    }

    matchedKeys.add(subjectKey);
    await saveRuleState(rule.id, subjectKey);
    const actionLabel = getCampaignAlertLabel(rule.action) as 'Pause' | 'Active';
    let nextStatus: TikTokSpentCampaign['status'] | null = null;
    let failureReason: string | undefined;

    try {
      const result = await setCampaignAdsStatus(
        campaign.advertiser_id,
        campaign.campaign_id,
        rule.action === 'pause' ? 'DISABLE' : 'ENABLE'
      );
      nextStatus = result.status || (rule.action === 'pause' ? 'paused' : 'active');
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
    }

    const wasSuccessful = Boolean(nextStatus);
    const alertCampaign: TikTokSpentCampaign = {
      ...campaign,
      status: (nextStatus || campaign.status) as TikTokSpentCampaign['status'],
    };
    const alertContent = createCampaignAlertContent(alertCampaign, rule, {
      result: {
        actionLabel,
        success: wasSuccessful,
        ...(failureReason ? { reason: failureReason } : {}),
      },
    });
    const type =
      rule.action === 'pause'
        ? (wasSuccessful ? 'campaign_paused' : 'campaign_pause_failed')
        : (wasSuccessful ? 'campaign_enabled' : 'campaign_enable_failed');
    await saveAndSendAlert(bot, type, alertContent.plainText, severity, {
      telegramHtml: alertContent.htmlText,
      replyMarkup: alertContent.replyMarkup,
    });
  }

  if (notificationCampaigns.length > 0) {
    const alertContent = createCampaignAlertGroupContent(notificationCampaigns, rule);
    await saveAndSendAlert(bot, 'campaign_notify', alertContent.plainText, notificationSeverity || 'low', {
      telegramHtml: alertContent.htmlText,
      replyMarkup: alertContent.replyMarkup,
    });
    await saveRuleState(rule.id, notificationSubjectKey);
  }

  await clearRuleStates(rule.id, matchedKeys);
}

async function processQualifiedCampaignNotifyRules(
  bot: Telegraf,
  rules: AlertActionRule[],
  campaigns: TikTokSpentCampaign[]
): Promise<void> {
  if (rules.length === 0) {
    return;
  }

  const existingStates = await getRuleStateKeys(CAMPAIGN_QUALIFIED_NOTIFICATION_RULE_ID);
  const now = Date.now();
  const matchedKeys = new Set<string>();
  const candidateBySubjectKey = new Map<string, QualifiedCampaignCandidate>();
  let notificationSeverity: AlertSeverity | undefined;

  for (const rule of rules) {
    const matchedCampaigns = campaigns.filter(campaign => matchesCampaignRule(rule, campaign));

    for (const campaign of matchedCampaigns) {
      const subjectKey = getCampaignSubjectKey(campaign);
      const metricValue = getRuleMetricValue(campaign, rule.metric);
      const severity = calculateAlertSeverity(metricValue, rule.metric_threshold);
      const existingCandidate = candidateBySubjectKey.get(subjectKey);

      matchedKeys.add(subjectKey);

      if (
        !shouldSendTelegramAlert(
          existingStates.get(subjectKey),
          now,
          CAMPAIGN_QUALIFIED_ALERT_COOLDOWN_MS
        )
      ) {
        continue;
      }

      if (!existingCandidate) {
        candidateBySubjectKey.set(subjectKey, { campaign, severity });
      } else {
        candidateBySubjectKey.set(subjectKey, {
          campaign: existingCandidate.campaign,
          severity: getHigherAlertSeverity(existingCandidate.severity, severity),
        });
      }
    }
  }

  const candidates = [...candidateBySubjectKey.values()];

  if (candidates.length > 0) {
    const campaignsToNotify = candidates.map(candidate => candidate.campaign);
    const cloneCountByCampaignId = await getCampaignCloneCountMap(
      campaignsToNotify.map(campaign => campaign.campaign_id)
    );
    const alertContent = createQualifiedCampaignAlertGroupContent(
      campaignsToNotify,
      cloneCountByCampaignId
    );

    for (const candidate of candidates) {
      notificationSeverity = getHigherAlertSeverity(notificationSeverity, candidate.severity);
    }

    await saveAndSendAlert(bot, 'campaign_notify', alertContent.plainText, notificationSeverity || 'low', {
      telegramHtml: alertContent.htmlText,
      replyMarkup: alertContent.replyMarkup,
    });

    for (const campaign of campaignsToNotify) {
      await saveRuleState(CAMPAIGN_QUALIFIED_NOTIFICATION_RULE_ID, getCampaignSubjectKey(campaign));
    }
  }

  await clearRuleStates(CAMPAIGN_QUALIFIED_NOTIFICATION_RULE_ID, matchedKeys);
}

async function processAdRule(
  bot: Telegraf,
  rule: AlertActionRule,
  ads: EnrichedSpentAd[]
): Promise<void> {
  const matchedAds = ads.filter(ad => matchesAdRule(rule, ad));
  const matchedKeys = new Set<string>();
  const existingStates = await getRuleStateKeys(rule.id);
  const notifiedAds: EnrichedSpentAd[] = [];
  const now = Date.now();
  const notificationSubjectKey = getRuleNotificationSubjectKey(rule.id);
  const canSendRuleNotification = shouldSendTelegramAlert(
    existingStates.get(notificationSubjectKey),
    now
  );

  if (rule.action === 'notify' && matchedAds.length > 0) {
    matchedKeys.add(notificationSubjectKey);
  }

  for (const ad of matchedAds) {
    const subjectKey = getAdSubjectKey(ad);
    const lastAlertedAt = existingStates.get(subjectKey);

    if (
      rule.action === 'notify' &&
      (!canSendRuleNotification || !shouldSendTelegramAlert(lastAlertedAt, now))
    ) {
      matchedKeys.add(subjectKey);
      continue;
    }

    matchedKeys.add(subjectKey);

    if (rule.action === 'notify') {
      await saveRuleState(rule.id, subjectKey);
      notifiedAds.push(ad);
      continue;
    }

    if (!lastAlertedAt) {
      await saveRuleState(rule.id, subjectKey);
    }

    console.log(`Skipping unsupported ad action "${rule.action}" for rule ${rule.id}`);
  }

  if (notifiedAds.length > 0) {
    const highestMetricValue = Math.max(...notifiedAds.map(ad => getRuleMetricValue(ad, rule.metric)));
    const severity = calculateAlertSeverity(highestMetricValue, rule.metric_threshold);
    const message = createAdActionAlertMessage(notifiedAds, rule);
    await saveAndSendAlert(bot, 'ad_notify', message, severity);
    await saveRuleState(rule.id, notificationSubjectKey);
  }

  await clearRuleStates(rule.id, matchedKeys);
}

async function checkLevel2ProductCpAdsAlerts(bot: Telegraf): Promise<void> {
  if (!isLevel2ProductCpAdsEnabled()) {
    await clearRuleStates(LEVEL2_PRODUCT_CP_ADS_RULE_ID, new Set());
    return;
  }

  const threshold = await getLevel2ProductCpAdsThreshold();
  const period = getTodayBcReportPeriod();
  const summaries = await buildBcProductMarketSummaries({
    ...period,
    targetMktCode: process.env.TARGET_MKT_CODE,
  });
  const matchedSummaries = summaries
    .filter(summary => summary.spendVnd > 0)
    .filter(summary => getProductSummaryCpAds(summary) > threshold)
    .sort((summaryA, summaryB) =>
      Number.isFinite(getProductSummaryCpAds(summaryB)) === Number.isFinite(getProductSummaryCpAds(summaryA))
        ? getProductSummaryCpAds(summaryB) - getProductSummaryCpAds(summaryA) || summaryB.spendVnd - summaryA.spendVnd
        : Number.isFinite(getProductSummaryCpAds(summaryB)) ? -1 : 1
    );
  const matchedKeys = new Set(matchedSummaries.map(getProductSummarySubjectKey));
  const notificationSubjectKey = getRuleNotificationSubjectKey(LEVEL2_PRODUCT_CP_ADS_RULE_ID);

  if (matchedSummaries.length === 0) {
    await clearRuleStates(LEVEL2_PRODUCT_CP_ADS_RULE_ID, new Set());
    return;
  }

  matchedKeys.add(notificationSubjectKey);
  const existingStates = await getRuleStateKeys(LEVEL2_PRODUCT_CP_ADS_RULE_ID);
  const now = Date.now();

  if (!shouldSendTelegramAlert(
    existingStates.get(notificationSubjectKey),
    now,
    LEVEL2_PRODUCT_CP_ADS_COOLDOWN_MS
  )) {
    await clearRuleStates(LEVEL2_PRODUCT_CP_ADS_RULE_ID, matchedKeys);
    return;
  }

  const maxCpAds = Math.max(...matchedSummaries.map(getProductSummaryCpAds));
  const severity = calculateAlertSeverity(maxCpAds, threshold);
  const alertContent = createLevel2ProductCpAdsAlertContent(matchedSummaries, threshold);

  await saveAndSendAlert(bot, 'level2_product_cp_ads', alertContent.plainText, severity, {
    telegramHtml: alertContent.htmlText,
  });

  for (const summary of matchedSummaries) {
    await saveRuleState(LEVEL2_PRODUCT_CP_ADS_RULE_ID, getProductSummarySubjectKey(summary));
  }
  await saveRuleState(LEVEL2_PRODUCT_CP_ADS_RULE_ID, notificationSubjectKey);

  await clearRuleStates(LEVEL2_PRODUCT_CP_ADS_RULE_ID, matchedKeys);
}

export async function checkAndSendLevel2Alerts(bot: Telegraf): Promise<void> {
  console.log('Checking level 2 product CP ads alerts...');
  await checkLevel2ProductCpAdsAlerts(bot);
}

export async function checkAndSendAlerts(bot: Telegraf): Promise<void> {
  console.log('Checking action rules and balance alerts...');

  const [balanceRule, actionRules] = await Promise.all([
    db.get<BalanceAlertRule>(
      'SELECT * FROM alert_rules WHERE metric = ? AND is_active = 1 LIMIT 1',
      [BALANCE_RULE_METRIC]
    ),
    db.all<AlertActionRule>(
      'SELECT * FROM alert_action_rules WHERE is_active = 1 ORDER BY id ASC'
    ),
  ]);

  const needCampaigns = true;
  const needAds = actionRules.some(rule => rule.entity === 'ad');
  const needBalances = Boolean(balanceRule);

  const [spentCampaigns, spentAds, balances] = await Promise.all([
    needCampaigns ? getTodaySpentCampaigns() : Promise.resolve([] as TikTokSpentCampaign[]),
    needAds ? getTodaySpentAds() : Promise.resolve([] as TikTokSpentAd[]),
    needBalances ? getTikTokAccountBalance() : Promise.resolve([] as TikTokAccountBalance[]),
  ]);

  if (!balanceRule && actionRules.length === 0) {
    console.log('No active alert rules found; refreshed spent campaign cache only');
    return;
  }

  const trackedAdvertiserIds = await getTrackedAdvertiserIdSet([
    ...spentCampaigns.map(campaign => ({
      advertiserId: campaign.advertiser_id,
      advertiserName: campaign.advertiser_name,
    })),
    ...spentAds.map(ad => ({
      advertiserId: ad.advertiser_id,
      advertiserName: ad.advertiser_name,
    })),
    ...balances.map(account => ({
      advertiserId: account.advertiser_id,
      advertiserName: account.advertiser_name,
    })),
  ]);

  const dailyUntrackedCampaignKeys = await getUntrackedCampaignDailyAlertKeys();
  const filteredCampaigns = spentCampaigns
    .filter(campaign => trackedAdvertiserIds.has(campaign.advertiser_id))
    .filter(campaign => !dailyUntrackedCampaignKeys.has(getCampaignDailyAlertKey(campaign)));
  const filteredBalances = balances.filter(account => trackedAdvertiserIds.has(account.advertiser_id));
  const campaignById = new Map(filteredCampaigns.map(campaign => [campaign.campaign_id, campaign]));
  const enrichedAds: EnrichedSpentAd[] = spentAds
    .filter(ad => trackedAdvertiserIds.has(ad.advertiser_id))
    .map(ad => ({
      ...ad,
      campaign_name: ad.campaign_name || campaignById.get(ad.campaign_id)?.campaign_name,
    }));

  if (balanceRule) {
    await checkLowBalanceAlerts(bot, filteredBalances, balanceRule);
  }

  const qualifiedCampaignNotifyRules = actionRules.filter(isQualifiedCampaignNotifyRule);
  await processQualifiedCampaignNotifyRules(bot, qualifiedCampaignNotifyRules, filteredCampaigns);

  for (const rule of actionRules) {
    if (isQualifiedCampaignNotifyRule(rule)) {
      continue;
    }

    if (rule.entity === 'campaign') {
      await processCampaignRule(bot, rule, filteredCampaigns);
      continue;
    }

    await processAdRule(bot, rule, enrichedAds);
  }
}
