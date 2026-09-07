import type { Telegraf } from 'telegraf';
import { getCampaignCloneCountMap } from '../campaigns/clone-tracking.js';
import { parseMaterialDetailCallbackData } from '../materials/callbacks.js';
import { getTodaySpentCampaigns, type TikTokSpentCampaign } from '../tiktok/api.js';

const BATCH_IDLE_MS = 10_000;
const BATCH_MAX_WAIT_MS = 25_000;
const MAX_CAMPAIGNS_IN_MESSAGE = 10;
const MAX_DETAILS_PER_CAMPAIGN = 4;
const DETAIL_BUTTONS_PER_ROW = 5;

interface ParsedAutoAction {
  campaignLine: string;
  campaignId?: string;
  advertiserId?: string;
  pauseSuccess: number;
  activeSuccess: number;
  unverified: number;
  details: string[];
  detailButton?: Record<string, unknown>;
}

interface PendingBatch {
  firstAt: number;
  items: ParsedAutoAction[];
  timer?: NodeJS.Timeout;
}

interface CampaignDisplayData {
  reportLine: string;
  advertiserId: string;
  advertiserName?: string;
}

function isMaterialAutoActionText(text: string): boolean {
  return /^🤖\s*<b>Material Rule Auto<\/b>/i.test(text.trim());
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function findMaterialDetailButton(replyMarkup: unknown): Record<string, unknown> | undefined {
  if (!replyMarkup || typeof replyMarkup !== 'object') return undefined;
  const keyboard = (replyMarkup as { inline_keyboard?: Array<Array<Record<string, unknown>>> }).inline_keyboard;
  if (!Array.isArray(keyboard)) return undefined;

  return keyboard
    .flat()
    .find(button => String(button?.callback_data || '').startsWith('md:'));
}

function extractCampaignId(campaignLine: string): string | undefined {
  return campaignLine.match(/<code>(\d{10,})<\/code>/)?.[1];
}

function getCampaignDisplayName(campaignName: string): string {
  const parts = String(campaignName || '')
    .split(' - ')
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]} - ${parts[1]}`;
  }

  return String(campaignName || '').trim();
}

function normalizeCampaignLine(campaignLine: string): string {
  const match = campaignLine.match(/^<b>(.*?)<\/b>\s*-\s*<code>(\d{10,})<\/code>\s*$/);
  if (!match) return campaignLine;

  return `<b>${getCampaignDisplayName(match[1])}</b> - <code>${match[2]}</code>`;
}

function getAccountLabel(advertiserName: string | undefined, advertiserId: string | undefined): string {
  const accountName = String(advertiserName || '').trim();
  const aaNumberMatch = accountName.match(/\bAA\s*(\d+)\b/i);

  if (aaNumberMatch?.[1]) {
    return aaNumberMatch[1].padStart(2, '0');
  }

  return accountName || String(advertiserId || '').trim();
}

function formatCampaignReportLine(campaign: TikTokSpentCampaign): string {
  return `💸 $${campaign.spend.toFixed(2)} · ` +
    `👆 ${campaign.clicks.toLocaleString()}/${campaign.ctr.toFixed(2)}% · ` +
    `🎯 ${campaign.conversions.toLocaleString()} · ` +
    `💰 $${campaign.cpa.toFixed(2)}`;
}

async function getCampaignDisplayDataMap(items: ParsedAutoAction[]): Promise<Map<string, CampaignDisplayData>> {
  const targetCampaignIds = new Set(
    items
      .map(item => item.campaignId)
      .filter((campaignId): campaignId is string => Boolean(campaignId))
  );

  if (targetCampaignIds.size === 0) {
    return new Map();
  }

  try {
    const campaigns = await getTodaySpentCampaigns();
    const displayData = new Map<string, CampaignDisplayData>();

    for (const campaign of campaigns) {
      if (!targetCampaignIds.has(campaign.campaign_id)) continue;
      displayData.set(campaign.campaign_id, {
        reportLine: formatCampaignReportLine(campaign),
        advertiserId: campaign.advertiser_id,
        advertiserName: campaign.advertiser_name,
      });
    }

    return displayData;
  } catch (error) {
    // Feedback kết quả action phải vẫn được gửi dù report refresh tạm lỗi.
    console.warn('[MaterialAutoActionFeedback] campaign summary refresh failed:', error);
    return new Map();
  }
}

function parseAutoActionPayload(payload: unknown): ParsedAutoAction | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const source = payload as Record<string, unknown>;
  if (String(source.parse_mode || '').toUpperCase() !== 'HTML' || typeof source.text !== 'string') {
    return undefined;
  }

  const text = source.text;
  if (!isMaterialAutoActionText(text)) return undefined;
  const lines = text.split('\n');
  if (lines.length < 3) return undefined;

  const campaignLine = lines[1] || '';
  const resultLines = lines.slice(2).filter(Boolean);
  const detailButton = findMaterialDetailButton(source.reply_markup);
  const detailCallback = String(detailButton?.callback_data || '');
  const detailRef = detailCallback ? parseMaterialDetailCallbackData(detailCallback) : undefined;
  let pauseSuccess = 0;
  let activeSuccess = 0;
  let unverified = 0;

  const details = resultLines.map(line => {
    const isVerified = line.startsWith('✅');
    const isPause = /\sTẮT\s/.test(line);
    const isActive = /\sBẬT\s/.test(line);

    if (isVerified && isPause) pauseSuccess += 1;
    if (isVerified && isActive) activeSuccess += 1;
    if (!isVerified) unverified += 1;

    return line
      .replace(/^✅\s*/, isPause ? '⏸ ' : isActive ? '▶️ ' : '✅ ')
      .replace(/^⚠️\s*/, '⚠️ ')
      .replace(/\sTẮT\s·/, ' ·')
      .replace(/\sBẬT\s·/, ' ·');
  });

  return {
    campaignLine: normalizeCampaignLine(campaignLine),
    campaignId: extractCampaignId(campaignLine),
    advertiserId: detailRef?.advertiserId,
    pauseSuccess,
    activeSuccess,
    unverified,
    details,
    detailButton,
  };
}

async function buildGroupedMessage(
  items: ParsedAutoAction[],
  campaignDisplayData: Map<string, CampaignDisplayData>
) {
  const pauseSuccess = items.reduce((sum, item) => sum + item.pauseSuccess, 0);
  const activeSuccess = items.reduce((sum, item) => sum + item.activeSuccess, 0);
  const unverified = items.reduce((sum, item) => sum + item.unverified, 0);
  const pauseCampaigns = items.filter(item => item.pauseSuccess > 0).length;
  const activeCampaigns = items.filter(item => item.activeSuccess > 0).length;
  const unverifiedCampaigns = items.filter(item => item.unverified > 0).length;

  const headerLines: string[] = [];
  if (pauseSuccess > 0 && activeSuccess === 0 && unverified === 0) {
    headerLines.push(`✅ <b>Pause thành công</b> (${pauseSuccess} material · ${pauseCampaigns} camp)`);
  } else if (activeSuccess > 0 && pauseSuccess === 0 && unverified === 0) {
    headerLines.push(`✅ <b>Active thành công</b> (${activeSuccess} material · ${activeCampaigns} camp)`);
  } else {
    headerLines.push('🤖 <b>Ruler material tự động</b>');
    if (pauseSuccess > 0) {
      headerLines.push(`✅ <b>Pause thành công</b>: ${pauseSuccess} material · ${pauseCampaigns} camp`);
    }
    if (activeSuccess > 0) {
      headerLines.push(`✅ <b>Active thành công</b>: ${activeSuccess} material · ${activeCampaigns} camp`);
    }
    if (unverified > 0) {
      headerLines.push(`⚠️ <b>Chưa xác minh</b>: ${unverified} material · ${unverifiedCampaigns} camp`);
    }
  }

  const visibleItems = items.slice(0, MAX_CAMPAIGNS_IN_MESSAGE);
  const cloneCountByCampaignId = await getCampaignCloneCountMap(
    visibleItems
      .map(item => item.campaignId)
      .filter((campaignId): campaignId is string => Boolean(campaignId))
  );
  const detailLines: string[] = [];
  const buttons: Record<string, unknown>[] = [];

  visibleItems.forEach((item, index) => {
    const displayData = item.campaignId
      ? campaignDisplayData.get(item.campaignId)
      : undefined;
    const advertiserId = item.advertiserId || displayData?.advertiserId;
    const accountLabel = getAccountLabel(displayData?.advertiserName, advertiserId);
    const accountSuffix = accountLabel ? ` · ${accountLabel}` : '';
    const cloneCount = item.campaignId
      ? cloneCountByCampaignId.get(item.campaignId) || 0
      : 0;

    detailLines.push(
      '',
      `<b>${index + 1}.</b> ${item.campaignLine}${accountSuffix} · 🚀 x${cloneCount}`
    );

    if (displayData?.reportLine) {
      detailLines.push(displayData.reportLine);
    }

    const visibleDetails = item.details.slice(0, MAX_DETAILS_PER_CAMPAIGN);
    detailLines.push(...visibleDetails);
    const hiddenDetails = item.details.length - visibleDetails.length;
    if (hiddenDetails > 0) {
      detailLines.push(`… +${hiddenDetails} material khác`);
    }

    if (item.detailButton) {
      buttons.push({
        ...item.detailButton,
        text: `🔎 ${index + 1}`,
      });
    }
  });

  const hiddenCampaigns = items.length - visibleItems.length;
  if (hiddenCampaigns > 0) {
    detailLines.push('', `… +${hiddenCampaigns} camp khác trong cùng lượt ruler`);
  }

  return {
    text: [...headerLines, ...detailLines].join('\n'),
    replyMarkup: buttons.length > 0
      ? { inline_keyboard: chunkArray(buttons, DETAIL_BUTTONS_PER_ROW) }
      : undefined,
  };
}

function getBatchKey(payload: Record<string, unknown>): string {
  return String(payload.chat_id ?? 'default');
}

function buildBufferedResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const numericChatId = Number(payload.chat_id);
  return {
    message_id: -1,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number.isFinite(numericChatId) ? numericChatId : 0,
      type: 'private',
    },
    text: typeof payload.text === 'string' ? payload.text : '',
  };
}

/**
 * Gom các kết quả Pause/Active tự động của material trong cùng một đợt chạy ruler
 * thành một thông báo Telegram duy nhất thay vì mỗi campaign gửi một message.
 *
 * Batching chỉ tác động presentation Telegram của payload `Material Rule Auto`:
 * - không đổi rule, mapping hay TikTok write API;
 * - tên campaign giữ format gọn cũ: `<sản phẩm> - <market>` + campaign_id;
 * - mỗi campaign hiển thị account số ngắn kiểu `32` + clone count `🚀 xN` giống alert ADS đạt điều kiện;
 * - mỗi campaign hiển thị thêm report tổng hôm nay: spend / click+CTR / conversion / CPA;
 * - mỗi campaign vẫn giữ nút chi tiết riêng, hiển thị thành `🔎 1`, `🔎 2`, ...;
 * - chờ tối đa 25 giây và flush sau 10 giây không có result mới để gom nhiều camp;
 * - giới hạn phần chi tiết để tránh vượt Telegram message limit.
 */
export function setupMaterialAutoActionFeedback(bot: Telegraf): void {
  const telegram = bot.telegram as any;
  const originalCallApi = telegram.callApi.bind(telegram);
  const pendingByChat = new Map<string, PendingBatch>();

  const flushBatch = async (batchKey: string): Promise<void> => {
    const batch = pendingByChat.get(batchKey);
    if (!batch) return;
    pendingByChat.delete(batchKey);
    if (batch.timer) clearTimeout(batch.timer);
    if (batch.items.length === 0) return;

    const campaignDisplayData = await getCampaignDisplayDataMap(batch.items);
    const grouped = await buildGroupedMessage(batch.items, campaignDisplayData);
    const firstItemPayload = (batch as PendingBatch & { payload?: Record<string, unknown> }).payload;
    if (!firstItemPayload) return;

    const nextPayload: Record<string, unknown> = {
      ...firstItemPayload,
      text: grouped.text,
    };
    if (grouped.replyMarkup) {
      nextPayload.reply_markup = grouped.replyMarkup;
    } else {
      delete nextPayload.reply_markup;
    }

    try {
      await originalCallApi('sendMessage', nextPayload);
    } catch (error) {
      console.error('[MaterialAutoActionFeedback] grouped notification failed:', error);
    }
  };

  telegram.callApi = async (method: unknown, payload: unknown, ...rest: unknown[]) => {
    if (String(method) !== 'sendMessage' || !payload || typeof payload !== 'object') {
      return originalCallApi(method, payload, ...rest);
    }

    const source = payload as Record<string, unknown>;
    const parsed = parseAutoActionPayload(source);
    if (!parsed) {
      return originalCallApi(method, payload, ...rest);
    }

    const batchKey = getBatchKey(source);
    const now = Date.now();
    const existing = pendingByChat.get(batchKey) as (PendingBatch & { payload?: Record<string, unknown> }) | undefined;
    const batch: PendingBatch & { payload?: Record<string, unknown> } = existing || {
      firstAt: now,
      items: [],
      payload: source,
    };

    batch.items.push(parsed);
    batch.payload ||= source;
    if (batch.timer) clearTimeout(batch.timer);

    const maxRemaining = Math.max(0, BATCH_MAX_WAIT_MS - (now - batch.firstAt));
    const waitMs = Math.min(BATCH_IDLE_MS, maxRemaining);
    batch.timer = setTimeout(() => void flushBatch(batchKey), waitMs);
    pendingByChat.set(batchKey, batch);

    return buildBufferedResponse(source);
  };
}
