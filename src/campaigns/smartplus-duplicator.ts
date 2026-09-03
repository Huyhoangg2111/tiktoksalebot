import axios from 'axios';
import { getTikTokConfig } from '../tiktok/config.js';

const DEFAULT_SIGNER_URL = 'http://127.0.0.1:8092';
const DEFAULT_SIGNER_TIMEOUT_MS = 30_000;         // timeout mỗi request API (30s)
const SIGNER_STATUS_POLL_INTERVAL_MS = 2_000;     // poll login status mỗi 2s
const CAMPAIGN_LOOKUP_PAGE_SIZE = 100;
const DEFAULT_CAMPAIGN_SETTLE_TIMEOUT_MS = 120_000;    // tong thoi gian cho campaign on dinh (120s)
const DEFAULT_CAMPAIGN_POLL_INTERVAL_MS = 3_000;       // poll danh sách campaign mỗi 3s
const DEFAULT_CAMPAIGN_DISCOVERY_TIMEOUT_MS = 60_000;  // tim campaign moi toi da 60s
const DEFAULT_DRAFT_PUBLISH_TIMEOUT_MS = 60_000;       // UI publish draft toi da 60s
const DEFAULT_TASK_RESULT_TIMEOUT_MS = 90_000;         // poll async task toi da 90s
const CAMPAIGN_CREATE_TIME_GRACE_MS = 120_000;
const MINIMUM_CAMPAIGN_DURATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLONE_START_DELAY_SECONDS = 120;

type SmartPlusDuplicateMode = 'signer' | 'disabled';

export interface SmartPlusDuplicateResult {
  status: 'created' | 'draft' | 'queued';
  campaignId?: string;
  taskId?: string;
  campaignName?: string;
  advertiserId: string;
}

interface RiskInfo {
  user_agent: string;
  referrer: string;
  cookie_enabled: boolean;
  screen_width: number;
  screen_height: number;
  browser_language: string;
  browser_platform: string;
  browser_name: string;
  browser_version: string;
  browser_online: boolean;
  timezone_name: string;
  pre_referer: string;
  device_platform: string;
  duration: number;
  priority_region: string;
}

interface CampaignLookupItem {
  campaign_id?: string;
  campaign_name?: string;
  create_time?: string | number;
  operation_status?: string;
  secondary_status?: string;
  budget?: number;
  budget_mode?: string;
}

interface AsyncTaskPollResult {
  campaignId?: string;
  finished: boolean;
  failed: boolean;
  reason?: string;
  status?: string;
}

const DEFAULT_RISK_INFO: RiskInfo = {
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  referrer: 'https://ads.tiktok.com/i18n/manage/campaign',
  cookie_enabled: true,
  screen_width: 1920,
  screen_height: 1080,
  browser_language: 'vi',
  browser_platform: 'Win32',
  browser_name: 'Mozilla',
  browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  browser_online: true,
  timezone_name: 'Asia/Saigon',
  pre_referer: 'https://ads.tiktok.com/i18n/manage/campaign',
  device_platform: 'Web',
  duration: 2000,
  priority_region: 'VN',
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFieldName(value: string): string {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function parseCampaignCreateTimeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  const rawValue = String(value || '').trim();
  if (!rawValue) return null;

  if (/^\d+$/.test(rawValue)) {
    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue)
      ? (numericValue > 10_000_000_000 ? numericValue : numericValue * 1000)
      : null;
  }

  const dateTimeMatch = rawValue.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (dateTimeMatch) {
    return new Date(
      Number(dateTimeMatch[1]),
      Number(dateTimeMatch[2]) - 1,
      Number(dateTimeMatch[3]),
      Number(dateTimeMatch[4]),
      Number(dateTimeMatch[5]),
      Number(dateTimeMatch[6] || 0)
    ).getTime();
  }

  const parsed = Date.parse(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildUniqueCampaignName(baseName: string, originalCampaignId: string): string {
  const normalizedBaseName = String(baseName || 'Campaign - API').trim() || 'Campaign - API';
  const now = new Date();
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  const suffix = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(now.getMilliseconds(), 3),
  ].join('') + `-${String(originalCampaignId).slice(-4)}`;
  const maxBaseLength = 512 - suffix.length - 1;
  const truncatedBaseName = normalizedBaseName.slice(0, Math.max(1, maxBaseLength)).trim();

  return `${truncatedBaseName} ${suffix}`;
}

function parseTikTokDateTime(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000);
  }

  const rawValue = String(value || '').trim();
  if (!rawValue) return null;

  if (/^\d+$/.test(rawValue)) {
    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue)
      ? new Date(numericValue > 10_000_000_000 ? numericValue : numericValue * 1000)
      : null;
  }

  const match = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0)
    );
  }

  const parsed = Date.parse(rawValue);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function formatTikTokDateTime(value: Date): string {
  const pad = (numberValue: number): string => numberValue.toString().padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function normalizeDateTimeValueType(value: unknown, nextDateTime: Date): unknown {
  if (typeof value === 'number') {
    return value > 10_000_000_000
      ? nextDateTime.getTime()
      : Math.floor(nextDateTime.getTime() / 1000);
  }

  const rawValue = String(value || '').trim();
  if (/^\d+$/.test(rawValue)) {
    const nextTimestamp = Number(rawValue) > 10_000_000_000
      ? nextDateTime.getTime()
      : Math.floor(nextDateTime.getTime() / 1000);
    return String(nextTimestamp);
  }

  return formatTikTokDateTime(nextDateTime);
}

function isStartTimeField(normalizedKey: string): boolean {
  return (
    normalizedKey === 'starttime' ||
    normalizedKey === 'schedulestarttime' ||
    normalizedKey === 'scheduledstarttime' ||
    normalizedKey === 'campaignstarttime' ||
    normalizedKey === 'adstarttime'
  );
}

function isEndTimeField(normalizedKey: string): boolean {
  return (
    normalizedKey === 'endtime' ||
    normalizedKey === 'scheduleendtime' ||
    normalizedKey === 'scheduledendtime' ||
    normalizedKey === 'campaignendtime' ||
    normalizedKey === 'adendtime'
  );
}

function getObjectTimeByField(
  value: Record<string, unknown>,
  predicate: (normalizedKey: string) => boolean
): Date | null {
  for (const [key, nestedValue] of Object.entries(value)) {
    if (predicate(normalizeFieldName(key))) {
      const parsed = parseTikTokDateTime(nestedValue);
      if (parsed) return parsed;
    }
  }

  return null;
}

function getShiftedEndTimeForObject(
  value: Record<string, unknown>,
  cloneStartTime: Date
): Date {
  const originalStartTime = getObjectTimeByField(value, isStartTimeField);
  const originalEndTime = getObjectTimeByField(value, isEndTimeField);
  const minimumEndTime = new Date(cloneStartTime.getTime() + MINIMUM_CAMPAIGN_DURATION_MS);

  if (originalStartTime && originalEndTime) {
    const originalDurationMs = originalEndTime.getTime() - originalStartTime.getTime();
    return new Date(cloneStartTime.getTime() + Math.max(originalDurationMs, MINIMUM_CAMPAIGN_DURATION_MS));
  }

  if (originalEndTime && originalEndTime.getTime() > minimumEndTime.getTime()) {
    return originalEndTime;
  }

  return minimumEndTime;
}

function applyCloneScheduleDeep(value: unknown, cloneStartTime: Date): unknown {

  if (Array.isArray(value)) {
    return value.map(item => applyCloneScheduleDeep(item, cloneStartTime));
  }

  if (value && typeof value === 'object') {
    const cloned: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    const shiftedEndTime = getShiftedEndTimeForObject(cloned, cloneStartTime);

    for (const [key, nestedValue] of Object.entries(cloned)) {
      const normalizedKey = normalizeFieldName(key);
      if (isStartTimeField(normalizedKey) && parseTikTokDateTime(nestedValue)) {
        cloned[key] = normalizeDateTimeValueType(nestedValue, cloneStartTime);
        continue;
      }

      if (isEndTimeField(normalizedKey) && parseTikTokDateTime(nestedValue)) {
        cloned[key] = normalizeDateTimeValueType(nestedValue, shiftedEndTime);
        continue;
      }

      cloned[key] = applyCloneScheduleDeep(nestedValue, cloneStartTime);
    }

    return cloned;
  }

  return value;
}

function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (typeof error.response?.data === 'string' && error.response.data.trim()) {
      return error.response.data;
    }
    const msg =
      typeof error.response?.data?.message === 'string'
        ? error.response.data.message
        : typeof error.response?.data?.reason === 'string'
          ? error.response.data.reason
          : '';
    if (msg) return msg;
  }
  return error instanceof Error ? error.message : String(error);
}

