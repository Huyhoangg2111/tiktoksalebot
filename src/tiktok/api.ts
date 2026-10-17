import axios from 'axios';
import { executeOfficialDuplicate } from '../campaigns/official-duplicate.js';
import {
  assertAdvertiserAllowed,
  getAllowedAdvertiserIds,
  getTikTokBalanceConfig,
  getTikTokConfig,
  getTikTokWriteAccessToken,
} from './config.js';
import { db } from '../db/index.js';

// Define interfaces for TikTok API responses
export interface TikTokAccountBalance {
  mkt_code?: string;
  advertiser_id: string;
  advertiser_name?: string;
  balance: number;
  valid_balance: number;
  currency: string;
}

interface TikTokAdvertiserBalanceItem {
  advertiser_id: string;
  advertiser_name?: string;
  account_balance?: number | string;
  valid_account_balance?: number | string;
  currency?: string;
}

export interface TikTokCampaign {
  id: string;
  advertiser_id: string;
  name: string;
  status: string;
  objective_type: string;
  daily_budget?: number;
  lifetime_budget?: number;
  created_time: string;
  updated_time: string;
}

export interface TikTokCampaignPerformance {
  campaign_id: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number; // Cost Per Click
  cpa: number; // Cost Per Acquisition
  ctr: number; // Click Through Rate
}

export interface TikTokSpentCampaign {
  campaign_id: string;
  campaign_name: string;
  advertiser_id: string;
  advertiser_name?: string;
  mkt_code?: string;
  status: 'active' | 'paused' | 'deleted';
  raw_status?: string;
  ad_status?: 'active' | 'paused' | 'deleted' | 'mixed';
  raw_ad_status?: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number;
  cpa: number;
  ctr: number;
}

export interface TikTokSpentAd {
  ad_id: string;
  ad_name?: string;
  campaign_id: string;
  campaign_name?: string;
  advertiser_id: string;
  advertiser_name?: string;
  mkt_code?: string;
  status?: 'active' | 'paused' | 'deleted';
  raw_status?: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number;
  cpa: number;
  ctr: number;
}

interface CachedSpentCampaignRow {
  advertiser_id: string;
  campaign_id: string;
  date_key: string;
  campaign_name?: string;
  advertiser_name?: string;
  mkt_code?: string;
  status?: string;
  raw_status?: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number;
  cpa: number;
  ctr: number;
}

interface CampaignStatusInfo {
  status: TikTokSpentCampaign['status'];
  rawStatus: string;
  campaignName?: string;
}

interface AdMetadataInfo {
  adName?: string;
  campaignId?: string;
  campaignName?: string;
  status?: TikTokSpentAd['status'];
  rawStatus?: string;
}

interface TikTokSpentAdReportRow {
  adId: string;
  adName?: string;
  campaignId?: string;
  campaignName?: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number;
  cpa: number;
  ctr: number;
}

interface TikTokAdvertiserAccountOption {
  advertiserId: string;
  advertiserName?: string;
  mktCode?: string;
}

interface TikTokSpentCampaignOptions {
  includeCache?: boolean;
  includeActiveNoSpend?: boolean;
  /** Skip campaign/get status pages (faster for /bc reports that only need spend metrics). */
  skipStatusMap?: boolean;
  /** Skip ad-level report enrichment (faster for sales reports). */
  skipAdSupplement?: boolean;
  /** Max concurrent advertiser API workers (default 4). */
  concurrency?: number;
  advertiserIds?: string[];
  advertiserAccounts?: TikTokAdvertiserAccountOption[];
}

interface TikTokSpentAdOptions {
  advertiserIds?: string[];
  advertiserAccounts?: TikTokAdvertiserAccountOption[];
}

// Base API configuration
const TIKTOK_API_BASE_URL = 'https://business-api.tiktok.com/open_api/v1.3';
export type TikTokCampaignOperationStatus = 'ENABLE' | 'DISABLE';

export interface TikTokCampaignStatusRef {
  advertiserId: string;
  campaignId: string;
}

export interface TikTokCampaignStatusFailure extends TikTokCampaignStatusRef {
  error: string;
}

export interface TikTokCampaignStatusBatchResult {
  succeeded: TikTokCampaignStatusRef[];
  failed: TikTokCampaignStatusFailure[];
}

export interface TikTokAdStatusUpdateResult {
  advertiserId: string;
  campaignId: string;
  adIds: string[];
  status: NonNullable<TikTokSpentAd['status']>;
}

export interface TikTokCampaignAdsStatus {
  advertiserId: string;
  campaignId: string;
  ads: Array<{ adId: string; status: TikTokSpentAd['status']; rawStatus: string }>;
}

export interface TikTokDuplicateCampaignResult {
  campaignId: string;
  advertiserId: string;
  campaignName?: string;
  overrideWarnings?: string[];
}

export interface TikTokCampaignCloneDefaults {
  campaignId: string;
  advertiserId?: string;
  campaignName?: string;
  budget?: number;
  bid?: number;
  status?: TikTokSpentCampaign['status'];
}

interface TikTokCampaignRecord {
  advertiser_id: string;
  campaign_id: string;
  campaign_name?: string;
  objective_type?: string;
  budget_mode?: string;
  budget?: number | string;
  operation_status?: string;
  secondary_status?: string;
  campaign_automation_type?: string;
  is_smart_performance_campaign?: boolean;
}

interface TikTokAdGroupRecord {
  advertiser_id?: string;
  campaign_id?: string;
  adgroup_id?: string;
  adgroup_name?: string;
  budget?: number | string;
  bid?: number | string;
  bid_price?: number | string;
  conversion_bid_price?: number | string;
  deep_bid?: number | string;
}

