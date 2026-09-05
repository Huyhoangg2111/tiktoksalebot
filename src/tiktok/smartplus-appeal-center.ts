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

export interface AppealTemplate {
  key: string;
  label: string;
  matches: string;
  text: string;
}

export interface SmartPlusAppealRunOptions {
  forceRescan?: boolean;
  onProgress?: (message: string) => void | Promise<void>;
}

export interface SmartPlusAppealSuccessItem {
  advertiserId: string;
  smartPlusAdId: string;
  campaignId?: string;
  templateKey: string;
  rejectReason: string;
  appealStatus?: string;
  reviewStatus?: string;
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
  successfulAds: SmartPlusAppealSuccessItem[];
}

export interface SmartPlusAppealStatusItem {
  advertiserId: string;
  smartPlusAdId: string;
  campaignId?: string;
  reviewStatus?: string;
  appealStatus?: string;
  appealRejectReasons: string[];
  rejectReason?: string;
  templateKey?: string;
  appealReason?: string;
  lastSubmissionOutcome?: string;
  lastSubmissionAt?: string;
  source: 'BOT_SUCCESS' | 'TIKTOK_HISTORY';
}

export interface SmartPlusAppealStatusReport {
  total: number;
  botSuccess: number;
  tiktokHistory: number;
  scanErrors: string[];
  items: SmartPlusAppealStatusItem[];
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
  appeal_reject_reasons?: unknown;
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
  appealRejectReasons: string[];
  rejectedMaterialCount: number;
  rejectReasons: string[];
}

interface AdvertiserScanResult {
  scannedAds: number;
  rejectedAds: RejectedSmartPlusAd[];
  reviewsByAd: Map<string, SmartPlusAdReviewInfo>;
  adsById: Map<string, SmartPlusAdRecord>;
  rejectReasonsByAd: Map<string, string[]>;
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

interface AppealStateRow {
  advertiser_id: string;
  smart_plus_ad_id: string;
  campaign_id?: string | null;
  review_status?: string | null;
  appeal_status?: string | null;
  appeal_reject_reasons?: string | null;
  reject_reason?: string | null;
  template_key?: string | null;
  appeal_reason?: string | null;
  last_submission_outcome?: string | null;
  last_submission_at?: string | null;
}

const APPEAL_TEMPLATES: AppealTemplate[] = [
  {
    key: 'adult_supplies',
    label: 'Adult Supplies / Services / Entertainment',
    matches: 'Prohibited Industry - Adult Supplies, Services, Entertainment',
    text:
      'Please conduct a manual review. We believe this ad may have been misclassified under Adult Supplies, Services, Entertainment. The creative promotes a lawful consumer product and is not intended to advertise adult sexual-wellness products, sexual services, or adult entertainment. Please review the creative, landing page, audio, and full context. If any element is non-compliant, we are willing to revise it.',
  },
  {
    key: 'sexual_suggestive',
    label: 'Sexually suggestive content',
    matches: 'sexually suggestive content / sexual behavior / sexualized language or movements',
    text:
      'Please conduct a manual review. The creative is intended to demonstrate and market the product, not to depict, encourage, or promote sexual behavior. Any pose, movement, wording, or audio should be evaluated in the full product context rather than as sexually suggestive content. If any specific element is non-compliant, we are willing to revise it.',
  },
  {
    key: 'openly_sexual',
    label: 'Openly sexual / sexualized content',
    matches: 'openly sexual content / sexualized language or movements',
    text:
      'Please conduct a manual review. We believe the creative may have been interpreted out of context. It is intended to demonstrate the product and does not intentionally contain or promote explicit sexual activity or sexual services. Please review the complete creative and landing page. If a specific visual, phrase, movement, or audio element is non-compliant, we are willing to revise it.',
  },
  {
    key: 'generic_review',
    label: 'Generic manual review',
    matches: 'fallback for an unknown rejection reason',
    text:
      'Please conduct a manual review of this Smart+ ad and its rejected material. We believe the creative may have been misclassified and request a review in the full context of the advertised product, landing page, audio, and visual content. If a specific element is found non-compliant, we are willing to revise it to meet TikTok Ads policies.',
  },
];

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

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function extractRejectReasons(rejectInfo: unknown[]): string[] {
  const reasons = new Set<string>();

  for (const item of rejectInfo) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;
    const candidates = [
      record.reasons,
      record.reason,
      record.reject_reason,
      record.reject_reasons,
    ];

    for (const candidate of candidates) {
      for (const reason of normalizeStringArray(candidate)) {
        reasons.add(reason);
      }
    }
  }