function isAxiosTimeout(error: unknown): boolean {
  return axios.isAxiosError(error) && (
    error.code === 'ECONNABORTED' ||
    String(error.message || '').toLowerCase().includes('timeout')
  );
}

function getSmartPlusDuplicateMode(): SmartPlusDuplicateMode {
  const rawValue = String(process.env.SMARTPLUS_DUPLICATION_MODE || '').trim().toLowerCase();
  if (['disabled', 'off', 'false', '0', 'no'].includes(rawValue)) return 'disabled';
  return 'signer';
}

function getSmartPlusSignerConfig() {
  return {
    mode: getSmartPlusDuplicateMode(),
    baseUrl: normalizeBaseUrl(
      process.env.SMARTPLUS_SIGNER_URL || process.env.PW_SIGNER_URL || DEFAULT_SIGNER_URL
    ),
    timeoutMs: parsePositiveNumber(process.env.SMARTPLUS_SIGNER_TIMEOUT_MS, DEFAULT_SIGNER_TIMEOUT_MS),
    settleTimeoutMs: parsePositiveNumber(process.env.SMARTPLUS_CAMPAIGN_SETTLE_TIMEOUT_MS, DEFAULT_CAMPAIGN_SETTLE_TIMEOUT_MS),
    discoveryTimeoutMs: parsePositiveNumber(process.env.SMARTPLUS_CAMPAIGN_DISCOVERY_TIMEOUT_MS, DEFAULT_CAMPAIGN_DISCOVERY_TIMEOUT_MS),
    campaignPollIntervalMs: parsePositiveNumber(process.env.SMARTPLUS_CAMPAIGN_POLL_INTERVAL_MS, DEFAULT_CAMPAIGN_POLL_INTERVAL_MS),
    draftPublishTimeoutMs: parsePositiveNumber(process.env.SMARTPLUS_DRAFT_PUBLISH_TIMEOUT_MS, DEFAULT_DRAFT_PUBLISH_TIMEOUT_MS),
    taskResultTimeoutMs: parsePositiveNumber(process.env.SMARTPLUS_TASK_RESULT_TIMEOUT_MS, DEFAULT_TASK_RESULT_TIMEOUT_MS),
    cloneStartDelayMs: parsePositiveNumber(
      process.env.SMARTPLUS_CLONE_START_DELAY_SECONDS,
      DEFAULT_CLONE_START_DELAY_SECONDS
    ) * 1000,
  };
}

async function getSigner(path: string, timeoutMs: number, baseUrl: string) {
  return axios.get(`${baseUrl}${path}`, { timeout: timeoutMs });
}

async function postSigner(path: string, payload: unknown, timeoutMs: number, baseUrl: string) {
  return axios.post(`${baseUrl}${path}`, payload, { timeout: timeoutMs });
}

async function getSignerTokens(baseUrl: string, timeoutMs: number) {
  const res = await getSigner('/tokens', timeoutMs, baseUrl);
  const snapshot = res.data.tokens;
  const csrfToken = String(snapshot.lastSignedHeaders?.['x-csrftoken'] || snapshot.xCsrfToken || '');
  return { csrfToken };
}

async function signedPost(params: {
  url: string;
  body: Record<string, unknown>;
  csrfToken: string;
  signerBaseUrl: string;
  signerTimeoutMs: number;
}) {
  return postSigner(
    '/sign-request',
    {
      method: 'POST',
      url: params.url,
      headers: {
        'content-type': 'application/json',
        'x-csrftoken': params.csrfToken,
      },
      body: JSON.stringify(params.body),
    },
    params.signerTimeoutMs,
    params.signerBaseUrl
  );
}

async function signedGet(params: {
  url: string;
  csrfToken: string;
  signerBaseUrl: string;
  signerTimeoutMs: number;
}) {
  return postSigner(
    '/sign-request',
    {
      method: 'GET',
      url: params.url,
      headers: { 'x-csrftoken': params.csrfToken },
    },
    params.signerTimeoutMs,
    params.signerBaseUrl
  );
}

async function listAdvertiserCampaigns(advertiserId: string): Promise<CampaignLookupItem[]> {
  const { accessToken } = await getTikTokConfig();
  const campaigns: CampaignLookupItem[] = [];
  let page = 1;

  while (true) {
    const response = await axios.get('https://business-api.tiktok.com/open_api/v1.3/campaign/get/', {
      params: { advertiser_id: advertiserId, page, page_size: CAMPAIGN_LOOKUP_PAGE_SIZE },
      headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json' },
      timeout: DEFAULT_SIGNER_TIMEOUT_MS,
    });

    if (response.data?.code !== 0) {
      throw new Error(`Khong doc duoc danh sach campaign: ${String(response.data?.message || 'Unknown error')}`);
    }

    const items = Array.isArray(response.data?.data?.list) ? (response.data.data.list as CampaignLookupItem[]) : [];
    campaigns.push(...items);
    if (items.length < CAMPAIGN_LOOKUP_PAGE_SIZE) break;
    page += 1;
  }

  return campaigns;
}

