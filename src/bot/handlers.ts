import { Markup, Telegraf, type Context } from 'telegraf';
import type { InlineKeyboardMarkup } from '@telegraf/types/markup';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getRecentAlerts,
  initializeAlertRules,
  setCampaignDailyAlertTracking,
  type StoredAlert,
} from '../alerts/index.js';
import {
  getCampaignCloneDefaults,
  getTikTokAccountBalance,
  getCampaignAdsStatuses,
  getTodaySpentAds,
  getTodaySpentCampaigns,
  setCampaignAdsStatus,
  setCampaignAdsStatusByCampaignId,
  type TikTokSpentAd,
  type TikTokSpentCampaign,
} from '../tiktok/api.js';
import { duplicateCampaign } from '../campaigns/manager.js';
import { recordCampaignClone } from '../campaigns/clone-tracking.js';
import {
  getAdvertiserPermissions,
  getBusinessCenterId,
  getConfigSnapshot,
  getSalesData,
  type AdvertiserPermission,
} from '../google-sheets/api.js';
import {
  getAdvertiserTrackingStates,
  syncAdvertiserTrackingCache,
  toggleAdvertiserTracking,
  type AdvertiserTrackingState,
} from '../accounts/tracking.js';
import { sendBcAllMenu, sendBcMenu, setupBcSalesHandlers } from '../sales/bc-command.js';
import { restartScheduler } from '../scheduler/index.js';
import {
  getRuntimeSettingsSnapshot,
  setRuntimeSettingNumber,
  type RuntimeSettingKey,
} from '../settings/runtime.js';

type ReplyOptions = Parameters<Context['reply']>[1];
type CampaignMessageStatus = 'active' | 'paused' | 'deleted';
type CampaignVisualStatus = CampaignMessageStatus | 'mixed';
type CampaignOperationStatus = 'ENABLE' | 'DISABLE';

const COMMAND_MENU_DEFAULT = [
  { command: 'start', description: '🚀 Mở hướng dẫn nhanh' },
  { command: 'balance', description: '💰 Kiểm tra số dư TKQC' },
  { command: 'campaigns', description: '📊 Chiến dịch có chi tiêu hôm nay' },
  { command: 'campactive', description: '🟢 Campaign active theo sản phẩm' },
  { command: 'campmkt', description: '📈 Chiến dịch theo MKT và thời gian' },
  { command: 'tkqc', description: '📋 Chiến dịch theo TKQC' },
  { command: 'bc', description: '🧾 Báo cáo doanh số MKT' },
  { command: 'bcall', description: '📦 Báo cáo doanh số all MKT' },
  { command: 'settings', description: '⚙️ Cài đặt bot' },
] as const;

const CAMPAIGN_ACTION_CALLBACK_PREFIX = 'campaign_action';
const CAMPAIGN_DAILY_ALERT_CALLBACK_PREFIX = 'cad';
const CAMPAIGNS_PAGE_CALLBACK_PREFIX = 'campaigns_page';
const CAMPAIGNS_STATUS_CALLBACK_PREFIX = 'cs';
const CAMPAIGNS_NOOP_CALLBACK_PREFIX = 'cn';
const CAMPAIGNS_ACCOUNT_PERIOD_CALLBACK_PREFIX = 'cap';
const CAMPAIGNS_ACCOUNT_REPORT_CALLBACK_PREFIX = 'car';
const CAMPAIGNS_MKT_PERIOD_CALLBACK_PREFIX = 'cmp';
const CAMPAIGNS_MKT_REPORT_CALLBACK_PREFIX = 'cmr';
const CAMPAIGNS_MKT_PAGE_CALLBACK_PREFIX = 'cmpg';
const CAMPAIGNS_PAGE_SIZE = 15;
const CAMPAIGNS_STATUS_BUTTONS_PER_ROW = 5;
const CAMPAIGNS_ACCOUNT_BUTTONS_PER_ROW = 3;
const CAMPAIGNS_MKT_BUTTONS_PER_ROW = 3;
const CAMPAIGNS_LIST_CACHE_TTL_MS = 20_000;

const COMMAND_MENU_ADMIN = [
  ...COMMAND_MENU_DEFAULT,
  { command: 'reload', description: '🔄 Reload dữ liệu đầu vào' },
  { command: 'on', description: '✅ Bật quảng cáo theo camp' },
  { command: 'off', description: '⏸ Tắt quảng cáo theo camp' },
  { command: 'xcamp', description: '🚀 Nhân bản chiến dịch' },
] as const;

let isReloading = false;
let isDuplicatingCampaigns = false;
const xcampQueue: XcampQueueJob[] = [];
let campaignsListCache:
  | {
    campaigns: TikTokSpentCampaign[];
    fetchedAt: number;
    inFlight?: Promise<TikTokSpentCampaign[]>;
  }
  | undefined;
const campaignsListStateByMessage = new Map<string, {
  campaigns: TikTokSpentCampaign[];
  fetchedAt: number;
  period?: CampaignAccountReportPeriod;
}>();
const campaignsMktStateByMessage = new Map<string, {
  campaigns: TikTokSpentCampaign[];
  fetchedAt: number;
  period: CampaignAccountReportPeriod;
  mktCode: string;
}>();
const pendingCampaignListActions = new Map<string, CampaignOperationStatus>();
const pendingSettingsByChat = new Map<number, RuntimeSettingKey>();
const execFileAsync = promisify(execFile);

const MAIN_MENU_BUTTONS = [
  { label: '💰 Số dư', action: 'balance' },
  { label: '📊 Camp', action: 'campaigns' },
  { label: '🟢 Active SP', action: 'campactive' },
  { label: '📈 Camp MKT', action: 'campmkt' },
  { label: '📋 TKQC', action: 'tkqc' },
  { label: '🧾 BC MKT', action: 'bc' },
  { label: '📦 BC All', action: 'bcall' },
  { label: '⚙️ Cài đặt', action: 'settings' },
  { label: '🔄 Reload', action: 'reload' },
  { label: '🚀 XCamp', action: 'xcamp' },
] as const;

type MainMenuAction = typeof MAIN_MENU_BUTTONS[number]['action'];

function chunkMainMenuButtons<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  let index = 0;

  while (index < items.length) {
    const remaining = items.length - index;
    const rowSize =
      remaining <= 4
        ? remaining
        : remaining <= 7 || remaining % 4 === 1
          ? 3
          : 4;

    rows.push(items.slice(index, index + rowSize));
    index += rowSize;
  }

  return rows;
}

const MAIN_MENU_ACTION_BY_LABEL = new Map<string, MainMenuAction>(
  MAIN_MENU_BUTTONS.map(button => [button.label, button.action])
);

const MAIN_MENU_KEYBOARD = Markup.keyboard(
  chunkMainMenuButtons(MAIN_MENU_BUTTONS.map(button => button.label))
).resize();

const SETTING_LABELS: Record<RuntimeSettingKey, string> = {
  level1_interval_minutes: 'Lịch cảnh báo cấp 1',
  level2_interval_minutes: 'Lịch cảnh báo cấp 2',
  exchange_rate: 'Tỉ giá USD/VND',
  balance_threshold_usd: 'Ngưỡng số dư',
  level2_cp_ads_threshold: 'Ngưỡng %CP cấp 2',
};

type CampaignAccountReportPeriod = {
  startDate: string;
  endDate: string;
  label: string;
};

type CampaignReportAdvertiserAccount = {
  advertiser_id: string;
  advertiser_name?: string;
  mkt_code?: string;
};

type CampaignMktGroup = {
  mktCode: string;
  accounts: CampaignReportAdvertiserAccount[];
};

type DuplicatedCampaignResult = {
  campaignId?: string;
  advertiserId: string;
  campaignName?: string;
  overrideWarnings?: string[];
  status?: 'created' | 'pending';
  taskId?: string;
};

type XcampQueueJob = {
  ctx: Context;
  waitMessageId: number;
  chatId?: number;
  campaignId: string;
  quantity: number;
  budget?: number;
  bid?: number;
};

type ActiveCampaignProductSummary = {
  productName: string;
  marketCode: string;
  campaignCount: number;
  accountCounts: Map<string, number>;
};

function isAdmin(ctx: Context): boolean {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  return adminChatId ? ctx.chat?.id.toString() === adminChatId : false;
}

