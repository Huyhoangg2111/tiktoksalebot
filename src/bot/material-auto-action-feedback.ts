import type { Telegraf } from 'telegraf';
import { getCampaignCloneCountMap } from '../campaigns/clone-tracking.js';
import { db } from '../db/index.js';
import { parseMaterialDetailCallbackData } from '../materials/callbacks.js';
import {
  getCampaignMaterialSnapshot,
  getSmartPlusAdsByIds,
  getSmartPlusAdsForAdvertiser,
  getVietnamDateKey,
} from '../materials/service.js';
import { getTodaySpentCampaigns, type TikTokSpentCampaign } from '../tiktok/api.js';

const BATCH_IDLE_MS = 10_000;
const BATCH_MAX_WAIT_MS = 25_000;
const MAX_CAMPAIGNS_IN_MESSAGE = 10;
const MAX_DETAILS_PER_CAMPAIGN = 4;
const DETAIL_BUTTONS_PER_ROW = 5;
const CAMPAIGN_MATERIAL_DISPLAY_CACHE_TTL_MS = 10_000;

type CampaignMaterialDisplayStatus = 'active' | 'paused' | 'mixed';
type CampaignDisplayStatus = CampaignMaterialDisplayStatus | 'deleted';
type MaterialOperationStatus = 'ENABLE' | 'DISABLE';

interface ParsedAutoAction {
  campaignLine: string;
  campaignId?: string;
  advertiserId?: string;
  mkt?: string;
  pauseSuccess: number;
  activeSuccess: number;
  unverified: number;
  details: string[];
  detailButton?: Record<string, unknown>;
}

interface PendingBatch {
  firstAt: number;
  items: ParsedAutoAction[];
  payload?: Record<string, unknown>;
  timer?: NodeJS.Timeout;
}

interface CampaignDisplayData {
  reportLine: string;
  advertiserId: string;
  advertiserName?: string;
}

interface SpentCampaignStatusRow {
  advertiser_id: string;
  campaign_id: string;
  status?: string | null;
}

interface LocalMaterialOperationRow {
  advertiser_id: string;
  smart_plus_ad_id: string;
  ad_material_id: string;
  operation_status: string;
  confirmed_at_ms?: number | null;
}

interface CampaignMaterialDisplaySnapshot {
  byCampaignId: Map<string, CampaignMaterialDisplayStatus>;
  materialCountsByCampaignId: Map<string, { active: number; paused: number }>;
  allMaterialCountsByCampaignId: Map<string, { active: number; paused: number }>;
  campaignRows: SpentCampaignStatusRow[];
}

let campaignMaterialDisplayCache:
  | {
    expiresAt: number;
    snapshot: CampaignMaterialDisplaySnapshot;
  }
  | undefined;

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

function extractCampaignId(campaignLine: string): string | undefined {
  return campaignLine.match(/<code>(\d{10,})<\/code>/)?.[1];
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

function normalizeMaterialOperationStatus(value: unknown): MaterialOperationStatus | 'UNKNOWN' {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'ENABLE' || normalized === 'DISABLE') return normalized;
  return 'UNKNOWN';
}

function getCreativeMaterialStatus(creative: any): MaterialOperationStatus | 'UNKNOWN' {
  const candidates = [
    creative?.material_operation_status,
    creative?.operation_status,
    creative?.status,
    creative?.material_status,
    creative?.creative_status,
    creative?.creative_info?.material_operation_status,
    creative?.creative_info?.operation_status,
    creative?.creative_info?.status,
  ];

  for (const candidate of candidates) {
    const status = normalizeMaterialOperationStatus(candidate);
    if (status !== 'UNKNOWN') return status;
  }

  return 'UNKNOWN';
}

function normalizeStoredCampaignStatus(value: unknown): CampaignDisplayStatus {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('delete') || normalized.includes('remove')) return 'deleted';
  if (
    normalized.includes('pause') ||
    normalized.includes('disable') ||
    normalized.includes('suspend') ||
    normalized.includes('offline')
  ) {
    return 'paused';
  }
  return 'active';
}

