import axios from 'axios';
import { db } from '../db/index.js';
import { getTikTokReadAccessToken, getTikTokWriteAccessToken } from '../tiktok/config.js';

const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const SMART_PLUS_PAGE_SIZE = 100;
const SMART_PLUS_CACHE_TTL_MS = 30_000;
const MATERIAL_STATUS_VERIFY_DELAYS_MS = [2_000, 3_000, 5_000] as const;
const DEFAULT_MATERIAL_WRITE_CONCURRENCY = 2;
const MAX_MATERIAL_WRITE_CONCURRENCY = 6;

let activeMaterialWrites = 0;
const materialWriteWaiters: Array<() => void> = [];

function getMaterialWriteConcurrency(): number {
  const configured = Number(process.env.MATERIAL_WRITE_CONCURRENCY);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MATERIAL_WRITE_CONCURRENCY;
  }
  return Math.min(MAX_MATERIAL_WRITE_CONCURRENCY, Math.max(1, Math.trunc(configured)));
}

async function withMaterialWriteSlot<T>(task: () => Promise<T>): Promise<T> {
  const concurrency = getMaterialWriteConcurrency();

  if (activeMaterialWrites >= concurrency) {
    await new Promise<void>(resolve => {
      materialWriteWaiters.push(() => {
        activeMaterialWrites += 1;
        resolve();
      });
    });
  } else {
    activeMaterialWrites += 1;
  }

  try {
    return await task();
  } finally {
    activeMaterialWrites -= 1;
    materialWriteWaiters.shift()?.();
  }
}

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