function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatCommandNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function splitMessage(message: string, maxLength = 3500): string[] {
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of message.split('\n')) {
    const nextChunk = currentChunk ? `${currentChunk}\n${line}` : line;

    if (nextChunk.length <= maxLength) {
      currentChunk = nextChunk;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = '';
    }

    if (line.length <= maxLength) {
      currentChunk = line;
      continue;
    }

    for (let index = 0; index < line.length; index += maxLength) {
      chunks.push(line.slice(index, index + maxLength));
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function replyLongMessage(ctx: Context, message: string, options?: ReplyOptions): Promise<void> {
  const chunks = splitMessage(message);

  for (let index = 0; index < chunks.length; index++) {
    const prefix = chunks.length > 1 ? `Phần ${index + 1}/${chunks.length}\n` : '';
    await ctx.reply(`${prefix}${chunks[index]}`, options);
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function getCampaignShortName(campaignName: string): string {
  const parts = campaignName
    .split(' - ')
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]} - ${parts[1]}`;
  }

  return campaignName.trim();
}

function getCampaignVisualStatus(campaign: { status?: CampaignMessageStatus; ad_status?: CampaignVisualStatus }): CampaignVisualStatus {
  return campaign.ad_status || campaign.status || 'deleted';
}

function getCampaignStatusIcon(campaign: { status?: CampaignMessageStatus; ad_status?: CampaignVisualStatus }): string {
  const status = getCampaignVisualStatus(campaign);

  if (status === 'active') {
    return '\u{1F7E2}';
  }

  if (status === 'paused' || status === 'mixed') {
    return '\u{1F7E1}';
  }

  if (status === 'deleted') {
    return '\u26AA';
  }

  return '\u26AA';
}

function getAccountDisplayName(account: { advertiser_name?: string; advertiser_id: string }): string {
  const accountName = account.advertiser_name || account.advertiser_id;
  const shortNameMatch = accountName.match(/\]\s*(AA\s+\d+)/i) || accountName.match(/^(AA\s+\d+)/i);

  return shortNameMatch?.[1]?.toUpperCase() || accountName;
}

function getAccountNumberLabel(account: { advertiser_name?: string; advertiser_id: string }): string {
  const accountName = getAccountDisplayName(account);
  const aaNumberMatch = accountName.match(/\bAA\s*(\d+)\b/i);

  if (!aaNumberMatch?.[1]) {
    return '';
  }

  return aaNumberMatch[1].padStart(2, '0');
}

function getAccountShortBalanceLabel(account: { advertiser_name?: string; advertiser_id: string }): string {
  const accountDisplayName = getAccountDisplayName(account);
  const aaNumberLabel = getAccountNumberLabel(account);

  if (aaNumberLabel) {
    return `AA ${aaNumberLabel}`;
  }

  return accountDisplayName;
}

function buildAdvertiserPermissionMap(
  permissions: AdvertiserPermission[]
): Map<string, AdvertiserPermission> {
  return new Map(
    permissions
      .filter(permission => permission.advertiserId)
      .map(permission => [permission.advertiserId, permission])
  );
}

function formatDuplicatedCampaignResultLine(
  result: DuplicatedCampaignResult,
  permissionByAdvertiserId: Map<string, AdvertiserPermission>
): string {
  const permission = permissionByAdvertiserId.get(result.advertiserId);
  const accountLabel = getAccountNumberLabel({
    advertiser_id: result.advertiserId,
    advertiser_name: permission?.advertiserName,
  }) || getAccountShortBalanceLabel({
    advertiser_id: result.advertiserId,
    advertiser_name: permission?.advertiserName,
  });
  const campaignName = getCampaignShortName(result.campaignName || 'Không rõ tên camp');
  const accountSuffix = accountLabel ? ` · ${escapeHtml(accountLabel)}` : '';

  return `🚀 ${escapeHtml(campaignName)} - <code>${escapeHtml(result.campaignId || '')}</code>${accountSuffix}`;
}

function formatPendingDuplicatedCampaignLine(result: DuplicatedCampaignResult): string {
  const expectedName = result.campaignName || 'không rõ';
  const taskId = result.taskId || 'không rõ';
  return `⏳ Task <code>${escapeHtml(taskId)}</code> · Tên dự kiến: ${escapeHtml(expectedName)}`;
}

function getAccountTrackingLabel(
  account: { advertiser_name?: string; advertiser_id: string },
  isTracked: boolean
): string {
  return `${isTracked ? '🟢' : '🔴'} ${getAccountDisplayName(account)}`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function compareAccountNames(accountA: string, accountB: string): number {
  const numberA = Number(accountA.match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);
  const numberB = Number(accountB.match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);

  if (numberA !== numberB) {
    return numberA - numberB;
  }

  return accountA.localeCompare(accountB, 'vi');
}

function getCurrentDateKey(timeZone = 'Asia/Ho_Chi_Minh'): string {
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

function isValidDateKey(dateKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return false;
  }

  const parsedDate = new Date(`${dateKey}T00:00:00Z`);
  return !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === dateKey;
}

function addDaysToDateKey(dateKey: string, dayOffset: number): string {
  const parsedDate = new Date(`${dateKey}T00:00:00Z`);
  parsedDate.setUTCDate(parsedDate.getUTCDate() + dayOffset);
  return parsedDate.toISOString().slice(0, 10);
}

function getMonthStartDateKey(dateKey: string): string {
  return `${dateKey.slice(0, 8)}01`;
}

function buildCampaignReportDateKey(year: string, month: string, day: string): string | undefined {
  const dateKey = [
    year.padStart(4, '0'),
    month.padStart(2, '0'),
    day.padStart(2, '0'),
  ].join('-');

  return isValidDateKey(dateKey) ? dateKey : undefined;
}

function parseCampaignReportDateInput(value: string): string | undefined {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return undefined;
  }

  const ymdMatch = trimmedValue.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymdMatch?.[1] && ymdMatch[2] && ymdMatch[3]) {
    const dateKey = [
      ymdMatch[1],
      ymdMatch[2].padStart(2, '0'),
      ymdMatch[3].padStart(2, '0'),
    ].join('-');

    return isValidDateKey(dateKey) ? dateKey : undefined;
  }

  const dmyMatch = trimmedValue.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmyMatch?.[1] && dmyMatch[2] && dmyMatch[3]) {
    const dateKey = [
      dmyMatch[3],
      dmyMatch[2].padStart(2, '0'),
      dmyMatch[1].padStart(2, '0'),
    ].join('-');

    return isValidDateKey(dateKey) ? dateKey : undefined;
  }

  return undefined;
}

function parseCampaignReportPartialDateInput(
  value: string,
  fallbackDateKey: string
): string | undefined {
  const trimmedValue = value.trim();
  const fullDate = parseCampaignReportDateInput(trimmedValue);

  if (fullDate) {
    return fullDate;
  }

  const fallbackYear = fallbackDateKey.slice(0, 4);
  const fallbackMonth = fallbackDateKey.slice(5, 7);
  const dayMonthMatch = trimmedValue.match(/^(\d{1,2})[/.](\d{1,2})$/);

  if (dayMonthMatch?.[1] && dayMonthMatch[2]) {
    return buildCampaignReportDateKey(fallbackYear, dayMonthMatch[2], dayMonthMatch[1]);
  }

  const dayOnlyMatch = trimmedValue.match(/^(\d{1,2})$/);

  if (dayOnlyMatch?.[1]) {
    return buildCampaignReportDateKey(fallbackYear, fallbackMonth, dayOnlyMatch[1]);
  }

  return undefined;
}

function parseCampaignReportRangeInput(value: string): CampaignAccountReportPeriod | undefined {
  const normalizedValue = value.replace(/\s+/g, '');
  const rangeMatch = normalizedValue.match(
    /^(\d{1,2}(?:[/.]\d{1,2}(?:[/.]\d{4})?)?)-(\d{1,2}(?:[/.]\d{1,2}(?:[/.]\d{4})?)?)$/
  );

  if (!rangeMatch?.[1] || !rangeMatch[2]) {
    return undefined;
  }

  const today = getCurrentDateKey();
  const startDate = parseCampaignReportPartialDateInput(rangeMatch[1], today);
  const endDate = startDate
    ? parseCampaignReportPartialDateInput(rangeMatch[2], startDate)
    : undefined;

  if (!startDate || !endDate) {
    return undefined;
  }

  return buildCampaignAccountReportPeriod(startDate, endDate);
}

function normalizeCommandToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\s_-]+/g, '');
}

function formatCampaignReportPeriodRange(period: CampaignAccountReportPeriod): string {
  return period.startDate === period.endDate
    ? period.startDate
    : `${period.startDate} -> ${period.endDate}`;
}

function buildCampaignAccountReportPeriod(
  startDate: string,
  endDate: string,
  label?: string
): CampaignAccountReportPeriod {
  const normalizedStartDate = startDate <= endDate ? startDate : endDate;
  const normalizedEndDate = startDate <= endDate ? endDate : startDate;

  return {
    startDate: normalizedStartDate,
    endDate: normalizedEndDate,
    label: label || formatCampaignReportPeriodRange({
      startDate: normalizedStartDate,
      endDate: normalizedEndDate,
      label: '',
    }),
  };
}

function getCampaignAccountQuickPeriods(): Array<CampaignAccountReportPeriod & {
  buttonText: string;
  aliases: string[];
}> {
  const today = getCurrentDateKey();
  const yesterday = addDaysToDateKey(today, -1);

  return [
    {
      ...buildCampaignAccountReportPeriod(today, today, 'Hôm nay'),
      buttonText: 'Hôm nay',
      aliases: ['today', 'homnay', 'hn'],
    },
    {
      ...buildCampaignAccountReportPeriod(yesterday, yesterday, 'Hôm qua'),
      buttonText: 'Hôm qua',
      aliases: ['yesterday', 'homqua', 'hq'],
    },
    {
      ...buildCampaignAccountReportPeriod(addDaysToDateKey(today, -6), today, '7 ngày'),
      buttonText: '7 ngày',
      aliases: ['7d', '7ngay', 'week', 'tuan'],
    },
    {
      ...buildCampaignAccountReportPeriod(getMonthStartDateKey(today), today, 'Tháng này'),
      buttonText: 'Tháng này',
      aliases: ['month', 'mtd', 'thangnay', 'thang'],
    },
  ];
}

function parseCampaignAccountReportPeriodArgs(args: string[]): {
  period?: CampaignAccountReportPeriod;
  error?: string;
} {
  if (args.length === 0) {
    return {};
  }

  const firstToken = normalizeCommandToken(args[0] || '');
  const quickPeriod = getCampaignAccountQuickPeriods()
    .find(period => period.aliases.includes(firstToken));

  if (quickPeriod) {
    return { period: quickPeriod };
  }

  const rangePeriod = parseCampaignReportRangeInput(args.join(' '));
  if (rangePeriod) {
    return { period: rangePeriod };
  }

  const startDate = parseCampaignReportDateInput(args[0] || '');
  if (!startDate) {
    return {
      error: 'Thời gian không hợp lệ. Dùng dạng YYYY-MM-DD hoặc DD/MM/YYYY.',
    };
  }

  const endDate = args[1]
    ? parseCampaignReportDateInput(args[1])
    : startDate;

  if (!endDate) {
    return {
      error: 'Ngày kết thúc không hợp lệ. Dùng dạng YYYY-MM-DD hoặc DD/MM/YYYY.',
    };
  }

  return {
    period: buildCampaignAccountReportPeriod(startDate, endDate),
  };
}

function parseCampaignsPeriodArgs(args: string[]): {
  period?: CampaignAccountReportPeriod;
  error?: string;
} {
  if (args.length === 0) {
    return {};
  }

  const firstToken = normalizeCommandToken(args[0] || '');
  const quickPeriod = getCampaignAccountQuickPeriods()
    .find(period => period.aliases.includes(firstToken));

  if (quickPeriod && args.length === 1) {
    return { period: quickPeriod };
  }

  const rangePeriod = parseCampaignReportRangeInput(args.join(' '));
  if (rangePeriod) {
    return { period: rangePeriod };
  }

  const today = getCurrentDateKey();
  const startDate = parseCampaignReportPartialDateInput(args[0] || '', today);

  if (!startDate) {
    return {
      error: 'Thời gian không hợp lệ. Dùng dạng DD, DD-DD, DD/MM-DD/MM hoặc YYYY-MM-DD.',
    };
  }

  const endDate = args[1]
    ? parseCampaignReportPartialDateInput(args[1], startDate)
    : startDate;

  if (!endDate) {
    return {
      error: 'Ngày kết thúc không hợp lệ. Dùng dạng DD, DD/MM hoặc YYYY-MM-DD.',
    };
  }

  return {
    period: buildCampaignAccountReportPeriod(startDate, endDate),
  };
}

function getCampaignListStateKey(chatId: number | string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function getCampaignListStateKeyFromContext(ctx: Context): string | undefined {
  const message = ctx.callbackQuery?.message;

  if (!message?.chat?.id || !message.message_id) {
    return undefined;
  }

  return getCampaignListStateKey(message.chat.id, message.message_id);
}

function getCampaignListActionKey(advertiserId: string, campaignId: string): string {
  return `${advertiserId}:${campaignId}`;
}

function summarizeAdStatusesForCampaign(ads: TikTokSpentAd[]): CampaignVisualStatus | undefined {
  const statuses = new Set(
    ads
      .map(ad => ad.status)
      .filter((status): status is CampaignMessageStatus => Boolean(status))
  );

  if (statuses.size === 0) {
    return undefined;
  }

  if (statuses.size === 1) {
    return [...statuses][0];
  }

  return 'mixed';
}

async function applyTodayAdStatusesToCampaigns(
  campaigns: TikTokSpentCampaign[],
  options: {
    advertiserIds?: string[];
    advertiserAccounts?: Array<{ advertiserId: string; advertiserName?: string; mktCode?: string }>;
  } = {}
): Promise<TikTokSpentCampaign[]> {
  if (campaigns.length === 0) {
    return campaigns;
  }

  try {
    const campaignAdStatuses = await getCampaignAdsStatuses(campaigns);
    const adsByCampaignKey = new Map<string, TikTokSpentAd[]>();

    for (const campaignAdStatus of campaignAdStatuses) {
      const campaignKey = `${campaignAdStatus.advertiserId}:${campaignAdStatus.campaignId}`;
      adsByCampaignKey.set(
        campaignKey,
        campaignAdStatus.ads.map(ad => ({
          advertiser_id: campaignAdStatus.advertiserId,
          campaign_id: campaignAdStatus.campaignId,
          ad_id: ad.adId,
          ad_name: '',
          campaign_name: '',
          advertiser_name: '',
          date: getCurrentDateKey(),
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          cpc: 0,
          cpa: 0,
          ctr: 0,
          metrics: {
            spend: 0,
            conversions: 0,
            impressions: 0,
            clicks: 0,
            ctr: 0,
            cpc: 0,
            conversion_rate: 0,
            cost_per_conversion: 0,
          },
          status: ad.status,
          raw_status: ad.rawStatus,
        }))
      );
    }

    return campaigns.map(campaign => {
      const campaignAds = adsByCampaignKey.get(`${campaign.advertiser_id}:${campaign.campaign_id}`) || [];
      const adStatus = summarizeAdStatusesForCampaign(campaignAds);

      return adStatus
        ? {
          ...campaign,
          ad_status: adStatus,
          raw_ad_status: adStatus === 'mixed' ? 'MIXED_AD_STATUS' : adStatus,
        }
        : campaign;
    });
  } catch (error) {
    console.error('Error applying ad statuses to campaigns:', error);
    return campaigns;
  }
}

async function getCampaignsForCampaignsList(forceRefresh = false): Promise<TikTokSpentCampaign[]> {
  const now = Date.now();

  if (
    !forceRefresh &&
    campaignsListCache &&
    now - campaignsListCache.fetchedAt < CAMPAIGNS_LIST_CACHE_TTL_MS
  ) {
    return campaignsListCache.campaigns;
  }

  if (!forceRefresh && campaignsListCache?.inFlight) {
    return campaignsListCache.inFlight;
  }

  const inFlight = getTodaySpentCampaigns(undefined, undefined, {
    includeActiveNoSpend: true,
  }).then(campaigns => applyTodayAdStatusesToCampaigns(campaigns))
    .then(campaigns => {
    campaignsListCache = {
      campaigns,
      fetchedAt: Date.now(),
    };
    return campaigns;
  }).finally(() => {
    if (campaignsListCache?.inFlight === inFlight) {
      campaignsListCache = {
        campaigns: campaignsListCache.campaigns,
        fetchedAt: campaignsListCache.fetchedAt,
      };
    }
  });

  campaignsListCache = {
    campaigns: campaignsListCache?.campaigns || [],
    fetchedAt: campaignsListCache?.fetchedAt || 0,
    inFlight,
  };

  return inFlight;
}

function saveCampaignsListMessageState(
  chatId: number | string,
  messageId: number,
  campaigns: TikTokSpentCampaign[],
  period?: CampaignAccountReportPeriod
): void {
  campaignsListStateByMessage.set(
    getCampaignListStateKey(chatId, messageId),
    {
      campaigns,
      fetchedAt: Date.now(),
      period,
    }
  );
}

function updateCampaignAdStatusInCampaignListState(
  advertiserId: string,
  campaignId: string,
  status: CampaignVisualStatus,
  rawStatus: string
): void {
  const updateCampaign = (campaign: TikTokSpentCampaign): TikTokSpentCampaign => (
    campaign.advertiser_id === advertiserId && campaign.campaign_id === campaignId
      ? {
        ...campaign,
        ad_status: status,
        raw_ad_status: rawStatus,
      }
      : campaign
  );

  if (campaignsListCache) {
    campaignsListCache = {
      ...campaignsListCache,
      campaigns: campaignsListCache.campaigns.map(updateCampaign),
      fetchedAt: Date.now(),
    };
  }

  for (const [stateKey, state] of campaignsListStateByMessage.entries()) {
    campaignsListStateByMessage.set(stateKey, {
      ...state,
      campaigns: state.campaigns.map(updateCampaign),
      fetchedAt: Date.now(),
    });
  }
}

async function refreshCampaignAdStatusInCampaignListState(
  advertiserId: string,
  campaignId: string
): Promise<void> {
  const [campaignAdStatus] = await getCampaignAdsStatuses([{
    advertiser_id: advertiserId,
    campaign_id: campaignId,
  }]);

  if (!campaignAdStatus) {
    return;
  }

  const adStatus = summarizeAdStatusesForCampaign(
    campaignAdStatus.ads.map(ad => ({
      advertiser_id: advertiserId,
      campaign_id: campaignId,
      ad_id: ad.adId,
      date: getCurrentDateKey(),
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      cpc: 0,
      cpa: 0,
      ctr: 0,
      status: ad.status,
      raw_status: ad.rawStatus,
    }))
  );

  if (!adStatus) {
    return;
  }

  updateCampaignAdStatusInCampaignListState(
    advertiserId,
    campaignId,
    adStatus,
    adStatus === 'mixed' ? 'MIXED_AD_STATUS' : adStatus
  );
}

function buildBalanceTrackingKeyboard(
  balances: Array<{ advertiser_id: string; advertiser_name?: string }>,
  trackingStates: AdvertiserTrackingState[]
) {
  if (balances.length === 0) {
    return undefined;
  }

  const trackingById = new Map(trackingStates.map(account => [account.advertiserId, account.isTracked]));
  const uniqueBalances = [...new Map(
    balances.map(account => [account.advertiser_id, account])
  ).values()].sort((accountA, accountB) =>
    compareAccountNames(getAccountDisplayName(accountA), getAccountDisplayName(accountB))
  );

  const buttons = uniqueBalances.map(account =>
    Markup.button.callback(
      getAccountTrackingLabel(account, trackingById.get(account.advertiser_id) !== false),
      `toggle_balance_tracking:${account.advertiser_id}`
    )
  );

  return Markup.inlineKeyboard(chunkArray(buttons, 4));
}

function buildCampaignActionCallbackData(
  operationStatus: CampaignOperationStatus,
  campaignId: string
): string {
  return `${CAMPAIGN_ACTION_CALLBACK_PREFIX}:${operationStatus}:${campaignId}`;
}

function buildCampaignActionKeyboard(campaignId: string, status: CampaignMessageStatus) {
  if (status === 'active') {
    return Markup.inlineKeyboard([[
      Markup.button.callback(
        '⏸ Pause',
        buildCampaignActionCallbackData('DISABLE', campaignId)
      ),
    ]]);
  }

  if (status === 'paused') {
    return Markup.inlineKeyboard([[
      Markup.button.callback(
        '✅ Active',
        buildCampaignActionCallbackData('ENABLE', campaignId)
      ),
    ]]);
  }

  return undefined;
}

function isGroupedCampaignAlertText(messageText: string): boolean {
  const firstLine = messageText.split('\n')[0] || '';

  return /^\S+\s+Ads\s+.+\(\d+\s+camp\)$/i.test(firstLine.trim());
}

function getGroupedActionButtonText(
  currentText: string,
  nextStatus: CampaignMessageStatus
): string {
  const indexMatch = currentText.match(/\b(\d+)\b/);
  const indexText = indexMatch ? `${indexMatch[1]} ` : '';

  if (nextStatus === 'active') {
    return `⏸ ${indexText}Pause`;
  }

  if (nextStatus === 'paused') {
    return `✅ ${indexText}Active`;
  }

  return currentText;
}

function updateGroupedCampaignActionReplyMarkup(
  replyMarkup: InlineKeyboardMarkup | undefined,
  campaignId: string,
  nextStatus: CampaignMessageStatus
): InlineKeyboardMarkup | undefined {
  if (!replyMarkup?.inline_keyboard) {
    return undefined;
  }

  const nextOperationStatus =
    nextStatus === 'active'
      ? 'DISABLE'
      : nextStatus === 'paused'
        ? 'ENABLE'
        : undefined;

  if (!nextOperationStatus) {
    return undefined;
  }

  let changed = false;
  const updatedKeyboard = replyMarkup.inline_keyboard.map(row =>
    row.map(button => {
      const callbackData = 'callback_data' in button ? button.callback_data : '';

      if (!callbackData.startsWith(`${CAMPAIGN_ACTION_CALLBACK_PREFIX}:`) || !callbackData.endsWith(`:${campaignId}`)) {
        return button;
      }

      changed = true;
      return {
        ...button,
        text: getGroupedActionButtonText(button.text, nextStatus),
        callback_data: buildCampaignActionCallbackData(nextOperationStatus, campaignId),
      };
    })
  );

  return changed ? { inline_keyboard: updatedKeyboard as InlineKeyboardMarkup['inline_keyboard'] } : undefined;
}

function buildCampaignDailyAlertCallbackData(
  isTracked: boolean,
  advertiserId: string,
  campaignId: string
): string {
  return `${CAMPAIGN_DAILY_ALERT_CALLBACK_PREFIX}:${isTracked ? '1' : '0'}:${advertiserId}:${campaignId}`;
}

function getCampaignDailyAlertButtonText(currentText: string, isCurrentlyTracked: boolean): string {
  const indexMatch = currentText.match(/\b(\d+)\b/);
  const label = isCurrentlyTracked ? 'Bỏ TD' : 'Theo dõi';

  if (indexMatch?.[1]) {
    return `${isCurrentlyTracked ? '🔕' : '🔔'} ${indexMatch[1]} ${label}`;
  }

  return isCurrentlyTracked ? '🔕 Bỏ theo dõi hôm nay' : '🔔 Theo dõi lại hôm nay';
}

function updateCampaignDailyAlertReplyMarkup(
  replyMarkup: InlineKeyboardMarkup | undefined,
  advertiserId: string,
  campaignId: string,
  isTracked: boolean
): InlineKeyboardMarkup | undefined {
  if (!replyMarkup?.inline_keyboard) {
    return undefined;
  }

  const callbackPattern = new RegExp(
    `^${CAMPAIGN_DAILY_ALERT_CALLBACK_PREFIX}:[01]:${advertiserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${campaignId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
  );
  let changed = false;
  const updatedKeyboard = replyMarkup.inline_keyboard.map(row =>
    row.map(button => {
      const callbackData = 'callback_data' in button ? button.callback_data : '';

      if (!callbackPattern.test(callbackData)) {
        return button;
      }

      changed = true;
      return {
        ...button,
        text: getCampaignDailyAlertButtonText(button.text, isTracked),
        callback_data: buildCampaignDailyAlertCallbackData(!isTracked, advertiserId, campaignId),
      };
    })
  );

  return changed ? { inline_keyboard: updatedKeyboard as InlineKeyboardMarkup['inline_keyboard'] } : undefined;
}

function upsertCampaignActionResultLine(
  messageText: string,
  actionLabel: 'Pause' | 'Active',
  success: boolean
): string {
  const lines = messageText
    .split('\n')
    .filter(line => !/^(✅|⛔)?\s*(Pause|Active) (thành công|thất bại)$/i.test(line.trim()))
    .filter(line => !/^ℹ️ Lý do:/i.test(line.trim()));

  lines.push(`${success ? '✅' : '⛔'} ${actionLabel} ${success ? 'thành công' : 'thất bại'}`);
  return lines.join('\n');
}

function renderCampaignAlertMessageHtml(messageText: string): string {
  const lines = messageText.split('\n');

  if (lines.length === 0) {
    return '';
  }

  const firstLine = lines[0] || '';
  const firstLineMatch = firstLine.match(/^(.+?)\s+([A-Za-z]+):\s*(.+)$/);
  let firstLineHtml = escapeHtml(firstLine);

  if (firstLineMatch) {
    const icon = firstLineMatch[1];
    const label = firstLineMatch[2];
    const remainder = firstLineMatch[3];
    const separatorIndex = remainder.lastIndexOf(' - ');

    if (separatorIndex >= 0) {
      const campaignName = remainder.slice(0, separatorIndex);
      const campaignId = remainder.slice(separatorIndex + 3);
      firstLineHtml =
        `${escapeHtml(icon)} <b>${escapeHtml(label)}</b>: ${escapeHtml(campaignName)} - <code>${escapeHtml(campaignId)}</code>`;
    }
  }

  const restLines = lines.slice(1).map(line => {
    const conditionMatch = line.match(/^(.+?)\s+([^:]+):\s*(.+)$/);

    if (conditionMatch) {
      const icon = conditionMatch[1];
      const label = conditionMatch[2];
      const value = conditionMatch[3];

      if (/vượt giới hạn|đạt điều kiện/i.test(label)) {
        // The value might have HTML bold tags now from the new alert content logic, we must not escape them if they are <b>...
        // Actually, we just trust the new htmlText from alerts/index.ts for the bot.
        // Wait, renderCampaignAlertMessageHtml is used when editing message on button click.
        // We can just use the line directly but safely.
        // To be safe, we'll recreate the bolding if it doesn't have it.
        if (value.includes('<b>')) {
          return `${escapeHtml(icon)} <b>${escapeHtml(label)}</b>: ${value}`;
        }
        return `${escapeHtml(icon)} <b>${escapeHtml(label)}</b>: ${escapeHtml(value)}`;
      }
    }

    return escapeHtml(line);
  });

  return [
    firstLineHtml,
    ...restLines,
  ].join('\n');
}

function summarizeCampaigns(campaigns: Array<{
  spend: number;
  clicks: number;
  ctr: number;
  conversions: number;
}>): {
  campaignCount: number;
  spend: number;
  clicks: number;
  ctr: number;
  conversions: number;
  cpa: number;
} {
  const spend = campaigns.reduce((sum, campaign) => sum + campaign.spend, 0);
  const clicks = campaigns.reduce((sum, campaign) => sum + campaign.clicks, 0);
  const conversions = campaigns.reduce((sum, campaign) => sum + campaign.conversions, 0);
  const weightedCtr = campaigns.reduce((sum, campaign) => sum + campaign.ctr * campaign.clicks, 0);

  return {
    campaignCount: campaigns.length,
    spend,
    clicks,
    ctr: clicks > 0 ? weightedCtr / clicks : 0,
    conversions,
    cpa: conversions > 0 ? spend / conversions : 0,
  };
}

function formatCampaignSummary(summary: ReturnType<typeof summarizeCampaigns>, includeCampaignCount = false): string {
  const prefix = includeCampaignCount ? `${summary.campaignCount} chiến dịch - ` : '';

  return `${prefix}${formatCurrency(summary.spend)} - ${summary.clicks.toLocaleString()}/${formatPercent(summary.ctr)} - ${summary.conversions.toLocaleString()} - ${formatCurrency(summary.cpa)}`;
}

function formatCampaignStatusSummary(campaigns: Array<{ status: CampaignMessageStatus; ad_status?: CampaignVisualStatus }>): string {
  const statusCounts = campaigns.reduce(
    (counts, campaign) => {
      const visualStatus = getCampaignVisualStatus(campaign);
      if (visualStatus === 'mixed') {
        counts.mixed += 1;
      } else {
        counts[visualStatus] += 1;
      }
      return counts;
    },
    { active: 0, paused: 0, deleted: 0, mixed: 0 } satisfies Record<CampaignVisualStatus, number>
  );

  return `Tr\u1ea1ng th\u00e1i QC: \u{1F7E2} Active ${statusCounts.active} \u00b7 \u{1F7E1} Pause ${statusCounts.paused} \u00b7 Mix ${statusCounts.mixed} \u00b7 \u26AA Deleted ${statusCounts.deleted}`;
}

function extractCampaignProductMarket(campaignName: string): { productName: string; marketCode: string } {
  const parts = campaignName
    .split(/\s+-\s+/)
    .map(part => part.trim())
    .filter(Boolean);

  return {
    productName: parts[0] || 'Unknown',
    marketCode: (parts[1] || 'UNKNOWN').toUpperCase(),
  };
}

function getActiveCampaignProductSummaryKey(productName: string, marketCode: string): string {
  return `${normalizeCommandToken(productName)}|${normalizeCommandToken(marketCode)}`;
}

function summarizeActiveCampaignsByProduct(
  campaigns: TikTokSpentCampaign[]
): ActiveCampaignProductSummary[] {
  const summariesByProduct = new Map<string, ActiveCampaignProductSummary>();
  const countedCampaignKeys = new Set<string>();

  for (const campaign of campaigns) {
    if (getCampaignVisualStatus(campaign) !== 'active') {
      continue;
    }

    const campaignKey = `${campaign.advertiser_id}:${campaign.campaign_id}`;
    if (countedCampaignKeys.has(campaignKey)) {
      continue;
    }
    countedCampaignKeys.add(campaignKey);

    const { productName, marketCode } = extractCampaignProductMarket(campaign.campaign_name);
    const summaryKey = getActiveCampaignProductSummaryKey(productName, marketCode);
    const existingSummary = summariesByProduct.get(summaryKey);
    const summary = existingSummary || {
      productName,
      marketCode,
      campaignCount: 0,
      accountCounts: new Map<string, number>(),
    };
    const accountLabel = getAccountNumberLabel(campaign) ||
      getAccountShortBalanceLabel(campaign) ||
      campaign.advertiser_id;

    summary.campaignCount += 1;
    summary.accountCounts.set(accountLabel, (summary.accountCounts.get(accountLabel) || 0) + 1);
    summariesByProduct.set(summaryKey, summary);
  }

  return [...summariesByProduct.values()].sort((summaryA, summaryB) =>
    summaryB.campaignCount - summaryA.campaignCount ||
    summaryA.productName.localeCompare(summaryB.productName, 'vi') ||
    summaryA.marketCode.localeCompare(summaryB.marketCode, 'vi')
  );
}

function formatActiveCampaignProductSummaryLine(summary: ActiveCampaignProductSummary): string {
  const accountSummary = [...summary.accountCounts.entries()]
    .sort(([accountLabelA], [accountLabelB]) => compareAccountNames(accountLabelA, accountLabelB))
    .map(([accountLabel, campaignCount]) =>
      `${campaignCount.toLocaleString('vi-VN')} \u00b7 ${escapeHtml(accountLabel)}`
    )
    .join(' - ');

  return `${escapeHtml(summary.productName)} (${escapeHtml(summary.marketCode)}) - \u{1F7E2} ${summary.campaignCount.toLocaleString('vi-VN')} camp - ${accountSummary}`;
}

function buildActiveCampaignProductsMessage(campaigns: TikTokSpentCampaign[]): string {
  const summaries = summarizeActiveCampaignsByProduct(campaigns);
  const totalActiveCampaigns = summaries.reduce((sum, summary) => sum + summary.campaignCount, 0);

  if (summaries.length === 0) {
    return 'Kh\u00f4ng c\u00f3 campaign active \u0111\u1ec3 th\u1ed1ng k\u00ea theo s\u1ea3n ph\u1ea9m.';
  }

  return [
    '<b>Campaign active theo s\u1ea3n ph\u1ea9m</b>',
    `T\u1ed5ng: \u{1F7E2} ${totalActiveCampaigns.toLocaleString('vi-VN')} camp`,
    '',
    ...summaries.map(formatActiveCampaignProductSummaryLine),
  ].join('\n');
}

function normalizeCampaignPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) {
    return 0;
  }

  return Math.min(Math.max(Math.trunc(page), 0), Math.max(totalPages - 1, 0));
}

function getSortedCampaignsBySpend(campaigns: TikTokSpentCampaign[]): TikTokSpentCampaign[] {
  return [...campaigns].sort((campaignA, campaignB) =>
    campaignB.spend - campaignA.spend ||
    campaignA.campaign_name.localeCompare(campaignB.campaign_name, 'vi') ||
    campaignA.campaign_id.localeCompare(campaignB.campaign_id)
  );
}

function getCampaignListOperationStatus(campaign: TikTokSpentCampaign): CampaignOperationStatus | undefined {
  const visualStatus = getCampaignVisualStatus(campaign);

  if (visualStatus === 'active' || visualStatus === 'mixed') {
    return 'DISABLE';
  }

  if (visualStatus === 'paused') {
    return 'ENABLE';
  }

  return undefined;
}

function buildCampaignsStatusCallbackData(
  operationStatus: CampaignOperationStatus,
  page: number,
  advertiserId: string,
  campaignId: string
): string {
  const statusCode = operationStatus === 'ENABLE' ? 'E' : 'D';
  return `${CAMPAIGNS_STATUS_CALLBACK_PREFIX}:${statusCode}:${page}:${advertiserId}:${campaignId}`;
}

function buildCampaignAccountPeriodCallbackData(period: CampaignAccountReportPeriod): string {
  return `${CAMPAIGNS_ACCOUNT_PERIOD_CALLBACK_PREFIX}:${period.startDate}:${period.endDate}`;
}

function buildCampaignAccountReportCallbackData(
  period: CampaignAccountReportPeriod,
  advertiserId: string
): string {
  return `${CAMPAIGNS_ACCOUNT_REPORT_CALLBACK_PREFIX}:${period.startDate}:${period.endDate}:${advertiserId}`;
}

function buildCampaignAccountPeriodKeyboard() {
  const buttons = getCampaignAccountQuickPeriods().map(period =>
    Markup.button.callback(
      period.buttonText,
      buildCampaignAccountPeriodCallbackData(period)
    )
  );

  return Markup.inlineKeyboard(chunkArray(buttons, 2));
}

function getCampaignAccountSelectorLabel(account: CampaignReportAdvertiserAccount): string {
  const accountLabel = getAccountShortBalanceLabel(account);

  return account.mkt_code
    ? `${accountLabel} · ${account.mkt_code}`
    : accountLabel;
}

function buildCampaignAccountSelectorKeyboard(
  accounts: CampaignReportAdvertiserAccount[],
  period: CampaignAccountReportPeriod
) {
  const buttons = accounts.map(account =>
    Markup.button.callback(
      getCampaignAccountSelectorLabel(account),
      buildCampaignAccountReportCallbackData(period, account.advertiser_id)
    )
  );

  return Markup.inlineKeyboard(chunkArray(buttons, CAMPAIGNS_ACCOUNT_BUTTONS_PER_ROW));
}

function encodeCallbackValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCallbackValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildCampaignMktPeriodCallbackData(period: CampaignAccountReportPeriod): string {
  return `${CAMPAIGNS_MKT_PERIOD_CALLBACK_PREFIX}:${period.startDate}:${period.endDate}`;
}

function buildCampaignMktReportCallbackData(
  period: CampaignAccountReportPeriod,
  mktCode: string
): string {
  return `${CAMPAIGNS_MKT_REPORT_CALLBACK_PREFIX}:${period.startDate}:${period.endDate}:${encodeCallbackValue(mktCode)}`;
}

function buildCampaignMktPageCallbackData(page: number): string {
  return `${CAMPAIGNS_MKT_PAGE_CALLBACK_PREFIX}:${page}`;
}

function buildCampaignMktPeriodKeyboard() {
  const buttons = getCampaignAccountQuickPeriods().map(period =>
    Markup.button.callback(
      period.buttonText,
      buildCampaignMktPeriodCallbackData(period)
    )
  );

  return Markup.inlineKeyboard(chunkArray(buttons, 2));
}

async function getCampaignMktGroups(): Promise<CampaignMktGroup[]> {
  const accounts = await getCampaignReportAdvertiserAccounts();
  const groupByMkt = new Map<string, CampaignReportAdvertiserAccount[]>();

  for (const account of accounts) {
    const mktCode = String(account.mkt_code || 'CHUA_GAN_MKT').trim() || 'CHUA_GAN_MKT';
    const groupAccounts = groupByMkt.get(mktCode) || [];

    groupAccounts.push(account);
    groupByMkt.set(mktCode, groupAccounts);
  }

  return [...groupByMkt.entries()]
    .map(([mktCode, groupAccounts]) => ({
      mktCode,
      accounts: groupAccounts.sort((accountA, accountB) =>
        compareAccountNames(getAccountShortBalanceLabel(accountA), getAccountShortBalanceLabel(accountB))
      ),
    }))
    .sort((groupA, groupB) => groupA.mktCode.localeCompare(groupB.mktCode, 'vi'));
}

function getCampaignMktSelectorLabel(group: CampaignMktGroup): string {
  return `${group.mktCode} (${group.accounts.length} TKQC)`;
}

function buildCampaignMktSelectorKeyboard(
  groups: CampaignMktGroup[],
  period: CampaignAccountReportPeriod
) {
  const buttons = groups.map(group =>
    Markup.button.callback(
      getCampaignMktSelectorLabel(group),
      buildCampaignMktReportCallbackData(period, group.mktCode)
    )
  );

  return Markup.inlineKeyboard(chunkArray(buttons, CAMPAIGNS_MKT_BUTTONS_PER_ROW));
}

function getCampaignsStatusButtonText(
  campaign: TikTokSpentCampaign,
  itemNumber: number,
  isPending: boolean
): string {
  if (isPending) {
    return `\u23F3 ${itemNumber}`;
  }

  const visualStatus = getCampaignVisualStatus(campaign);

  if (visualStatus === 'active') {
    return `\u{1F7E2} ${itemNumber}`;
  }

  if (visualStatus === 'paused' || visualStatus === 'mixed') {
    return `\u{1F7E1} ${itemNumber}`;
  }

  return `\u26AA ${itemNumber}`;
}

function buildCampaignsPageKeyboard(
  page: number,
  totalPages: number,
  pageCampaigns: TikTokSpentCampaign[],
  pendingActionKeys: ReadonlySet<string>
) {
  const previousPage = normalizeCampaignPage(page - 1, totalPages);
  const nextPage = normalizeCampaignPage(page + 1, totalPages);
  const campaignButtonRows = chunkArray(
    pageCampaigns.map((campaign, index) => {
      const itemNumber = index + 1;
      const operationStatus = getCampaignListOperationStatus(campaign);
      const isPending = pendingActionKeys.has(getCampaignListActionKey(campaign.advertiser_id, campaign.campaign_id));

      return Markup.button.callback(
        getCampaignsStatusButtonText(campaign, itemNumber, isPending),
        operationStatus && !isPending
          ? buildCampaignsStatusCallbackData(operationStatus, page, campaign.advertiser_id, campaign.campaign_id)
          : `${CAMPAIGNS_NOOP_CALLBACK_PREFIX}:${page}:${campaign.campaign_id}`
      );
    }),
    CAMPAIGNS_STATUS_BUTTONS_PER_ROW
  );
  const paginationRow = totalPages > 1
    ? [
      Markup.button.callback('\u23EA', `${CAMPAIGNS_PAGE_CALLBACK_PREFIX}:${previousPage}`),
      Markup.button.callback(`${page + 1}/${totalPages}`, `${CAMPAIGNS_PAGE_CALLBACK_PREFIX}:${page}`),
      Markup.button.callback('\u23E9', `${CAMPAIGNS_PAGE_CALLBACK_PREFIX}:${nextPage}`),
    ]
    : [];
  const rows = paginationRow.length > 0
    ? [...campaignButtonRows, paginationRow]
    : campaignButtonRows;

  return rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
}

function buildCampaignsPageMessage(
  campaigns: TikTokSpentCampaign[],
  requestedPage = 0,
  period?: CampaignAccountReportPeriod
): {
  message: string;
  page: number;
  totalPages: number;
  replyMarkup?: ReturnType<typeof buildCampaignsPageKeyboard>;
} {
  const sortedCampaigns = getSortedCampaignsBySpend(campaigns);
  const totalPages = Math.max(Math.ceil(sortedCampaigns.length / CAMPAIGNS_PAGE_SIZE), 1);
  const page = normalizeCampaignPage(requestedPage, totalPages);
  const pageCampaigns = sortedCampaigns.slice(
    page * CAMPAIGNS_PAGE_SIZE,
    (page + 1) * CAMPAIGNS_PAGE_SIZE
  );
  const summary = summarizeCampaigns(sortedCampaigns);
  const pendingActionKeys = new Set(pendingCampaignListActions.keys());
  const titleLine = period
    ? `\u{1F4CA} Chi\u1ebfn d\u1ecbch c\u00f3 chi ti\u00eau: <code>${escapeHtml(formatCampaignReportPeriodRange(period))}</code>`
    : '\u{1F4CA} Chi\u1ebfn d\u1ecbch c\u00f3 chi ti\u00eau h\u00f4m nay:';
  const lines = [
    `<b>Ph\u1ea7n ${page + 1}/${totalPages}</b>`,
    titleLine,
    '',
    escapeHtml(formatCampaignSummary(summary, true)),
    escapeHtml(formatCampaignStatusSummary(sortedCampaigns)),
    '',
  ];

  for (const [index, campaign] of pageCampaigns.entries()) {
    const shortName = getCampaignShortName(campaign.campaign_name);
    const accountNumber = getAccountNumberLabel(campaign);
    const accountSuffix = accountNumber ? ` \u00b7 ${escapeHtml(accountNumber)}` : '';
    const itemNumber = index + 1;

    lines.push(
      `${itemNumber}. ${getCampaignStatusIcon(campaign)} ${escapeHtml(shortName)} - <code>${escapeHtml(campaign.campaign_id)}</code>${accountSuffix}`,
      `\u{1F4B8} ${formatCurrency(campaign.spend)} \u00b7 \u{1F446} ${campaign.clicks.toLocaleString()}/${formatPercent(campaign.ctr)} \u00b7 \u{1F3AF} ${campaign.conversions.toLocaleString()} \u00b7 \u{1F4B0} ${formatCurrency(campaign.cpa)}`
    );
  }

  return {
    message: lines.join('\n'),
    page,
    totalPages,
    replyMarkup: buildCampaignsPageKeyboard(page, totalPages, pageCampaigns, pendingActionKeys),
  };
}

function buildCampaignMktPageKeyboard(page: number, totalPages: number) {
  if (totalPages <= 1) {
    return undefined;
  }

  const previousPage = normalizeCampaignPage(page - 1, totalPages);
  const nextPage = normalizeCampaignPage(page + 1, totalPages);

  return Markup.inlineKeyboard([[
    Markup.button.callback('\u23EA', buildCampaignMktPageCallbackData(previousPage)),
    Markup.button.callback(`${page + 1}/${totalPages}`, buildCampaignMktPageCallbackData(page)),
    Markup.button.callback('\u23E9', buildCampaignMktPageCallbackData(nextPage)),
  ]]);
}

function buildCampaignMktReportPageMessage(
  mktCode: string,
  period: CampaignAccountReportPeriod,
  campaigns: TikTokSpentCampaign[],
  requestedPage = 0
): {
  message: string;
  page: number;
  totalPages: number;
  replyMarkup?: ReturnType<typeof buildCampaignMktPageKeyboard>;
} {
  const sortedCampaigns = getSortedCampaignsBySpend(campaigns);
  const totalPages = Math.max(Math.ceil(sortedCampaigns.length / CAMPAIGNS_PAGE_SIZE), 1);
  const page = normalizeCampaignPage(requestedPage, totalPages);
  const pageCampaigns = sortedCampaigns.slice(
    page * CAMPAIGNS_PAGE_SIZE,
    (page + 1) * CAMPAIGNS_PAGE_SIZE
  );
  const periodRange = formatCampaignReportPeriodRange(period);
  const lines = [
    `<b>Chiến dịch MKT ${escapeHtml(mktCode)}</b>`,
    `<b>Phần ${page + 1}/${totalPages}</b>`,
    `\u{1F4C5} <code>${escapeHtml(periodRange)}</code>`,
    '',
    escapeHtml(formatCampaignSummary(summarizeCampaigns(sortedCampaigns), true)),
    escapeHtml(formatCampaignStatusSummary(sortedCampaigns)),
    '',
  ];

  for (const [index, campaign] of pageCampaigns.entries()) {
    const shortName = getCampaignShortName(campaign.campaign_name);
    const accountNumber = getAccountNumberLabel(campaign);
    const accountSuffix = accountNumber ? ` \u00b7 ${escapeHtml(accountNumber)}` : '';
    const itemNumber = page * CAMPAIGNS_PAGE_SIZE + index + 1;

    lines.push(
      `${itemNumber}. ${getCampaignStatusIcon(campaign)} ${escapeHtml(shortName)} - <code>${escapeHtml(campaign.campaign_id)}</code>${accountSuffix}`,
      `\u{1F4B8} ${formatCurrency(campaign.spend)} \u00b7 \u{1F446} ${campaign.clicks.toLocaleString()}/${formatPercent(campaign.ctr)} \u00b7 \u{1F3AF} ${campaign.conversions.toLocaleString()} \u00b7 \u{1F4B0} ${formatCurrency(campaign.cpa)}`
    );
  }

  return {
    message: lines.join('\n'),
    page,
    totalPages,
    replyMarkup: buildCampaignMktPageKeyboard(page, totalPages),
  };
}

function dedupeCampaignReportAdvertiserAccounts(
  accounts: CampaignReportAdvertiserAccount[]
): CampaignReportAdvertiserAccount[] {
  const accountById = new Map<string, CampaignReportAdvertiserAccount>();

  for (const account of accounts) {
    if (!account.advertiser_id) {
      continue;
    }

    const existingAccount = accountById.get(account.advertiser_id);
    accountById.set(account.advertiser_id, {
      advertiser_id: account.advertiser_id,
      advertiser_name: existingAccount?.advertiser_name || account.advertiser_name,
      mkt_code: existingAccount?.mkt_code || account.mkt_code,
    });
  }

  return [...accountById.values()].sort((accountA, accountB) =>
    compareAccountNames(
      getAccountShortBalanceLabel(accountA),
      getAccountShortBalanceLabel(accountB)
    )
  );
}

async function getCampaignReportAdvertiserAccounts(): Promise<CampaignReportAdvertiserAccount[]> {
  try {
    const permissions = await getAdvertiserPermissions({ includeAllMkt: true });
    const permissionAccounts = dedupeCampaignReportAdvertiserAccounts(
      permissions.map(permission => ({
        advertiser_id: permission.advertiserId,
        advertiser_name: permission.advertiserName,
        mkt_code: permission.mktCode,
      }))
    );

    if (permissionAccounts.length > 0) {
      return permissionAccounts;
    }
  } catch (error) {
    console.error('Error fetching advertiser permissions for campaign account report:', error);
  }

  const balances = await getTikTokAccountBalance();
  return dedupeCampaignReportAdvertiserAccounts(
    balances.map(account => ({
      advertiser_id: account.advertiser_id,
      advertiser_name: account.advertiser_name,
      mkt_code: account.mkt_code,
    }))
  );
}

function aggregateCampaignsByCampaign(campaigns: TikTokSpentCampaign[]): TikTokSpentCampaign[] {
  const campaignByKey = new Map<string, TikTokSpentCampaign>();

  for (const campaign of campaigns) {
    const campaignKey = `${campaign.advertiser_id}:${campaign.campaign_id}`;
    const existingCampaign = campaignByKey.get(campaignKey);

    if (!existingCampaign) {
      campaignByKey.set(campaignKey, { ...campaign });
      continue;
    }

    existingCampaign.spend += campaign.spend;
    existingCampaign.impressions += campaign.impressions;
    existingCampaign.clicks += campaign.clicks;
    existingCampaign.conversions += campaign.conversions;

    if (!existingCampaign.campaign_name || existingCampaign.campaign_name === 'Không rõ tên campaign') {
      existingCampaign.campaign_name = campaign.campaign_name;
    }

    if (campaign.date > existingCampaign.date) {
      existingCampaign.date = campaign.date;
      existingCampaign.status = campaign.status;
      existingCampaign.raw_status = campaign.raw_status;
    }
  }

  return [...campaignByKey.values()]
    .map(campaign => ({
      ...campaign,
      cpc: campaign.clicks > 0 ? campaign.spend / campaign.clicks : 0,
      cpa: campaign.conversions > 0 ? campaign.spend / campaign.conversions : 0,
      ctr: campaign.impressions > 0 ? (campaign.clicks / campaign.impressions) * 100 : 0,
    }))
    .sort((campaignA, campaignB) =>
      campaignB.spend - campaignA.spend ||
      campaignA.campaign_name.localeCompare(campaignB.campaign_name, 'vi') ||
      campaignA.campaign_id.localeCompare(campaignB.campaign_id)
    );
}

function buildCampaignAccountReportMessage(
  account: CampaignReportAdvertiserAccount,
  period: CampaignAccountReportPeriod,
  campaigns: TikTokSpentCampaign[]
): string {
  const sortedCampaigns = aggregateCampaignsByCampaign(campaigns);
  const accountLabel = getAccountDisplayName(account);
  const periodRange = formatCampaignReportPeriodRange(period);
  const lines = [
    `<b>${escapeHtml(accountLabel)}</b>`,
    `\u{1F4C5} ${escapeHtml(period.label)} · <code>${escapeHtml(periodRange)}</code>`,
    '',
  ];

  if (sortedCampaigns.length === 0) {
    lines.push('Không có chiến dịch phát sinh chi tiêu trong thời gian này.');
    return lines.join('\n');
  }

  lines.push(
    escapeHtml(formatCampaignSummary(summarizeCampaigns(sortedCampaigns), true)),
    escapeHtml(formatCampaignStatusSummary(sortedCampaigns)),
    ''
  );

  for (const [index, campaign] of sortedCampaigns.entries()) {
    const shortName = getCampaignShortName(campaign.campaign_name);

    lines.push(
      `${index + 1}. ${getCampaignStatusIcon(campaign)} ${escapeHtml(shortName)} - <code>${escapeHtml(campaign.campaign_id)}</code>`,
      `\u{1F4B8} ${formatCurrency(campaign.spend)} \u00b7 \u{1F446} ${campaign.clicks.toLocaleString()}/${formatPercent(campaign.ctr)} \u00b7 \u{1F3AF} ${campaign.conversions.toLocaleString()} \u00b7 \u{1F4B0} ${formatCurrency(campaign.cpa)}`
    );
  }

  return lines.join('\n');
}

async function editCampaignsListMessage(
  telegram: Context['telegram'],
  chatId: number | string,
  messageId: number,
  campaigns: TikTokSpentCampaign[],
  requestedPage: number,
  period?: CampaignAccountReportPeriod
): Promise<void> {
  const campaignPage = buildCampaignsPageMessage(campaigns, requestedPage, period);

  try {
    await telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      campaignPage.message,
      {
        parse_mode: 'HTML',
        ...(campaignPage.replyMarkup?.reply_markup ? { reply_markup: campaignPage.replyMarkup.reply_markup } : {}),
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (!errorMessage.toLowerCase().includes('message is not modified')) {
      throw error;
    }
  }

  saveCampaignsListMessageState(chatId, messageId, campaigns, period);
}

function saveCampaignMktMessageState(
  chatId: number | string,
  messageId: number,
  campaigns: TikTokSpentCampaign[],
  period: CampaignAccountReportPeriod,
  mktCode: string
): void {
  campaignsMktStateByMessage.set(
    getCampaignListStateKey(chatId, messageId),
    {
      campaigns,
      fetchedAt: Date.now(),
      period,
      mktCode,
    }
  );
}

async function editCampaignMktReportMessage(
  telegram: Context['telegram'],
  chatId: number | string,
  messageId: number,
  requestedPage: number
): Promise<void> {
  const state = campaignsMktStateByMessage.get(getCampaignListStateKey(chatId, messageId));

  if (!state) {
    await telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      'Báo cáo MKT đã hết hạn. Vui lòng chạy lại /campmkt.'
    );
    return;
  }

  const campaignPage = buildCampaignMktReportPageMessage(
    state.mktCode,
    state.period,
    state.campaigns,
    requestedPage
  );

  try {
    await telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      campaignPage.message,
      {
        parse_mode: 'HTML',
        ...(campaignPage.replyMarkup?.reply_markup ? { reply_markup: campaignPage.replyMarkup.reply_markup } : {}),
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (!errorMessage.toLowerCase().includes('message is not modified')) {
      throw error;
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unknown error';
}

function formatCallbackErrorMessage(prefix: string, error: unknown): string {
  const reason = getErrorMessage(error).replace(/\s+/g, ' ').trim();
  const message = reason ? `${prefix}: ${reason}` : prefix;
  return message.length > 190 ? `${message.slice(0, 187)}...` : message;
}

function getAlertSeverityIcon(severity: StoredAlert['severity']): string {
  if (severity === 'critical') {
    return '🛑';
  }

  if (severity === 'high') {
    return '🔴';
  }

  if (severity === 'medium') {
    return '🟠';
  }

  return '🟡';
}

function formatAlertTypeLabel(type: string): string {
  return type
    .split('_')
    .filter(Boolean)
    .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function buildRecentAlertsMessage(alerts: StoredAlert[]): string {
  return alerts
    .map((alert, index) => {
      const title = `${getAlertSeverityIcon(alert.severity)} ${alert.severity.toUpperCase()} · ${formatAlertTypeLabel(alert.type)}`;
      return [
        `<b>${index + 1}. ${escapeHtml(title)}</b>`,
        `<code>${escapeHtml(alert.createdAt)} UTC</code>`,
        `<code>${escapeHtml(alert.type)}</code>`,
        escapeHtml(alert.message.trim() || '(Không có nội dung)'),
      ].join('\n');
    })
    .join('\n\n');
}

async function setupCommandMenu(bot: Telegraf): Promise<void> {
  try {
    await (bot.telegram as any).callApi('deleteMyCommands', {});

    const adminChatId = process.env.ADMIN_CHAT_ID?.trim();
    if (adminChatId) {
      await (bot.telegram as any).callApi('deleteMyCommands', {
        scope: {
          type: 'chat',
          chat_id: adminChatId,
        },
      });
    }

    console.log('Telegram command menu hidden');
  } catch (error) {
    console.error('Error hiding Telegram command menu:', error);
  }
}

async function sendCommandMenuStartMessage(ctx: Context): Promise<void> {
  await ctx.reply(
    'Chọn chức năng bên dưới.',
    MAIN_MENU_KEYBOARD
  );
}

async function handleMainMenuButton(ctx: Context): Promise<boolean> {
  const action = MAIN_MENU_ACTION_BY_LABEL.get(getTextMessage(ctx).trim());
  if (!action) {
    return false;
  }

  switch (action) {
    case 'balance':
      await handleBalanceRequest(ctx);
      return true;
    case 'campaigns':
      await handleCampaignsRequest(ctx, []);
      return true;
    case 'campactive':
      await handleActiveCampaignProductsRequest(ctx);
      return true;
    case 'campmkt':
      await handleCampaignMktReportRequest(ctx, []);
      return true;
    case 'tkqc':
      await handleCampaignAccountReportRequest(ctx, []);
      return true;
    case 'bc':
      await sendBcMenu(ctx);
      return true;
    case 'bcall':
      await sendBcAllMenu(ctx);
      return true;
    case 'settings':
      await handleSettingsRequest(ctx);
      return true;
    case 'reload':
      await handleReloadRequest(ctx);
      return true;
    case 'xcamp':
      await ctx.reply(
        'Nhập lệnh nhân bản theo mẫu:\n<code>/xcamp campaign_id số_lượng ngân_sách bid</code>',
        { parse_mode: 'HTML' }
      );
      return true;
  }

  return false;
}

function formatSettingNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('vi-VN')
    : value.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
}

async function buildSettingsMessage(): Promise<string> {
  const settings = await getRuntimeSettingsSnapshot();

  return [
    '<b>Cài đặt bot</b>',
    '',
    `Cấp 1: mỗi <b>${formatSettingNumber(settings.level1IntervalMinutes)}</b> phút`,
    `Cấp 2: mỗi <b>${formatSettingNumber(settings.level2IntervalMinutes)}</b> phút`,
    `Tỉ giá: <b>${formatSettingNumber(settings.exchangeRate)}</b> VND/USD`,
    `Số dư: cảnh báo dưới <b>$${formatSettingNumber(settings.balanceThresholdUsd)}</b>`,
    `%CP cấp 2: trên <b>${formatSettingNumber(settings.level2CpAdsThreshold)}%</b>`,
    '',
    'Bấm mục cần sửa rồi nhập số mới.',
  ].join('\n');
}

function buildSettingsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⏱ Cấp 1', 'settings:set:level1_interval_minutes'),
      Markup.button.callback('⏱ Cấp 2', 'settings:set:level2_interval_minutes'),
    ],
    [
      Markup.button.callback('💱 Tỉ giá', 'settings:set:exchange_rate'),
      Markup.button.callback('💰 Số dư', 'settings:set:balance_threshold_usd'),
    ],
    [
      Markup.button.callback('📈 %CP C2', 'settings:set:level2_cp_ads_threshold'),
      Markup.button.callback('🚀 Chạy install-vps', 'settings:restart'),
    ],
  ]);
}

