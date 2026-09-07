import {
  getAdvertiserPermissions,
  getBusinessCenterId,
  getTikTokTokenConfig,
  type AdvertiserPermission,
  type TikTokTokenConfig,
} from '../google-sheets/api.js';

// Configuration for TikTok API
export interface TikTokConfig {
  accessToken: string;
  advertiserIds: string[];
  businessCenterId?: string;
}

export interface TikTokBalanceConfig {
  accessToken: string;
  businessCenterId: string;
  advertiserIds: string[];
  advertiserAccounts: AdvertiserPermission[];
}

const PLACEHOLDER_VALUES = new Set([
  'comma_separated_advertiser_ids',
  'your_tiktok_access_token_here',
  'your_business_center_id_here',
]);

const TIKTOK_TOKEN_CACHE_TTL_MS = 60_000;
let cachedTikTokTokenConfig: { value: TikTokTokenConfig; expiresAt: number } | undefined;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value) || value.startsWith('your_') || value.endsWith('_here');
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value || isPlaceholder(value)) {
    throw new Error(`Missing ${name} in .env`);
  }

  return value;
}

async function getCachedTikTokTokenConfig(): Promise<TikTokTokenConfig> {
  const now = Date.now();
  if (cachedTikTokTokenConfig && cachedTikTokTokenConfig.expiresAt > now) {
    return cachedTikTokTokenConfig.value;
  }

  try {
    const value = await getTikTokTokenConfig();
    cachedTikTokTokenConfig = {
      value,
      expiresAt: now + TIKTOK_TOKEN_CACHE_TTL_MS,
    };
    return value;
  } catch (error) {
    if (cachedTikTokTokenConfig) {
      console.warn('[TikTokConfig] Token sheet read failed; using last-known-good token config:', error);
      return cachedTikTokTokenConfig.value;
    }
    throw error;
  }
}

async function getReadAccessToken(): Promise<string> {
  const tokenConfig = await getCachedTikTokTokenConfig();
  const readToken = tokenConfig.readAccessToken?.trim();

  if (readToken && !isPlaceholder(readToken)) {
    return readToken;
  }

  throw new Error('Missing TIKTOK_READ_ACCESS_TOKEN in Google Sheet tab Token');
}

async function getWriteAccessToken(): Promise<string> {
  const tokenConfig = await getCachedTikTokTokenConfig();
  const writeToken = tokenConfig.writeAccessToken?.trim();

  if (writeToken && !isPlaceholder(writeToken)) {
    return writeToken;
  }

  throw new Error('Missing TIKTOK_WRITE_ACCESS_TOKEN in Google Sheet tab Token');
}

function getAdvertiserIdsFromEnv(required: boolean): string[] {
  const rawValue = process.env.TIKTOK_ADVERTISER_IDS?.trim();

  if (!rawValue || isPlaceholder(rawValue)) {
    if (required) {
      throw new Error('Missing TIKTOK_ADVERTISER_IDS in .env');
    }

    return [];
  }

  return rawValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id && !isPlaceholder(id));
}

async function getConfiguredAdvertiserAccounts(required: boolean): Promise<AdvertiserPermission[]> {
  const advertiserAccounts = await getAdvertiserPermissions();

  if (advertiserAccounts.length > 0) {
    return advertiserAccounts;
  }

  const envAdvertiserIds = getAdvertiserIdsFromEnv(false);

  if (envAdvertiserIds.length > 0) {
    return envAdvertiserIds.map(advertiserId => ({
      mktCode: 'ENV',
      advertiserId,
      enabled: true,
    }));
  }

  if (required && advertiserAccounts.length === 0) {
    throw new Error('Missing TikTok advertiser IDs. Add TIKTOK_ADVERTISER_IDS in .env or enabled rows in Google Sheet tab Permissions.');
  }

  return advertiserAccounts;
}

async function getConfiguredAdvertiserIds(required: boolean): Promise<string[]> {
  const advertiserAccounts = await getConfiguredAdvertiserAccounts(required);
  return [...new Set(advertiserAccounts.map(account => account.advertiserId))];
}

async function getConfiguredBusinessCenterId(): Promise<string> {
  const envBusinessCenterId = process.env.TIKTOK_BC_ID?.trim();

  if (envBusinessCenterId && !isPlaceholder(envBusinessCenterId)) {
    return envBusinessCenterId;
  }

  const sheetBusinessCenterId = await getBusinessCenterId();

  if (!sheetBusinessCenterId || isPlaceholder(sheetBusinessCenterId)) {
    throw new Error('Missing TikTok Business Center ID. Add TIKTOK_BC_ID in .env or put it in Google Sheet tab BC cell A2.');
  }

  return sheetBusinessCenterId;
}

/**
 * Get the TikTok API configuration from environment variables
 */
export async function getTikTokConfig(): Promise<TikTokConfig> {
  const accessToken = await getReadAccessToken();
  const advertiserIds = await getConfiguredAdvertiserIds(true);
  const businessCenterId = process.env.TIKTOK_BC_ID?.trim();

  return {
    accessToken,
    advertiserIds,
    businessCenterId: businessCenterId && !isPlaceholder(businessCenterId) ? businessCenterId : undefined,
  };
}

/**
 * Read-token-only accessor for high-frequency TikTok API paths.
 * It deliberately avoids loading advertiser Permissions on every request.
 */
export async function getTikTokReadAccessToken(): Promise<string> {
  return getReadAccessToken();
}

/**
 * Get the TikTok API configuration needed for balance APIs.
 */
export async function getTikTokBalanceConfig(): Promise<TikTokBalanceConfig> {
  const advertiserAccounts = await getConfiguredAdvertiserAccounts(false);

  return {
    accessToken: await getReadAccessToken(),
    businessCenterId: await getConfiguredBusinessCenterId(),
    advertiserIds: [...new Set(advertiserAccounts.map(account => account.advertiserId))],
    advertiserAccounts,
  };
}

export async function getTikTokWriteAccessToken(): Promise<string> {
  return getWriteAccessToken();
}

/**
 * Validate the TikTok API configuration
 */
export async function validateTikTokConfig(): Promise<boolean> {
  try {
    const config = await getTikTokConfig();
    return !!config.accessToken && config.advertiserIds.length > 0;
  } catch (error) {
    console.error('TikTok configuration validation failed:', error);
    return false;
  }
}