function materialStateKey(advertiserId: string, smartPlusAdId: string, adMaterialId: string): string {
  return `${advertiserId}:${smartPlusAdId}:${adMaterialId}`;
}

async function getCampaignMaterialDisplaySnapshot(
  forceRefresh = false,
  sourceCampaigns?: TikTokSpentCampaign[]
): Promise<CampaignMaterialDisplaySnapshot> {
  const now = Date.now();
  if (
    !sourceCampaigns &&
    !forceRefresh &&
    campaignMaterialDisplayCache?.expiresAt &&
    campaignMaterialDisplayCache.expiresAt > now
  ) {
    return campaignMaterialDisplayCache.snapshot;
  }

  const dateKey = getVietnamDateKey();
  const campaignRows: SpentCampaignStatusRow[] = sourceCampaigns
    ? sourceCampaigns.map(campaign => ({
      advertiser_id: campaign.advertiser_id,
      campaign_id: campaign.campaign_id,
      status: campaign.status,
    }))
    : await db.all<SpentCampaignStatusRow>(
      `SELECT advertiser_id, campaign_id, status
       FROM spent_campaign_cache
       WHERE date_key = ?`,
      [dateKey]
    );
  const campaignIds = new Set(campaignRows.map(row => String(row.campaign_id || '')).filter(Boolean));
  const advertiserIds = [...new Set(campaignRows.map(row => String(row.advertiser_id || '')).filter(Boolean))];
  const spentMaterialKeys = new Set<string>();
  let materialSpendDataAvailable = false;

  // Chỉ đếm Material có chi tiêu trong cùng ngày với danh sách campaign.
  // Trạng thái của Material không phát sinh chi tiêu không được đưa vào tổng.
  const materialSnapshots = await Promise.allSettled(campaignRows.map(row =>
    getCampaignMaterialSnapshot(row.advertiser_id, row.campaign_id, undefined, dateKey, dateKey)
  ));
  materialSnapshots.forEach(result => {
    if (result.status !== 'fulfilled') return;
    materialSpendDataAvailable = true;
    result.value.materials
      .filter(material => Number(material.spend) > 0)
      .forEach(material => spentMaterialKeys.add(
        `${material.advertiserId}:${material.campaignId}:${material.smartPlusAdId}:${material.adMaterialId}`
      ));
  });

  let localRows: LocalMaterialOperationRow[] = [];
  try {
    localRows = await db.all<LocalMaterialOperationRow>(
      `SELECT advertiser_id, smart_plus_ad_id, ad_material_id, operation_status, confirmed_at_ms
       FROM material_operation_state`
    );
  } catch {
    // Bảng này được tạo lazy ở material service; chưa có bảng nghĩa là chưa từng có write material.
  }

  const localStateByKey = new Map(
    localRows.map(row => [
      materialStateKey(row.advertiser_id, row.smart_plus_ad_id, row.ad_material_id),
      row,
    ])
  );
  const operationStatusesByCampaignId = new Map<string, Set<MaterialOperationStatus>>();
  const materialCountsByCampaignId = new Map<string, { active: number; paused: number; seen: Set<string> }>();
  const allMaterialCountsByCampaignId = new Map<string, { active: number; paused: number; seen: Set<string> }>();

  await Promise.all(advertiserIds.map(async advertiserId => {
    try {
      const ads = await getSmartPlusAdsForAdvertiser(advertiserId);
      const missingDetailIds = ads
        .filter(ad => {
          const campaignId = String(ad?.campaign_id || '').trim();
          const creatives = Array.isArray(ad?.creative_list) ? ad.creative_list : [];
          return campaignIds.has(campaignId) && creatives.length === 0;
        })
        .map(ad => String(ad?.smart_plus_ad_id || '').trim())
        .filter(Boolean);
      const detailedAds = await getSmartPlusAdsByIds(advertiserId, missingDetailIds);
      const detailBySmartPlusAdId = new Map(
        detailedAds.map(ad => [String(ad?.smart_plus_ad_id || '').trim(), ad])
      );

      for (const listedAd of ads) {
        const listedSmartPlusAdId = String(listedAd?.smart_plus_ad_id || '').trim();
        const ad = detailBySmartPlusAdId.get(listedSmartPlusAdId) || listedAd;
        const campaignId = String(ad?.campaign_id || listedAd?.campaign_id || '').trim();
        if (!campaignId || !campaignIds.has(campaignId)) continue;

        const smartPlusAdId = String(ad?.smart_plus_ad_id || '').trim();
        const creatives = Array.isArray(ad?.creative_list) ? ad.creative_list : [];
        if (!smartPlusAdId || creatives.length === 0) continue;

        const statuses = operationStatusesByCampaignId.get(campaignId) || new Set<MaterialOperationStatus>();

        for (const creative of creatives) {
          const adMaterialId = String(creative?.ad_material_id || '').trim();
          if (!adMaterialId) continue;

          const apiStatus = getCreativeMaterialStatus(creative);
          const localState = localStateByKey.get(materialStateKey(advertiserId, smartPlusAdId, adMaterialId));
          const localStatus = normalizeMaterialOperationStatus(localState?.operation_status);
          const effectiveStatus = localState && !localState.confirmed_at_ms && localStatus !== 'UNKNOWN'
            ? localStatus
            : apiStatus !== 'UNKNOWN'
              ? apiStatus
              : localStatus;

          if (effectiveStatus === 'ENABLE' || effectiveStatus === 'DISABLE') {
            const materialKey = `${smartPlusAdId}:${adMaterialId}`;
            const allCounts = allMaterialCountsByCampaignId.get(campaignId) || {
              active: 0,
              paused: 0,
              seen: new Set<string>(),
            };
            if (!allCounts.seen.has(materialKey)) {
              allCounts.seen.add(materialKey);
              if (effectiveStatus === 'ENABLE') allCounts.active += 1;
              if (effectiveStatus === 'DISABLE') allCounts.paused += 1;
            }
            allMaterialCountsByCampaignId.set(campaignId, allCounts);

            const materialSpendKey = `${advertiserId}:${campaignId}:${smartPlusAdId}:${adMaterialId}`;
            if (materialSpendDataAvailable && !spentMaterialKeys.has(materialSpendKey)) continue;
            statuses.add(effectiveStatus);
            const counts = materialCountsByCampaignId.get(campaignId) || {
              active: 0,
              paused: 0,
              seen: new Set<string>(),
            };
            if (!counts.seen.has(materialKey)) {
              counts.seen.add(materialKey);
              if (effectiveStatus === 'ENABLE') counts.active += 1;
              if (effectiveStatus === 'DISABLE') counts.paused += 1;
            }
            materialCountsByCampaignId.set(campaignId, counts);
          }
        }

        if (statuses.size > 0) {
          operationStatusesByCampaignId.set(campaignId, statuses);
        }
      }
    } catch (error) {
      console.warn(`[CampaignMaterialStatus] advertiser=${advertiserId} status refresh failed:`, error);
    }
  }));

  const byCampaignId = new Map<string, CampaignMaterialDisplayStatus>();
  for (const [campaignId, statuses] of operationStatusesByCampaignId.entries()) {
    if (statuses.size > 1) {
      byCampaignId.set(campaignId, 'mixed');
    } else if (statuses.has('DISABLE')) {
      byCampaignId.set(campaignId, 'paused');
    } else if (statuses.has('ENABLE')) {
      byCampaignId.set(campaignId, 'active');
    }
  }

  const normalizedMaterialCounts = new Map(
    [...materialCountsByCampaignId.entries()].map(([campaignId, counts]) => [
      campaignId,
      { active: counts.active, paused: counts.paused },
    ])
  );
  const normalizedAllMaterialCounts = new Map(
    [...allMaterialCountsByCampaignId.entries()].map(([campaignId, counts]) => [
      campaignId,
      { active: counts.active, paused: counts.paused },
    ])
  );
  const snapshot = {
    byCampaignId,
    materialCountsByCampaignId: normalizedMaterialCounts,
    allMaterialCountsByCampaignId: normalizedAllMaterialCounts,
    campaignRows,
  };
  if (!sourceCampaigns) {
    campaignMaterialDisplayCache = {
      expiresAt: Date.now() + CAMPAIGN_MATERIAL_DISPLAY_CACHE_TTL_MS,
      snapshot,
    };
  }
  return snapshot;
}