async function handleSettingsRequest(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('❌ Chỉ admin mới có thể mở cài đặt.');
    return;
  }

  await ctx.reply(await buildSettingsMessage(), {
    parse_mode: 'HTML',
    ...buildSettingsKeyboard(),
  });
}

async function applyRuntimeSetting(key: RuntimeSettingKey, value: number): Promise<void> {
  await setRuntimeSettingNumber(key, value);

  if (key === 'level1_interval_minutes' || key === 'level2_interval_minutes') {
    await restartScheduler();
  }

  if (key === 'balance_threshold_usd') {
    await initializeAlertRules();
  }
}

async function runInstallVpsScript(): Promise<void> {
  try {
    await execFileAsync('bash', ['install-vps.sh'], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    return;
  } catch (error) {
    console.error('install-vps.sh failed:', error);
  }
}

async function handlePendingSettingText(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return false;
  }

  const pendingKey = pendingSettingsByChat.get(chatId);
  if (!pendingKey) {
    return false;
  }

  const value = Number(getTextMessage(ctx).replace(/,/g, '').trim());
  if (!Number.isFinite(value) || value <= 0) {
    await ctx.reply('Giá trị không hợp lệ. Nhập một số lớn hơn 0.');
    return true;
  }

  try {
    await applyRuntimeSetting(pendingKey, value);
    pendingSettingsByChat.delete(chatId);
    await ctx.reply(
      `✅ Đã cập nhật ${SETTING_LABELS[pendingKey]}: <b>${escapeHtml(formatSettingNumber(value))}</b>`,
      { parse_mode: 'HTML' }
    );
    await handleSettingsRequest(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Không lưu được cài đặt: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
  }

  return true;
}

async function handleBalanceRequest(ctx: Context): Promise<void> {
  try {
    const balances = await getTikTokAccountBalance();
    let response = '💰 Số dư tài khoản TikTok:\n\n';

    if (balances.length === 0) {
      await ctx.reply('Không tìm thấy TKQC đang bật trong tab Permissions.');
      return;
    }

    balances
      .sort((accountA, accountB) =>
        compareAccountNames(
          getAccountShortBalanceLabel(accountA),
          getAccountShortBalanceLabel(accountB)
        )
      )
      .forEach(account => {
        response += `${getAccountShortBalanceLabel(account)} - ${formatCurrency(account.balance, account.currency)}\n`;
      });

    /*
    const balancesByMktCode = new Map<string, typeof balances>();
    balances.forEach(account => {
      const mktCode = account.mkt_code || 'Chưa gán MKT';
      const mktBalances = balancesByMktCode.get(mktCode) || [];
      mktBalances.push(account);
      balancesByMktCode.set(mktCode, mktBalances);
    });
    */

    /*
    balancesByMktCode.forEach((accounts, mktCode) => {
      response += `${mktCode}:\n`;

      accounts.forEach(account => {
        const accountName = account.advertiser_name || account.advertiser_id;
        const idSuffix = accountName.includes(account.advertiser_id) ? '' : ` (${account.advertiser_id})`;
        response += `• ${accountName}${idSuffix}: ${formatCurrency(account.balance, account.currency)}\n`;
      });

      response += '\n';
    });
    */

    const trackingAccounts = balances.map(account => ({
      advertiserId: account.advertiser_id,
      advertiserName: account.advertiser_name,
    }));
    const keyboard = isAdmin(ctx)
      ? buildBalanceTrackingKeyboard(
        balances,
        await getAdvertiserTrackingStates(trackingAccounts)
      )
      : undefined;
    const chunks = splitMessage(response);

    for (let index = 0; index < chunks.length; index++) {
      const prefix = chunks.length > 1 ? `Phần ${index + 1}/${chunks.length}\n` : '';
      const isLastChunk = index === chunks.length - 1;

      await ctx.reply(
        `${prefix}${chunks[index]}`,
        isLastChunk && keyboard ? keyboard : undefined
      );
    }
  } catch (error) {
    console.error('Error fetching account balance:', error);
    const message = error instanceof Error ? error.message : '';
    await ctx.reply(
      message.startsWith('Missing ')
        ? `❌ ${message}. Vui lòng kiểm tra cấu hình TikTok trong file .env.`
        : '❌ Có lỗi xảy ra khi lấy số dư tài khoản.'
    );
  }
}

function getTextMessage(ctx: Context): string {
  const message = ctx.message;

  return message && 'text' in message && typeof message.text === 'string'
    ? message.text
    : '';
}

function parseOptionalPositiveNumberArg(value: string | undefined): number | undefined {
  if (!value || value === '-') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
}

async function updateXcampQueueMessage(job: XcampQueueJob, message: string): Promise<void> {
  if (job.chatId) {
    await job.ctx.telegram.editMessageText(
      job.chatId,
      job.waitMessageId,
      undefined,
      message,
      { parse_mode: 'HTML' }
    );
    return;
  }

  await job.ctx.reply(message, { parse_mode: 'HTML' });
}

async function runXcampQueueJob(job: XcampQueueJob): Promise<void> {
  try {
    await updateXcampQueueMessage(
      job,
      `⏳ Đang nhân bản <b>${job.quantity}</b> chiến dịch từ gốc <code>${escapeHtml(job.campaignId)}</code>...\n${job.budget ? `Ngân sách mới: $${job.budget}\n` : ''}${job.bid ? `Giá thầu mới: $${job.bid}\n` : ''}Xin vui lòng chờ...`
    );
  } catch (editError) {
    console.error('Lỗi khi cập nhật trạng thái bắt đầu xcamp:', editError);
  }

  try {
    const duplicatedCampaigns: DuplicatedCampaignResult[] = [];
    const pendingCampaigns: DuplicatedCampaignResult[] = [];
    const errors: string[] = [];

    for (let i = 0; i < job.quantity; i++) {
      try {
        const result = await duplicateCampaign(job.campaignId, {
          overrideBudget: job.budget,
          overrideBid: job.bid,
        });
        if (!result) {
          errors.push(`Không nhận được kết quả nhân bản (lần ${i + 1}).`);
          continue;
        }

        if (result.status === 'pending') {
          pendingCampaigns.push(result);
          continue;
        }

        if (result.campaignId) {
          duplicatedCampaigns.push(result);
          try {
            await recordCampaignClone(job.campaignId, {
              campaignId: result.campaignId,
              advertiserId: result.advertiserId,
              campaignName: result.campaignName,
            });
          } catch (recordError) {
            console.error('Không ghi được bộ đếm nhân bản campaign:', recordError);
          }
        } else {
          errors.push(`Nhân bản lần ${i + 1} thiếu campaign ID.`);
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    let advertiserPermissions: AdvertiserPermission[] = [];
    try {
      advertiserPermissions = await getAdvertiserPermissions({ includeAllMkt: true });
    } catch (permissionError) {
      console.error('Không đọc được Permissions để hiển thị TKQC clone:', permissionError);
    }
    const permissionByAdvertiserId = buildAdvertiserPermissionMap(advertiserPermissions);

    const createdCount = duplicatedCampaigns.length;
    const pendingCount = pendingCampaigns.length;
    const errorCount = errors.length;
    const summaryIcon = errorCount > 0 && createdCount === 0 && pendingCount === 0
      ? '❌'
      : pendingCount > 0 && createdCount === 0
        ? '⏳'
        : '✅';

    let finalMsg =
      `${summaryIcon} <b>Kết quả nhân bản:</b> tạo <b>${createdCount}</b> · đang xử lý <b>${pendingCount}</b> · lỗi <b>${errorCount}</b> / tổng <b>${job.quantity}</b>\n\n`;

    if (duplicatedCampaigns.length > 0) {
      finalMsg += `Các camp mới:\n${duplicatedCampaigns.map(result =>
        formatDuplicatedCampaignResultLine(result, permissionByAdvertiserId)
      ).join('\n')}\n`;
    }
    if (pendingCampaigns.length > 0) {
      finalMsg += `\n⏳ <b>Đang xử lý</b> (TikTok đã nhận task, camp có thể chưa hiện ngay):\n${pendingCampaigns.map(formatPendingDuplicatedCampaignLine).join('\n')}\n`;
    }
    const overrideWarnings = duplicatedCampaigns
      .flatMap(result => result.overrideWarnings || [])
      .filter(Boolean);
    if (overrideWarnings.length > 0) {
      finalMsg += `\n⚠️ <b>Cảnh báo:</b>\n${escapeHtml(overrideWarnings[0])}`;
      if (overrideWarnings.length > 1) finalMsg += ` (và ${overrideWarnings.length - 1} cảnh báo khác)`;
    }
    if (errors.length > 0) {
      finalMsg += `\n❌ <b>Lỗi:</b>\n${errors.map(error => `• ${escapeHtml(error)}`).join('\n')}`;
    }

    await updateXcampQueueMessage(job, finalMsg);
  } catch (error) {
    console.error('Lỗi khi nhân bản Smart+', error);
    const errMsg = error instanceof Error ? error.message : String(error);
    try {
      await updateXcampQueueMessage(
        job,
        `❌ Lỗi hệ thống khi nhân bản chiến dịch:\n${escapeHtml(errMsg)}`
      );
    } catch (editError) {
      console.error('Lỗi khi cập nhật tin nhắn lỗi xcamp:', editError);
    }
  }
}

async function processXcampQueue(): Promise<void> {
  if (isDuplicatingCampaigns) {
    return;
  }

  isDuplicatingCampaigns = true;
  try {
    while (xcampQueue.length > 0) {
      const job = xcampQueue.shift();

      if (job) {
        await runXcampQueueJob(job);
      }
    }
  } finally {
    isDuplicatingCampaigns = false;
  }
}

function buildCampaignMktSelectorMessage(period: CampaignAccountReportPeriod): string {
  return [
    '<b>Chọn MKT để xem chiến dịch</b>',
    `Thời gian: <code>${escapeHtml(formatCampaignReportPeriodRange(period))}</code>`,
    '',
    'Có thể nhập khoảng ngày riêng:',
    '<code>/campmkt 24</code>',
    '<code>/campmkt 24-29</code>',
    '<code>/campmkt 24/04-29/04</code>',
    '<code>/campmkt 2026-04-24 2026-04-29</code>',
  ].join('\n');
}

async function sendCampaignMktSelector(
  ctx: Context,
  period: CampaignAccountReportPeriod
): Promise<void> {
  const groups = await getCampaignMktGroups();

  if (groups.length === 0) {
    await ctx.reply('Không tìm thấy MKT nào đang bật trong tab Permissions.');
    return;
  }

  const keyboard = buildCampaignMktSelectorKeyboard(groups, period);
  await ctx.reply(
    buildCampaignMktSelectorMessage(period),
    {
      parse_mode: 'HTML',
      ...keyboard,
    }
  );
}

async function editCampaignMktSelector(
  ctx: Context,
  period: CampaignAccountReportPeriod
): Promise<void> {
  const groups = await getCampaignMktGroups();

  if (groups.length === 0) {
    await ctx.editMessageText('Không tìm thấy MKT nào đang bật trong tab Permissions.');
    return;
  }

  const keyboard = buildCampaignMktSelectorKeyboard(groups, period);
  await ctx.editMessageText(
    buildCampaignMktSelectorMessage(period),
    {
      parse_mode: 'HTML',
      ...keyboard,
    }
  );
}

async function handleCampaignMktReportRequest(ctx: Context, forcedArgs?: string[]): Promise<void> {
  const messageText = getTextMessage(ctx);
  const args = forcedArgs ?? messageText.split(/\s+/).slice(1).filter(Boolean);
  const parseResult = parseCampaignsPeriodArgs(args);

  if (parseResult.error) {
    await ctx.reply(
      'Thời gian không hợp lệ.\n\nVí dụ:\n/campmkt 24\n/campmkt 24-29\n/campmkt 24/04-29/04\n/campmkt 2026-04-24 2026-04-29'
    );
    return;
  }

  if (!parseResult.period) {
    await ctx.reply(
      '<b>Chọn thời gian xem chiến dịch theo MKT</b>',
      {
        parse_mode: 'HTML',
        ...buildCampaignMktPeriodKeyboard(),
      }
    );
    return;
  }

  await sendCampaignMktSelector(ctx, parseResult.period);
}

async function sendCampaignMktReport(
  ctx: Context,
  period: CampaignAccountReportPeriod,
  mktCode: string
): Promise<void> {
  const message = ctx.callbackQuery?.message;

  if (!message?.chat?.id || !message.message_id) {
    await ctx.reply('Không cập nhật được tin nhắn báo cáo MKT.');
    return;
  }

  const groups = await getCampaignMktGroups();
  const group = groups.find(item => item.mktCode === mktCode);

  if (!group) {
    await ctx.editMessageText(`Không tìm thấy MKT ${escapeHtml(mktCode)} trong Permissions.`, {
      parse_mode: 'HTML',
    });
    return;
  }

  await ctx.editMessageText(
    `Đang lấy dữ liệu chiến dịch cho MKT <b>${escapeHtml(mktCode)}</b>...`,
    { parse_mode: 'HTML' }
  );

  const allowedAdvertiserIds = new Set(group.accounts.map(account => account.advertiser_id));
  const campaigns = await applyTodayAdStatusesToCampaigns(aggregateCampaignsByCampaign((await getTodaySpentCampaigns(
    period.startDate,
    period.endDate,
    {
      advertiserIds: group.accounts.map(account => account.advertiser_id),
      advertiserAccounts: group.accounts.map(account => ({
        advertiserId: account.advertiser_id,
        advertiserName: account.advertiser_name,
        mktCode: account.mkt_code,
      })),
    }
  )).filter(campaign => allowedAdvertiserIds.has(campaign.advertiser_id))), {
    advertiserIds: group.accounts.map(account => account.advertiser_id),
    advertiserAccounts: group.accounts.map(account => ({
      advertiserId: account.advertiser_id,
      advertiserName: account.advertiser_name,
      mktCode: account.mkt_code,
    })),
  });

  if (campaigns.length === 0) {
    await ctx.editMessageText(
      `Không có chiến dịch phát sinh chi tiêu cho MKT <b>${escapeHtml(mktCode)}</b> trong thời gian <code>${escapeHtml(formatCampaignReportPeriodRange(period))}</code>.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  saveCampaignMktMessageState(message.chat.id, message.message_id, campaigns, period, mktCode);
  await editCampaignMktReportMessage(ctx.telegram, message.chat.id, message.message_id, 0);
}

function buildCampaignAccountSelectorMessage(period: CampaignAccountReportPeriod): string {
  return [
    '<b>Chọn TKQC để xem chiến dịch</b>',
    `Thời gian: <code>${escapeHtml(formatCampaignReportPeriodRange(period))}</code>`,
    '',
    'Có thể nhập khoảng ngày riêng:',
    '<code>/tkqc 01-29</code>',
    '<code>/tkqc 01/04-29/04</code>',
    '<code>/tkqc 01/04/2026-29/04/2026</code>',
  ].join('\n');
}

async function sendCampaignAccountSelector(
  ctx: Context,
  period: CampaignAccountReportPeriod
): Promise<void> {
  const accounts = await getCampaignReportAdvertiserAccounts();

  if (accounts.length === 0) {
    await ctx.reply('Không tìm thấy TKQC đang bật trong tab Permissions.');
    return;
  }

  const keyboard = buildCampaignAccountSelectorKeyboard(accounts, period);
  await ctx.reply(
    buildCampaignAccountSelectorMessage(period),
    {
      parse_mode: 'HTML',
      ...keyboard,
    }
  );
}

async function editCampaignAccountSelector(
  ctx: Context,
  period: CampaignAccountReportPeriod
): Promise<void> {
  const accounts = await getCampaignReportAdvertiserAccounts();

  if (accounts.length === 0) {
    await ctx.editMessageText('Không tìm thấy TKQC đang bật trong tab Permissions.');
    return;
  }

  const keyboard = buildCampaignAccountSelectorKeyboard(accounts, period);
  await ctx.editMessageText(
    buildCampaignAccountSelectorMessage(period),
    {
      parse_mode: 'HTML',
      ...keyboard,
    }
  );
}

async function handleCampaignAccountReportRequest(ctx: Context, forcedArgs?: string[]): Promise<void> {
  const messageText = getTextMessage(ctx);
  const args = forcedArgs ?? messageText.split(/\s+/).slice(1).filter(Boolean);
  const parseResult = parseCampaignAccountReportPeriodArgs(args);

  if (parseResult.error) {
    await ctx.reply(
      `${parseResult.error}\n\nVí dụ:\n/tkqc 01-29\n/tkqc 01/04-29/04\n/tkqc 01/04/2026-29/04/2026\n/tkqc 2026-04-01 2026-04-29`
    );
    return;
  }

  if (!parseResult.period) {
    await ctx.reply(
      '<b>Chọn thời gian xem chiến dịch theo TKQC</b>',
      {
        parse_mode: 'HTML',
        ...buildCampaignAccountPeriodKeyboard(),
      }
    );
    return;
  }

  await sendCampaignAccountSelector(ctx, parseResult.period);
}

async function sendCampaignAccountReport(
  ctx: Context,
  period: CampaignAccountReportPeriod,
  advertiserId: string
): Promise<void> {
  const accounts = await getCampaignReportAdvertiserAccounts();
  const account = accounts.find(item => item.advertiser_id === advertiserId) || {
    advertiser_id: advertiserId,
  };

  try {
    await ctx.editMessageText(
      `Đang lấy dữ liệu chiến dịch cho ${escapeHtml(getCampaignAccountSelectorLabel(account))}...`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Error editing campaign account selector while loading:', error);
  }

  const campaigns = await applyTodayAdStatusesToCampaigns(await getTodaySpentCampaigns(
    period.startDate,
    period.endDate,
    {
      advertiserIds: [advertiserId],
      advertiserAccounts: [{
        advertiserId: account.advertiser_id,
        advertiserName: account.advertiser_name,
        mktCode: account.mkt_code,
      }],
    }
  ), {
    advertiserIds: [advertiserId],
    advertiserAccounts: [{
      advertiserId: account.advertiser_id,
      advertiserName: account.advertiser_name,
      mktCode: account.mkt_code,
    }],
  });

  const reportMessage = buildCampaignAccountReportMessage(account, period, campaigns);
  await replyLongMessage(ctx, reportMessage, { parse_mode: 'HTML' });
}

async function handleCampaignsRequest(ctx: Context, forcedArgs?: string[]): Promise<void> {
  try {
    const messageText = getTextMessage(ctx);
    const args = forcedArgs ?? messageText.split(/\s+/).slice(1).filter(Boolean);
    const parseResult = parseCampaignsPeriodArgs(args);

    if (parseResult.error) {
      await ctx.reply(
        `Thời gian không hợp lệ.\n\nVí dụ:\n/campaigns 24\n/campaigns 24-29\n/campaigns 24/04-29/04\n/campaigns 2026-04-24 2026-04-29`
      );
      return;
    }

    if (parseResult.error) {
      await ctx.reply(
        `${parseResult.error}\n\nVí dụ:\n/campaigns 24\n/campaigns 24-29\n/campaigns 24/04-29/04\n/campaigns 2026-04-24 2026-04-29`
      );
      return;
    }

    const period = parseResult.period;
    const campaigns = period
      ? await applyTodayAdStatusesToCampaigns(aggregateCampaignsByCampaign(await getTodaySpentCampaigns(
        period.startDate,
        period.endDate,
        { includeCache: false }
      )))
      : await getCampaignsForCampaignsList();

    if (campaigns.length === 0 && period) {
      await ctx.reply(`Không có chiến dịch phát sinh chi tiêu trong thời gian ${formatCampaignReportPeriodRange(period)}.`);
      return;
    }

    if (campaigns.length === 0) {
      await ctx.reply('Hôm nay chưa có chiến dịch nào phát sinh chi tiêu.');
      return;
    }

    const campaignPage = buildCampaignsPageMessage(campaigns, 0, period);
    const sentMessage = await ctx.reply(
      campaignPage.message,
      {
        parse_mode: 'HTML',
        ...(campaignPage.replyMarkup ? campaignPage.replyMarkup : {}),
      }
    );
    saveCampaignsListMessageState(sentMessage.chat.id, sentMessage.message_id, campaigns, period);
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    await ctx.reply('❌ Có lỗi xảy ra khi lấy danh sách chiến dịch.');
  }
}

async function handleActiveCampaignProductsRequest(ctx: Context): Promise<void> {
  try {
    const campaigns = await getCampaignsForCampaignsList();
    const message = buildActiveCampaignProductsMessage(campaigns);

    await replyLongMessage(ctx, message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error building active campaign product report:', error);
    await ctx.reply('❌ Có lỗi xảy ra khi thống kê campaign active theo sản phẩm.');
  }
}

async function handleAlertsRequest(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('❌ Chỉ admin mới có thể xem danh sách cảnh báo.');
    return;
  }

  try {
    const alerts = await getRecentAlerts(10);

    if (alerts.length === 0) {
      await ctx.reply('📋 Chưa có cảnh báo nào được ghi nhận.');
      return;
    }

    const response = `📋 10 cảnh báo gần đây:\n\n${buildRecentAlertsMessage(alerts)}`;
    await replyLongMessage(ctx, response, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    await ctx.reply('❌ Có lỗi xảy ra khi lấy danh sách cảnh báo.');
  }
}

async function handleReloadRequest(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('❌ Chỉ admin mới có thể reload dữ liệu.');
    return;
  }

  if (isReloading) {
    await ctx.reply('⏳ Đang có một tiến trình reload khác chạy. Chờ xong rồi thử lại.');
    return;
  }

  isReloading = true;

  try {
    await ctx.reply('🔄 Đang quét lại dữ liệu...');

    const [configResult, alertSyncResult, businessCenterResult, balancesResult, campaignsResult, adsResult, salesResult] = await Promise.allSettled([
      getConfigSnapshot(),
      initializeAlertRules(),
      getBusinessCenterId(),
      getTikTokAccountBalance(),
      getTodaySpentCampaigns(),
      getTodaySpentAds(),
      getSalesData(),
    ]);

    const trackableAdvertisers = [
      ...(configResult.status === 'fulfilled'
        ? configResult.value.permissions.map(permission => ({
          advertiserId: permission.advertiserId,
          advertiserName: permission.advertiserName,
        }))
        : []),
      ...(balancesResult.status === 'fulfilled'
        ? balancesResult.value.map(account => ({
          advertiserId: account.advertiser_id,
          advertiserName: account.advertiser_name,
        }))
        : []),
      ...(campaignsResult.status === 'fulfilled'
        ? campaignsResult.value.map(campaign => ({
          advertiserId: campaign.advertiser_id,
          advertiserName: campaign.advertiser_name,
        }))
        : []),
      ...(adsResult.status === 'fulfilled'
        ? adsResult.value.map(ad => ({
          advertiserId: ad.advertiser_id,
          advertiserName: ad.advertiser_name,
        }))
        : []),
    ];
    const canPruneTrackingCache = configResult.status === 'fulfilled';
    const trackingSyncResult = canPruneTrackingCache
      ? await syncAdvertiserTrackingCache(trackableAdvertisers)
      : {
        states: trackableAdvertisers.length > 0
          ? await getAdvertiserTrackingStates(trackableAdvertisers)
          : [],
        prunedCount: 0,
      };

    const reloadSteps = [
      ['config', configResult],
      ['alerts', alertSyncResult],
      ['business_center', businessCenterResult],
      ['balances', balancesResult],
      ['campaigns', campaignsResult],
      ['ads', adsResult],
      ['sales', salesResult],
    ] as const;
    const failedSteps = reloadSteps
      .filter(([, result]) => result.status === 'rejected')
      .map(([name, result]) => ({
        step: name,
        error: result.status === 'rejected' ? getErrorMessage(result.reason) : '',
      }));
    const trackingStates = trackingSyncResult.states;
    const lines = [
      failedSteps.length > 0
        ? '⚠️ Reload hoàn tất nhưng có lỗi ở một số bước.'
        : '✅ Reload thành công.',
    ];

    if (configResult.status === 'fulfilled') {
      lines.push(
        `✅ Settings: ${configResult.value.sources.length} sources · rate ${configResult.value.exchangeRate.toLocaleString('en-US')}`,
        `✅ Permissions: ${configResult.value.permissions.length} TKQC`,
        `✅ PageMap: ${configResult.value.pageMap.length} mappings`
      );
    } else {
      lines.push(`❌ Config: ${getErrorMessage(configResult.reason)}`);
    }

    if (businessCenterResult.status === 'fulfilled') {
      lines.push(`✅ BC: ${businessCenterResult.value || 'trống'}`);
    } else {
      lines.push(`❌ BC: ${getErrorMessage(businessCenterResult.reason)}`);
    }

    if (alertSyncResult.status === 'fulfilled') {
      lines.push(
        `✅ Alerts: ${alertSyncResult.value.actionRuleCount} action rules`,
        `✅ Alerts sheet: ${alertSyncResult.value.sheetCreated ? 'created' : 'exists'}${alertSyncResult.value.clearedLegacyDemo ? ' · cleared legacy demo' : ''}`,
        `✅ Balance rule: < ${formatCurrency(alertSyncResult.value.balanceThreshold)}`
      );
    } else if (alertSyncResult.status === 'rejected') {
      lines.push(`❌ Alerts sync: ${getErrorMessage(alertSyncResult.reason)}`);
    }

    if (balancesResult.status === 'fulfilled') {
      lines.push(`✅ Balance scan: ${balancesResult.value.length} TKQC`);
    } else {
      lines.push(`❌ Balance scan: ${getErrorMessage(balancesResult.reason)}`);
    }

    if (campaignsResult.status === 'fulfilled') {
      lines.push(`✅ Campaign scan: ${campaignsResult.value.length} campaign`);
    } else {
      lines.push(`❌ Campaign scan: ${getErrorMessage(campaignsResult.reason)}`);
    }

    if (adsResult.status === 'fulfilled') {
      lines.push(`✅ Ad scan: ${adsResult.value.length} ads`);
    } else {
      lines.push(`❌ Ad scan: ${getErrorMessage(adsResult.reason)}`);
    }

    if (salesResult.status === 'fulfilled') {
      lines.push(`✅ Sales scan: ${salesResult.value.length} dòng`);
    } else {
      lines.push(`❌ Sales scan: ${getErrorMessage(salesResult.reason)}`);
    }

    lines.push(
      `✅ Tracking sync: ${trackingStates.length} TKQC`,
      canPruneTrackingCache
        ? `✅ Tracking prune: ${trackingSyncResult.prunedCount} TKQC cũ`
        : '⏭️ Tracking prune: bỏ qua vì chưa đọc được Permissions'
    );

    if (failedSteps.length > 0) {
      console.error('Reload completed with errors:', failedSteps);
      lines.push('');
      lines.push('Chi tiết lỗi:');
      failedSteps.forEach(step => {
        lines.push(`• ${step.step}: ${step.error}`);
      });
    }

    await replyLongMessage(ctx, lines.join('\n'));
  } catch (error) {
    console.error('Error reloading data:', error);
    await ctx.reply('❌ Reload lỗi.');
  } finally {
    isReloading = false;
  }
}

export function setupBotHandlers(bot: Telegraf) {
  // Global error handler — prevents unhandled errors from crashing Telegraf's polling loop.
  // Without this, a single unhandled rejection in any handler stops ALL command processing.
  bot.catch((err, ctx) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bot.catch] Unhandled error for update ${ctx.updateType}:`, errMsg);
  });

  void setupCommandMenu(bot);

  bot.start((ctx) => void sendCommandMenuStartMessage(ctx));

  bot.command('balance', (ctx) => void handleBalanceRequest(ctx));
  bot.command('campactive', (ctx) => void handleActiveCampaignProductsRequest(ctx));
  bot.command('campmkt', (ctx) => void handleCampaignMktReportRequest(ctx));
  bot.command('tkqc', (ctx) => void handleCampaignAccountReportRequest(ctx));
  bot.command('settings', (ctx) => void handleSettingsRequest(ctx));
  setupBcSalesHandlers(bot);

  bot.action(/^settings:set:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const key = ctx.match[1] as RuntimeSettingKey;
    if (!SETTING_LABELS[key]) {
      await ctx.answerCbQuery('Cài đặt không hợp lệ.');
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCbQuery('Không xác định được chat.');
      return;
    }

    pendingSettingsByChat.set(chatId, key);
    await ctx.answerCbQuery();
    await ctx.reply(`Nhập giá trị mới cho ${SETTING_LABELS[key]}.`);
  });

  bot.action(/^settings:restart$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    await ctx.answerCbQuery('Đang chạy install-vps.sh...');
    await ctx.reply('🚀 Đang chạy bash install-vps.sh.');
    void runInstallVpsScript();
  });

  bot.action(/^toggle_balance_tracking:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const advertiserId = ctx.match[1];

    try {
      const balances = await getTikTokAccountBalance();
      const selectedAccount = balances.find(account => account.advertiser_id === advertiserId);
      const nextState = await toggleAdvertiserTracking(advertiserId, selectedAccount?.advertiser_name);
      const trackingStates = await getAdvertiserTrackingStates(
        balances.map(account => ({
          advertiserId: account.advertiser_id,
          advertiserName: account.advertiser_name,
        }))
      );
      const keyboard = buildBalanceTrackingKeyboard(balances, trackingStates);

      if (keyboard) {
        await ctx.editMessageReplyMarkup(keyboard.reply_markup);
      }

      const accountLabel = selectedAccount
        ? getAccountDisplayName(selectedAccount)
        : advertiserId;

      await ctx.answerCbQuery(
        nextState.isTracked
          ? `${accountLabel}: đang theo dõi`
          : `${accountLabel}: đã bỏ theo dõi`
      );
    } catch (error) {
      console.error('Error toggling advertiser tracking:', error);
      await ctx.answerCbQuery('Có lỗi khi cập nhật trạng thái theo dõi.');
    }

  });

  bot.action(/^cmp:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const period = buildCampaignAccountReportPeriod(ctx.match[1], ctx.match[2]);

    await ctx.answerCbQuery();

    try {
      await editCampaignMktSelector(ctx, period);
    } catch (error) {
      console.error('Error showing campaign MKT selector:', error);
      await ctx.reply('Có lỗi khi tải danh sách MKT.');
    }
  });

  bot.action(/^cmr:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2}):(.+)$/, async (ctx) => {
    const period = buildCampaignAccountReportPeriod(ctx.match[1], ctx.match[2]);
    const mktCode = decodeCallbackValue(ctx.match[3]);

    await ctx.answerCbQuery('Đang lấy dữ liệu...');

    try {
      await sendCampaignMktReport(ctx, period, mktCode);
    } catch (error) {
      console.error('Error fetching campaign MKT report:', error);

      try {
        await ctx.editMessageText(`Lấy dữ liệu thất bại: ${getErrorMessage(error)}`);
      } catch (editError) {
        console.error('Error editing failed campaign MKT report message:', editError);
        await ctx.reply(`Lấy dữ liệu thất bại: ${getErrorMessage(error)}`);
      }
    }
  });

  bot.action(/^cmpg:(\d+)$/, async (ctx) => {
    const requestedPage = Number(ctx.match[1] || 0);

    await ctx.answerCbQuery();

    try {
      const message = ctx.callbackQuery.message;

      if (!message?.chat?.id || !message.message_id) {
        return;
      }

      await editCampaignMktReportMessage(
        ctx.telegram,
        message.chat.id,
        message.message_id,
        requestedPage
      );
    } catch (error) {
      console.error('Error editing campaign MKT page:', error);
    }
  });

  bot.action(/^cap:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const period = buildCampaignAccountReportPeriod(ctx.match[1], ctx.match[2]);

    await ctx.answerCbQuery();

    try {
      await editCampaignAccountSelector(ctx, period);
    } catch (error) {
      console.error('Error showing campaign account selector:', error);
      await ctx.reply('Có lỗi khi tải danh sách TKQC.');
    }
  });

  bot.action(/^car:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2}):([^:]+)$/, async (ctx) => {
    const period = buildCampaignAccountReportPeriod(ctx.match[1], ctx.match[2]);
    const advertiserId = ctx.match[3];

    await ctx.answerCbQuery('Đang lấy dữ liệu...');

    try {
      await sendCampaignAccountReport(ctx, period, advertiserId);
    } catch (error) {
      console.error('Error fetching campaign account report:', error);

      try {
        await ctx.editMessageText(`❌ Lấy dữ liệu thất bại: ${getErrorMessage(error)}`);
      } catch (editError) {
        console.error('Error editing failed campaign account report message:', editError);
        await ctx.reply(`❌ Lấy dữ liệu thất bại: ${getErrorMessage(error)}`);
      }
    }
  });

  bot.action(/^campaigns_page:(\d+)$/, async (ctx) => {
    const requestedPage = Number(ctx.match[1] || 0);

    await ctx.answerCbQuery();

    try {
      const message = ctx.callbackQuery.message;

      if (!message?.chat?.id || !message.message_id) {
        return;
      }

      const stateKey = getCampaignListStateKey(message.chat.id, message.message_id);
      const state = campaignsListStateByMessage.get(stateKey);
      const campaigns = state?.campaigns ||
        await getCampaignsForCampaignsList();

      if (campaigns.length === 0) {
        await ctx.editMessageText('Hôm nay chưa có chiến dịch nào phát sinh chi tiêu.');
        return;
      }

      await editCampaignsListMessage(
        ctx.telegram,
        message.chat.id,
        message.message_id,
        campaigns,
        requestedPage,
        state?.period
      );
    } catch (error: any) {
      console.error('Error editing campaigns page:', error);
    }
  });

  bot.action(/^cn:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Campaign này không thể thao tác từ danh sách.');
  });

  bot.action(/^cs:([ED]):(\d+):([^:]+):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const operationStatus: CampaignOperationStatus = ctx.match[1] === 'E' ? 'ENABLE' : 'DISABLE';
    const requestedPage = Number(ctx.match[2] || 0);
    const advertiserId = ctx.match[3];
    const campaignId = ctx.match[4];
    const actionLabel = operationStatus === 'ENABLE' ? 'Active' : 'Pause';
    const callbackQueryId = ctx.callbackQuery.id;
    const message = ctx.callbackQuery.message;

    if (!message?.chat?.id || !message.message_id) {
      await ctx.answerCbQuery('Không cập nhật được tin nhắn.');
      return;
    }

    const chatId = message.chat.id;
    const messageId = message.message_id;
    const stateKey = getCampaignListStateKey(chatId, messageId);
    const state = campaignsListStateByMessage.get(stateKey);
    const campaigns = state?.campaigns ||
      await getCampaignsForCampaignsList();
    const period = state?.period;
    const campaign = campaigns.find(item =>
      item.advertiser_id === advertiserId && item.campaign_id === campaignId
    );
    const actionKey = getCampaignListActionKey(advertiserId, campaignId);

    if (pendingCampaignListActions.has(actionKey)) {
      await ctx.answerCbQuery('Campaign này đang xử lý. Vui lòng chờ kết quả.');
      return;
    }

    const accountLabel = campaign
      ? getAccountDisplayName(campaign)
      : advertiserId;

    pendingCampaignListActions.set(actionKey, operationStatus);

    try {
      await editCampaignsListMessage(ctx.telegram, chatId, messageId, campaigns, requestedPage, period);
    } catch (error) {
      console.error('Error marking campaign status as pending:', error);
    }

    void (async () => {
      try {
        const result = await setCampaignAdsStatus(advertiserId, campaignId, operationStatus);
        updateCampaignAdStatusInCampaignListState(
          advertiserId,
          campaignId,
          result.status || (operationStatus === 'ENABLE' ? 'active' : 'paused'),
          operationStatus
        );

        try {
          await ctx.telegram.answerCbQuery(
            callbackQueryId,
            `${accountLabel} ${actionLabel} ${result.adIds.length} QC thành công`
          );
        } catch (notifyError) {
          console.error('Error sending campaign status success notification:', notifyError);
        }
      } catch (error) {
        console.error('Error updating campaign status from campaigns list:', error);

        try {
          await refreshCampaignAdStatusInCampaignListState(advertiserId, campaignId);
        } catch (refreshError) {
          console.error('Error refreshing campaign ad status after failed action:', refreshError);
        }

        try {
          await ctx.telegram.answerCbQuery(
            callbackQueryId,
            formatCallbackErrorMessage(`${accountLabel} ${actionLabel} thất bại`, error),
            { show_alert: true }
          );
        } catch (notifyError) {
          console.error('Error sending campaign status failure notification:', notifyError);
        }
      } finally {
        pendingCampaignListActions.delete(actionKey);
        const latestState = campaignsListStateByMessage.get(stateKey);
        const latestCampaigns = latestState?.campaigns || campaigns;

        try {
          await editCampaignsListMessage(
            ctx.telegram,
            chatId,
            messageId,
            latestCampaigns,
            requestedPage,
            latestState?.period || period
          );
        } catch (editError) {
          console.error('Error refreshing campaigns list after status update:', editError);
        }
      }
    })();

    return;
  });

  bot.action(/^campaign_action:(ENABLE|DISABLE):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const operationStatus = ctx.match[1] as CampaignOperationStatus;
    const campaignId = ctx.match[2];
    const actionLabel: 'Pause' | 'Active' =
      operationStatus === 'ENABLE' ? 'Active' : 'Pause';
    const message = ctx.callbackQuery.message;

    if (!message || !('text' in message) || typeof message.text !== 'string') {
      await ctx.answerCbQuery('Không cập nhật được tin nhắn.');
      return;
    }

    try {
      const result = await setCampaignAdsStatusByCampaignId(campaignId, operationStatus);
      const newStatus = result.status || (operationStatus === 'ENABLE' ? 'active' : 'paused');
      const groupedReplyMarkup = updateGroupedCampaignActionReplyMarkup(
        (message as { reply_markup?: InlineKeyboardMarkup }).reply_markup,
        campaignId,
        newStatus as CampaignMessageStatus
      );

      if (groupedReplyMarkup && isGroupedCampaignAlertText(message.text)) {
        try {
          await ctx.editMessageReplyMarkup(groupedReplyMarkup);
        } catch (editError) {
          console.error('Error editing grouped campaign action keyboard:', editError);
        }

        await ctx.answerCbQuery(`${actionLabel} ${result.adIds.length} QC thành công`);
        return;
      }

      const nextText = upsertCampaignActionResultLine(message.text, actionLabel, true);
      const keyboard = buildCampaignActionKeyboard(
        campaignId,
        newStatus as CampaignMessageStatus
      );

      if (nextText !== message.text) {
        try {
          await ctx.editMessageText(renderCampaignAlertMessageHtml(nextText), {
            parse_mode: 'HTML',
            ...(keyboard ? { reply_markup: keyboard.reply_markup } : {}),
          });
        } catch (editError) {
          console.error('Error editing campaign action message:', editError);
        }
      }

      await ctx.answerCbQuery(`${actionLabel} ${result.adIds.length} QC thành công`);
    } catch (error) {
      console.error('Error updating campaign status from alert button:', error);
      const alertErrorMessage = formatCallbackErrorMessage(`${actionLabel} thất bại`, error);
      if (isGroupedCampaignAlertText(message.text)) {
        await ctx.answerCbQuery(alertErrorMessage, { show_alert: true });
        return;
      }

      const nextText = upsertCampaignActionResultLine(message.text, actionLabel, false);
      const failureReason = error instanceof Error ? error.message : String(error);
      const nextTextWithReason = `${nextText}\nℹ️ Lý do: ${failureReason}`;

      if (nextTextWithReason !== message.text) {
        try {
          await ctx.editMessageText(renderCampaignAlertMessageHtml(nextTextWithReason), {
            parse_mode: 'HTML',
          });
        } catch (editError) {
          console.error('Error editing failed campaign action message:', editError);
        }
      } else {
        try {
          await ctx.editMessageReplyMarkup(undefined);
        } catch (editError) {
          console.error('Error removing campaign action keyboard after failure:', editError);
        }
      }

      await ctx.answerCbQuery(alertErrorMessage, { show_alert: true });
    }
  });

  bot.action(/^cad:([01]):([^:]+):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const isTracked = ctx.match[1] === '1';
    const advertiserId = ctx.match[2];
    const campaignId = ctx.match[3];

    try {
      await setCampaignDailyAlertTracking(advertiserId, campaignId, isTracked);

      const message = ctx.callbackQuery.message as { reply_markup?: InlineKeyboardMarkup } | undefined;
      if (message?.reply_markup) {
        const nextReplyMarkup = updateCampaignDailyAlertReplyMarkup(
          message.reply_markup,
          advertiserId,
          campaignId,
          isTracked
        );

        if (nextReplyMarkup) {
          try {
            await ctx.editMessageReplyMarkup(nextReplyMarkup);
          } catch (editError) {
            console.error('Error editing campaign daily alert tracking keyboard:', editError);
          }
        }
      }

      await ctx.answerCbQuery(
        isTracked
          ? 'Đã theo dõi lại camp này trong hôm nay.'
          : 'Đã bỏ theo dõi camp này trong hôm nay.'
      );
    } catch (error) {
      console.error('Error updating campaign daily alert tracking:', error);
      await ctx.answerCbQuery('Không cập nhật được theo dõi camp.', { show_alert: true });
    }
  });

  bot.action(/^duplicate_camp:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const campaignId = ctx.match[1];

    await ctx.answerCbQuery();

    let budget = 20;
    let bid = 0.5;
    try {
      const cloneDefaults = await getCampaignCloneDefaults(campaignId);
      if (cloneDefaults.budget != null) {
        budget = cloneDefaults.budget;
      }
      if (cloneDefaults.bid != null) {
        bid = cloneDefaults.bid;
      }
    } catch (error) {
      console.error(`Không lấy được ngân sách/thầu hiện tại cho camp ${campaignId}:`, error);
    }

    const budgetText = formatCommandNumber(budget);
    const bidText = formatCommandNumber(bid);
    await ctx.reply(`Ví dụ nhân bản 3 camp, ngân sách $${budgetText}, thầu $${bidText}:\n<code>/xcamp ${campaignId} 3 ${budgetText} ${bidText}</code>`, { parse_mode: 'HTML' });
  });

  bot.command('campaigns', (ctx) => void handleCampaignsRequest(ctx));
  bot.command('reload', (ctx) => void handleReloadRequest(ctx));

  // ── /on <campaign_id> — Bật quảng cáo trong chiến dịch ───────────────────
  bot.command('on', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('❌ Chỉ admin mới có thể thực hiện hành động này.');
      return;
    }

    const args = ctx.message?.text.split(/\s+/);
    if (!args || args.length < 2) {
      await ctx.reply('❌ Vui lòng cung cấp ID chiến dịch.\nVí dụ: /on 12345');
      return;
    }

    const campaignId = args[1];
    try {
      const result = await setCampaignAdsStatusByCampaignId(campaignId, 'ENABLE');
      await ctx.reply(`✅ Đã bật <b>${result.adIds.length}</b> quảng cáo trong camp <code>${escapeHtml(campaignId)}</code>.`, { parse_mode: 'HTML' });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Không thể bật quảng cáo trong camp <code>${escapeHtml(campaignId)}</code>:\n${escapeHtml(errMsg)}`, { parse_mode: 'HTML' });
    }
  });

  // ── /off <campaign_id> — Tắt quảng cáo trong chiến dịch ──────────────────
  bot.command('off', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('❌ Chỉ admin mới có thể thực hiện hành động này.');
      return;
    }

    const args = ctx.message?.text.split(/\s+/);
    if (!args || args.length < 2) {
      await ctx.reply('❌ Vui lòng cung cấp ID chiến dịch.\nVí dụ: /off 12345');
      return;
    }

    const campaignId = args[1];
    try {
      const result = await setCampaignAdsStatusByCampaignId(campaignId, 'DISABLE');
      await ctx.reply(`⏸ Đã tắt <b>${result.adIds.length}</b> quảng cáo trong camp <code>${escapeHtml(campaignId)}</code>.`, { parse_mode: 'HTML' });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Không thể tắt quảng cáo trong camp <code>${escapeHtml(campaignId)}</code>:\n${escapeHtml(errMsg)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('xcamp', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('❌ Chỉ admin mới có thể thực hiện hành động này.');
      return;
    }

    const args = ctx.message?.text.split(/\s+/);
    if (!args || args.length < 2) {
      await ctx.reply('❌ Vui lòng cung cấp ID chiến dịch để nhân bản.\nVí dụ: /xcamp 12345 3 20 0.5');
      return;
    }

    const campaignId = args[1];
    const quantity = Math.max(1, parseInt(args[2]) || 1);
    const budget = parseOptionalPositiveNumberArg(args[3]);
    const bid = parseOptionalPositiveNumberArg(args[4]);
    const chatId = ctx.chat?.id;

    if (Number.isNaN(budget) || Number.isNaN(bid)) {
      await ctx.reply('❌ Ngân sách và giá thầu phải là số lớn hơn 0.\nVí dụ: /xcamp 12345 3 20 0.5');
      return;
    }

    const position = (isDuplicatingCampaigns ? 1 : 0) + xcampQueue.length + 1;
    const waitMessage = await ctx.reply(
      position === 1
        ? `⏳ Đã nhận lệnh nhân bản <b>${quantity}</b> chiến dịch từ gốc <code>${escapeHtml(campaignId)}</code>.`
        : `⏳ Đã thêm vào hàng đợi /xcamp.\nVị trí chờ: <b>${position}</b>\nCamp gốc: <code>${escapeHtml(campaignId)}</code> · Số lượng: <b>${quantity}</b>`,
      { parse_mode: 'HTML' }
    );

    xcampQueue.push({
      ctx,
      waitMessageId: waitMessage.message_id,
      chatId,
      campaignId,
      quantity,
      budget,
      bid,
    });

    void processXcampQueue();
  });

  bot.on('text', (ctx) => {
    void (async () => {
      if (await handleMainMenuButton(ctx)) {
        return;
      }

      if (await handlePendingSettingText(ctx)) {
        return;
      }

      await ctx.reply('Tôi không hiểu lệnh này. Bấm /start để mở menu.', MAIN_MENU_KEYBOARD);
    })();
  });
}