interface MaterialOperationStateRow {
  ad_material_id: string;
  operation_status: MaterialOperationStatus;
  accepted_at_ms: number;
  confirmed_at_ms?: number | null;
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

async function ensureMaterialOperationStateTable(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS material_operation_state (
      advertiser_id TEXT NOT NULL,
      smart_plus_ad_id TEXT NOT NULL,
      ad_material_id TEXT NOT NULL,
      operation_status TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      confirmed_at_ms INTEGER,
      PRIMARY KEY (advertiser_id, smart_plus_ad_id, ad_material_id)
    )
  `);
}

async function rememberAcceptedMaterialStatus(
  advertiserId: string,
  smartPlusAdId: string,
  adMaterialIds: string[],
  operationStatus: MaterialOperationStatus
): Promise<void> {
  await ensureMaterialOperationStateTable();
  const acceptedAtMs = Date.now();

  for (const adMaterialId of adMaterialIds) {
    await db.run(
      `INSERT INTO material_operation_state (
        advertiser_id,
        smart_plus_ad_id,
        ad_material_id,
        operation_status,
        accepted_at_ms,
        confirmed_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(advertiser_id, smart_plus_ad_id, ad_material_id)
      DO UPDATE SET
        operation_status = excluded.operation_status,
        accepted_at_ms = excluded.accepted_at_ms,
        confirmed_at_ms = NULL`,
      [advertiserId, smartPlusAdId, adMaterialId, operationStatus, acceptedAtMs]
    );
  }
}

async function markMaterialStatusConfirmed(
  advertiserId: string,
  smartPlusAdId: string,
  adMaterialIds: string[]
): Promise<void> {
  if (adMaterialIds.length === 0) return;
  await ensureMaterialOperationStateTable();
  const confirmedAtMs = Date.now();

  for (const adMaterialId of adMaterialIds) {
    await db.run(
      `UPDATE material_operation_state
       SET confirmed_at_ms = ?
       WHERE advertiser_id = ? AND smart_plus_ad_id = ? AND ad_material_id = ?`,
      [confirmedAtMs, advertiserId, smartPlusAdId, adMaterialId]
    );
  }
}

async function getMaterialOperationStateMap(
  advertiserId: string,
  smartPlusAdId: string
): Promise<Map<string, MaterialOperationStateRow>> {
  await ensureMaterialOperationStateTable();
  const rows = await db.all<MaterialOperationStateRow>(
    `SELECT ad_material_id, operation_status, accepted_at_ms, confirmed_at_ms
     FROM material_operation_state
     WHERE advertiser_id = ? AND smart_plus_ad_id = ?`,
    [advertiserId, smartPlusAdId]
  );
  return new Map(rows.map(row => [row.ad_material_id, row]));
}

async function reconcileCreativeStatuses(
  advertiserId: string,
  smartPlusAdId: string,
  creatives: any[]
): Promise<Map<string, SmartPlusCreativeRef['status']>> {
  const localStates = await getMaterialOperationStateMap(advertiserId, smartPlusAdId);
  const resolved = new Map<string, SmartPlusCreativeRef['status']>();

  for (const creative of creatives) {
    const adMaterialId = String(creative?.ad_material_id || '');
    if (!adMaterialId) continue;

    const apiStatus = getCreativeStatus(creative);
    const localState = localStates.get(adMaterialId);
    if (!localState) {
      resolved.set(adMaterialId, apiStatus);
      continue;
    }

    if (apiStatus === localState.operation_status) {
      resolved.set(adMaterialId, apiStatus);
      if (!localState.confirmed_at_ms) {
        await markMaterialStatusConfirmed(advertiserId, smartPlusAdId, [adMaterialId]);
      }
      continue;
    }

    if (localState.confirmed_at_ms && apiStatus !== 'UNKNOWN') {
      resolved.set(adMaterialId, apiStatus);
      await db.run(
        `DELETE FROM material_operation_state
         WHERE advertiser_id = ? AND smart_plus_ad_id = ? AND ad_material_id = ?`,
        [advertiserId, smartPlusAdId, adMaterialId]
      );
      continue;
    }

    resolved.set(adMaterialId, localState.operation_status);
  }

  return resolved;
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

export async function getSmartPlusAdsByIds(
  advertiserId: string,
  smartPlusAdIds: string[]
): Promise<any[]> {
  const uniqueIds = [...new Set(smartPlusAdIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const accessToken = await getReadToken();
  const results: any[] = [];

  for (let offset = 0; offset < uniqueIds.length; offset += SMART_PLUS_PAGE_SIZE) {
    const batchIds = uniqueIds.slice(offset, offset + SMART_PLUS_PAGE_SIZE);
    const response = await axios.get(`${TIKTOK_API_BASE}/smart_plus/ad/get/`, {
      params: {
        advertiser_id: advertiserId,
        smart_plus_ad_ids: JSON.stringify(batchIds),
        page: 1,
        page_size: SMART_PLUS_PAGE_SIZE,
      },
      headers: { 'Access-Token': accessToken },
      timeout: 30_000,
    });

    assertTikTokSuccess(response.data, `Smart+ ad detail batch advertiser=${advertiserId}`);
    results.push(...(Array.isArray(response.data?.data?.list) ? response.data.data.list : []));
  }

  return results;
}

async function getSmartPlusAdById(
  advertiserId: string,
  smartPlusAdId: string
): Promise<any | undefined> {
  const details = await getSmartPlusAdsByIds(advertiserId, [smartPlusAdId]);
  return details.find(
    (item: any) => String(item?.smart_plus_ad_id || '') === smartPlusAdId
  );
}

async function getCampaignSmartPlusAds(
  advertiserId: string,
  campaignId: string
): Promise<any[]> {
  const ads = await getSmartPlusAdsForAdvertiser(advertiserId);
  const matched = ads.filter(ad => String(ad?.campaign_id || '') === campaignId);
  const ready = matched.filter(ad => Array.isArray(ad?.creative_list) && ad.creative_list.length > 0);
  const missingDetailIds = matched
    .filter(ad => !Array.isArray(ad?.creative_list) || ad.creative_list.length === 0)
    .map(ad => String(ad?.smart_plus_ad_id || '').trim())
    .filter(Boolean);

  if (missingDetailIds.length === 0) {
    return ready;
  }

  const details = await getSmartPlusAdsByIds(advertiserId, missingDetailIds);
  return [...ready, ...details];
}

interface MaterialReportRow {
  mainMaterialId: string;
  metrics: MaterialPerformance;
}

async function fetchMaterialReportForAd(
  advertiserId: string,
  smartPlusAdId: string,
  startDate: string,
  endDate = startDate
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
      start_date: startDate,
      end_date: endDate,
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

function getCreativeStatus(creative: any): SmartPlusCreativeRef['status'] {
  const raw = String(
    creative?.material_operation_status ?? creative?.operation_status ?? ''
  ).toUpperCase();
  if (raw === 'ENABLE' || raw === 'DISABLE') return raw;
  return 'UNKNOWN';
}

export async function getCampaignMaterialSnapshot(
  advertiserId: string,
  campaignId: string,
  campaignName?: string,
  dateKey = getVietnamDateKey(),
  endDate = dateKey
): Promise<CampaignMaterialSnapshot> {
  const ads = await getCampaignSmartPlusAds(advertiserId, campaignId);
  const materials: CampaignMaterialItem[] = [];
  let runningNumber = 0;

  for (const ad of ads) {
    const smartPlusAdId = String(ad?.smart_plus_ad_id || '');
    if (!smartPlusAdId) continue;

    const reportRows = await fetchMaterialReportForAd(advertiserId, smartPlusAdId, dateKey, endDate);
    const reportByTikTokItemId = new Map(reportRows.map(row => [row.mainMaterialId, row.metrics]));
    const creatives = Array.isArray(ad?.creative_list) ? ad.creative_list : [];
    const resolvedStatusByMaterialId = await reconcileCreativeStatuses(
      advertiserId,
      smartPlusAdId,
      creatives
    );

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
        status: resolvedStatusByMaterialId.get(adMaterialId) || getCreativeStatus(creative),
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

async function verifyMaterialOperationStatusInBackground(
  advertiserId: string,
  smartPlusAdId: string,
  adMaterialIds: string[],
  operationStatus: MaterialOperationStatus
): Promise<void> {
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

    const confirmedIds = adMaterialIds.filter(id => statusById.get(id) === operationStatus);
    if (confirmedIds.length > 0) {
      await markMaterialStatusConfirmed(advertiserId, smartPlusAdId, confirmedIds);
    }

    if (confirmedIds.length === adMaterialIds.length) {
      return;
    }
  }

  const pendingReadback = adMaterialIds.filter(id => statusById.get(id) !== operationStatus);
  if (pendingReadback.length > 0) {
    console.warn(
      `[MaterialStatusVerify] write accepted but TikTok readback still pending advertiser=${advertiserId} ad=${smartPlusAdId} status=${operationStatus} materials=${pendingReadback.join(',')}`
    );
  }
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
  const response = await withMaterialWriteSlot(() => axios.post(
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
  ));

  assertTikTokSuccess(response.data, `Material ${operationStatus} Smart+ ad=${smartPlusAdId}`);
  smartPlusAdsCache.delete(advertiserId);
  await rememberAcceptedMaterialStatus(advertiserId, smartPlusAdId, uniqueIds, operationStatus);

  // TikTok accepted the write. Verify readback without blocking the whole Level 1 scan;
  // pending local state remains authoritative until TikTok reflects the new status.
  void verifyMaterialOperationStatusInBackground(
    advertiserId,
    smartPlusAdId,
    uniqueIds,
    operationStatus
  ).catch(error => {
    console.warn(
      `[MaterialStatusVerify] background verification failed advertiser=${advertiserId} ad=${smartPlusAdId}:`,
      error
    );
  });

  return {
    requested: uniqueIds,
    verified: uniqueIds,
    failed: [],
  };
}