async function ensureSignerReady(config: { baseUrl: string; timeoutMs: number }): Promise<void> {
  const statusResponse = await getSigner('/login-status', config.timeoutMs, config.baseUrl);
  if (statusResponse.data?.stage === 'logged_in') return;

  console.warn(`[SmartPlus] Signer chua san sang, dang auto-login. Stage=${String(statusResponse.data?.stage || 'unknown')}`);

  try {
    const autoLoginResponse = await getSigner('/auto-login', config.timeoutMs, config.baseUrl);
    if (!autoLoginResponse.data?.success) {
      throw new Error(`Auto-login khong thanh cong: ${String(autoLoginResponse.data?.reason || 'Khong ro nguyen nhan')}`);
    }
  } catch (error) {
    if (!isAxiosTimeout(error)) throw error;
    console.warn(`[SmartPlus] /auto-login bi timeout. Tiep tuc doi...`);
  }

  const deadline = Date.now() + config.timeoutMs;
  let lastStage = 'unknown';

  while (Date.now() < deadline) {
    const verifiedStatus = await getSigner('/login-status', config.timeoutMs, config.baseUrl);
    if (verifiedStatus.data?.stage === 'logged_in') return;
    lastStage = String(verifiedStatus.data?.stage || 'unknown');
    await sleep(SIGNER_STATUS_POLL_INTERVAL_MS);
  }

  throw new Error(`Signer van chua dang nhap sau auto-login. Stage=${lastStage}`);
}

async function waitForCreatedCampaign(params: {
  advertiserId: string;
  originalCampaignId: string;
  targetCampaignName: string;
  timeoutMs: number;
  pollIntervalMs: number;
  returnDraftImmediately?: boolean;
  existingCampaignIds?: Set<string>;
  createdAfterMs?: number;
}): Promise<{ campaignId: string; status: 'created' | 'draft' } | null> {
  const deadline = Date.now() + params.timeoutMs;
  let latestDraft: { campaignId: string; status: 'draft' } | null = null;

  while (Date.now() < deadline) {
    const campaigns = await listAdvertiserCampaigns(params.advertiserId);
    const matchedCampaign = campaigns
      .filter((c) => {
        const createdAtMs = parseCampaignCreateTimeMs(c.create_time);
        return (
          String(c.campaign_id || '') !== params.originalCampaignId &&
          !params.existingCampaignIds?.has(String(c.campaign_id || '').trim()) &&
          (
            !params.createdAfterMs ||
            !createdAtMs ||
            createdAtMs >= params.createdAfterMs - CAMPAIGN_CREATE_TIME_GRACE_MS
          ) &&
          String(c.campaign_name || '').trim() === params.targetCampaignName
        );
      })
      .sort((a, b) => {
        return (parseCampaignCreateTimeMs(b.create_time) || 0) - (parseCampaignCreateTimeMs(a.create_time) || 0);
      })[0];

    const matchedId = String(matchedCampaign?.campaign_id || '').trim();
    if (matchedId) {
      const rawStatus = `${String(matchedCampaign?.operation_status || '')} ${String(matchedCampaign?.secondary_status || '')}`.toLowerCase();
      if (!rawStatus.includes('draft')) {
        return { campaignId: matchedId, status: 'created' };
      }
      latestDraft = { campaignId: matchedId, status: 'draft' };
      console.log(`[SmartPlus] Campaign o trang thai draft (${matchedId}).`);
      if (params.returnDraftImmediately) return latestDraft;
    }

    await sleep(params.pollIntervalMs);
  }

  return latestDraft;
}

async function attemptDraftPublish(params: {
  advertiserId: string;
  campaignId?: string;
  campaignName: string;
  signerBaseUrl: string;
  signerTimeoutMs: number;
  draftPublishTimeoutMs: number;
}): Promise<void> {
  const timeoutMs = Math.max(params.signerTimeoutMs, params.draftPublishTimeoutMs);
  const response = await postSigner(
    '/draft/publish',
    {
      advertiser_id: params.advertiserId,
      campaign_id: params.campaignId,
      campaign_name: params.campaignName,
      timeout_ms: params.draftPublishTimeoutMs,
    },
    timeoutMs,
    params.signerBaseUrl
  );

  console.log(`[SmartPlus] Draft publish response: ${JSON.stringify(response.data)}`);

  if (!response.data?.published) {
    throw new Error(
      String(response.data?.reason || 'Signer khong publish duoc draft.') +
      (Array.isArray(response.data?.capturedCreationUrls) && response.data.capturedCreationUrls.length > 0
        ? ` Captured endpoints: ${response.data.capturedCreationUrls.join(', ')}`
        : '')
    );
  }
}

function applyNumericOverrideDeep(
  value: unknown,
  overrideValue: number,
  fieldNames: string[]
): unknown {
  const normalizedFieldNames = new Set(fieldNames.map(normalizeFieldName));
  return applyNumericOverrideDeepWithNormalizedSet(value, overrideValue, normalizedFieldNames);
}

function applyNumericOverrideDeepWithNormalizedSet(
  value: unknown,
  overrideValue: number,
  normalizedFieldNames: ReadonlySet<string>
): unknown {
  if (Array.isArray(value)) {
    return value.map(item => applyNumericOverrideDeepWithNormalizedSet(item, overrideValue, normalizedFieldNames));
  }

  if (value && typeof value === 'object') {
    const cloned: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, nestedValue] of Object.entries(cloned)) {
      if (normalizedFieldNames.has(normalizeFieldName(key))) {
        cloned[key] = typeof nestedValue === 'string'
          ? String(overrideValue)
          : overrideValue;
        continue;
      }

      cloned[key] = applyNumericOverrideDeepWithNormalizedSet(nestedValue, overrideValue, normalizedFieldNames);
    }
    return cloned;
  }

  return value;
}

function isNumericLike(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && Number.isFinite(Number(trimmed.replace(/,/g, '')));
  }

  return value == null;
}

function coerceNumericOverrideValue(existingValue: unknown, overrideValue: number): unknown {
  if (typeof existingValue === 'string') {
    return String(overrideValue);
  }

  return overrideValue;
}

function isOverrideFieldExcluded(normalizedKey: string): boolean {
  const isIdentifierField =
    (normalizedKey.endsWith('id') && !normalizedKey.endsWith('bid')) ||
    normalizedKey.endsWith('ids');

  return (
    isIdentifierField ||
    normalizedKey.includes('name') ||
    normalizedKey.includes('mode') ||
    normalizedKey.includes('type') ||
    normalizedKey.includes('strategy') ||
    normalizedKey.includes('status') ||
    normalizedKey.includes('enabled') ||
    normalizedKey.includes('enable') ||
    normalizedKey.includes('auto') ||
    normalizedKey.includes('rule')
  );
}

function isBudgetOverrideField(normalizedKey: string): boolean {
  return normalizedKey.includes('budget') && !isOverrideFieldExcluded(normalizedKey);
}

function isBidOverrideField(normalizedKey: string): boolean {
  return (
    normalizedKey.includes('bid') ||
    normalizedKey.includes('targetcpa') ||
    normalizedKey.includes('targetcost') ||
    normalizedKey.includes('costcap') ||
    normalizedKey.includes('costperconversion')
  ) && !isOverrideFieldExcluded(normalizedKey);
}

