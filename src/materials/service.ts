import axios from 'axios';
import { getTikTokReadAccessToken, getTikTokWriteAccessToken } from '../tiktok/config.js';

const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const SMART_PLUS_PAGE_SIZE = 100;
const SMART_PLUS_CACHE_TTL_MS = 30_000;
const MATERIAL_STATUS_VERIFY_DELAYS_MS = [2_000, 3_000, 5_000] as const;

export type MaterialOperationStatus = 'ENABLE' | 'DISABLE';

export interface SmartPlusCreativeRef {
  advertiserId: string;
  campaignId: string;
  campaignName?: string;
  smartPlusAdId: string;
  adMaterialId: string;
  smartPlusCreativeId?: string;
  tiktokItemId: string;
  status: MaterialOperationStatus | 'UNKNOWN';
}

export interface MaterialPerformance {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number;
  cpa: number;
  ctr: number;
  videoPlayActions: number;
  name?: string;
}

export interface CampaignMaterialItem extends SmartPlusCreativeRef, MaterialPerformance {
  materialNumber: number;
}

export interface CampaignMaterialSnapshot {
  advertiserId: string;
  campaignId: string;
  campaignName?: string;
  dateKey: string;
  materials: CampaignMaterialItem[];
}

interface CachedSmartPlusAds {
  expiresAt: number;
  ads: any[];
}

const smartPlusAdsCache = new Map<string, CachedSmartPlusAds>();

function getApiErrorMessage(payload: any): string {
  return String(payload?.message || payload?.msg || payload?.code || 'Unknown TikTok API error');
}