function parseMetricNumber(value: unknown): number {
  const parsed = Number(String(value ?? 0).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function getTodayDate(timeZone = 'Asia/Ho_Chi_Minh'): string {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const year = dateParts.find(part => part.type === 'year')?.value;
  const month = dateParts.find(part => part.type === 'month')?.value;
  const day = dateParts.find(part => part.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

function getCampaignCacheKey(campaign: Pick<TikTokSpentCampaign, 'advertiser_id' | 'campaign_id' | 'date'>): string {
  return `${campaign.advertiser_id}:${campaign.campaign_id}:${campaign.date.slice(0, 10)}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function parsePositiveEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isSmartPlusCreativeStatusError(message: string): boolean {
  return /auto[-\s]?generated|creative assets|smart\+|upgraded_smart_plus|permission error/i.test(message)
    || /\b40002\b/.test(message);
}

function isSmartPlusCampaignRecord(campaign: TikTokCampaignRecord | null | undefined): boolean {
  if (!campaign) {
    return false;
  }

  const campaignRecord = campaign as TikTokCampaignRecord & { automation_type?: unknown };
  const automationType = String(
    campaignRecord.campaign_automation_type ||
    campaignRecord.automation_type ||
    ''
  ).toUpperCase();

  return automationType.includes('SMART_PLUS') || automationType.includes('SMART+');
}

function getAdvertiserCampaignKey(advertiserId: string, campaignId: string): string {
  return `${advertiserId}:${campaignId}`;
}

function normalizeAdvertiserIds(advertiserIds: string[]): string[] {
  return [...new Set(
    advertiserIds
      .map(advertiserId => String(advertiserId || '').trim())
      .filter(Boolean)
  )];
}

async function syncSpentCampaignCache(
  today: string,
  advertiserIds: string[],
  currentCampaigns: TikTokSpentCampaign[]
): Promise<TikTokSpentCampaign[]> {
  await db.run('DELETE FROM spent_campaign_cache WHERE date_key <> ?', [today]);

  for (const campaign of currentCampaigns) {
    await db.run(
      `INSERT INTO spent_campaign_cache (
        advertiser_id,
        campaign_id,
        date_key,
        campaign_name,
        advertiser_name,
        mkt_code,
        status,
        raw_status,
        spend,
        impressions,
        clicks,
        conversions,
        cpc,
        cpa,
        ctr,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(advertiser_id, campaign_id, date_key)
      DO UPDATE SET
        campaign_name = excluded.campaign_name,
        advertiser_name = excluded.advertiser_name,
        mkt_code = excluded.mkt_code,
        status = excluded.status,
        raw_status = excluded.raw_status,
        spend = excluded.spend,
        impressions = excluded.impressions,
        clicks = excluded.clicks,
        conversions = excluded.conversions,
        cpc = excluded.cpc,
        cpa = excluded.cpa,
        ctr = excluded.ctr,
        updated_at = CURRENT_TIMESTAMP`,
      [
        campaign.advertiser_id,
        campaign.campaign_id,
        today,
        campaign.campaign_name,
        campaign.advertiser_name || null,
        campaign.mkt_code || null,
        campaign.status,
        campaign.raw_status || null,
        campaign.spend,
        campaign.impressions,
        campaign.clicks,
        campaign.conversions,
        campaign.cpc,
        campaign.cpa,
        campaign.ctr,
      ]
    );
  }

  if (advertiserIds.length === 0) {
    return currentCampaigns;
  }

  const placeholders = advertiserIds.map(() => '?').join(', ');
  const cachedRows = await db.all<CachedSpentCampaignRow>(
    `SELECT
      advertiser_id,
      campaign_id,
      date_key,
      campaign_name,
      advertiser_name,
      mkt_code,
      status,
      raw_status,
      spend,
      impressions,
      clicks,
      conversions,
      cpc,
      cpa,
      ctr
     FROM spent_campaign_cache
     WHERE date_key = ? AND advertiser_id IN (${placeholders})`,
    [today, ...advertiserIds]
  );

  const currentByKey = new Map(currentCampaigns.map(campaign => [getCampaignCacheKey(campaign), campaign]));
  const mergedCampaigns = [...currentCampaigns];
  let restoredDeletedCampaignCount = 0;

  cachedRows.forEach(row => {
    const cacheKey = `${row.advertiser_id}:${row.campaign_id}:${row.date_key}`;

    if (currentByKey.has(cacheKey)) {
      return;
    }

    restoredDeletedCampaignCount += 1;
    mergedCampaigns.push({
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name || 'Không rõ tên campaign',
      advertiser_id: row.advertiser_id,
      advertiser_name: row.advertiser_name,
      mkt_code: row.mkt_code,
      status: 'deleted',
      raw_status: row.raw_status || 'MISSING_FROM_API_CACHE',
      date: `${row.date_key} 00:00:00`,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      cpc: row.cpc,
      cpa: row.cpa,
      ctr: row.ctr,
    });
  });

  if (restoredDeletedCampaignCount > 0) {
    console.log(`Restored ${restoredDeletedCampaignCount} deleted spend campaigns from cache for ${today}`);
  }

  return mergedCampaigns.sort((campaignA, campaignB) => campaignB.spend - campaignA.spend);
}

function normalizeCampaignStatus(status: unknown): TikTokSpentCampaign['status'] {
  const normalizedStatus = String(status ?? '').toUpperCase();

  if (
    normalizedStatus.includes('DELETE') ||
    normalizedStatus.includes('REMOVE')
  ) {
    return 'deleted';
  }

  if (
    normalizedStatus.includes('DISABLE') ||
    normalizedStatus.includes('PAUSE') ||
    normalizedStatus.includes('SUSPEND') ||
    normalizedStatus.includes('FROZEN') ||
    normalizedStatus.includes('OFFLINE')
  ) {
    return 'paused';
  }

  if ([
    'ENABLE',
    'ACTIVE',
    'RUNNING',
    'CAMPAIGN_STATUS_ENABLE',
    'AD_STATUS_DELIVERY_OK',
    'AD_STATUS_NORMAL',
    'AD_STATUS_ENABLE',
  ].includes(normalizedStatus)) {
    return 'active';
  }

  if (normalizedStatus.includes('ENABLE') || normalizedStatus.includes('ACTIVE') || normalizedStatus.includes('DELIVERY_OK')) {
    return 'active';
  }

  return 'paused';
}

function getTikTokEffectiveRawStatus(entity: Record<string, unknown>): string {
  const statusFields = [
    entity.secondary_status,
    entity.status,
    entity.opt_status,
    entity.operation_status,
  ]
    .map(value => String(value ?? '').trim())
    .filter(Boolean);

  const disabledStatus = statusFields.find(value =>
    /DELETE|REMOVE|DISABLE|PAUSE|SUSPEND|FROZEN|OFFLINE/i.test(value)
  );
  if (disabledStatus) {
    return disabledStatus;
  }

  return String(
    entity.operation_status ||
    entity.opt_status ||
    entity.status ||
    entity.secondary_status ||
    ''
  );
}

async function getCampaignStatusMap(accessToken: string, advertiserId: string): Promise<Map<string, CampaignStatusInfo>> {
  const statusMap = new Map<string, CampaignStatusInfo>();
  const fetchStatuses = async (filtering?: Record<string, string>) => {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await axios.get(`${TIKTOK_API_BASE_URL}/campaign/get/`, {
          params: {
            advertiser_id: advertiserId,
            page,
            page_size: 100,
            ...(filtering ? { filtering: JSON.stringify(filtering) } : {}),
          },
          headers: {
            'Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        });

        if (!response.data || response.data.code !== 0) {
          console.error(`Failed to get campaign statuses for advertiser ${advertiserId}:`, response.data);
          break;
        }

        const responseData = response.data.data;
        const campaignRows = responseData?.list || [];

        campaignRows.forEach((campaign: any) => {
          const campaignId = String(campaign.campaign_id || '');
          const rawStatus = getTikTokEffectiveRawStatus(campaign);

          if (campaignId) {
            statusMap.set(campaignId, {
              status: normalizeCampaignStatus(rawStatus),
              rawStatus,
              campaignName: String(campaign.campaign_name || '').trim() || undefined,
            });
          }
        });

        const pageInfo = responseData?.page_info;
        const totalRecords = Number(pageInfo?.total_number || campaignRows.length);
        const pageSize = Number(pageInfo?.page_size || 100);
        const currentPage = Number(pageInfo?.page || page);

        hasMore = currentPage * pageSize < totalRecords;
        page++;
      } catch (error: any) {
        console.error(`Error fetching campaign statuses for advertiser ${advertiserId}:`, error.message || error);
        break;
      }
    }
  };

  await fetchStatuses();
  await fetchStatuses({ primary_status: 'STATUS_DELETE' });

  return statusMap;
}

async function getAdMetadataMap(
  accessToken: string,
  advertiserId: string,
  adIds: string[]
): Promise<Map<string, AdMetadataInfo>> {
  const metadataMap = new Map<string, AdMetadataInfo>();
  const uniqueAdIds = [...new Set(adIds.filter(Boolean))];

  if (uniqueAdIds.length === 0) {
    return metadataMap;
  }

  for (const adIdChunk of chunkItems(uniqueAdIds, 100)) {
    try {
      const response = await axios.get(`${TIKTOK_API_BASE_URL}/ad/get/`, {
        params: {
          advertiser_id: advertiserId,
          page_size: 100,
          filtering: JSON.stringify({
            ad_ids: adIdChunk,
          }),
        },
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });

      if (!response.data || response.data.code !== 0) {
        console.error(`Failed to get ad metadata for advertiser ${advertiserId}:`, response.data);
        continue;
      }

      const adRows = response.data.data?.list || [];

      adRows.forEach((ad: any) => {
        const adId = String(ad.ad_id || '');
        const rawStatus = getTikTokEffectiveRawStatus(ad);

        if (!adId) {
          return;
        }

        metadataMap.set(adId, {
          adName: String(ad.ad_name || '').trim() || undefined,
          campaignId: String(ad.campaign_id || '').trim() || undefined,
          campaignName: String(ad.campaign_name || '').trim() || undefined,
          status: normalizeCampaignStatus(rawStatus),
          rawStatus,
        });
      });
    } catch (error: any) {
      console.error(`Error fetching ad metadata for advertiser ${advertiserId}:`, error.message || error);
      if (error.response) {
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
      }
    }
  }

  return metadataMap;
}

function parseSpentAdReportRow(row: any, fallbackDate: string): TikTokSpentAdReportRow {
  const dimensions = row.dimensions || row;
  const metrics = row.metrics || row;
  const spend = parseMetricNumber(metrics.spend);
  const impressions = parseMetricNumber(metrics.impressions);
  const clicks = parseMetricNumber(metrics.clicks);
  const conversions = parseMetricNumber(metrics.conversion);
  const reportedCpc = parseMetricNumber(metrics.cpc);
  const reportedCpa = parseMetricNumber(metrics.cost_per_conversion);
  const reportedCtr = parseMetricNumber(metrics.ctr);

  return {
    adId: String(dimensions.ad_id || row.ad_id || '').trim(),
    adName: String(metrics.ad_name || dimensions.ad_name || row.ad_name || '').trim() || undefined,
    campaignId: String(dimensions.campaign_id || row.campaign_id || '').trim() || undefined,
    campaignName: String(metrics.campaign_name || dimensions.campaign_name || row.campaign_name || '').trim() || undefined,
    date: String(dimensions.stat_time_day || fallbackDate),
    spend,
    impressions,
    clicks,
    conversions,
    cpc: reportedCpc || (clicks > 0 ? spend / clicks : 0),
    cpa: reportedCpa || (conversions > 0 ? spend / conversions : 0),
    ctr: reportedCtr || (impressions > 0 ? (clicks / impressions) * 100 : 0),
  };
}

async function fetchSpentAdReportRowsForAdvertiser(
  accessToken: string,
  advertiserId: string,
  today: string,
  dimensions: string[],
  metrics: string[]
): Promise<TikTokSpentAdReportRow[]> {
  const rows: TikTokSpentAdReportRow[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await axios.get(`${TIKTOK_API_BASE_URL}/report/integrated/get/`, {
      params: {
        advertiser_id: advertiserId,
        report_type: 'BASIC',
        data_level: 'AUCTION_AD',
        entity: 'AD',
        dimensions: JSON.stringify(dimensions),
        metrics: JSON.stringify(metrics),
        start_date: today,
        end_date: today,
        page,
        page_size: 100,
      },
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.data || response.data.code !== 0) {
      throw new Error(
        `Failed to get today's ad spend for advertiser ${advertiserId}: ${JSON.stringify(response.data)}`
      );
    }

    const responseData = response.data.data;
    const reportRows = responseData?.list || [];

    rows.push(
      ...reportRows
        .map((row: any) => parseSpentAdReportRow(row, today))
        .filter((row: TikTokSpentAdReportRow) => row.adId && row.spend > 0)
    );

    const pageInfo = responseData?.page_info;
    const totalRecords = Number(pageInfo?.total_number || reportRows.length);
    const pageSize = Number(pageInfo?.page_size || 100);
    const currentPage = Number(pageInfo?.page || page);

    hasMore = currentPage * pageSize < totalRecords;
    page++;
  }

  return rows;
}

async function getSpentAdReportRowsForAdvertiser(
  accessToken: string,
  advertiserId: string,
  today: string
): Promise<TikTokSpentAdReportRow[]> {
  return fetchSpentAdReportRowsForAdvertiser(
    accessToken,
    advertiserId,
    today,
    ['ad_id', 'stat_time_day'],
    ['spend', 'impressions', 'clicks', 'ctr', 'conversion', 'cost_per_conversion']
  );
}

async function supplementSpentCampaignsFromAds(
  currentCampaigns: TikTokSpentCampaign[],
  campaignStatusMaps: Map<string, Map<string, CampaignStatusInfo>>,
  advertiserAccounts: TikTokAdvertiserAccountOption[]
): Promise<TikTokSpentCampaign[]> {
  try {
    const allowedAdvertiserIds = [...campaignStatusMaps.keys()];
    const allowedAdvertiserIdSet = new Set(allowedAdvertiserIds);
    const spentAds = await getTodaySpentAds({
      advertiserIds: allowedAdvertiserIds,
      advertiserAccounts,
    });
    const currentCampaignKeys = new Set(
      currentCampaigns.map(campaign => getAdvertiserCampaignKey(campaign.advertiser_id, campaign.campaign_id))
    );
    const supplementedCampaigns = new Map<string, TikTokSpentCampaign>();

    for (const ad of spentAds) {
      if (!ad.campaign_id) {
        continue;
      }

      if (!allowedAdvertiserIdSet.has(ad.advertiser_id)) {
        continue;
      }

      const campaignKey = getAdvertiserCampaignKey(ad.advertiser_id, ad.campaign_id);
      if (currentCampaignKeys.has(campaignKey)) {
        continue;
      }

      const existingCampaign = supplementedCampaigns.get(campaignKey);
      if (!existingCampaign) {
        const campaignStatus = campaignStatusMaps.get(ad.advertiser_id)?.get(ad.campaign_id);

        supplementedCampaigns.set(campaignKey, {
          campaign_id: ad.campaign_id,
          campaign_name: ad.campaign_name || campaignStatus?.campaignName || 'Không rõ tên campaign',
          advertiser_id: ad.advertiser_id,
          advertiser_name: ad.advertiser_name,
          mkt_code: ad.mkt_code,
          status: campaignStatus?.status || 'deleted',
          raw_status: campaignStatus?.rawStatus,
          date: ad.date,
          spend: ad.spend,
          impressions: ad.impressions,
          clicks: ad.clicks,
          conversions: ad.conversions,
          cpc: ad.cpc,
          cpa: ad.cpa,
          ctr: ad.ctr,
        });
        continue;
      }

      existingCampaign.spend += ad.spend;
      existingCampaign.impressions += ad.impressions;
      existingCampaign.clicks += ad.clicks;
      existingCampaign.conversions += ad.conversions;

      if (
        (ad.campaign_name || campaignStatusMaps.get(ad.advertiser_id)?.get(ad.campaign_id)?.campaignName) &&
        (!existingCampaign.campaign_name || existingCampaign.campaign_name === 'Không rõ tên campaign')
      ) {
        existingCampaign.campaign_name =
          ad.campaign_name ||
          campaignStatusMaps.get(ad.advertiser_id)?.get(ad.campaign_id)?.campaignName ||
          existingCampaign.campaign_name;
      }
    }

    const recoveredCampaigns = [...supplementedCampaigns.values()].map(campaign => ({
      ...campaign,
      cpc: campaign.clicks > 0 ? campaign.spend / campaign.clicks : 0,
      cpa: campaign.conversions > 0 ? campaign.spend / campaign.conversions : 0,
      ctr: campaign.impressions > 0 ? (campaign.clicks / campaign.impressions) * 100 : 0,
    }));

    if (recoveredCampaigns.length > 0) {
      console.log(`Recovered ${recoveredCampaigns.length} spend campaigns from ad report fallback`);
    }

    return [...currentCampaigns, ...recoveredCampaigns];
  } catch (error) {
    console.error('Error supplementing spent campaigns from ad report:', error);
    return currentCampaigns;
  }
}

function includeActiveCampaignsWithoutSpend(
  currentCampaigns: TikTokSpentCampaign[],
  campaignStatusMaps: Map<string, Map<string, CampaignStatusInfo>>,
  advertiserAccountById: Map<string, { advertiserName?: string; mktCode?: string }>,
  dateKey: string
): TikTokSpentCampaign[] {
  const campaignKeys = new Set(
    currentCampaigns.map(campaign => getAdvertiserCampaignKey(campaign.advertiser_id, campaign.campaign_id))
  );
  const activeNoSpendCampaigns: TikTokSpentCampaign[] = [];

  for (const [advertiserId, campaignStatusMap] of campaignStatusMaps.entries()) {
    const advertiserAccount = advertiserAccountById.get(advertiserId);

    for (const [campaignId, campaignStatus] of campaignStatusMap.entries()) {
      const campaignKey = getAdvertiserCampaignKey(advertiserId, campaignId);

      if (campaignKeys.has(campaignKey) || campaignStatus.status !== 'active') {
        continue;
      }

      activeNoSpendCampaigns.push({
        campaign_id: campaignId,
        campaign_name: campaignStatus.campaignName || 'Không rõ tên campaign',
        advertiser_id: advertiserId,
        advertiser_name: advertiserAccount?.advertiserName,
        mkt_code: advertiserAccount?.mktCode,
        status: 'active',
        raw_status: campaignStatus.rawStatus,
        date: `${dateKey} 00:00:00`,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        cpc: 0,
        cpa: 0,
        ctr: 0,
      });
      campaignKeys.add(campaignKey);
    }
  }

  if (activeNoSpendCampaigns.length > 0) {
    console.log(`Included ${activeNoSpendCampaigns.length} active no-spend campaigns for ${dateKey}`);
  }

  return [...currentCampaigns, ...activeNoSpendCampaigns]
    .sort((campaignA, campaignB) =>
      campaignB.spend - campaignA.spend ||
      campaignA.campaign_name.localeCompare(campaignB.campaign_name, 'vi') ||
      campaignA.campaign_id.localeCompare(campaignB.campaign_id)
    );
}

/**
 * Get account balances for all advertisers
 */
export async function getTikTokAccountBalance(): Promise<TikTokAccountBalance[]> {
  const { accessToken, advertiserIds, advertiserAccounts, businessCenterId } = await getTikTokBalanceConfig();
  const requestedAdvertiserIds = new Set(advertiserIds);
  const advertiserAccountById = new Map(advertiserAccounts.map(account => [account.advertiserId, account]));
  const balances: TikTokAccountBalance[] = [];

  // Fail closed: không có danh sách chỉ định thì tuyệt đối không quét toàn bộ BC.
  if (requestedAdvertiserIds.size === 0) {
    return balances;
  }
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await axios.get(`${TIKTOK_API_BASE_URL}/advertiser/balance/get/`, {
      params: {
        bc_id: businessCenterId,
        page,
        page_size: 50,
      },
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.data || response.data.code !== 0) {
      console.error('Failed to get advertiser balances:', response.data);
      break;
    }

    const responseData = response.data.data;
    const accountList: TikTokAdvertiserBalanceItem[] = responseData?.advertiser_account_list || [];

    balances.push(
      ...accountList
        .filter(account => requestedAdvertiserIds.has(String(account.advertiser_id)))
        .map(account => {
          const advertiserId = String(account.advertiser_id);
          const advertiserAccount = advertiserAccountById.get(advertiserId);
          const balance = parseFloat(String(account.account_balance ?? 0)) || 0;
          const validBalance = parseFloat(String(account.valid_account_balance ?? balance)) || 0;

          return {
            mkt_code: advertiserAccount?.mktCode || undefined,
            advertiser_id: advertiserId,
            advertiser_name: advertiserAccount?.advertiserName || account.advertiser_name,
            balance,
            valid_balance: validBalance,
            currency: account.currency || 'USD',
          };
        })
    );

    const pageInfo = responseData?.page_info;
    const totalRecords = Number(pageInfo?.total_number || accountList.length);
    const pageSize = Number(pageInfo?.page_size || 50);
    const currentPage = Number(pageInfo?.page || page);

    hasMore = currentPage * pageSize < totalRecords;
    page++;
  }

  return balances;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

/**
 * Get campaigns that have spend today from reporting data.
 *
 * This uses reporting instead of campaign listing so campaigns can still be
 * returned after being paused or deleted, as long as they spent today.
 */
export async function getTodaySpentCampaigns(
  startDate?: string,
  endDate?: string,
  options: TikTokSpentCampaignOptions = {}
): Promise<TikTokSpentCampaign[]> {
  const tiktokConfig = await getTikTokConfig();
  const balanceConfig = await getTikTokBalanceConfig();
  const accessToken = tiktokConfig.accessToken;
  const allowedAdvertiserIds = new Set(tiktokConfig.advertiserIds);
  const requestedAdvertiserIds = options.advertiserIds?.length
    ? normalizeAdvertiserIds(options.advertiserIds)
    : tiktokConfig.advertiserIds;
  const advertiserIds = requestedAdvertiserIds.filter(advertiserId => allowedAdvertiserIds.has(advertiserId));
  const advertiserAccounts = options.advertiserAccounts || balanceConfig.advertiserAccounts;
  const advertiserAccountById = new Map(advertiserAccounts.map(account => [account.advertiserId, account]));
  const today = getTodayDate();
  const fetchStart = startDate || today;
  const fetchEnd = endDate || today;
  const campaignStatusMaps = new Map<string, Map<string, CampaignStatusInfo>>();
  const concurrency = Math.max(1, Math.min(options.concurrency || 4, 8));
  const skipStatusMap = options.skipStatusMap === true;
  const skipAdSupplement = options.skipAdSupplement === true;

  const perAdvertiserCampaigns = await mapWithConcurrency(advertiserIds, concurrency, async (advertiserId) => {
    const campaignStatusMap = skipStatusMap
      ? new Map<string, CampaignStatusInfo>()
      : await getCampaignStatusMap(accessToken, advertiserId);
    campaignStatusMaps.set(advertiserId, campaignStatusMap);

    const advertiserCampaigns: TikTokSpentCampaign[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await axios.get(`${TIKTOK_API_BASE_URL}/report/integrated/get/`, {
          params: {
            advertiser_id: advertiserId,
            report_type: 'BASIC',
            data_level: 'AUCTION_CAMPAIGN',
            entity: 'CAMPAIGN',
            dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
            metrics: JSON.stringify([
              'campaign_name',
              'spend',
              'impressions',
              'clicks',
              'ctr',
              'conversion',
              'cost_per_conversion',
            ]),
            start_date: fetchStart,
            end_date: fetchEnd,
            page,
            page_size: 100,
          },
          headers: {
            'Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        });

        if (!response.data || response.data.code !== 0) {
          console.error(`Failed to get today's campaign spend for advertiser ${advertiserId}:`, response.data);
          break;
        }

        const responseData = response.data.data;
        const reportRows = responseData?.list || [];
        const advertiserAccount = advertiserAccountById.get(advertiserId);

        advertiserCampaigns.push(
          ...reportRows
            .map((row: any) => {
              const dimensions = row.dimensions || row;
              const metrics = row.metrics || row;
              const spend = parseMetricNumber(metrics.spend);
              const impressions = parseMetricNumber(metrics.impressions);
              const clicks = parseMetricNumber(metrics.clicks);
              const conversions = parseMetricNumber(metrics.conversion);
              const reportedCpc = parseMetricNumber(metrics.cpc);
              const reportedCpa = parseMetricNumber(metrics.cost_per_conversion);
              const campaignId = String(dimensions.campaign_id || row.campaign_id || '');
              const campaignStatus = campaignStatusMap.get(campaignId);
              const campaignName = String(
                metrics.campaign_name ||
                dimensions.campaign_name ||
                campaignStatus?.campaignName ||
                row.campaign_name ||
                'Không rõ tên campaign'
              );

              return {
                campaign_id: campaignId,
                campaign_name: campaignName,
                advertiser_id: advertiserId,
                advertiser_name: advertiserAccount?.advertiserName,
                mkt_code: advertiserAccount?.mktCode,
                // When status map is skipped (BC path), treat as active for aggregation only.
                status: campaignStatus?.status || (skipStatusMap ? 'active' : 'deleted'),
                raw_status: campaignStatus?.rawStatus,
                date: String(dimensions.stat_time_day || today),
                spend,
                impressions,
                clicks,
                conversions,
                cpc: reportedCpc || (clicks > 0 ? spend / clicks : 0),
                cpa: reportedCpa || (conversions > 0 ? spend / conversions : 0),
                ctr: parseMetricNumber(metrics.ctr) || (impressions > 0 ? (clicks / impressions) * 100 : 0),
              };
            })
            .filter((campaign: TikTokSpentCampaign) => campaign.campaign_id && campaign.spend > 0)
        );

        const pageInfo = responseData?.page_info;
        const totalRecords = Number(pageInfo?.total_number || reportRows.length);
        const pageSize = Number(pageInfo?.page_size || 100);
        const currentPage = Number(pageInfo?.page || page);

        hasMore = currentPage * pageSize < totalRecords;
        page++;
      } catch (error: any) {
        console.error(`Error fetching today's campaign spend for advertiser ${advertiserId}:`, error.message || error);
        if (error.response) {
          console.error('Response data:', error.response.data);
          console.error('Response status:', error.response.status);
        }
        break;
      }
    }

    return advertiserCampaigns;
  });

  const campaigns = perAdvertiserCampaigns.flat();

  const shouldSupplementWithTodayAds =
    !skipAdSupplement &&
    !skipStatusMap &&
    fetchStart <= today &&
    fetchEnd >= today;
  const supplementedCampaigns = shouldSupplementWithTodayAds
    ? await supplementSpentCampaignsFromAds(campaigns, campaignStatusMaps, advertiserAccounts)
    : campaigns;

  if (fetchStart === today && fetchEnd === today && options.includeCache !== false) {
    const cachedCampaigns = await syncSpentCampaignCache(today, advertiserIds, supplementedCampaigns);

    return options.includeActiveNoSpend
      ? includeActiveCampaignsWithoutSpend(cachedCampaigns, campaignStatusMaps, advertiserAccountById, today)
      : cachedCampaigns;
  }

  if (options.includeActiveNoSpend && fetchStart <= today && fetchEnd >= today) {
    return includeActiveCampaignsWithoutSpend(supplementedCampaigns, campaignStatusMaps, advertiserAccountById, today);
  }

  return supplementedCampaigns.sort((campaignA, campaignB) => campaignB.spend - campaignA.spend);
}

export async function getTodaySpentAds(options: TikTokSpentAdOptions = {}): Promise<TikTokSpentAd[]> {
  const tiktokConfig = await getTikTokConfig();
  const balanceConfig = await getTikTokBalanceConfig();
  const accessToken = tiktokConfig.accessToken;
  const allowedAdvertiserIds = new Set(tiktokConfig.advertiserIds);
  const requestedAdvertiserIds = options.advertiserIds?.length
    ? normalizeAdvertiserIds(options.advertiserIds)
    : tiktokConfig.advertiserIds;
  const advertiserIds = requestedAdvertiserIds.filter(advertiserId => allowedAdvertiserIds.has(advertiserId));
  const advertiserAccounts = options.advertiserAccounts || balanceConfig.advertiserAccounts;
  const advertiserAccountById = new Map(advertiserAccounts.map(account => [account.advertiserId, account]));
  const today = getTodayDate();
  const ads: TikTokSpentAd[] = [];

  for (const advertiserId of advertiserIds) {
    try {
      const reportRowsForAdvertiser = await getSpentAdReportRowsForAdvertiser(accessToken, advertiserId, today);
      const metadataAdIds = reportRowsForAdvertiser.map(row => row.adId);
      const advertiserAccount = advertiserAccountById.get(advertiserId);
      const adMetadataMap = await getAdMetadataMap(
        accessToken,
        advertiserId,
        metadataAdIds
      );

      ads.push(
        ...reportRowsForAdvertiser.map(row => {
          const metadata = adMetadataMap.get(row.adId);

          return {
            ad_id: row.adId,
            ad_name: row.adName || metadata?.adName,
            campaign_id: row.campaignId || metadata?.campaignId || '',
            campaign_name: row.campaignName || metadata?.campaignName,
            advertiser_id: advertiserId,
            advertiser_name: advertiserAccount?.advertiserName,
            mkt_code: advertiserAccount?.mktCode,
            status: metadata?.status,
            raw_status: metadata?.rawStatus,
            date: row.date,
            spend: row.spend,
            impressions: row.impressions,
            clicks: row.clicks,
            conversions: row.conversions,
            cpc: row.cpc,
            cpa: row.cpa,
            ctr: row.ctr,
          };
        })
      );
    } catch (error: any) {
      console.error(`Error fetching today's ad spend for advertiser ${advertiserId}:`, error.message || error);
      if (error.response) {
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
      }
    }
  }

  return ads.sort((a, b) => b.spend - a.spend);
}

/**
 * Get all campaigns for configured advertisers
 */
export async function getCampaigns(options: { strict?: boolean } = {}): Promise<TikTokCampaign[]> {
  const { accessToken, advertiserIds } = await getTikTokConfig();

  const campaigns: TikTokCampaign[] = [];

  for (const advertiserId of advertiserIds) {
    try {
      // First, get all campaign IDs for the advertiser
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await axios.get(`${TIKTOK_API_BASE_URL}/campaign/get/`, {
          params: {
            advertiser_id: advertiserId,
            page_size: 100, // Get up to 100 campaigns per request
            page: page,
          },
          headers: {
            'Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        });

        if (response.data && response.data.code === 0) {
          const responseData = response.data.data;
          const campaignsData = responseData?.list || [];
          
          campaigns.push(...campaignsData.map((camp: any) => ({
            id: camp.campaign_id,
            advertiser_id: advertiserId,
            name: camp.campaign_name,
            status: camp.operation_status || camp.status || camp.secondary_status || '',
            objective_type: camp.objective_type,
            daily_budget: camp.daily_budget ? parseFloat(camp.daily_budget) : undefined,
            lifetime_budget: camp.lifetime_budget ? parseFloat(camp.lifetime_budget) : undefined,
            created_time: camp.create_time,
            updated_time: camp.update_time,
          })));

          // Check if there are more pages
          const totalRecords = responseData?.page_info?.total_number || 0;
          const pageSize = responseData?.page_info?.page_size || 100;
          const currentPage = responseData?.page_info?.page || 1;
          
          hasMore = currentPage * pageSize < totalRecords;
          page++;
        } else {
          const message = getTikTokApiErrorMessage(
            response.data,
            `Failed to get campaigns for advertiser ${advertiserId}`
          );
          console.error(`Failed to get campaigns for advertiser ${advertiserId}:`, response.data);
          if (options.strict) {
            throw new Error(message);
          }
          // Break the loop if there's an error
          hasMore = false;
        }
      }
    } catch (error: any) {
      console.error(`Error fetching campaigns for advertiser ${advertiserId}:`, error.message || error);
      // Check if it's an axios error with response data
      if (error.response) {
        console.error(`Response data:`, error.response.data);
        console.error(`Response status:`, error.response.status);
        console.error(`Response headers:`, error.response.headers);
      } else if (error.request) {
        console.error(`Request data:`, error.request);
      }
      if (options.strict) {
        throw error;
      }
    }
  }

  return campaigns;
}

/** Return every currently active campaign from the configured advertiser accounts. */
export async function getActiveCampaigns(options: { strict?: boolean } = {}): Promise<TikTokCampaign[]> {
  const campaigns = await getCampaigns(options);
  return campaigns.filter(campaign => normalizeCampaignStatus(campaign.status) === 'active');
}

/**
 * Get campaign performance data
 */
export async function getCampaignPerformance(
  campaignId: string,
  startDate?: string,
  endDate?: string
): Promise<TikTokCampaignPerformance[]> {
  const { accessToken, advertiserIds } = await getTikTokConfig();

  // Default to last 24 hours if no dates provided
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const start = startDate || yesterday.toISOString().split('T')[0];
  const end = endDate || now.toISOString().split('T')[0];

  // Find which advertiser the campaign belongs to
  let advertiserIdForCampaign: string | null = null;
  for (const advId of advertiserIds) {
    // We'll make a quick check to see if the campaign belongs to this advertiser
    // In practice, you might cache this mapping
    try {
      const response = await axios.get(`${TIKTOK_API_BASE_URL}/campaign/get/`, {
        params: {
          advertiser_id: advId,
          filtering: [{
            field_name: 'campaign_ids',
            operator: 'EQUALS',
            field_values: [campaignId],
          }],
          page_size: 1,
        },
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });

      if (response.data && response.data.code === 0) {
        const campaignsData = response.data.data?.list || [];
        if (campaignsData.length > 0) {
          advertiserIdForCampaign = advId;
          break;
        }
      }
    } catch (error) {
      console.error(`Error checking advertiser for campaign ${campaignId}:`, error);
    }
  }

  if (!advertiserIdForCampaign) {
    console.error(`Could not find advertiser for campaign ${campaignId}`);
    return [];
  }

  try {
    const response = await axios.post(
      `${TIKTOK_API_BASE_URL}/report/integrated_get/`,
      {
        advertiser_id: advertiserIdForCampaign,
        report_type: 'BASIC',
        entity: 'CAMPAIGN',
        dimensions: ['campaign_id', 'stat_time_day'],
        metrics: [
          'spend',
          'impressions',
          'clicks',
          'reach',
          'frequency',
          'conversions',
          'cost_per_conversion',
          'conversion_rate',
          'cpc',
          'cpm',
          'ctr',
          'video_play_actions',
          'video_views_p25',
          'video_views_p50',
          'video_views_p75',
          'video_completion_rate'
        ],
        start_date: start,
        end_date: end,
        filtering: [
          {
            field_name: 'campaign_ids',
            operator: 'IN',
            field_values: [campaignId],
          },
        ],
      },
      {
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data && response.data.code === 0) {
      const rawData = response.data.data?.list || [];
      return rawData.map((item: any) => ({
        campaign_id: item.campaign_id,
        date: item.stat_time_day,
        spend: parseFloat(item.spend) || 0,
        impressions: parseInt(item.impressions) || 0,
        clicks: parseInt(item.clicks) || 0,
        conversions: parseInt(item.conversions) || 0,
        cpc: parseFloat(item.cpc) || 0,
        cpa: parseFloat(item.cost_per_conversion) || 0,
        ctr: parseFloat(item.ctr) || 0,
      }));
    } else {
      console.error(`Failed to get performance for campaign ${campaignId}:`, response.data);
      return [];
    }
  } catch (error: any) {
    console.error(`Error fetching performance for campaign ${campaignId}:`, error.message || error);
    // Check if it's an axios error with response data
    if (error.response) {
      console.error(`Response data:`, error.response.data);
      console.error(`Response status:`, error.response.status);
      console.error(`Response headers:`, error.response.headers);
    } else if (error.request) {
      console.error(`Request data:`, error.request);
    }
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasPositiveOverride(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function getTikTokApiErrorMessage(data: any, fallback = 'Không rõ lỗi từ TikTok API'): string {
  const message = String(
    data?.message ||
    data?.msg ||
    data?.data?.message ||
    data?.error?.message ||
    ''
  ).trim();
  const code = data?.code != null ? `code=${data.code}` : '';
  const requestId = data?.request_id ? `request_id=${data.request_id}` : '';
  const detail = [message, code, requestId].filter(Boolean).join(' · ');

  return detail || fallback;
}

async function postTikTokWriteApi(
  accessToken: string,
  endpoint: string,
  payload: Record<string, unknown>
): Promise<any> {
  let response;
  try {
    response = await axios.post(
      `${TIKTOK_API_BASE_URL}/${endpoint.replace(/^\/+/, '')}`,
      payload,
      {
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error: any) {
    throw new Error(getTikTokApiErrorMessage(error?.response?.data, error?.message || String(error)));
  }

  if (response.data?.code !== 0) {
    throw new Error(getTikTokApiErrorMessage(response.data));
  }

  return response.data;
}

async function updateCampaignBudgetAfterClone(
  accessToken: string,
  advertiserId: string,
  campaignId: string,
  budget: number,
  isSmartPlusCampaign: boolean
): Promise<void> {
  const endpoints = isSmartPlusCampaign
    ? ['campaign/update/', 'campaign/spc/update/']
    : ['campaign/update/'];
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    try {
      await postTikTokWriteApi(accessToken, endpoint, {
        advertiser_id: advertiserId,
        campaign_id: campaignId,
        budget,
      });
      console.log(`[TikTok Override] Updated campaign budget ${campaignId} via ${endpoint}: ${budget}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${endpoint}: ${message}`);
      console.warn(`[TikTok Override] Campaign budget update failed via ${endpoint}: ${message}`);
    }
  }

  throw new Error(errors[0] || 'Không cập nhật được ngân sách campaign.');
}

async function getAdGroupsByCampaignId(
  accessToken: string,
  advertiserId: string,
  campaignId: string
): Promise<TikTokAdGroupRecord[]> {
  const fetchAdgroups = async (filtering?: Record<string, unknown>): Promise<TikTokAdGroupRecord[]> => {
    const rows: TikTokAdGroupRecord[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      let response;
      try {
        response = await axios.get(`${TIKTOK_API_BASE_URL}/adgroup/get/`, {
          params: {
            advertiser_id: advertiserId,
            ...(filtering ? { filtering: JSON.stringify(filtering) } : {}),
            page,
            page_size: 100,
          },
          headers: {
            'Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        });
      } catch (error: any) {
        throw new Error(getTikTokApiErrorMessage(error?.response?.data, error?.message || String(error)));
      }

      if (response.data?.code !== 0) {
        throw new Error(getTikTokApiErrorMessage(response.data));
      }

      const list = response.data.data?.list || [];
      for (const item of list) {
        const itemCampaignId = String(item?.campaign_id || '').trim();
        const matchesCampaign = filtering
          ? (!itemCampaignId || itemCampaignId === String(campaignId))
          : itemCampaignId === String(campaignId);

        if (item?.adgroup_id && matchesCampaign) {
          rows.push({
            ...item,
            advertiser_id: String(item.advertiser_id || advertiserId),
            campaign_id: itemCampaignId || String(campaignId),
            adgroup_id: String(item.adgroup_id),
          });
        }
      }

      totalPages = Number(response.data.data?.page_info?.total_page || page);
      page += 1;
    } while (page <= totalPages);

    return rows;
  };

  const filteredAdgroups = await fetchAdgroups({ campaign_ids: [campaignId] });
  if (filteredAdgroups.length > 0) {
    return filteredAdgroups;
  }

  console.warn(`[TikTok Override] Khong tim thay adgroup theo filtering campaign_ids, thu quet advertiser ${advertiserId}`);
  return fetchAdgroups();
}

async function waitForAdGroupsByCampaignId(
  accessToken: string,
  advertiserId: string,
  campaignId: string
): Promise<TikTokAdGroupRecord[]> {
  const deadline = Date.now() + 180_000;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const adgroups = await getAdGroupsByCampaignId(accessToken, advertiserId, campaignId);
      if (adgroups.length > 0) {
        return adgroups;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(3_000);
  }

  if (lastError) {
    throw new Error(lastError);
  }

  return [];
}

async function updateAdGroupBudgetAfterClone(
  accessToken: string,
  advertiserId: string,
  adgroupId: string,
  budget: number
): Promise<void> {
  await postTikTokWriteApi(accessToken, 'adgroup/update/', {
    advertiser_id: advertiserId,
    adgroup_id: adgroupId,
    budget,
  });
}

function getBidUpdateFieldCandidates(adgroup: TikTokAdGroupRecord): string[] {
  const candidates: string[] = [];
  const addCandidate = (field: string): void => {
    if (!candidates.includes(field)) {
      candidates.push(field);
    }
  };

  if (adgroup.conversion_bid_price != null) addCandidate('conversion_bid_price');
  if (adgroup.bid_price != null) addCandidate('bid_price');
  if (adgroup.bid != null) addCandidate('bid');
  if (adgroup.deep_bid != null) addCandidate('deep_bid');

  addCandidate('conversion_bid_price');
  addCandidate('bid_price');
  addCandidate('bid');

  return candidates;
}

function parsePositiveSettingNumber(value: unknown): number | undefined {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getCampaignBudgetSetting(campaign: TikTokCampaignRecord): number | undefined {
  const rawCampaign = campaign as unknown as Record<string, unknown>;
  const budgetFields = [
    'budget',
    'daily_budget',
    'lifetime_budget',
    'campaign_budget',
    'campaign_budget_value',
  ];

  for (const field of budgetFields) {
    const value = parsePositiveSettingNumber(rawCampaign[field]);
    if (value != null) {
      return value;
    }
  }

  return undefined;
}

function getAdGroupBudgetSetting(adgroups: TikTokAdGroupRecord[]): number | undefined {
  for (const adgroup of adgroups) {
    const value = parsePositiveSettingNumber(adgroup.budget);
    if (value != null) {
      return value;
    }
  }

  return undefined;
}

function getAdGroupBidSetting(adgroups: TikTokAdGroupRecord[]): number | undefined {
  const bidFields = [
    'conversion_bid_price',
    'bid_price',
    'bid',
    'deep_bid',
    'target_cpa',
    'target_cpa_bid',
    'target_cost',
    'cost_cap',
    'cost_cap_bid',
    'cpabid',
    'ocpc_bid',
    'oecpc_bid',
  ];

  for (const adgroup of adgroups) {
    const rawAdgroup = adgroup as Record<string, unknown>;
    for (const field of bidFields) {
      const value = parsePositiveSettingNumber(rawAdgroup[field]);
      if (value != null) {
        return value;
      }
    }
  }

  return undefined;
}

export async function getCampaignCloneDefaults(campaignId: string): Promise<TikTokCampaignCloneDefaults> {
  const { accessToken } = await getTikTokConfig();
  const campaign = await getRawCampaignById(campaignId);

  if (!campaign) {
    return { campaignId };
  }

  let adgroups: TikTokAdGroupRecord[] = [];
  try {
    adgroups = await getAdGroupsByCampaignId(accessToken, campaign.advertiser_id, campaignId);
  } catch (error) {
    console.warn(`Không lấy được adgroup để đọc ngân sách/thầu camp ${campaignId}:`, error);
  }

  return {
    campaignId,
    advertiserId: campaign.advertiser_id,
    campaignName: campaign.campaign_name,
    budget: getCampaignBudgetSetting(campaign) ?? getAdGroupBudgetSetting(adgroups),
    bid: getAdGroupBidSetting(adgroups),
    status: normalizeCampaignStatus(
      `${campaign.operation_status || ''} ${campaign.secondary_status || ''}`
    ),
  };
}

async function updateAdGroupBidAfterClone(
  accessToken: string,
  advertiserId: string,
  adgroup: TikTokAdGroupRecord,
  bid: number
): Promise<void> {
  const adgroupId = String(adgroup.adgroup_id || '').trim();
  const errors: string[] = [];

  if (!adgroupId) {
    throw new Error('Thiếu adgroup_id.');
  }

  for (const bidField of getBidUpdateFieldCandidates(adgroup)) {
    try {
      await postTikTokWriteApi(accessToken, 'adgroup/update/', {
        advertiser_id: advertiserId,
        adgroup_id: adgroupId,
        [bidField]: bid,
      });
      console.log(`[TikTok Override] Updated adgroup bid ${adgroupId} field ${bidField}: ${bid}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${bidField}: ${message}`);
    }
  }

  throw new Error(errors[0] || 'Không cập nhật được giá thầu adgroup.');
}

async function applyCloneOverridesAfterCreate(params: {
  accessToken: string;
  advertiserId: string;
  campaignId: string;
  options?: {
    overrideBudget?: number;
    overrideBid?: number;
  };
  isSmartPlusCampaign: boolean;
}): Promise<void> {
  const budget = params.options?.overrideBudget;
  const bid = params.options?.overrideBid;
  let adgroups: TikTokAdGroupRecord[] | undefined;

  if (hasPositiveOverride(budget)) {
    const errors: string[] = [];
    let updated = false;

    if (!params.isSmartPlusCampaign) {
      try {
        await updateCampaignBudgetAfterClone(
          params.accessToken,
          params.advertiserId,
          params.campaignId,
          budget,
          false
        );
        updated = true;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    try {
      adgroups = await waitForAdGroupsByCampaignId(
        params.accessToken,
        params.advertiserId,
        params.campaignId
      );
      let adgroupBudgetUpdates = 0;
      for (const adgroup of adgroups) {
        const adgroupId = String(adgroup.adgroup_id || '').trim();
        if (!adgroupId) continue;

        try {
          await updateAdGroupBudgetAfterClone(
            params.accessToken,
            params.advertiserId,
            adgroupId,
            budget
          );
          adgroupBudgetUpdates += 1;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      updated = updated || adgroupBudgetUpdates > 0;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    if (!updated) {
      throw new Error(`Không cập nhật được ngân sách camp mới ${params.campaignId}: ${errors[0] || 'TikTok không nhận thay đổi ngân sách.'}`);
    }
  }

  if (hasPositiveOverride(bid)) {
    if (!adgroups) {
      adgroups = await waitForAdGroupsByCampaignId(
        params.accessToken,
        params.advertiserId,
        params.campaignId
      );
    }

    if (adgroups.length === 0) {
      throw new Error(`Không tìm thấy adgroup của camp mới ${params.campaignId} để cập nhật giá thầu.`);
    }

    const errors: string[] = [];
    let updatedCount = 0;

    for (const adgroup of adgroups) {
      try {
        await updateAdGroupBidAfterClone(
          params.accessToken,
          params.advertiserId,
          adgroup,
          bid
        );
        updatedCount += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (updatedCount !== adgroups.length) {
      throw new Error(
        `Cập nhật giá thầu camp mới ${params.campaignId} chưa đủ (${updatedCount}/${adgroups.length} adgroup): ${errors[0] || 'TikTok không nhận thay đổi giá thầu.'}`
      );
    }
  }
}

/**
 * Create a new campaign by duplicating an existing one
 */
export async function duplicateCampaign(
  originalCampaignId: string,
  options?: {
    newName?: string;
    overrideBudget?: number;
    overrideBid?: number;
    actor?: string;
  }
): Promise<TikTokDuplicateCampaignResult | null> {
  return executeOfficialDuplicate(originalCampaignId, options);
}

/**
 * Toggle the status of a campaign (enable/disable)
 */
export async function toggleCampaignStatus(campaignId: string): Promise<string | null> {
  // Find the campaign to get its current status
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    console.error(`Campaign not found: ${campaignId}`);
    return null;
  }

  // Determine the new status based on current status
  const normalizedStatus = normalizeCampaignStatus(campaign.status);
  const newStatus: TikTokCampaignOperationStatus = normalizedStatus === 'active' ? 'DISABLE' : 'ENABLE';

  return setCampaignStatus(campaign.advertiser_id, campaignId, newStatus);
}

export async function setCampaignStatusById(
  campaignId: string,
  operationStatus: TikTokCampaignOperationStatus
): Promise<TikTokSpentCampaign['status']> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    throw new Error(`Không tìm thấy chiến dịch ${campaignId}`);
  }

  const currentStatus = normalizeCampaignStatus(campaign.status);
  const targetStatus = normalizeCampaignStatus(operationStatus);

  if (currentStatus === targetStatus) {
    return currentStatus;
  }

  return setCampaignStatus(campaign.advertiser_id, campaignId, operationStatus);
}

export async function setCampaignStatus(
  advertiserId: string,
  campaignId: string,
  operationStatus: TikTokCampaignOperationStatus
): Promise<TikTokSpentCampaign['status']> {
  await assertAdvertiserAllowed(advertiserId);
  const accessToken = await getTikTokWriteAccessToken();

  try {
    const response = await axios.post(
      `${TIKTOK_API_BASE_URL}/campaign/status/update/`,
      {
        advertiser_id: advertiserId,
        campaign_ids: [campaignId],
        operation_status: operationStatus,
      },
      {
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data && response.data.code === 0) {
      const normalizedStatus = normalizeCampaignStatus(operationStatus);
      console.log(`Campaign status updated successfully. New status: ${operationStatus}`);
      return normalizedStatus;
    }

    const errorMessage = String(response.data?.message || '').trim() || 'Không rõ lỗi từ TikTok API';
    console.error(`Failed to update campaign status for ${campaignId}:`, response.data);
    throw new Error(errorMessage);
  } catch (error: any) {
    const apiMessage = String(error?.response?.data?.message || '').trim();
    const errorMessage = apiMessage || error?.message || String(error);
    console.error(`Error updating campaign status for ${campaignId}:`, errorMessage);
    if (error.response) {
      console.error(`Response data:`, error.response.data);
      console.error(`Response status:`, error.response.status);
      console.error(`Response headers:`, error.response.headers);
    } else if (error.request) {
      console.error(`Request data:`, error.request);
    }

    throw new Error(errorMessage);
  }
}

const CAMPAIGN_STATUS_BATCH_SIZE = 20;

/**
 * Update many campaigns while reading the write token only once.
 * Requests are grouped by advertiser and sent in conservative batches. If a
 * batch fails, retry each campaign in that batch so callers receive exact
 * campaign-level failures and can safely retry only what remains active.
 */
export async function setCampaignStatusesBatch(
  campaigns: TikTokCampaignStatusRef[],
  operationStatus: TikTokCampaignOperationStatus
): Promise<TikTokCampaignStatusBatchResult> {
  const uniqueCampaigns = new Map<string, TikTokCampaignStatusRef>();

  for (const campaign of campaigns) {
    const advertiserId = String(campaign.advertiserId || '').trim();
    const campaignId = String(campaign.campaignId || '').trim();
    if (!advertiserId || !campaignId) {
      continue;
    }
    uniqueCampaigns.set(`${advertiserId}:${campaignId}`, { advertiserId, campaignId });
  }

  const normalizedCampaigns = [...uniqueCampaigns.values()];
  if (normalizedCampaigns.length === 0) {
    return { succeeded: [], failed: [] };
  }

  const allowedAdvertiserIds = new Set(await getAllowedAdvertiserIds(true));
  const allowedCampaigns = normalizedCampaigns.filter(campaign => allowedAdvertiserIds.has(campaign.advertiserId));
  const permissionFailures: TikTokCampaignStatusFailure[] = normalizedCampaigns
    .filter(campaign => !allowedAdvertiserIds.has(campaign.advertiserId))
    .map(campaign => ({
      ...campaign,
      error: `TKQC ${campaign.advertiserId} chưa được chỉ định trong mục Tài khoản quảng cáo.`,
    }));

  if (allowedCampaigns.length === 0) {
    return { succeeded: [], failed: permissionFailures };
  }

  const accessToken = await getTikTokWriteAccessToken();
  const byAdvertiser = new Map<string, TikTokCampaignStatusRef[]>();

  for (const campaign of allowedCampaigns) {
    const items = byAdvertiser.get(campaign.advertiserId) || [];
    items.push(campaign);
    byAdvertiser.set(campaign.advertiserId, items);
  }

  const succeeded: TikTokCampaignStatusRef[] = [];
  const failed: TikTokCampaignStatusFailure[] = [...permissionFailures];

  const updateChunk = async (
    advertiserId: string,
    chunk: TikTokCampaignStatusRef[]
  ): Promise<void> => {
    await postTikTokWriteApi(accessToken, 'campaign/status/update/', {
      advertiser_id: advertiserId,
      campaign_ids: chunk.map(campaign => campaign.campaignId),
      operation_status: operationStatus,
    });
  };

  for (const [advertiserId, advertiserCampaigns] of byAdvertiser.entries()) {
    for (let index = 0; index < advertiserCampaigns.length; index += CAMPAIGN_STATUS_BATCH_SIZE) {
      const chunk = advertiserCampaigns.slice(index, index + CAMPAIGN_STATUS_BATCH_SIZE);

      try {
        await updateChunk(advertiserId, chunk);
        succeeded.push(...chunk);
      } catch (batchError) {
        if (chunk.length === 1) {
          failed.push({
            ...chunk[0],
            error: batchError instanceof Error ? batchError.message : String(batchError),
          });
          continue;
        }

        for (const campaign of chunk) {
          try {
            await updateChunk(advertiserId, [campaign]);
            succeeded.push(campaign);
          } catch (campaignError) {
            failed.push({
              ...campaign,
              error: campaignError instanceof Error ? campaignError.message : String(campaignError),
            });
          }
        }
      }
    }
  }

  return { succeeded, failed };
}

async function getAdsByCampaignId(
  accessToken: string,
  advertiserId: string,
  campaignId: string
): Promise<Array<{ adId: string; status: TikTokSpentAd['status']; rawStatus: string }>> {
  const statuses = await getAdsByCampaignIds(accessToken, advertiserId, [campaignId]);
  return statuses[0]?.ads || [];
}

async function getAdsByCampaignIds(
  accessToken: string,
  advertiserId: string,
  campaignIds: string[]
): Promise<TikTokCampaignAdsStatus[]> {
  const uniqueCampaignIds = [...new Set(campaignIds.map(id => String(id || '').trim()).filter(Boolean))];
  const adsByCampaignId = new Map<string, TikTokCampaignAdsStatus['ads']>();

  uniqueCampaignIds.forEach(campaignId => {
    adsByCampaignId.set(campaignId, []);
  });

  if (uniqueCampaignIds.length === 0) {
    return [];
  }

  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await axios.get(`${TIKTOK_API_BASE_URL}/ad/get/`, {
      params: {
        advertiser_id: advertiserId,
        page,
        page_size: 100,
        filtering: JSON.stringify({
          campaign_ids: uniqueCampaignIds,
        }),
      },
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.data || response.data.code !== 0) {
      const errorMessage = String(response.data?.message || '').trim() || 'Không lấy được danh sách quảng cáo từ TikTok API';
      throw new Error(errorMessage);
    }

    const responseData = response.data.data;
    const adRows = responseData?.list || [];
    adRows.forEach((ad: any) => {
      const adId = String(ad.ad_id || '').trim();
      const campaignId = String(ad.campaign_id || '').trim();
      const rawStatus = getTikTokEffectiveRawStatus(ad);

      if (adId && campaignId) {
        const campaignAds = adsByCampaignId.get(campaignId) || [];
        campaignAds.push({
          adId,
          status: normalizeCampaignStatus(rawStatus),
          rawStatus,
        });
        adsByCampaignId.set(campaignId, campaignAds);
      }
    });

    const pageInfo = responseData?.page_info;
    const totalRecords = Number(pageInfo?.total_number || adRows.length);
    const pageSize = Number(pageInfo?.page_size || 100);
    const currentPage = Number(pageInfo?.page || page);

    hasMore = currentPage * pageSize < totalRecords;
    page++;
  }

  return uniqueCampaignIds.map(campaignId => ({
    advertiserId,
    campaignId,
    ads: adsByCampaignId.get(campaignId) || [],
  }));
}

export async function getCampaignAdsStatuses(
  campaigns: Array<{ advertiser_id: string; campaign_id: string }>
): Promise<TikTokCampaignAdsStatus[]> {
  const { accessToken } = await getTikTokConfig();
  const campaignIdsByAdvertiser = new Map<string, string[]>();
  const results: TikTokCampaignAdsStatus[] = [];

  for (const campaign of campaigns) {
    const advertiserId = String(campaign.advertiser_id || '').trim();
    const campaignId = String(campaign.campaign_id || '').trim();

    if (!advertiserId || !campaignId) {
      continue;
    }

    const advertiserCampaignIds = campaignIdsByAdvertiser.get(advertiserId) || [];
    advertiserCampaignIds.push(campaignId);
    campaignIdsByAdvertiser.set(advertiserId, advertiserCampaignIds);
  }

  for (const [advertiserId, campaignIds] of campaignIdsByAdvertiser.entries()) {
    for (let index = 0; index < campaignIds.length; index += 50) {
      const campaignIdBatch = campaignIds.slice(index, index + 50);
      const batchStatuses = await getAdsByCampaignIds(accessToken, advertiserId, campaignIdBatch);
      results.push(...batchStatuses);
    }
  }

  return results;
}

async function setCampaignAdsStatusViaOpenApiAds(
  accessToken: string,
  advertiserId: string,
  campaignId: string,
  adIds: string[],
  operationStatus: TikTokCampaignOperationStatus
): Promise<void> {
  const response = await axios.post(
    `${TIKTOK_API_BASE_URL}/ad/status/update/`,
    {
      advertiser_id: advertiserId,
      ad_ids: adIds,
      operation_status: operationStatus,
    },
    {
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );

  if (!response.data || response.data.code !== 0) {
    const errorMessage = getTikTokApiErrorMessage(response.data);
    console.error(`Failed to update ad status for campaign ${campaignId}:`, response.data);
    throw new Error(errorMessage);
  }
}

async function setCampaignStatusViaOpenApi(
  accessToken: string,
  advertiserId: string,
  campaignId: string,
  operationStatus: TikTokCampaignOperationStatus
): Promise<void> {
  const response = await axios.post(
    `${TIKTOK_API_BASE_URL}/campaign/status/update/`,
    {
      advertiser_id: advertiserId,
      campaign_ids: [campaignId],
      operation_status: operationStatus,
    },
    {
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );

  if (!response.data || response.data.code !== 0) {
    const errorMessage = getTikTokApiErrorMessage(response.data);
    console.error(`Failed to update campaign status for ${campaignId}:`, response.data);
    throw new Error(errorMessage);
  }
}

/**
 * Bật/tắt delivery — CHỈ ở cấp campaign (`campaign/status/update`).
 * Không còn ad/status/update hay Ads Manager creative list.
 *
 * Tên giữ setCampaignAdsStatus để tương thích call-site; hành vi = campaign only.
 */
export async function setCampaignAdsStatus(
  advertiserId: string,
  campaignId: string,
  operationStatus: TikTokCampaignOperationStatus
): Promise<TikTokAdStatusUpdateResult> {
  const status = await setCampaignStatus(advertiserId, campaignId, operationStatus);

  return {
    advertiserId,
    campaignId,
    adIds: [],
    status,
  };
}

export async function setCampaignAdsStatusByCampaignId(
  campaignId: string,
  operationStatus: TikTokCampaignOperationStatus
): Promise<TikTokAdStatusUpdateResult> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    throw new Error(`Không tìm thấy chiến dịch ${campaignId}`);
  }

  const status = await setCampaignStatus(campaign.advertiser_id, campaignId, operationStatus);

  return {
    advertiserId: campaign.advertiser_id,
    campaignId,
    adIds: [],
    status,
  };
}

/**
 * Get a specific campaign by ID
 */
async function getCampaignById(campaignId: string): Promise<TikTokCampaign | null> {
  const campaigns = await getCampaigns();
  return campaigns.find(camp => camp.id === campaignId) || null;
}

async function getRawCampaignById(campaignId: string): Promise<TikTokCampaignRecord | null> {
  const { accessToken, advertiserIds } = await getTikTokConfig();

  for (const advertiserId of advertiserIds) {
    try {
      const response = await axios.get(`${TIKTOK_API_BASE_URL}/campaign/get/`, {
        params: {
          advertiser_id: advertiserId,
          filtering: JSON.stringify({
            campaign_ids: [campaignId],
          }),
          page: 1,
          page_size: 10,
        },
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });

      if (response.data?.code !== 0) {
        continue;
      }

      const campaign = response.data.data?.list?.[0];
      if (campaign) {
        return {
          ...campaign,
          advertiser_id: String(campaign.advertiser_id || advertiserId),
          campaign_id: String(campaign.campaign_id || campaignId),
        };
      }
    } catch (error: any) {
      console.error(`Error fetching raw campaign ${campaignId} for advertiser ${advertiserId}:`, error.message || error);
    }
  }

  return null;
}

