import axios from 'axios';
import { db } from '../db/index.js';
import { getTikTokConfig, getTikTokWriteAccessToken } from './config.js';

const TIKTOK_API_BASE_URL = 'https://business-api.tiktok.com/open_api/v1.3';
const REVIEW_BATCH_SIZE = 100;
const REVIEW_QPS_BACKOFF_MS = [0, 2_000, 5_000, 10_000, 20_000, 40_000] as const;
const APPEAL_QPS_BACKOFF_MS = [0, 3_000, 7_000, 15_000] as const;
const APPEAL_REQUEST_SPACING_MS = 1_200;

export type SmartPlusAppealOutcome =
  | 'SUCCESS'
  | 'NO_TICKET'
  | 'QPS_LIMIT'
  | 'OTHER_ERROR'
  | 'TRANSPORT_ERROR';

export interface SmartPlusAppealRunOptions {
  /** Ignore local history and retry all currently rejected ads. */
  forceRescan?: boolean;
  onProgress?: (message: string) => void | Promise<void>;
}

export interface SmartPlusAppealRunSummary {
  forceRescan: boolean;
  advertiserCount: number;
  scannedAds: number;
  rejectedAds: number;
  attempted: number;
  skippedHistory: number;
  skippedAppealStatus: number;
  success: number;
  noTicket: number;
  qpsLimit: number;
  otherError: number;
  transportError: number;
  scanErrors: string[];
}

interface SmartPlusCreativeRecord {
  ad_material_id?: string;
}

interface SmartPlusAdRecord {
  advertiser_id?: string;
  smart_plus_ad_id?: string;
  campaign_id?: string;
  secondary_status?: string;
  creative_list?: SmartPlusCreativeRecord[];
}

interface SmartPlusAdReviewInfo {
  smart_plus_ad_id?: string;
  review_status?: string;
  appeal_status?: string;
}

interface SmartPlusMaterialReviewInfo {
  ad_material_id?: string;
  smart_plus_ad_id?: string;
  reject_info?: unknown[];
}

interface SmartPlusReviewResponseData {
  smart_plus_ad_review_infos?: SmartPlusAdReviewInfo[];
  material_review_infos?: SmartPlusMaterialReviewInfo[];
}

interface RejectedSmartPlusAd {
  advertiserId: string;
  smartPlusAdId: string;
  campaignId?: string;
  secondaryStatus?: string;
  reviewStatus?: string;
  appealStatus?: string;
  rejectedMaterialCount: number;
}

interface AppealApiResult {
  outcome: SmartPlusAppealOutcome;
  code?: number;
  message?: string;
  requestId?: string;
}

interface AttemptedAdRow {
  smart_plus_ad_id: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function getApiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data as { message?: unknown } | undefined;
    return String(responseData?.message || error.message || 'Unknown TikTok API error');
  }

  return error instanceof Error ? error.message : String(error);
}

async function emitProgress(
  callback: SmartPlusAppealRunOptions['onProgress'],
  message: string
): Promise<void> {
  if (!callback) {
    return;
  }

  try {
    await callback(message);
  } catch (error) {
    console.error('Smart+ appeal progress callback failed:', error);
  }
}

async function getAllSmartPlusAds(
  advertiserId: string,
  readToken: string
): Promise<SmartPlusAdRecord[]> {
  const ads: SmartPlusAdRecord[] = [];
  let page = 1;
  let totalPage = 1;

  do {
    const response = await axios.get(
      `${TIKTOK_API_BASE_URL}/smart_plus/ad/get/`,
      {
        params: {
          advertiser_id: advertiserId,
          page,
          page_size: 100,
        },
        headers: {
          'Access-Token': readToken,
          Accept: 'application/json',
        },
        timeout: 30_000,
      }
    );

    const payload = response.data as {
      code?: number;
      message?: string;
      data?: {
        list?: SmartPlusAdRecord[];
        page_info?: { total_page?: number | string };
      };
    };

    if (Number(payload.code || 0) !== 0) {
      throw new Error(
        `smart_plus/ad/get failed: code=${payload.code} message=${payload.message || ''}`
      );
    }

    ads.push(...(payload.data?.list || []));
    totalPage = Math.max(1, Number(payload.data?.page_info?.total_page || 1));
    page += 1;
  } while (page <= totalPage);

  return ads;
}