function assertTikTokSuccess(payload: any, context: string): void {
  if (Number(payload?.code || 0) !== 0) {
    throw new Error(`${context}: ${getApiErrorMessage(payload)}`);
  }
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getVietnamDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find(part => part.type === 'year')?.value || '1970';
  const month = parts.find(part => part.type === 'month')?.value || '01';
  const day = parts.find(part => part.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

async function getReadToken(): Promise<string> {
  return getTikTokReadAccessToken();
}

async function getSmartPlusAdsPage(advertiserId: string, page: number): Promise<any[]> {
  const accessToken = await getReadToken();
  const response = await axios.get(`${TIKTOK_API_BASE}/smart_plus/ad/get/`, {
    params: {
      advertiser_id: advertiserId,
      page,
      page_size: SMART_PLUS_PAGE_SIZE,
    },
    headers: { 'Access-Token': accessToken },
    timeout: 30_000,
  });

  assertTikTokSuccess(response.data, `Smart+ ad list advertiser=${advertiserId}`);
  return Array.isArray(response.data?.data?.list) ? response.data.data.list : [];
}

export async function getSmartPlusAdsForAdvertiser(
  advertiserId: string,
  forceRefresh = false
): Promise<any[]> {
  const cached = smartPlusAdsCache.get(advertiserId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.ads;
  }

  const ads: any[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const list = await getSmartPlusAdsPage(advertiserId, page);
    ads.push(...list);
    if (list.length < SMART_PLUS_PAGE_SIZE) break;
  }

  smartPlusAdsCache.set(advertiserId, {
    expiresAt: Date.now() + SMART_PLUS_CACHE_TTL_MS,
    ads,
  });
  return ads;
}

async function getSmartPlusAdById(
  advertiserId: string,
  smartPlusAdId: string
): Promise<any | undefined> {
  const accessToken = await getReadToken();
  const response = await axios.get(`${TIKTOK_API_BASE}/smart_plus/ad/get/`, {
    params: {
      advertiser_id: advertiserId,
      smart_plus_ad_ids: JSON.stringify([smartPlusAdId]),
      page: 1,
      page_size: SMART_PLUS_PAGE_SIZE,
    },
    headers: { 'Access-Token': accessToken },
    timeout: 30_000,
  });

  assertTikTokSuccess(response.data, `Smart+ ad get ${smartPlusAdId}`);
  return (response.data?.data?.list || []).find(
    (item: any) => String(item?.smart_plus_ad_id || '') === smartPlusAdId
  );
}

async function getCampaignSmartPlusAds(
  advertiserId: string,
  campaignId: string
): Promise<any[]> {
  const ads = await getSmartPlusAdsForAdvertiser(advertiserId);
  const matched = ads.filter(ad => String(ad?.campaign_id || '') === campaignId);
  const detailed: any[] = [];

  for (const ad of matched) {
    if (Array.isArray(ad?.creative_list) && ad.creative_list.length > 0) {
      detailed.push(ad);
      continue;
    }

    const smartPlusAdId = String(ad?.smart_plus_ad_id || '');
    if (!smartPlusAdId) continue;
    const detail = await getSmartPlusAdById(advertiserId, smartPlusAdId);
    if (detail) detailed.push(detail);
  }

  return detailed;
}

interface MaterialReportRow {
  mainMaterialId: string;
  metrics: MaterialPerformance;
}

async function fetchMaterialReportForAd(
  advertiserId: string,
  smartPlusAdId: string,
  dateKey: string
): Promise<MaterialReportRow[]> {
  const accessToken = await getReadToken();
  const request = async () => axios.get(`${TIKTOK_API_BASE}/smart_plus/material_report/breakdown/`, {
    params: {
      advertiser_id: advertiserId,
      dimensions: JSON.stringify(['main_material_id']),
      metrics: JSON.stringify([
        'spend',
        'impressions',
        'clicks',
        'ctr',
        'cpc',
        'conversion',
        'cost_per_conversion',
        'video_play_actions',
      ]),
      filtering: JSON.stringify({ smart_plus_ad_ids: [smartPlusAdId] }),
      start_date: dateKey,
      end_date: dateKey,
      page: 1,
      page_size: SMART_PLUS_PAGE_SIZE,
    },
    headers: { 'Access-Token': accessToken },
    timeout: 30_000,
  });

  let response = await request();
  if (
    Number(response.data?.code || 0) !== 0 &&
    /qps|over_qps/i.test(getApiErrorMessage(response.data))
  ) {
    await sleep(1_500);
    response = await request();
  }

  assertTikTokSuccess(response.data, `Material report Smart+ ad=${smartPlusAdId}`);

  return (response.data?.data?.list || [])
    .map((row: any) => {
      const metrics = row?.metrics || {};
      return {
        mainMaterialId: String(row?.dimensions?.main_material_id || row?.main_material_id || ''),
        metrics: {
          spend: toNumber(metrics.spend ?? row?.spend),
          impressions: toNumber(metrics.impressions ?? row?.impressions),
          clicks: toNumber(metrics.clicks ?? row?.clicks),
          conversions: toNumber(metrics.conversion ?? row?.conversion),
          cpc: toNumber(metrics.cpc ?? row?.cpc),
          cpa: toNumber(metrics.cost_per_conversion ?? row?.cost_per_conversion),
          ctr: toNumber(metrics.ctr ?? row?.ctr),
          videoPlayActions: toNumber(metrics.video_play_actions ?? row?.video_play_actions),
          name: String(metrics.main_material_name || row?.main_material_name || '').trim() || undefined,
        },
      } satisfies MaterialReportRow;
    })
    .filter((row: MaterialReportRow) => Boolean(row.mainMaterialId));
}

/**
 * TikTok Smart+ creative responses are not fully consistent across list/detail calls.
 * In production we have observed the material switch exposed as `status`, while some
 * responses use `material_operation_status` / `operation_status` (occasionally nested
 * under `creative_info`). Only exact ENABLE/DISABLE values are accepted here so review
 * status fields cannot be mistaken for delivery state.
 */
function getCreativeStatus(creative: any): SmartPlusCreativeRef['status'] {
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
    const raw = String(candidate ?? '').trim().toUpperCase();
    if (raw === 'ENABLE' || raw === 'DISABLE') return raw;
  }

  return 'UNKNOWN';
}

export async function getCampaignMaterialSnapshot(
  advertiserId: string,
  campaignId: string,
  campaignName?: string,
  dateKey = getVietnamDateKey()
): Promise<CampaignMaterialSnapshot> {
  const ads = await getCampaignSmartPlusAds(advertiserId, campaignId);
  const materials: CampaignMaterialItem[] = [];
  let runningNumber = 0;

  for (const ad of ads) {
    const smartPlusAdId = String(ad?.smart_plus_ad_id || '');
    if (!smartPlusAdId) continue;

    const reportRows = await fetchMaterialReportForAd(advertiserId, smartPlusAdId, dateKey);
    const reportByTikTokItemId = new Map(reportRows.map(row => [row.mainMaterialId, row.metrics]));
    const creatives = Array.isArray(ad?.creative_list) ? ad.creative_list : [];

    for (const creative of creatives) {
      const adMaterialId = String(creative?.ad_material_id || '');
      const tiktokItemId = String(creative?.creative_info?.tiktok_item_id || '');
      if (!adMaterialId || !tiktokItemId) continue;

      runningNumber += 1;
      const metrics = reportByTikTokItemId.get(tiktokItemId) || {
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        cpc: 0,
        cpa: 0,
        ctr: 0,
        videoPlayActions: 0,
      };

      materials.push({
        advertiserId,
        campaignId,
        campaignName: campaignName || String(ad?.campaign_name || '').trim() || undefined,
        smartPlusAdId,
        adMaterialId,
        smartPlusCreativeId: String(creative?.smart_plus_creative_id || '').trim() || undefined,
        tiktokItemId,
        status: getCreativeStatus(creative),
        materialNumber: runningNumber,
        ...metrics,
      });
    }
  }

  materials.sort((a, b) => b.spend - a.spend || a.materialNumber - b.materialNumber);
  materials.forEach((item, index) => {
    item.materialNumber = index + 1;
  });

  return {
    advertiserId,
    campaignId,
    campaignName: campaignName || materials[0]?.campaignName,
    dateKey,
    materials,
  };
}

export interface MaterialBatchUpdateResult {
  requested: string[];
  verified: string[];
  failed: string[];
}

export async function setMaterialOperationStatusBatch(
  advertiserId: string,
  smartPlusAdId: string,
  adMaterialIds: string[],
  operationStatus: MaterialOperationStatus
): Promise<MaterialBatchUpdateResult> {
  const uniqueIds = [...new Set(adMaterialIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { requested: [], verified: [], failed: [] };
  }

  const writeToken = await getTikTokWriteAccessToken();
  const response = await axios.post(
    `${TIKTOK_API_BASE}/smart_plus/ad/material_status/update/`,
    {
      advertiser_id: advertiserId,
      smart_plus_ad_id: smartPlusAdId,
      ad_material_ids: uniqueIds,
      operation_status: operationStatus,
    },
    {
      headers: {
        'Access-Token': writeToken,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    }
  );

  assertTikTokSuccess(response.data, `Material ${operationStatus} Smart+ ad=${smartPlusAdId}`);
  smartPlusAdsCache.delete(advertiserId);

  const statusById = new Map<string, string>();
  for (const delayMs of MATERIAL_STATUS_VERIFY_DELAYS_MS) {
    await sleep(delayMs);

    try {
      const refreshed = await getSmartPlusAdById(advertiserId, smartPlusAdId);
      statusById.clear();
      for (const creative of refreshed?.creative_list || []) {
        statusById.set(String(creative?.ad_material_id || ''), getCreativeStatus(creative));
      }
    } catch (error) {
      console.warn(
        `[MaterialStatusVerify] read failed advertiser=${advertiserId} ad=${smartPlusAdId} delay=${delayMs}ms:`,
        error
      );
      continue;
    }

    if (uniqueIds.every(id => statusById.get(id) === operationStatus)) {
      break;
    }
  }

  const verified = uniqueIds.filter(id => statusById.get(id) === operationStatus);
  const failed = uniqueIds.filter(id => statusById.get(id) !== operationStatus);
  return { requested: uniqueIds, verified, failed };
}