export async function applyMaterialDisplayStatusesToCampaigns(
  campaigns: TikTokSpentCampaign[]
): Promise<TikTokSpentCampaign[]> {
  if (campaigns.length === 0) return campaigns;

  const snapshot = await getCampaignMaterialDisplaySnapshot(true, campaigns);
  return campaigns.map(campaign => {
    const materialCounts = snapshot.materialCountsByCampaignId.get(campaign.campaign_id);
    const allMaterialCounts = snapshot.allMaterialCountsByCampaignId.get(campaign.campaign_id);
    return {
      ...campaign,
      ad_status: campaign.status === 'deleted'
        ? undefined
        : snapshot.byCampaignId.get(campaign.campaign_id) || campaign.status,
      raw_ad_status: undefined,
      material_active_count: materialCounts?.active || 0,
      material_paused_count: materialCounts?.paused || 0,
      material_total_active_count: allMaterialCounts?.active || 0,
      material_total_paused_count: allMaterialCounts?.paused || 0,
    };
  });
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

/**
 * Parse message "Material Rule Auto" theo format nhóm MKT:
 *   🤖 <b>Material Rule Auto</b>
 *   👤 <b>MKT80.HOÀNG-TH</b>
 *   <b>Tên camp</b> - <code>ID</code>
 *   ✅ #4 TẮT · $0.62 · 🎯 0 · CPA $0.00
 * Mỗi campaign trở thành một item riêng; header MKT gắn vào item theo sau nó.
 */
export function parseGroupedAutoActionItems(text: string): ParsedAutoAction[] {
  const lines = text.split('\n');
  const items: ParsedAutoAction[] = [];
  let current: ParsedAutoAction | undefined;
  let currentMkt: string | undefined;

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;

    const mktHeader = line.match(/^👤\s*<b>(.*?)<\/b>\s*$/);
    if (mktHeader) {
      currentMkt = mktHeader[1];
      current = undefined;
      continue;
    }

    const campaignMatch = line.match(/^<b>(.*?)<\/b>\s*-\s*<code>(\d{10,})<\/code>\s*$/);
    if (campaignMatch) {
      current = {
        campaignLine: normalizeCampaignLine(line),
        campaignId: campaignMatch[2],
        mkt: currentMkt,
        pauseSuccess: 0,
        activeSuccess: 0,
        unverified: 0,
        details: [],
      };
      items.push(current);
      continue;
    }

    if (!current) continue;
    const isVerified = line.startsWith('✅');
    const isPause = /\sTẮT\s/.test(line);
    const isActive = /\sBẬT\s/.test(line);

    if (isVerified && isPause) current.pauseSuccess += 1;
    if (isVerified && isActive) current.activeSuccess += 1;
    if (!isVerified) current.unverified += 1;

    current.details.push(line
      .replace(/^✅\s*/, isPause ? '⏸ ' : isActive ? '▶️ ' : '✅ ')
      .replace(/^⚠️\s*/, '⚠️ ')
      .replace(/\sTẮT\s·/, ' ·')
      .replace(/\sBẬT\s·/, ' ·'));
  }

  return items;
}