function applyNumericOverrideDeepByMatcher(
  value: unknown,
  overrideValue: number,
  isOverrideField: (normalizedKey: string) => boolean
): unknown {
  if (Array.isArray(value)) {
    return value.map(item => applyNumericOverrideDeepByMatcher(item, overrideValue, isOverrideField));
  }

  if (value && typeof value === 'object') {
    const cloned: Record<string, unknown> = { ...(value as Record<string, unknown>) };

    for (const [key, nestedValue] of Object.entries(cloned)) {
      const normalizedKey = normalizeFieldName(key);

      if (isOverrideField(normalizedKey) && isNumericLike(nestedValue)) {
        cloned[key] = coerceNumericOverrideValue(nestedValue, overrideValue);
        continue;
      }

      cloned[key] = applyNumericOverrideDeepByMatcher(nestedValue, overrideValue, isOverrideField);
    }

    const descriptorValue = [
      'field',
      'fieldname',
      'name',
      'key',
      'code',
      'param',
      'paramname',
    ]
      .map(key => cloned[key])
      .find(item => typeof item === 'string' && isOverrideField(normalizeFieldName(item)));

    if (descriptorValue) {
      const valueKeys = ['value', 'fieldvalue', 'defaultvalue', 'currentvalue', 'amount'];
      let changed = false;

      for (const valueKey of valueKeys) {
        const existingKey = Object.keys(cloned).find(key => normalizeFieldName(key) === valueKey);
        if (existingKey && isNumericLike(cloned[existingKey])) {
          cloned[existingKey] = coerceNumericOverrideValue(cloned[existingKey], overrideValue);
          changed = true;
        }
      }

      if (!changed) {
        cloned.value = overrideValue;
      }
    }

    return cloned;
  }

  return value;
}

function applyBudgetOverrideToCampaignForm(
  campaignSketchFormData: Record<string, unknown>,
  overrideBudget: number | undefined,
  fallbackBudgetMode: string
): Record<string, unknown> {
  const cloned = { ...campaignSketchFormData };
  const effectiveBudget = overrideBudget ?? Number(cloned.budget ?? 0);

  if (!overrideBudget || !Number.isFinite(effectiveBudget) || effectiveBudget <= 0) {
    return cloned;
  }

  cloned.budget = typeof cloned.budget === 'string' ? String(effectiveBudget) : effectiveBudget;
  cloned.budget_value = typeof cloned.budget_value === 'string' ? String(effectiveBudget) : effectiveBudget;
  cloned.campaign_budget = typeof cloned.campaign_budget === 'string' ? String(effectiveBudget) : effectiveBudget;

  const normalizedBudgetMode = String(
    cloned.budget_mode ?? cloned.budgetMode ?? fallbackBudgetMode
  ).toUpperCase();
  const isLifetimeBudget = normalizedBudgetMode.includes('LIFETIME') || normalizedBudgetMode === '2';

  if ('daily_budget' in cloned) {
    cloned.daily_budget = isLifetimeBudget ? cloned.daily_budget : effectiveBudget;
  }
  if ('lifetime_budget' in cloned) {
    cloned.lifetime_budget = isLifetimeBudget ? effectiveBudget : cloned.lifetime_budget;
  }

  const budgetAutoAdjust = cloned.budget_auto_adjust;
  if (budgetAutoAdjust && typeof budgetAutoAdjust === 'object' && !Array.isArray(budgetAutoAdjust)) {
    cloned.budget_auto_adjust = {
      ...(budgetAutoAdjust as Record<string, unknown>),
      initial_budget: String(effectiveBudget),
    };
  }

  const exactApplied = applyNumericOverrideDeep(cloned, effectiveBudget, [
    'budget',
    'budgetvalue',
    'budgetamount',
    'campaignbudget',
    'campaignbudgetvalue',
    'dailybudget',
    'daybudget',
    'lifetimebudget',
    'totalbudget',
    'initialbudget',
    'adgroupbudget',
    'adgroupbudgetvalue',
  ]);

  return applyNumericOverrideDeepByMatcher(
    exactApplied,
    effectiveBudget,
    isBudgetOverrideField
  ) as Record<string, unknown>;
}

function applyBidOverrideToAdForm(
  adSketchFormData: Record<string, unknown>,
  overrideBid: number | undefined
): Record<string, unknown> {
  if (overrideBid == null || !Number.isFinite(overrideBid) || overrideBid <= 0) {
    return { ...adSketchFormData };
  }

  const exactApplied = applyNumericOverrideDeep(adSketchFormData, overrideBid, [
    'bid',
    'bidvalue',
    'bidprice',
    'bidamount',
    'conversionbid',
    'cpabid',
    'ocpcbid',
    'oecpcbid',
    'costcap',
    'costcapbid',
    'targetcost',
    'deepbid',
    'deepexternalactionbid',
    'targetcpa',
    'targetcpabid',
    'smartbid',
    'optimizationgoalbid',
    'goalbid',
    'roasbid',
    'maximumbid',
  ]);

  const cloned = applyNumericOverrideDeepByMatcher(
    exactApplied,
    overrideBid,
    isBidOverrideField
  ) as Record<string, unknown>;

  if (!('bid_price' in cloned)) {
    cloned.bid_price = overrideBid;
  }

  return cloned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSignedResponseData(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const parsed = parseJsonLikeString(value);
  return parsed ?? value;
}

function getSignedResponseData(response: unknown): any {
  const root = isRecord(response) ? response : {};
  const axiosData = isRecord(root.data) ? root.data : {};
  const signerData = isRecord(axiosData.data) ? axiosData.data : axiosData;

  if ('responseData' in signerData) {
    return parseSignedResponseData(signerData.responseData);
  }

  if (isRecord(signerData.response) && 'data' in signerData.response) {
    return parseSignedResponseData(signerData.response.data);
  }

  if ('response' in signerData) {
    return parseSignedResponseData(signerData.response);
  }

  return undefined;
}

function hasTikTokResponseCode(value: unknown): value is { code: number; message?: unknown; data?: any } {
  return isRecord(value) && typeof value.code === 'number';
}

function summarizeSignedResponse(response: unknown): string {
  const root = isRecord(response) ? response : {};
  const axiosData = isRecord(root.data) ? root.data : {};
  const signerData = isRecord(axiosData.data) ? axiosData.data : axiosData;
  const summary = {
    status: axiosData.status,
    responseStatus: signerData.responseStatus,
    responseData: signerData.responseData,
  };

  return JSON.stringify(summary).slice(0, 2000);
}

function parseJsonLikeString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || !['{', '['].includes(trimmed[0])) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeCampaignIdCandidate(value: unknown): string | null {
  const normalizedValue = String(value ?? '').trim();
  return /^\d{8,}$/.test(normalizedValue) ? normalizedValue : null;
}

function pushCampaignIdCandidate(
  candidates: string[],
  value: unknown,
  ignoredCampaignIds: ReadonlySet<string>
): void {
  const campaignId = normalizeCampaignIdCandidate(value);
  if (campaignId && !ignoredCampaignIds.has(campaignId) && !candidates.includes(campaignId)) {
    candidates.push(campaignId);
  }
}