async function getReviewBatch(
  advertiserId: string,
  smartPlusAdIds: string[],
  readToken: string
): Promise<SmartPlusReviewResponseData> {
  for (let attempt = 0; attempt < REVIEW_QPS_BACKOFF_MS.length; attempt += 1) {
    const waitMs = REVIEW_QPS_BACKOFF_MS[attempt];
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const params = new URLSearchParams();
    params.set('advertiser_id', advertiserId);
    params.set('smart_plus_ad_ids', JSON.stringify(smartPlusAdIds));
    params.set(
      'extra_info_setting',
      JSON.stringify({
        include_reject_info: true,
        include_violation_frame: false,
      })
    );
    params.set('lang', 'en');

    const response = await axios.get(
      `${TIKTOK_API_BASE_URL}/smart_plus/ad/review_info/?${params.toString()}`,
      {
        headers: {
          'Access-Token': readToken,
          Accept: 'application/json',
        },
        timeout: 60_000,
      }
    );

    const payload = response.data as {
      code?: number;
      message?: string;
      data?: SmartPlusReviewResponseData;
    };
    const message = String(payload.message || '');

    if (message.toUpperCase().includes('OVER_QPS_LIMIT')) {
      if (attempt === REVIEW_QPS_BACKOFF_MS.length - 1) {
        throw new Error('smart_plus/ad/review_info QPS retry exhausted');
      }
      continue;
    }

    if (Number(payload.code || 0) !== 0) {
      throw new Error(
        `smart_plus/ad/review_info failed: code=${payload.code} message=${message}`
      );
    }

    return payload.data || {};
  }

  throw new Error('smart_plus/ad/review_info retry exhausted');
}

async function findRejectedSmartPlusAds(
  advertiserId: string,
  readToken: string
): Promise<{ scannedAds: number; rejectedAds: RejectedSmartPlusAd[] }> {
  const ads = await getAllSmartPlusAds(advertiserId, readToken);
  const adMap = new Map<string, SmartPlusAdRecord>();
  const currentMaterialIdsByAd = new Map<string, Set<string>>();

  for (const ad of ads) {
    const smartPlusAdId = String(ad.smart_plus_ad_id || '');
    if (!smartPlusAdId) {
      continue;
    }

    adMap.set(smartPlusAdId, ad);
    currentMaterialIdsByAd.set(
      smartPlusAdId,
      new Set(
        (ad.creative_list || [])
          .map(creative => String(creative.ad_material_id || ''))
          .filter(Boolean)
      )
    );
  }

  const reviewByAd = new Map<string, SmartPlusAdReviewInfo>();
  const rejectedMaterialIdsByAd = new Map<string, Set<string>>();
  const batches = chunkItems([...adMap.keys()], REVIEW_BATCH_SIZE);

  for (const batch of batches) {
    const reviewData = await getReviewBatch(advertiserId, batch, readToken);

    for (const review of reviewData.smart_plus_ad_review_infos || []) {
      const smartPlusAdId = String(review.smart_plus_ad_id || '');
      if (smartPlusAdId) {
        reviewByAd.set(smartPlusAdId, review);
      }
    }

    for (const materialReview of reviewData.material_review_infos || []) {
      if (!Array.isArray(materialReview.reject_info) || materialReview.reject_info.length === 0) {
        continue;
      }

      const smartPlusAdId = String(materialReview.smart_plus_ad_id || '');
      const adMaterialId = String(materialReview.ad_material_id || '');
      if (!smartPlusAdId || !adMaterialId) {
        continue;
      }

      const currentMaterialIds = currentMaterialIdsByAd.get(smartPlusAdId);
      if (!currentMaterialIds?.has(adMaterialId)) {
        continue;
      }

      const rejectedIds = rejectedMaterialIdsByAd.get(smartPlusAdId) || new Set<string>();
      rejectedIds.add(adMaterialId);
      rejectedMaterialIdsByAd.set(smartPlusAdId, rejectedIds);
    }
  }

  const rejectedAds: RejectedSmartPlusAd[] = [];

  for (const [smartPlusAdId, rejectedMaterialIds] of rejectedMaterialIdsByAd) {
    const ad = adMap.get(smartPlusAdId);
    const review = reviewByAd.get(smartPlusAdId);

    rejectedAds.push({
      advertiserId,
      smartPlusAdId,
      campaignId: ad?.campaign_id ? String(ad.campaign_id) : undefined,
      secondaryStatus: ad?.secondary_status,
      reviewStatus: review?.review_status,
      appealStatus: review?.appeal_status,
      rejectedMaterialCount: rejectedMaterialIds.size,
    });
  }

  return {
    scannedAds: adMap.size,
    rejectedAds,
  };
}