  return [...reasons];
}

function pickAppealTemplate(reasons: string[]): AppealTemplate {
  const joined = reasons.join(' | ').toLowerCase();

  if (joined.includes('adult supplies') || joined.includes('adult services') || joined.includes('adult entertainment')) {
    return APPEAL_TEMPLATES[0];
  }

  if (joined.includes('openly sexual')) {
    return APPEAL_TEMPLATES[2];
  }

  if (joined.includes('sexually suggestive') || joined.includes('sexual behavior') || joined.includes('sexualized language')) {
    return APPEAL_TEMPLATES[1];
  }

  return APPEAL_TEMPLATES[3];
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
  if (!callback) return;
  try {
    await callback(message);
  } catch (error) {
    console.error('Smart+ appeal progress callback failed:', error);
  }
}

async function ensureAppealSchema(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS smart_plus_appeal_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advertiser_id TEXT NOT NULL,
      smart_plus_ad_id TEXT NOT NULL,
      campaign_id TEXT,
      previous_appeal_status TEXT,
      review_status TEXT,
      secondary_status TEXT,
      rejected_material_count INTEGER DEFAULT 0,
      outcome TEXT NOT NULL,
      response_code INTEGER,
      response_message TEXT,
      request_id TEXT,
      is_forced BOOLEAN DEFAULT 0,
      attempted_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const extraColumns = [
    'reject_reason TEXT',
    'template_key TEXT',
    'appeal_reason TEXT',
    'latest_appeal_status TEXT',
    'latest_review_status TEXT',
    'latest_appeal_reject_reasons TEXT',
    'status_checked_at TEXT',
  ];

  for (const column of extraColumns) {
    try {
      await db.run(`ALTER TABLE smart_plus_appeal_attempts ADD COLUMN ${column}`);
    } catch (error) {
      if (!String(error).toLowerCase().includes('duplicate column name')) {
        throw error;
      }
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS smart_plus_appeal_state (
      advertiser_id TEXT NOT NULL,
      smart_plus_ad_id TEXT NOT NULL,
      campaign_id TEXT,
      review_status TEXT,
      appeal_status TEXT,
      appeal_reject_reasons TEXT,
      reject_reason TEXT,
      template_key TEXT,
      appeal_reason TEXT,
      last_submission_outcome TEXT,
      last_submission_code INTEGER,
      last_submission_message TEXT,
      last_submission_request_id TEXT,
      last_submission_at TEXT,
      last_checked_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (advertiser_id, smart_plus_ad_id)
    )
  `);
}

async function getAllSmartPlusAds(advertiserId: string, readToken: string): Promise<SmartPlusAdRecord[]> {
  const ads: SmartPlusAdRecord[] = [];
  let page = 1;
  let totalPage = 1;

  do {
    const response = await axios.get(`${TIKTOK_API_BASE_URL}/smart_plus/ad/get/`, {
      params: { advertiser_id: advertiserId, page, page_size: 100 },
      headers: { 'Access-Token': readToken, Accept: 'application/json' },
      timeout: 30_000,
    });

    const payload = response.data as {
      code?: number;
      message?: string;
      data?: { list?: SmartPlusAdRecord[]; page_info?: { total_page?: number | string } };
    };

    if (Number(payload.code || 0) !== 0) {
      throw new Error(`smart_plus/ad/get failed: code=${payload.code} message=${payload.message || ''}`);
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
    if (waitMs > 0) await sleep(waitMs);

    const params = new URLSearchParams();
    params.set('advertiser_id', advertiserId);
    params.set('smart_plus_ad_ids', JSON.stringify(smartPlusAdIds));
    params.set('extra_info_setting', JSON.stringify({
      include_reject_info: true,
      include_violation_frame: false,
    }));
    params.set('lang', 'en');

    const response = await axios.get(
      `${TIKTOK_API_BASE_URL}/smart_plus/ad/review_info/?${params.toString()}`,
      {
        headers: { 'Access-Token': readToken, Accept: 'application/json' },
        timeout: 60_000,
      }
    );

    const payload = response.data as { code?: number; message?: string; data?: SmartPlusReviewResponseData };
    const message = String(payload.message || '');

    if (message.toUpperCase().includes('OVER_QPS_LIMIT')) {
      if (attempt === REVIEW_QPS_BACKOFF_MS.length - 1) {
        throw new Error('smart_plus/ad/review_info QPS retry exhausted');
      }
      continue;
    }

    if (Number(payload.code || 0) !== 0) {
      throw new Error(`smart_plus/ad/review_info failed: code=${payload.code} message=${message}`);
    }

    return payload.data || {};
  }

  throw new Error('smart_plus/ad/review_info retry exhausted');
}

async function scanAdvertiser(advertiserId: string, readToken: string): Promise<AdvertiserScanResult> {
  const ads = await getAllSmartPlusAds(advertiserId, readToken);
  const adsById = new Map<string, SmartPlusAdRecord>();
  const currentMaterialIdsByAd = new Map<string, Set<string>>();

  for (const ad of ads) {
    const adId = String(ad.smart_plus_ad_id || '');
    if (!adId) continue;
    adsById.set(adId, ad);
    currentMaterialIdsByAd.set(
      adId,
      new Set((ad.creative_list || []).map(item => String(item.ad_material_id || '')).filter(Boolean))
    );
  }

  const reviewsByAd = new Map<string, SmartPlusAdReviewInfo>();
  const rejectedMaterialIdsByAd = new Map<string, Set<string>>();
  const rejectReasonSetsByAd = new Map<string, Set<string>>();

  for (const batch of chunkItems([...adsById.keys()], REVIEW_BATCH_SIZE)) {
    const data = await getReviewBatch(advertiserId, batch, readToken);

    for (const review of data.smart_plus_ad_review_infos || []) {
      const adId = String(review.smart_plus_ad_id || '');
      if (adId) reviewsByAd.set(adId, review);
    }

    for (const material of data.material_review_infos || []) {
      if (!Array.isArray(material.reject_info) || material.reject_info.length === 0) continue;

      const adId = String(material.smart_plus_ad_id || '');
      const materialId = String(material.ad_material_id || '');
      if (!adId || !materialId) continue;
      if (!currentMaterialIdsByAd.get(adId)?.has(materialId)) continue;

      const ids = rejectedMaterialIdsByAd.get(adId) || new Set<string>();
      ids.add(materialId);
      rejectedMaterialIdsByAd.set(adId, ids);

      const reasonSet = rejectReasonSetsByAd.get(adId) || new Set<string>();
      for (const reason of extractRejectReasons(material.reject_info)) {
        reasonSet.add(reason);
      }
      rejectReasonSetsByAd.set(adId, reasonSet);
    }
  }

  const rejectReasonsByAd = new Map<string, string[]>();
  const rejectedAds: RejectedSmartPlusAd[] = [];

  for (const [adId, materialIds] of rejectedMaterialIdsByAd) {
    const ad = adsById.get(adId);
    const review = reviewsByAd.get(adId);
    const rejectReasons = [...(rejectReasonSetsByAd.get(adId) || new Set<string>())];
    rejectReasonsByAd.set(adId, rejectReasons);

    rejectedAds.push({
      advertiserId,
      smartPlusAdId: adId,
      campaignId: ad?.campaign_id ? String(ad.campaign_id) : undefined,
      secondaryStatus: ad?.secondary_status,
      reviewStatus: review?.review_status,
      appealStatus: review?.appeal_status,
      appealRejectReasons: normalizeStringArray(review?.appeal_reject_reasons),
      rejectedMaterialCount: materialIds.size,
      rejectReasons,
    });
  }

  return {
    scannedAds: adsById.size,
    rejectedAds,
    reviewsByAd,
    adsById,
    rejectReasonsByAd,
  };
}

async function upsertObservedState(
  advertiserId: string,
  adId: string,
  campaignId: string | undefined,
  review: SmartPlusAdReviewInfo | undefined,
  rejectReasons: string[]
): Promise<void> {
  await db.run(
    `INSERT INTO smart_plus_appeal_state (
       advertiser_id, smart_plus_ad_id, campaign_id, review_status, appeal_status,
       appeal_reject_reasons, reject_reason, last_checked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(advertiser_id, smart_plus_ad_id) DO UPDATE SET
       campaign_id = excluded.campaign_id,
       review_status = excluded.review_status,
       appeal_status = excluded.appeal_status,
       appeal_reject_reasons = excluded.appeal_reject_reasons,
       reject_reason = CASE
         WHEN excluded.reject_reason IS NOT NULL AND excluded.reject_reason <> '' THEN excluded.reject_reason
         ELSE smart_plus_appeal_state.reject_reason
       END,
       last_checked_at = CURRENT_TIMESTAMP`,
    [
      advertiserId,
      adId,
      campaignId || null,
      review?.review_status || null,
      review?.appeal_status || null,
      JSON.stringify(normalizeStringArray(review?.appeal_reject_reasons)),
      rejectReasons.join(' | ') || null,
    ]
  );
}

async function persistScanState(advertiserId: string, scan: AdvertiserScanResult): Promise<void> {
  for (const [adId, review] of scan.reviewsByAd) {
    const ad = scan.adsById.get(adId);
    await upsertObservedState(
      advertiserId,
      adId,
      ad?.campaign_id ? String(ad.campaign_id) : undefined,
      review,
      scan.rejectReasonsByAd.get(adId) || []
    );
  }
}

async function getAttemptedSmartPlusAdIds(advertiserId: string): Promise<Set<string>> {
  const rows = await db.all<AttemptedAdRow>(
    `SELECT DISTINCT smart_plus_ad_id FROM smart_plus_appeal_attempts WHERE advertiser_id = ?`,
    [advertiserId]
  );
  return new Set(rows.map(row => row.smart_plus_ad_id));
}

async function submitSmartPlusAppeal(
  advertiserId: string,
  smartPlusAdId: string,
  appealReason: string,
  writeToken: string
): Promise<AppealApiResult> {
  for (let attempt = 0; attempt < APPEAL_QPS_BACKOFF_MS.length; attempt += 1) {
    const waitMs = APPEAL_QPS_BACKOFF_MS[attempt];
    if (waitMs > 0) await sleep(waitMs);

    try {
      const response = await axios.post(
        `${TIKTOK_API_BASE_URL}/smart_plus/ad/appeal/`,
        {
          advertiser_id: advertiserId,
          smart_plus_ad_id: smartPlusAdId,
          appeal_reason: appealReason.slice(0, 512),
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

      const payload = response.data as { code?: number; message?: string; request_id?: string };
      const message = String(payload.message || '');

      if (message.toUpperCase().includes('OVER_QPS_LIMIT')) {
        if (attempt < APPEAL_QPS_BACKOFF_MS.length - 1) continue;
        return { outcome: 'QPS_LIMIT', code: payload.code, message, requestId: payload.request_id };
      }

      if (Number(payload.code || 0) === 0) {
        return { outcome: 'SUCCESS', code: payload.code, message, requestId: payload.request_id };
      }

      if (message.includes('No ticket created successfully')) {
        return { outcome: 'NO_TICKET', code: payload.code, message, requestId: payload.request_id };
      }

      return { outcome: 'OTHER_ERROR', code: payload.code, message, requestId: payload.request_id };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const data = error.response?.data as { code?: number; message?: string; request_id?: string } | undefined;
        const message = String(data?.message || error.message || '');

        if (message.toUpperCase().includes('OVER_QPS_LIMIT') && attempt < APPEAL_QPS_BACKOFF_MS.length - 1) {
          continue;
        }

        if (data) {
          return {
            outcome: message.includes('No ticket created successfully')
              ? 'NO_TICKET'
              : message.toUpperCase().includes('OVER_QPS_LIMIT')
                ? 'QPS_LIMIT'
                : 'OTHER_ERROR',
            code: data.code,
            message,
            requestId: data.request_id,
          };
        }

        return { outcome: 'TRANSPORT_ERROR', message };
      }

      return { outcome: 'TRANSPORT_ERROR', message: getApiErrorMessage(error) };
    }
  }

  return { outcome: 'QPS_LIMIT', message: 'Appeal retry exhausted' };
}

async function recordAppealAttempt(
  ad: RejectedSmartPlusAd,
  result: AppealApiResult,
  forceRescan: boolean,
  template: AppealTemplate
): Promise<void> {
  const rejectReason = ad.rejectReasons.join(' | ');

  await db.run(
    `INSERT INTO smart_plus_appeal_attempts (
       advertiser_id, smart_plus_ad_id, campaign_id, previous_appeal_status,
       review_status, secondary_status, rejected_material_count, outcome,
       response_code, response_message, request_id, is_forced,
       reject_reason, template_key, appeal_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      rejectReason || null,
      template.key,
      template.text,
    ]
  );

  await db.run(
    `INSERT INTO smart_plus_appeal_state (
       advertiser_id, smart_plus_ad_id, campaign_id, review_status, appeal_status,
       appeal_reject_reasons, reject_reason, template_key, appeal_reason,
       last_submission_outcome, last_submission_code, last_submission_message,
       last_submission_request_id, last_submission_at, last_checked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(advertiser_id, smart_plus_ad_id) DO UPDATE SET
       campaign_id = excluded.campaign_id,
       review_status = excluded.review_status,
       appeal_status = excluded.appeal_status,
       appeal_reject_reasons = excluded.appeal_reject_reasons,
       reject_reason = excluded.reject_reason,
       template_key = excluded.template_key,
       appeal_reason = excluded.appeal_reason,
       last_submission_outcome = excluded.last_submission_outcome,
       last_submission_code = excluded.last_submission_code,
       last_submission_message = excluded.last_submission_message,
       last_submission_request_id = excluded.last_submission_request_id,
       last_submission_at = CURRENT_TIMESTAMP,
       last_checked_at = CURRENT_TIMESTAMP`,
    [
      ad.advertiserId,
      ad.smartPlusAdId,
      ad.campaignId || null,
      ad.reviewStatus || null,
      ad.appealStatus || null,
      JSON.stringify(ad.appealRejectReasons),
      rejectReason || null,
      template.key,
      template.text,
      result.outcome,
      result.code ?? null,
      result.message || null,
      result.requestId || null,
    ]
  );
}

function applyOutcomeToSummary(summary: SmartPlusAppealRunSummary, outcome: SmartPlusAppealOutcome): void {
  switch (outcome) {
    case 'SUCCESS': summary.success += 1; return;
    case 'NO_TICKET': summary.noTicket += 1; return;
    case 'QPS_LIMIT': summary.qpsLimit += 1; return;
    case 'TRANSPORT_ERROR': summary.transportError += 1; return;
    default: summary.otherError += 1;
  }
}

async function refreshSuccessStatuses(
  advertiserId: string,
  successful: SmartPlusAppealSuccessItem[],
  readToken: string
): Promise<void> {
  if (successful.length === 0) return;

  const ids = successful.filter(item => item.advertiserId === advertiserId).map(item => item.smartPlusAdId);
  for (const batch of chunkItems(ids, REVIEW_BATCH_SIZE)) {
    if (batch.length === 0) continue;
    const data = await getReviewBatch(advertiserId, batch, readToken);
    for (const review of data.smart_plus_ad_review_infos || []) {
      const adId = String(review.smart_plus_ad_id || '');
      const item = successful.find(entry => entry.advertiserId === advertiserId && entry.smartPlusAdId === adId);
      if (!item) continue;

      item.appealStatus = review.appeal_status;
      item.reviewStatus = review.review_status;
      const rejectReasons = normalizeStringArray(review.appeal_reject_reasons);

      await db.run(
        `UPDATE smart_plus_appeal_attempts
         SET latest_appeal_status = ?, latest_review_status = ?,
             latest_appeal_reject_reasons = ?, status_checked_at = CURRENT_TIMESTAMP
         WHERE advertiser_id = ? AND smart_plus_ad_id = ? AND outcome = 'SUCCESS'`,
        [review.appeal_status || null, review.review_status || null, JSON.stringify(rejectReasons), advertiserId, adId]
      );

      await upsertObservedState(advertiserId, adId, item.campaignId, review, []);
    }
  }
}

export async function runSmartPlusAppealScan(
  options: SmartPlusAppealRunOptions = {}
): Promise<SmartPlusAppealRunSummary> {
  await ensureAppealSchema();

  const forceRescan = options.forceRescan === true;
  const config = await getTikTokConfig();
  const writeToken = await getTikTokWriteAccessToken();
  const readToken = config.accessToken;
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
    successfulAds: [],
  };

  for (let advertiserIndex = 0; advertiserIndex < advertiserIds.length; advertiserIndex += 1) {
    const advertiserId = advertiserIds[advertiserIndex];
    await emitProgress(options.onProgress, `Đang quét TKQC ${advertiserIndex + 1}/${advertiserIds.length}: ${advertiserId}`);

    try {
      const scan = await scanAdvertiser(advertiserId, readToken);
      summary.scannedAds += scan.scannedAds;
      summary.rejectedAds += scan.rejectedAds.length;
      await persistScanState(advertiserId, scan);

      const attemptedIds = forceRescan ? new Set<string>() : await getAttemptedSmartPlusAdIds(advertiserId);

      for (let index = 0; index < scan.rejectedAds.length; index += 1) {
        const ad = scan.rejectedAds[index];

        if (!forceRescan && attemptedIds.has(ad.smartPlusAdId)) {
          summary.skippedHistory += 1;
          continue;
        }

        if (!forceRescan && ad.appealStatus && ad.appealStatus !== 'NOT_APPEALED') {
          summary.skippedAppealStatus += 1;
          continue;
        }

        if (
          forceRescan &&
          ad.appealStatus &&
          !['NOT_APPEALED', 'APPEAL_FAILED'].includes(ad.appealStatus)
        ) {
          summary.skippedAppealStatus += 1;
          continue;
        }

        const template = pickAppealTemplate(ad.rejectReasons);
        await emitProgress(
          options.onProgress,
          `TKQC ${advertiserIndex + 1}/${advertiserIds.length} · appeal ${index + 1}/${scan.rejectedAds.length} · ${ad.smartPlusAdId}`
        );

        const result = await submitSmartPlusAppeal(ad.advertiserId, ad.smartPlusAdId, template.text, writeToken);
        summary.attempted += 1;
        applyOutcomeToSummary(summary, result.outcome);
        await recordAppealAttempt(ad, result, forceRescan, template);

        if (result.outcome === 'SUCCESS') {
          summary.successfulAds.push({
            advertiserId: ad.advertiserId,
            smartPlusAdId: ad.smartPlusAdId,
            campaignId: ad.campaignId,
            templateKey: template.key,
            rejectReason: ad.rejectReasons.join(' | '),
          });
        }

        if (index < scan.rejectedAds.length - 1) {
          await sleep(APPEAL_REQUEST_SPACING_MS);
        }
      }

      try {
        await refreshSuccessStatuses(advertiserId, summary.successfulAds, readToken);
      } catch (error) {
        summary.scanErrors.push(`Refresh appeal status ${advertiserId}: ${getApiErrorMessage(error)}`);
      }
    } catch (error) {
      summary.scanErrors.push(`${advertiserId}: ${getApiErrorMessage(error)}`);
    }
  }

  return summary;
}

export async function getSmartPlusAppealStatusReport(
  onProgress?: (message: string) => void | Promise<void>
): Promise<SmartPlusAppealStatusReport> {
  await ensureAppealSchema();

  const config = await getTikTokConfig();
  const readToken = config.accessToken;
  const advertiserIds = [...new Set(config.advertiserIds)];
  const scanErrors: string[] = [];

  for (let index = 0; index < advertiserIds.length; index += 1) {
    const advertiserId = advertiserIds[index];
    try {
      if (onProgress) await onProgress(`Đang cập nhật trạng thái TKQC ${index + 1}/${advertiserIds.length}: ${advertiserId}`);
      const scan = await scanAdvertiser(advertiserId, readToken);
      await persistScanState(advertiserId, scan);
    } catch (error) {
      scanErrors.push(`${advertiserId}: ${getApiErrorMessage(error)}`);
    }
  }

  const rows = await db.all<AppealStateRow>(
    `SELECT advertiser_id, smart_plus_ad_id, campaign_id, review_status, appeal_status,
            appeal_reject_reasons, reject_reason, template_key, appeal_reason,
            last_submission_outcome, last_submission_at
     FROM smart_plus_appeal_state
     WHERE last_submission_outcome = 'SUCCESS'
        OR (appeal_status IS NOT NULL AND appeal_status <> '' AND appeal_status <> 'NOT_APPEALED')
     ORDER BY COALESCE(last_submission_at, last_checked_at) DESC, smart_plus_ad_id DESC`
  );

  const items: SmartPlusAppealStatusItem[] = rows.map(row => {
    let appealRejectReasons: string[] = [];
    try {
      appealRejectReasons = row.appeal_reject_reasons
        ? normalizeStringArray(JSON.parse(row.appeal_reject_reasons))
        : [];
    } catch {
      appealRejectReasons = normalizeStringArray(row.appeal_reject_reasons);
    }

    return {
      advertiserId: row.advertiser_id,
      smartPlusAdId: row.smart_plus_ad_id,
      campaignId: row.campaign_id || undefined,
      reviewStatus: row.review_status || undefined,
      appealStatus: row.appeal_status || undefined,
      appealRejectReasons,
      rejectReason: row.reject_reason || undefined,
      templateKey: row.template_key || undefined,
      appealReason: row.appeal_reason || undefined,
      lastSubmissionOutcome: row.last_submission_outcome || undefined,
      lastSubmissionAt: row.last_submission_at || undefined,
      source: row.last_submission_outcome === 'SUCCESS' ? 'BOT_SUCCESS' : 'TIKTOK_HISTORY',
    };
  });

  return {
    total: items.length,
    botSuccess: items.filter(item => item.source === 'BOT_SUCCESS').length,
    tiktokHistory: items.filter(item => item.source === 'TIKTOK_HISTORY').length,
    scanErrors,
    items,
  };
}

export function getSmartPlusAppealTemplates(): AppealTemplate[] {
  return APPEAL_TEMPLATES.map(template => ({ ...template }));
}
