import axios from 'axios';
import { getCampaigns } from './api.js';
import { getTikTokConfig, getTikTokWriteAccessToken } from './config.js';

const TIKTOK_API_BASE_URL = 'https://business-api.tiktok.com/open_api/v1.3';
const SMART_PLUS_AD_PAGE_SIZE = 100;

export type SmartPlusOperationStatus = 'ENABLE' | 'DISABLE';

export interface SmartPlusAdInfo {
  advertiserId: string;
  campaignId?: string;
  smartPlusAdId: string;
  adName?: string;
  operationStatus?: string;
  primaryStatus?: string;
  secondaryStatus?: string;
}

export interface SmartPlusCampaignAdsResult {
  advertiserId: string;
  campaignId: string;
  campaignName?: string;
  ads: SmartPlusAdInfo[];
}

function getTikTokApiErrorMessage(data: any, fallback: string): string {
  const message = String(data?.message || data?.msg || data?.data?.message || '').trim();
  const code = data?.code != null ? `code=${data.code}` : '';
  const requestId = data?.request_id ? `request_id=${data.request_id}` : '';
  return [message || fallback, code, requestId].filter(Boolean).join(' · ');
}

function parseSmartPlusAd(
  raw: any,
  advertiserId: string,
  fallbackCampaignId?: string
): SmartPlusAdInfo | undefined {
  const smartPlusAdId = String(
    raw?.smart_plus_ad_id ||
    raw?.smart_plus_ad?.smart_plus_ad_id ||
    ''
  ).trim();

  if (!smartPlusAdId) {
    return undefined;
  }

  return {
    advertiserId,
    campaignId: String(raw?.campaign_id || fallbackCampaignId || '').trim() || undefined,
    smartPlusAdId,
    adName: String(raw?.ad_name || raw?.smart_plus_ad_name || raw?.name || '').trim() || undefined,
    operationStatus: raw?.operation_status != null ? String(raw.operation_status) : undefined,
    primaryStatus: raw?.primary_status != null ? String(raw.primary_status) : undefined,
    secondaryStatus: raw?.secondary_status != null ? String(raw.secondary_status) : undefined,
  };
}

async function fetchSmartPlusAds(params: {
  accessToken: string;
  advertiserId: string;
  filtering: Record<string, unknown>;
  fallbackCampaignId?: string;
}): Promise<SmartPlusAdInfo[]> {
  const ads: SmartPlusAdInfo[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    let response;
    try {
      response = await axios.get(`${TIKTOK_API_BASE_URL}/smart_plus/ad/get/`, {
        params: {
          advertiser_id: params.advertiserId,
          filtering: JSON.stringify(params.filtering),
          page,
          page_size: SMART_PLUS_AD_PAGE_SIZE,
        },
        headers: {
          'Access-Token': params.accessToken,
          'Content-Type': 'application/json',
        },
      });
    } catch (error: any) {
      throw new Error(
        getTikTokApiErrorMessage(
          error?.response?.data,
          error?.message || 'Không gọi được smart_plus/ad/get'
        )
      );
    }

    const data = response.data;
    if (data?.code != null && Number(data.code) !== 0) {
      throw new Error(getTikTokApiErrorMessage(data, 'TikTok từ chối smart_plus/ad/get'));
    }

    const responseData = data?.data || {};
    const rows = Array.isArray(responseData?.list)
      ? responseData.list
      : Array.isArray(responseData?.smart_plus_ad_list)
        ? responseData.smart_plus_ad_list
        : [];

    for (const row of rows) {
      const parsed = parseSmartPlusAd(row, params.advertiserId, params.fallbackCampaignId);
      if (parsed) {
        ads.push(parsed);
      }
    }

    const pageInfo = responseData?.page_info || {};
    const totalNumber = Number(pageInfo?.total_number ?? rows.length);
    const pageSize = Number(pageInfo?.page_size ?? SMART_PLUS_AD_PAGE_SIZE);
    const currentPage = Number(pageInfo?.page ?? page);
    hasMore = Number.isFinite(totalNumber) && totalNumber > currentPage * pageSize;
    page += 1;
  }

  return ads;
}

export async function getSmartPlusAdsByCampaignId(
  campaignId: string
): Promise<SmartPlusCampaignAdsResult> {
  const normalizedCampaignId = String(campaignId || '').trim();
  if (!normalizedCampaignId) {
    throw new Error('Thiếu campaign_id.');
  }

  const tiktokConfig = await getTikTokConfig();
  const campaigns = await getCampaigns();
  const campaign = campaigns.find(item => item.id === normalizedCampaignId);

  const candidates = campaign?.advertiser_id
    ? [campaign.advertiser_id]
    : tiktokConfig.advertiserIds;

  const errors: string[] = [];

  for (const advertiserId of candidates) {
    try {
      const ads = await fetchSmartPlusAds({
        accessToken: tiktokConfig.accessToken,
        advertiserId,
        filtering: { campaign_ids: [normalizedCampaignId] },
        fallbackCampaignId: normalizedCampaignId,
      });

      if (ads.length > 0) {
        return {
          advertiserId,
          campaignId: normalizedCampaignId,
          campaignName: campaign?.name,
          ads,
        };
      }
    } catch (error) {
      errors.push(`${advertiserId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const detail = errors.length > 0 ? `\n${errors.slice(0, 3).join('\n')}` : '';
  throw new Error(
    `Không tìm thấy Smart+ Ad cho campaign ${normalizedCampaignId} qua /smart_plus/ad/get/.${detail}`
  );
}

export async function getSmartPlusAdById(
  advertiserId: string,
  smartPlusAdId: string
): Promise<SmartPlusAdInfo | undefined> {
  const { accessToken } = await getTikTokConfig();
  const ads = await fetchSmartPlusAds({
    accessToken,
    advertiserId,
    filtering: { smart_plus_ad_ids: [smartPlusAdId] },
  });
  return ads.find(ad => ad.smartPlusAdId === String(smartPlusAdId));
}

export async function setSmartPlusAdStatus(
  advertiserId: string,
  smartPlusAdId: string,
  operationStatus: SmartPlusOperationStatus
): Promise<{ requestId?: string; verifiedAd?: SmartPlusAdInfo }> {
  const accessToken = await getTikTokWriteAccessToken();

  let response;
  try {
    response = await axios.post(
      `${TIKTOK_API_BASE_URL}/smart_plus/ad/status/update/`,
      {
        advertiser_id: String(advertiserId),
        smart_plus_ad_ids: [String(smartPlusAdId)],
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
  } catch (error: any) {
    throw new Error(
      getTikTokApiErrorMessage(
        error?.response?.data,
        error?.message || 'Không gọi được smart_plus/ad/status/update'
      )
    );
  }

  const data = response.data;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      getTikTokApiErrorMessage(data, `smart_plus/ad/status/update HTTP ${response.status}`)
    );
  }

  if (data?.code != null && Number(data.code) !== 0) {
    throw new Error(
      getTikTokApiErrorMessage(data, 'TikTok từ chối smart_plus/ad/status/update')
    );
  }

  await new Promise(resolve => setTimeout(resolve, 1500));

  let verifiedAd: SmartPlusAdInfo | undefined;
  try {
    verifiedAd = await getSmartPlusAdById(advertiserId, smartPlusAdId);
  } catch (error) {
    console.warn('[SmartPlus Test] Status update accepted but verification GET failed:', error);
  }

  return {
    requestId: data?.request_id ? String(data.request_id) : undefined,
    verifiedAd,
  };
}