async function getAttemptedSmartPlusAdIds(advertiserId: string): Promise<Set<string>> {
  const rows = await db.all<AttemptedAdRow>(
    `SELECT DISTINCT smart_plus_ad_id
     FROM smart_plus_appeal_attempts
     WHERE advertiser_id = ?`,
    [advertiserId]
  );

  return new Set(rows.map(row => row.smart_plus_ad_id));
}

async function recordAppealAttempt(
  ad: RejectedSmartPlusAd,
  result: AppealApiResult,
  forceRescan: boolean
): Promise<void> {
  await db.run(
    `INSERT INTO smart_plus_appeal_attempts (
       advertiser_id,
       smart_plus_ad_id,
       campaign_id,
       previous_appeal_status,
       review_status,
       secondary_status,
       rejected_material_count,
       outcome,
       response_code,
       response_message,
       request_id,
       is_forced
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ad.advertiserId,
      ad.smartPlusAdId,
      ad.campaignId || null,
      ad.appealStatus || null,
      ad.reviewStatus || null,
      ad.secondaryStatus || null,
      ad.rejectedMaterialCount,
      result.outcome,
      result.code ?? null,
      result.message || null,
      result.requestId || null,
      forceRescan ? 1 : 0,
    ]
  );
}

async function submitSmartPlusAppeal(
  advertiserId: string,
  smartPlusAdId: string,
  writeToken: string
): Promise<AppealApiResult> {
  for (let attempt = 0; attempt < APPEAL_QPS_BACKOFF_MS.length; attempt += 1) {
    const waitMs = APPEAL_QPS_BACKOFF_MS[attempt];
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    try {
      const response = await axios.post(
        `${TIKTOK_API_BASE_URL}/smart_plus/ad/appeal/`,
        {
          advertiser_id: advertiserId,
          smart_plus_ad_id: smartPlusAdId,
        },
        {
          headers: {
            'Access-Token': writeToken,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 30_000,
        }
      );

      const payload = response.data as {
        code?: number;
        message?: string;
        request_id?: string;
      };
      const message = String(payload.message || '');

      if (message.toUpperCase().includes('OVER_QPS_LIMIT')) {
        if (attempt < APPEAL_QPS_BACKOFF_MS.length - 1) {
          continue;
        }

        return {
          outcome: 'QPS_LIMIT',
          code: payload.code,
          message,
          requestId: payload.request_id,
        };
      }

      if (Number(payload.code || 0) === 0) {
        return {
          outcome: 'SUCCESS',
          code: payload.code,
          message,
          requestId: payload.request_id,
        };
      }

      if (message.includes('No ticket created successfully')) {
        return {
          outcome: 'NO_TICKET',
          code: payload.code,
          message,
          requestId: payload.request_id,
        };
      }

      return {
        outcome: 'OTHER_ERROR',
        code: payload.code,
        message,
        requestId: payload.request_id,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const responseData = error.response?.data as {
          code?: number;
          message?: string;
          request_id?: string;
        } | undefined;
        const message = String(responseData?.message || error.message || '');

        if (
          message.toUpperCase().includes('OVER_QPS_LIMIT') &&
          attempt < APPEAL_QPS_BACKOFF_MS.length - 1
        ) {
          continue;
        }

        if (responseData) {
          return {
            outcome: message.includes('No ticket created successfully')
              ? 'NO_TICKET'
              : message.toUpperCase().includes('OVER_QPS_LIMIT')
                ? 'QPS_LIMIT'
                : 'OTHER_ERROR',
            code: responseData.code,
            message,
            requestId: responseData.request_id,
          };
        }

        return {
          outcome: 'TRANSPORT_ERROR',
          message,
        };
      }

      return {
        outcome: 'TRANSPORT_ERROR',
        message: getApiErrorMessage(error),
      };
    }
  }

  return {
    outcome: 'QPS_LIMIT',
    message: 'Appeal retry exhausted',
  };
}

function applyOutcomeToSummary(
  summary: SmartPlusAppealRunSummary,
  outcome: SmartPlusAppealOutcome
): void {
  switch (outcome) {
    case 'SUCCESS':
      summary.success += 1;
      return;
    case 'NO_TICKET':
      summary.noTicket += 1;
      return;
    case 'QPS_LIMIT':
      summary.qpsLimit += 1;
      return;
    case 'TRANSPORT_ERROR':
      summary.transportError += 1;
      return;
    default:
      summary.otherError += 1;
  }
}

export async function runSmartPlusAppealScan(
  options: SmartPlusAppealRunOptions = {}
): Promise<SmartPlusAppealRunSummary> {
  const forceRescan = options.forceRescan === true;
  const config = await getTikTokConfig();
  const writeToken = await getTikTokWriteAccessToken();
  const advertiserIds = [...new Set(config.advertiserIds)];
  const summary: SmartPlusAppealRunSummary = {
    forceRescan,
    advertiserCount: advertiserIds.length,
    scannedAds: 0,
    rejectedAds: 0,
    attempted: 0,
    skippedHistory: 0,
    skippedAppealStatus: 0,
    success: 0,
    noTicket: 0,
    qpsLimit: 0,
    otherError: 0,
    transportError: 0,
    scanErrors: [],
  };

  for (let advertiserIndex = 0; advertiserIndex < advertiserIds.length; advertiserIndex += 1) {
    const advertiserId = advertiserIds[advertiserIndex];
    await emitProgress(
      options.onProgress,
      `Đang quét TKQC ${advertiserIndex + 1}/${advertiserIds.length}: ${advertiserId}`
    );

    try {
      const { scannedAds, rejectedAds } = await findRejectedSmartPlusAds(
        advertiserId,
        config.accessToken
      );
      summary.scannedAds += scannedAds;
      summary.rejectedAds += rejectedAds.length;

      const attemptedIds = forceRescan
        ? new Set<string>()
        : await getAttemptedSmartPlusAdIds(advertiserId);

      for (let index = 0; index < rejectedAds.length; index += 1) {
        const ad = rejectedAds[index];

        if (!forceRescan && attemptedIds.has(ad.smartPlusAdId)) {
          summary.skippedHistory += 1;
          continue;
        }

        // Normal mode only sends a first appeal for NOT_APPEALED ads.
        // APPEAL_FAILED or in-progress statuses are treated as already appealed.
        if (!forceRescan && ad.appealStatus !== 'NOT_APPEALED') {
          summary.skippedAppealStatus += 1;
          continue;
        }

        // Force mode ignores local history and retries failed appeals, but still
        // avoids duplicate writes while TikTok is actively processing an appeal.
        if (
          forceRescan &&
          ad.appealStatus &&
          !['NOT_APPEALED', 'APPEAL_FAILED'].includes(ad.appealStatus)
        ) {
          summary.skippedAppealStatus += 1;
          continue;
        }

        await emitProgress(
          options.onProgress,
          `Kháng nghị ${index + 1}/${rejectedAds.length} · ${ad.smartPlusAdId}`
        );

        const result = await submitSmartPlusAppeal(
          advertiserId,
          ad.smartPlusAdId,
          writeToken
        );

        await recordAppealAttempt(ad, result, forceRescan);
        summary.attempted += 1;
        applyOutcomeToSummary(summary, result.outcome);

        if (index < rejectedAds.length - 1) {
          await sleep(APPEAL_REQUEST_SPACING_MS);
        }
      }
    } catch (error) {
      const errorMessage = `TKQC ${advertiserId}: ${getApiErrorMessage(error)}`;
      summary.scanErrors.push(errorMessage);
      console.error('Smart+ appeal advertiser scan failed:', errorMessage);
    }
  }

  return summary;
}