function collectCampaignIdCandidates(
  value: unknown,
  ignoredCampaignIds: ReadonlySet<string>,
  candidates: string[] = [],
  seen = new Set<object>()
): string[] {
  if (typeof value === 'string') {
    const parsed = parseJsonLikeString(value);
    if (parsed != null) {
      collectCampaignIdCandidates(parsed, ignoredCampaignIds, candidates, seen);
    }
    return candidates;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCampaignIdCandidates(item, ignoredCampaignIds, candidates, seen);
    }
    return candidates;
  }

  if (!isRecord(value)) return candidates;
  if (seen.has(value)) return candidates;
  seen.add(value);

  const entityType = String(
    value.object_type ??
    value.entity_type ??
    value.resource_type ??
    value.material_type ??
    value.type ??
    ''
  ).toLowerCase();
  const isCampaignEntity = entityType.includes('campaign');

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = normalizeFieldName(key);

    if (
      normalizedKey === 'campaignid' ||
      normalizedKey === 'newcampaignid' ||
      normalizedKey === 'campaignidstr' ||
      normalizedKey === 'newcampaignidstr' ||
      normalizedKey === 'targetcampaignid'
    ) {
      if (Array.isArray(nestedValue)) {
        nestedValue.forEach(item => pushCampaignIdCandidate(candidates, item, ignoredCampaignIds));
      } else {
        pushCampaignIdCandidate(candidates, nestedValue, ignoredCampaignIds);
      }
    }

    if (
      isCampaignEntity &&
      ['id', 'objectid', 'entityid', 'resourceid'].includes(normalizedKey)
    ) {
      pushCampaignIdCandidate(candidates, nestedValue, ignoredCampaignIds);
    }

    collectCampaignIdCandidates(nestedValue, ignoredCampaignIds, candidates, seen);
  }

  return candidates;
}

function findCampaignIdInPayload(
  value: unknown,
  ignoredCampaignIds: ReadonlySet<string> = new Set<string>()
): string | undefined {
  return collectCampaignIdCandidates(value, ignoredCampaignIds)[0];
}

function collectStatusLikeValues(
  value: unknown,
  statuses: string[] = [],
  seen = new Set<object>()
): string[] {
  if (typeof value === 'string') {
    const parsed = parseJsonLikeString(value);
    if (parsed != null) {
      collectStatusLikeValues(parsed, statuses, seen);
    }
    return statuses;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStatusLikeValues(item, statuses, seen);
    }
    return statuses;
  }

  if (!isRecord(value)) return statuses;
  if (seen.has(value)) return statuses;
  seen.add(value);

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = normalizeFieldName(key);
    if (
      normalizedKey === 'status' ||
      normalizedKey === 'taskstatus' ||
      normalizedKey === 'asyncstatus' ||
      normalizedKey === 'createstatus' ||
      normalizedKey === 'state' ||
      normalizedKey === 'stage'
    ) {
      statuses.push(String(nestedValue ?? '').trim().toLowerCase());
    }

    collectStatusLikeValues(nestedValue, statuses, seen);
  }

  return statuses.filter(Boolean);
}

function getAsyncTaskState(payload: unknown): {
  finished: boolean;
  failed: boolean;
  status?: string;
  reason?: string;
} {
  const statuses = collectStatusLikeValues(payload);
  const status = statuses.find(Boolean);
  const statusText = statuses.join(' ');

  if (/(fail|failed|error|reject|rejected|cancel|canceled|invalid)/.test(statusText)) {
    const reason = isRecord(payload)
      ? String(payload.message || payload.reason || payload.error_msg || payload.error_message || '').trim()
      : '';
    return { finished: true, failed: true, status, reason: reason || undefined };
  }

  if (/(success|succeed|succeeded|done|finish|finished|complete|completed|publish|published|created)/.test(statusText)) {
    return { finished: true, failed: false, status };
  }

  return { finished: false, failed: false, status };
}

// Poll async task result using the correct endpoint: async_creation/detail/?async_request_id=...
async function pollAsyncTaskResult(params: {
  advertiserId: string;
  asyncRequestId: string;
  signerBaseUrl: string;
  signerTimeoutMs: number;
  timeoutMs: number;
  pollIntervalMs: number;
  ignoredCampaignIds?: ReadonlySet<string>;
}): Promise<AsyncTaskPollResult | null> {
  const deadline = Date.now() + params.timeoutMs;
  const { csrfToken } = await getSignerTokens(params.signerBaseUrl, params.signerTimeoutMs);

  const detailUrl = `https://ads.tiktok.com/api/v4/i18n/creation/async_creation/detail/?aadvid=${params.advertiserId}&req_src=ad_creation&async_request_id=${params.asyncRequestId}`;

  while (Date.now() < deadline) {
    try {
      const res = await signedGet({
        url: detailUrl,
        csrfToken,
        signerBaseUrl: params.signerBaseUrl,
        signerTimeoutMs: params.signerTimeoutMs,
      });

      const payload = getSignedResponseData(res);
      console.log(`[SmartPlus] Async detail response: ${JSON.stringify(payload)}`);

      if (!hasTikTokResponseCode(payload) || payload.code !== 0) {
        await sleep(params.pollIntervalMs);
        continue;
      }

      const taskData = payload.data;
      const campaignId = findCampaignIdInPayload(taskData, params.ignoredCampaignIds);
      const taskState = getAsyncTaskState(taskData);

      if (taskState.failed) {
        return {
          finished: true,
          failed: true,
          reason: taskState.reason || String(taskData?.message || taskData?.reason || 'Async task loi'),
          status: taskState.status,
          campaignId,
        };
      }

      if (campaignId || taskState.finished) {
        return {
          finished: true,
          failed: false,
          campaignId,
          status: taskState.status,
        };
      }
    } catch (err) {
      console.warn(`[SmartPlus] Loi khi poll async task: ${getErrorMessage(err)}`);
    }

    await sleep(params.pollIntervalMs);
  }

  return null;
}

