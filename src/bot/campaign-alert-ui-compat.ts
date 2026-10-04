import type { Telegraf } from 'telegraf';
import { getAdvertiserTrackingStates } from '../accounts/tracking.js';
import { getCampaignCloneCountMap } from '../campaigns/clone-tracking.js';
import { parseMaterialDetailCallbackData } from '../materials/callbacks.js';

const BATCH_IDLE_MS = 1_500;
const BATCH_MAX_WAIT_MS = 5_000;
const MAX_CAMPAIGNS_IN_MESSAGE = 20;
const DETAIL_BUTTONS_PER_ROW = 5;

type CampaignCondition = 'đạt điều kiện' | 'vượt giới hạn';

interface ParsedCampaignAlert {
  condition: CampaignCondition;
  campaignName: string;
  campaignId: string;
  advertiserId?: string;
  metricsLine: string;
  detailButton?: Record<string, unknown>;
}

interface PendingCampaignBatch {
  firstAt: number;
  items: Map<string, ParsedCampaignAlert>;
  payload: Record<string, unknown>;
  condition: CampaignCondition;
  timer?: NodeJS.Timeout;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCampaignDisplayName(campaignName: string): string {
  // Tên campaign mới phân tách bằng " · ", bản cũ dùng " - ". Giữ 3 dữ liệu đầu.
  const value = String(campaignName || '').trim();
  for (const separator of [' · ', ' - ']) {
    const parts = value.split(separator).map(part => part.trim()).filter(Boolean);
    if (parts.length >= 3) return parts.slice(0, 3).join(separator);
    if (parts.length > 1) return parts.join(separator);
  }
  return value;
}

function getAccountLabel(advertiserName: string | undefined, advertiserId: string | undefined): string {
  const accountName = String(advertiserName || '').trim();
  const aaNumberMatch = accountName.match(/\bAA\s*(\d+)\b/i);

  if (aaNumberMatch?.[1]) {
    return aaNumberMatch[1].padStart(2, '0');
  }

  return accountName || String(advertiserId || '').trim();
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function findMaterialDetailButtons(replyMarkup: unknown): Record<string, unknown>[] {
  if (!replyMarkup || typeof replyMarkup !== 'object') return [];
  const keyboard = (replyMarkup as { inline_keyboard?: Array<Array<Record<string, unknown>>> }).inline_keyboard;
  if (!Array.isArray(keyboard)) return [];

  return keyboard
    .flat()
    .filter(button => String(button?.callback_data || '').startsWith('md:'));
}

/**
 * Parse message "🔔 Campaign đạt điều kiện / vượt giới hạn" theo format nhóm MKT mới:
 * heading, dòng điều kiện (📏 …), rồi các khối "— MKT —" + "<b>camp</b> - <code>id</code>" + dòng metrics.
 * Trả về danh sách campaign (mỗi camp một item, nút md: gán theo thứ tự).
 */
function parseCampaignAlertPayload(payload: unknown): ParsedCampaignAlert[] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const source = payload as Record<string, unknown>;
  if (String(source.parse_mode || '').toUpperCase() !== 'HTML' || typeof source.text !== 'string') {
    return undefined;
  }

  const lines = source.text.split('\n');
  if (lines.length < 3) return undefined;

  const headingMatch = lines[0]?.match(/^🔔\s*<b>Campaign\s+(đạt điều kiện|vượt giới hạn)<\/b>\s*$/i);
  if (!headingMatch) return undefined;

  const condition = headingMatch[1].toLowerCase() as CampaignCondition;
  const detailButtons = findMaterialDetailButtons(source.reply_markup);
  const detailCallback = String(detailButtons[0]?.callback_data || '');
  const detailRef = detailCallback ? parseMaterialDetailCallbackData(detailCallback) : undefined;

  const items: ParsedCampaignAlert[] = [];
  for (let index = 1; index < lines.length; index++) {
    const campaignMatch = lines[index]?.match(/^<b>(.*?)<\/b>\s*-\s*<code>(\d{10,})<\/code>\s*$/);
    if (!campaignMatch) continue;
    const metricsLine = (lines[index + 1] || '').startsWith('💵') ? lines[index + 1] : '';
    items.push({
      condition,
      campaignName: getCampaignDisplayName(campaignMatch[1]),
      campaignId: campaignMatch[2],
      advertiserId: detailRef?.advertiserId,
      metricsLine,
      detailButton: detailButtons[items.length],
    });
  }

  return items.length > 0 ? items : undefined;
}

async function buildGroupedCampaignMessage(items: ParsedCampaignAlert[], condition: CampaignCondition) {
  const visibleItems = items.slice(0, MAX_CAMPAIGNS_IN_MESSAGE);
  const buttons: Record<string, unknown>[] = [];

  const advertiserIds = [...new Set(
    visibleItems
      .map(item => item.advertiserId)
      .filter((id): id is string => Boolean(id))
  )];

  const [trackingStates, cloneCountByCampaignId] = await Promise.all([
    getAdvertiserTrackingStates(advertiserIds.map(advertiserId => ({ advertiserId }))),
    getCampaignCloneCountMap(visibleItems.map(item => item.campaignId)),
  ]);

  const accountNameById = new Map(
    trackingStates.map(state => [state.advertiserId, state.advertiserName])
  );

  const heading = condition === 'vượt giới hạn'
    ? `<b>⚠️ ADS Vượt Giới Hạn (${items.length} camp)</b>`
    : `<b>✅ ADS Đạt Điều Kiện (${items.length} camp)</b>`;
  const lines: string[] = [heading];

  visibleItems.forEach((item, index) => {
    const accountLabel = getAccountLabel(
      item.advertiserId ? accountNameById.get(item.advertiserId) : undefined,
      item.advertiserId
    );
    const accountSuffix = accountLabel ? ` · ${escapeHtml(accountLabel)}` : '';
    const cloneCount = cloneCountByCampaignId.get(item.campaignId) || 0;
    const metricsLine = item.metricsLine.replace(/^💵\s*/, '💸 ');

    lines.push(
      `<b>${index + 1}. ${escapeHtml(item.campaignName)}</b> - <code>${escapeHtml(item.campaignId)}</code>${accountSuffix} · 🚀 x${cloneCount}`,
      metricsLine
    );

    if (item.detailButton) {
      buttons.push({
        ...item.detailButton,
        text: items.length === 1 ? '🔎 Chi tiết camp' : `🔎 ${index + 1}`,
      });
    }
  });

  const hiddenCampaigns = items.length - visibleItems.length;
  if (hiddenCampaigns > 0) {
    lines.push(`… +${hiddenCampaigns} camp khác trong cùng cảnh báo`);
  }

  return {
    text: lines.join('\n'),
    replyMarkup: buttons.length > 0
      ? { inline_keyboard: chunkArray(buttons, DETAIL_BUTTONS_PER_ROW) }
      : undefined,
  };
}

function getBatchKey(payload: Record<string, unknown>, condition: CampaignCondition): string {
  return `${String(payload.chat_id ?? 'default')}:${condition}`;
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
 * Presentation compatibility cho campaign Level 1:
 * - parse message nhóm MKT mới (heading + 📏 điều kiện + các khối "— MKT —" + camp);
 * - "đạt điều kiện" hiển thị "✅ ADS Đạt Điều Kiện (N camp)";
 * - "vượt giới hạn" (rule notify gt/gte) hiển thị "⚠️ ADS Vượt Giới Hạn (N camp)";
 * - các camp trong cùng lượt được gom thành một message, dedupe theo campaign id;
 * - khôi phục format cũ: account số ngắn kiểu `32` và clone count `🚀 xN`;
 * - giữ dòng metrics và callback `Chi tiết camp`;
 * - không thay đổi quyết định material rule hay TikTok write API.
 */
export function setupCampaignAlertUiCompatibility(bot: Telegraf): void {
  const telegram = bot.telegram as any;
  const originalCallApi = telegram.callApi.bind(telegram);
  const pendingByKey = new Map<string, PendingCampaignBatch>();

  const flushBatch = async (batchKey: string): Promise<void> => {
    const batch = pendingByKey.get(batchKey);
    if (!batch) return;
    pendingByKey.delete(batchKey);
    if (batch.timer) clearTimeout(batch.timer);

    const items = [...batch.items.values()];
    if (items.length === 0) return;

    try {
      const grouped = await buildGroupedCampaignMessage(items, batch.condition);
      const nextPayload: Record<string, unknown> = {
        ...batch.payload,
        text: grouped.text,
      };

      if (grouped.replyMarkup) {
        nextPayload.reply_markup = grouped.replyMarkup;
      } else {
        delete nextPayload.reply_markup;
      }

      await originalCallApi('sendMessage', nextPayload);
    } catch (error) {
      console.error('[CampaignAlertUiCompatibility] grouped campaign notification failed:', error);
    }
  };

  telegram.callApi = async (method: unknown, payload: unknown, ...rest: unknown[]) => {
    if (String(method) !== 'sendMessage' || !payload || typeof payload !== 'object') {
      return originalCallApi(method, payload, ...rest);
    }

    const source = payload as Record<string, unknown>;
    const parsedItems = parseCampaignAlertPayload(source);
    if (!parsedItems) {
      return originalCallApi(method, payload, ...rest);
    }

    const condition = parsedItems[0].condition;
    const batchKey = getBatchKey(source, condition);
    const now = Date.now();
    const existing = pendingByKey.get(batchKey);
    const batch: PendingCampaignBatch = existing || {
      firstAt: now,
      items: new Map<string, ParsedCampaignAlert>(),
      payload: source,
      condition,
    };

    // Một camp có thể đồng thời match nhiều rule đạt điều kiện. Chỉ hiển thị camp đó một lần.
    parsedItems.forEach(item => batch.items.set(item.campaignId, item));
    if (batch.timer) clearTimeout(batch.timer);

    const maxRemaining = Math.max(0, BATCH_MAX_WAIT_MS - (now - batch.firstAt));
    const waitMs = Math.min(BATCH_IDLE_MS, maxRemaining);
    batch.timer = setTimeout(() => {
      void flushBatch(batchKey).catch(error => {
        console.error('[CampaignAlertUiCompatibility] unhandled flush failure:', error);
      });
    }, waitMs);
    pendingByKey.set(batchKey, batch);

    return buildBufferedResponse(source);
  };
}