function parseAutoActionPayload(payload: unknown): ParsedAutoAction[] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const source = payload as Record<string, unknown>;
  if (String(source.parse_mode || '').toUpperCase() !== 'HTML' || typeof source.text !== 'string') {
    return undefined;
  }

  const text = source.text;
  if (!isMaterialAutoActionText(text)) return undefined;
  const items = parseGroupedAutoActionItems(text);
  return items.length > 0 ? items : undefined;
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

  // Giữ nguyên phân nhóm MKT như message gốc từ rule engine.
  const mktGroups = new Map<string, ParsedAutoAction[]>();
  visibleItems.forEach(item => {
    const key = item.mkt || '';
    const list = mktGroups.get(key) || [];
    list.push(item);
    mktGroups.set(key, list);
  });

  let displayIndex = 0;
  for (const [mkt, groupItems] of mktGroups.entries()) {
    if (mktGroups.size > 1 || mkt) {
      detailLines.push(`👤 <b>${escapeHtml(mkt === 'CHUA_GAN_MKT' ? 'Chưa gắn MKT' : mkt)}</b>`);
    }
    for (const item of groupItems) {
      displayIndex += 1;
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
        `<b>${displayIndex}.</b> ${item.campaignLine}${accountSuffix} · 🚀 x${cloneCount}`
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
          text: `🔎 ${displayIndex}`,
        });
      }
    }
  }

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
 * Đồng thời sửa presentation của /campaigns hôm nay để màu trạng thái được suy ra từ
 * material thật: tất cả ENABLE = xanh, tất cả DISABLE = vàng, trộn = cam.
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

    try {
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

      await originalCallApi('sendMessage', nextPayload);
    } catch (error) {
      // Không để lỗi DB/Telegram khi flush làm crash bot; gửi lại message gốc (chưa rút gọn) nếu được.
      console.error('[MaterialAutoActionFeedback] grouped notification failed:', error);
      try {
        const fallbackPayload: Record<string, unknown> = { ...(batch.payload || {}) };
        delete fallbackPayload.reply_markup;
        await originalCallApi('sendMessage', fallbackPayload);
      } catch (fallbackError) {
        console.error('[MaterialAutoActionFeedback] fallback notification failed:', fallbackError);
      }
    }
  };

  telegram.callApi = async (method: unknown, payload: unknown, ...rest: unknown[]) => {
    if (!payload || typeof payload !== 'object') {
      return originalCallApi(method, payload, ...rest);
    }

    const methodName = String(method);
    const source = payload as Record<string, unknown>;

    if (methodName !== 'sendMessage') {
      return originalCallApi(method, source, ...rest);
    }

    const parsedItems = parseAutoActionPayload(source);
    if (!parsedItems) {
      return originalCallApi(method, source, ...rest);
    }

    // Một write material vừa xảy ra: bỏ cache màu để lần xem /campaigns kế tiếp phản ánh ngay state mới.
    campaignMaterialDisplayCache = undefined;

    const batchKey = getBatchKey(source);
    const now = Date.now();
    const existing = pendingByChat.get(batchKey) as (PendingBatch & { payload?: Record<string, unknown> }) | undefined;
    const batch: PendingBatch & { payload?: Record<string, unknown> } = existing || {
      firstAt: now,
      items: [],
      payload: source,
    };

    batch.items.push(...parsedItems);
    batch.payload ||= source;
    if (batch.timer) clearTimeout(batch.timer);

    const maxRemaining = Math.max(0, BATCH_MAX_WAIT_MS - (now - batch.firstAt));
    const waitMs = Math.min(BATCH_IDLE_MS, maxRemaining);
    batch.timer = setTimeout(() => {
      void flushBatch(batchKey).catch(error => {
        console.error('[MaterialAutoActionFeedback] unhandled flush failure:', error);
      });
    }, waitMs);
    pendingByChat.set(batchKey, batch);

    return buildBufferedResponse(source);
  };
}