export async function duplicateSmartPlusCampaign(
  advertiserId: string,
  originalCampaignId: string,
  options?: {
    newName?: string;
    overrideBudget?: number;
    overrideBid?: number;
  }
): Promise<SmartPlusDuplicateResult> {
  const cfg = getSmartPlusSignerConfig();

  if (cfg.mode === 'disabled') {
    throw new Error('Nhan ban Smart+ dang bi tat. Hay bat SMARTPLUS_DUPLICATION_MODE.');
  }

  console.log(`[SmartPlus] Bat dau duplicate campaign ${originalCampaignId} (Adv: ${advertiserId})`);
  const duplicateStartedAtMs = Date.now();

  try {
    await ensureSignerReady(cfg);
  } catch (error: any) {
    throw new Error(`Smart+ signer (${cfg.baseUrl}) chua san sang: ${getErrorMessage(error)}`);
  }

  // Fetch original campaign to get budget fallback (since copy API doesn't return it)
  console.log(`[SmartPlus] Lay thong tin campaign goc ${originalCampaignId}`);
  const campaigns = await listAdvertiserCampaigns(advertiserId);
  const existingCampaignIds = new Set(
    campaigns
      .map(c => String(c.campaign_id || '').trim())
      .filter(Boolean)
  );
  existingCampaignIds.add(String(originalCampaignId));
  const origCamp = campaigns.find(c => String(c.campaign_id) === String(originalCampaignId));
  const fallbackBudget = origCamp?.budget ?? 20; // Default if completely unknown
  const fallbackBudgetMode = origCamp?.budget_mode ?? 'BUDGET_MODE_DAY';

  const { csrfToken } = await getSignerTokens(cfg.baseUrl, cfg.timeoutMs);
  const requestedCampaignName = options?.newName || `${origCamp?.campaign_name || originalCampaignId} - API`;
  const targetCampaignName = buildUniqueCampaignName(requestedCampaignName, originalCampaignId);
  const cloneStartTime = new Date(Date.now() + cfg.cloneStartDelayMs);
  console.log(`[SmartPlus] Ten campaign moi: ${targetCampaignName}`);
  console.log(`[SmartPlus] Lich chay clone: ${formatTikTokDateTime(cloneStartTime)}`);

  // ── STEP 1: Copy campaign snap ────────────────────────────────────────────
  // Correct URL uses /mi/api/v4/ prefix (confirmed from HAR)
  console.log('[SmartPlus] Buoc 1: Copy campaign snap');
  const copyUrl = `https://ads.tiktok.com/mi/api/v4/i18n/creation/campaign_snap/copy/?aadvid=${advertiserId}&req_src=ad_creation`;
  const copyPayload = {
    campaign_id: originalCampaignId,
    name: targetCampaignName,
    with_sketch: true,
    with_ad: true,
    with_creative: true,
    risk_info: DEFAULT_RISK_INFO,
  };

  const copyRes = await signedPost({
    url: copyUrl,
    body: copyPayload,
    csrfToken,
    signerBaseUrl: cfg.baseUrl,
    signerTimeoutMs: cfg.timeoutMs,
  });

  const copyData = getSignedResponseData(copyRes);
  if (!hasTikTokResponseCode(copyData) || copyData.code !== 0) {
    console.error('[SmartPlus] Copy response:', JSON.stringify(copyRes.data, null, 2));
    throw new Error(`Loi tao ban sao Smart+ (Copy API): code=${copyData?.code} msg=${copyData?.message || ''}`);
  }

  const dupData = copyData.data;
  const campaignSnapId: string = dupData.new_campaign_snap_info_item.campaign_snap_id;
  const campaignSketchId: string = dupData.new_campaign_sketch_id;

  // Dynamically map all ads and their creatives
  const adSnapItemsList: any[] = dupData.new_ad_snap_info_item_list || [];
  const adSketchIdsList: string[] = dupData.new_ad_sketch_ids || [];
  
  const mappedAdList = adSnapItemsList.map((adSnapItem, index) => {
    const adSnapId = adSnapItem.ad_snap_id;
    const adSketchId = adSketchIdsList[index];
    
    const creativeSnapItems = dupData.new_ad_and_creative_snap_info_item_map[adSnapId] || [];
    const creativeSketchIds = dupData.new_ad_and_creative_sketch_ids_map[adSketchId] || [];
    
    const mappedCreatives = creativeSnapItems.map((cItem: any, cIndex: number) => ({
      creative_id: '',
      creative_snap_id: cItem.creative_snap_id,
      creative_sketch_id: creativeSketchIds[cIndex],
      need_publish: true,
    }));

    return {
      ad_id: '',
      ad_snap_id: adSnapId,
      ad_sketch_id: adSketchId,
      creative_snap_info_list: mappedCreatives,
      need_publish: true,
    };
  });

  console.log(`[SmartPlus] Duplicated CampaignSnap=${campaignSnapId}, Ads count: ${mappedAdList.length}`);


  // ── STEP 2: Get snap detail to fetch real campaign + ad data ─────────────
  console.log('[SmartPlus] Buoc 2: Lay snap detail');
  const snapDetailUrl = `https://ads.tiktok.com/api/v4/i18n/creation/snap/detail/?aadvid=${advertiserId}&req_src=ad_creation`;
  let snapDetail: Record<string, any> = {};
  try {
    const snapDetailRes = await signedPost({
      url: snapDetailUrl,
      body: {
        campaign_snap_ids: [campaignSnapId],
        ad_snap_ids: mappedAdList.map(ad => ad.ad_snap_id),
      },
      csrfToken,
      signerBaseUrl: cfg.baseUrl,
      signerTimeoutMs: cfg.timeoutMs,
    });
    const snapDetailData = getSignedResponseData(snapDetailRes);
    if (hasTikTokResponseCode(snapDetailData) && snapDetailData.code === 0 && snapDetailData.data) {
      snapDetail = snapDetailData.data;
      console.log('[SmartPlus] Snap detail OK');
    } else {
      console.warn('[SmartPlus] Snap detail loi (non-fatal):', JSON.stringify(snapDetailData));
    }
  } catch (err) {
    console.warn('[SmartPlus] Snap detail exception (non-fatal):', getErrorMessage(err));
  }

  // Extract campaign sketch form data from snap detail
  const campaignSnapItems: any[] = snapDetail?.campaign_snap_list ?? snapDetail?.campaign_snap_info_list ?? snapDetail?.campaign_snap_items ?? [];
  const campaignSketchForm: Record<string, any> =
    campaignSnapItems.find((item: any) =>
      String(item?.campaign_snap_id ?? item?.snap_id ?? '') === campaignSnapId
    )?.campaign_sketch_form_data ??
    campaignSnapItems[0]?.campaign_sketch_form_data ??
    {};

  // Fallback budget if not retrieved from snap detail
  if (!campaignSketchForm.budget) {
    campaignSketchForm.budget = String(fallbackBudget);
    campaignSketchForm.budget_mode = fallbackBudgetMode === 'BUDGET_MODE_LIFETIME' ? 2 : 3;
    campaignSketchForm.budget_auto_adjust = { is_enabled: 1, initial_budget: String(fallbackBudget), strategy: 1 };
  }


  // ── STEP 3: Save campaign snap ────────────────────────────────────────────
  console.log('[SmartPlus] Buoc 3: Save campaign snap');
  const saveUrl = `https://ads.tiktok.com/api/v4/i18n/creation/campaign_snap/save/?aadvid=${advertiserId}&req_src=ad_creation`;
  const updatedCampaignSketchForm = applyCloneScheduleDeep(
    applyBudgetOverrideToCampaignForm(
      {
        ...campaignSketchForm,
        campaign_snap_id: campaignSnapId,
        campaign_sketch_id: campaignSketchId,
        campaign_name: targetCampaignName,
        name: targetCampaignName,
        origin_campaign_id: Number(originalCampaignId),
      },
      options?.overrideBudget,
      fallbackBudgetMode
    ),
    cloneStartTime
  ) as Record<string, unknown>;

  const savePayload = {
    with_sketch: true,
    clear_lower_level_sketches: false,
    // Use real data from snap detail, override name and IDs
    campaign_sketch_form_data: updatedCampaignSketchForm,
    is_skip_check_fields: true,
  };

  const saveRes = await signedPost({
    url: saveUrl,
    body: savePayload,
    csrfToken,
    signerBaseUrl: cfg.baseUrl,
    signerTimeoutMs: cfg.timeoutMs,
  });

  const saveData = getSignedResponseData(saveRes);
  if (!hasTikTokResponseCode(saveData)) {
    console.warn('[SmartPlus] Save campaign snap response khong ro (non-fatal):', summarizeSignedResponse(saveRes));
  } else if (saveData.code !== 0) {
    console.warn('[SmartPlus] Save campaign snap (non-fatal):', JSON.stringify(saveData));
  } else {
    console.log('[SmartPlus] Save campaign snap thanh cong');
  }

  // ── STEP 4: Save ad snaps (missing step — causes draft if skipped) ─────────
  console.log('[SmartPlus] Buoc 4: Save ad snaps');
  const adSnapSaveUrl = `https://ads.tiktok.com/api/v4/i18n/creation/ad_snap/save/?aadvid=${advertiserId}&req_src=ad_creation`;
  const adSnapItems: any[] = snapDetail?.ad_snap_list ?? snapDetail?.ad_snap_info_list ?? snapDetail?.ad_snap_info_item_list ?? snapDetail?.ad_snaps ?? snapDetail?.ad_snap_items ?? [];

  for (const adData of mappedAdList) {
    const currentAdSnapId = adData.ad_snap_id;
    let adSketchFormData = adSnapItems.find((item: any) =>
      String(item?.ad_snap_id ?? item?.snap_id ?? '') === currentAdSnapId
    )?.ad_sketch_form_data;

    // Fallback if exactly matching ID is not found (use the first one available)
    if (!adSketchFormData && adSnapItems.length > 0) {
      adSketchFormData = adSnapItems[0]?.ad_sketch_form_data;
    }

    if (adSketchFormData && Object.keys(adSketchFormData).length > 0) {
      const updatedAdSketchForm = applyBidOverrideToAdForm(
        applyBudgetOverrideToCampaignForm(
          applyCloneScheduleDeep(
            {
              ...adSketchFormData,
              ad_snap_id: currentAdSnapId,
              ad_sketch_id: adData.ad_sketch_id,
              campaign_snap_id: campaignSnapId,
              campaign_sketch_id: campaignSketchId,
              snap_create_source: 1,
            },
            cloneStartTime
          ) as Record<string, unknown>,
          options?.overrideBudget,
          fallbackBudgetMode
        ),
        options?.overrideBid
      );

      const adSavePayload = {
        campaign_id: '',
        campaign_snap_id: campaignSnapId,
        campaign_sketch_id: campaignSketchId,
        with_sketch: true,
        clear_lower_level_sketches: false,
        is_skip_check_fields: true,
        ad_sketch_form_data: updatedAdSketchForm,
        risk_info: DEFAULT_RISK_INFO,
      };

      try {
        const adSaveRes = await signedPost({
          url: adSnapSaveUrl,
          body: adSavePayload,
          csrfToken,
          signerBaseUrl: cfg.baseUrl,
          signerTimeoutMs: cfg.timeoutMs,
        });
        const adSaveData = getSignedResponseData(adSaveRes);
        if (!hasTikTokResponseCode(adSaveData)) {
          console.warn(`[SmartPlus] Save ad snap ${currentAdSnapId} response khong ro (non-fatal):`, summarizeSignedResponse(adSaveRes));
        } else if (adSaveData.code !== 0) {
          console.warn(`[SmartPlus] Save ad snap ${currentAdSnapId} (non-fatal):`, JSON.stringify(adSaveData));
        } else {
          console.log(`[SmartPlus] Save ad snap ${currentAdSnapId} thanh cong`);
        }
      } catch (err) {
        console.warn(`[SmartPlus] Save ad snap ${currentAdSnapId} exception (non-fatal):`, getErrorMessage(err));
      }
    } else {
      console.warn(`[SmartPlus] Khong lay duoc ad_sketch_form_data cho ${currentAdSnapId}, bo qua luu Ad`);
    }
  }

  // ── STEP 5: Check campaign snap validity ──────────────────────────────────
  console.log('[SmartPlus] Buoc 5: Check campaign snap');
  const checkUrl = `https://ads.tiktok.com/api/v4/i18n/creation/campaign_snap/check/?aadvid=${advertiserId}&req_src=ad_creation`;
  const checkRes = await signedPost({
    url: checkUrl,
    body: { campaign_snap_id: campaignSnapId },
    csrfToken,
    signerBaseUrl: cfg.baseUrl,
    signerTimeoutMs: cfg.timeoutMs,
  });

  const checkData = getSignedResponseData(checkRes);
  console.log('[SmartPlus] Check snap response:', JSON.stringify(checkData));
  if (hasTikTokResponseCode(checkData) && checkData.code !== 0) {
    console.warn(`[SmartPlus] Check snap loi (non-fatal): code=${checkData.code} msg=${checkData.message || ''}`);
  }

  // ── STEP 5.5: Check ad creative snap validity ─────────────────────────────
  console.log('[SmartPlus] Buoc 5.5: Check ad creative snap');
  const commonAdCreativeList = mappedAdList.map(ad => ({
    ad_id: '',
    ad_snap_id: ad.ad_snap_id,
    creative_snap_ids: ad.creative_snap_info_list.map((c: any) => c.creative_snap_id)
  }));

  const adCreativeCheckUrl = `https://ads.tiktok.com/api/v4/i18n/creation/ad_creative_snap/check/?aadvid=${advertiserId}&req_src=ad_creation`;
  const adCreativeCheckPayload = {
    campaign_id: '',
    fake_campaign_id: campaignSketchId, // mapped to fake_campaign_id in HAR
    ad_creative_snap_check_info: commonAdCreativeList,
    risk_info: DEFAULT_RISK_INFO
  };

  try {
    const adCreativeCheckRes = await signedPost({
      url: adCreativeCheckUrl,
      body: adCreativeCheckPayload,
      csrfToken,
      signerBaseUrl: cfg.baseUrl,
      signerTimeoutMs: cfg.timeoutMs,
    });
    const adCreativeCheckData = getSignedResponseData(adCreativeCheckRes);
    if (!hasTikTokResponseCode(adCreativeCheckData) || adCreativeCheckData.code !== 0) {
      console.warn(`[SmartPlus] Check ad creative snap loi (non-fatal):`, JSON.stringify(adCreativeCheckRes.data));
    }
  } catch (err) {
    console.warn(`[SmartPlus] Check ad creative snap exception (non-fatal):`, getErrorMessage(err));
  }

  // ── STEP 5.6: Initialize CTA IDs and DM Privacy Settings ────────────────
  console.log('[SmartPlus] Buoc 5.6: Init CTA IDs & DM Privacy');
  const commonSnapPayload = {
    campaign_id: '',
    campaign_snap_id: campaignSnapId,
    ad_and_creative_snap_info_list: commonAdCreativeList
  };

  try {
    await signedPost({
      url: `https://ads.tiktok.com/api/v4/i18n/creation/snap/update_identity_dm_privacy_setting/?aadvid=${advertiserId}&req_src=ad_creation`,
      body: commonSnapPayload,
      csrfToken,
      signerBaseUrl: cfg.baseUrl,
      signerTimeoutMs: cfg.timeoutMs,
    });
    await signedPost({
      url: `https://ads.tiktok.com/api/v4/i18n/creation/snap/batch_create_cta_id/?aadvid=${advertiserId}&req_src=ad_creation`,
      body: commonSnapPayload,
      csrfToken,
      signerBaseUrl: cfg.baseUrl,
      signerTimeoutMs: cfg.timeoutMs,
    });
    console.log('[SmartPlus] Init CTA IDs & DM Privacy thanh cong');
  } catch (err) {
    console.warn(`[SmartPlus] Init CTA IDs & DM Privacy exception (non-fatal):`, getErrorMessage(err));
  }

  // ── STEP 6: Publish via create_by_snap ───────────────────────────────────
  console.log('[SmartPlus] Buoc 6: Publish qua create_by_snap');
  const publishUrl = `https://ads.tiktok.com/api/v4/i18n/creation/async_creation/create_by_snap/?aadvid=${advertiserId}&req_src=ad_creation`;
  const publishPayload = {
    campaign_id: '',
    campaign_snap_id: campaignSnapId,
    campaign_sketch_id: campaignSketchId,
    ad_and_creative_snap_info_list: mappedAdList,
    coming_source_type: 1,
    sketch_publish_source: 1,
    is_partial_publish: false,
    is_status_disabled: false,
    risk_info: DEFAULT_RISK_INFO,
  };

  const publishRes = await signedPost({
    url: publishUrl,
    body: publishPayload,
    csrfToken,
    signerBaseUrl: cfg.baseUrl,
    signerTimeoutMs: cfg.timeoutMs,
  });

  const publishData = getSignedResponseData(publishRes);
  if (!hasTikTokResponseCode(publishData) || publishData.code !== 0) {
    console.error('[SmartPlus] Publish response:', JSON.stringify(publishRes.data, null, 2));
    throw new Error(`Loi xuat ban Smart+ (create_by_snap): code=${publishData?.code} msg=${publishData?.message || ''}`);
  }

  console.log('[SmartPlus] create_by_snap thanh cong:', JSON.stringify(publishData.data));

  // async_request_id is the correct field name (confirmed from HAR)
  const asyncRequestId = String(
    publishData.data?.async_request_id ||
    publishData.data?.task_id ||
    publishData.data?.asyncRequestId ||
    ''
  ).trim();

  const immediateCampaignId = findCampaignIdInPayload(publishData.data, existingCampaignIds);
  if (immediateCampaignId) {
    console.log(`[SmartPlus] Publish response tra ve campaign moi: ${immediateCampaignId}`);
    return {
      status: 'created',
      campaignId: immediateCampaignId,
      taskId: asyncRequestId || campaignSnapId,
      campaignName: targetCampaignName,
      advertiserId,
    };
  }

  // ── STEP 5: Poll async task result ───────────────────────────────────────
  if (asyncRequestId) {
    console.log(`[SmartPlus] Buoc 5: Poll async task (async_request_id=${asyncRequestId})`);
    const asyncResult = await pollAsyncTaskResult({
      advertiserId,
      asyncRequestId,
      signerBaseUrl: cfg.baseUrl,
      signerTimeoutMs: cfg.timeoutMs,
      timeoutMs: cfg.taskResultTimeoutMs,
      pollIntervalMs: cfg.campaignPollIntervalMs,
      ignoredCampaignIds: existingCampaignIds,
    });

    if (asyncResult?.failed) {
      throw new Error(`Async task bi loi: ${asyncResult.reason || 'Unknown'}`);
    }

    if (asyncResult?.campaignId) {
      if (existingCampaignIds.has(asyncResult.campaignId)) {
        console.warn(`[SmartPlus] Async task tra ve campaign ID cu (${asyncResult.campaignId}). Bo qua va tiep tuc doi campaign moi.`);
      } else {
        console.log(`[SmartPlus] Campaign duoc tao thanh cong: ${asyncResult.campaignId}`);
        return {
          status: 'created',
          campaignId: asyncResult.campaignId,
          taskId: asyncRequestId,
          campaignName: targetCampaignName,
          advertiserId,
        };
      }
    }
  }

  // ── STEP 6: Poll via campaign list API as fallback ────────────────────────
  console.log('[SmartPlus] Buoc 6: Doi campaign xuat hien trong danh sach');
  const settleDeadline = Date.now() + cfg.settleTimeoutMs;

  let createdCampaign = await waitForCreatedCampaign({
    advertiserId,
    originalCampaignId,
    targetCampaignName,
    timeoutMs: Math.min(cfg.discoveryTimeoutMs, cfg.settleTimeoutMs),
    pollIntervalMs: cfg.campaignPollIntervalMs,
    returnDraftImmediately: true,
    existingCampaignIds,
    createdAfterMs: duplicateStartedAtMs,
  });

  if (!createdCampaign) {
    createdCampaign = await waitForCreatedCampaign({
      advertiserId,
      originalCampaignId,
      targetCampaignName,
      timeoutMs: Math.max(cfg.campaignPollIntervalMs, settleDeadline - Date.now()),
      pollIntervalMs: cfg.campaignPollIntervalMs,
      returnDraftImmediately: true,
      existingCampaignIds,
      createdAfterMs: duplicateStartedAtMs,
    });
  }

  // ── STEP 7: If still draft, try Playwright UI publish ────────────────────
  if (createdCampaign?.status === 'draft') {
    console.warn(`[SmartPlus] Campaign ${createdCampaign.campaignId} van o draft. Thu publish bang UI...`);
    try {
      await attemptDraftPublish({
        advertiserId,
        campaignId: createdCampaign.campaignId,
        campaignName: targetCampaignName,
        signerBaseUrl: cfg.baseUrl,
        signerTimeoutMs: cfg.timeoutMs,
        draftPublishTimeoutMs: cfg.draftPublishTimeoutMs,
      });

      createdCampaign = await waitForCreatedCampaign({
        advertiserId,
        originalCampaignId,
        targetCampaignName,
        timeoutMs: Math.max(cfg.campaignPollIntervalMs, settleDeadline - Date.now()),
        pollIntervalMs: cfg.campaignPollIntervalMs,
        returnDraftImmediately: false,
        existingCampaignIds,
        createdAfterMs: duplicateStartedAtMs,
      }) || createdCampaign;
    } catch (error) {
      console.error('[SmartPlus] Khong publish duoc draft bang UI:', getErrorMessage(error));
    }
  }

  if (createdCampaign) {
    return {
      status: createdCampaign.status,
      campaignId: createdCampaign.campaignId,
      taskId: asyncRequestId || campaignSnapId,
      campaignName: targetCampaignName,
      advertiserId,
    };
  }

  return {
    status: 'queued',
    taskId: asyncRequestId || campaignSnapId,
    campaignName: targetCampaignName,
    advertiserId,
  };
}
