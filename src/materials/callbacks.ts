import type { MaterialOperationStatus } from './service.js';

function encodeId(value: string): string {
  return BigInt(value).toString(36);
}

function decodeId(value: string): string {
  let result = 0n;
  for (const char of value.toLowerCase()) {
    const digit = BigInt(parseInt(char, 36));
    if (digit < 0n || digit >= 36n) throw new Error('Invalid base36 id');
    result = result * 36n + digit;
  }
  return result.toString(10);
}

export function buildMaterialDetailCallbackData(
  advertiserId: string,
  campaignId: string,
  page = 0
): string {
  return `md:${encodeId(advertiserId)}:${encodeId(campaignId)}:${Math.max(0, page)}`;
}

export function parseMaterialDetailCallbackData(data: string): {
  advertiserId: string;
  campaignId: string;
  page: number;
} | undefined {
  const match = data.match(/^md:([0-9a-z]+):([0-9a-z]+):(\d+)$/i);
  if (!match) return undefined;
  return {
    advertiserId: decodeId(match[1]),
    campaignId: decodeId(match[2]),
    page: Number(match[3]) || 0,
  };
}

export function buildMaterialToggleCallbackData(input: {
  advertiserId: string;
  smartPlusAdId: string;
  adMaterialId: string;
  campaignId: string;
  operationStatus: MaterialOperationStatus;
  page: number;
}): string {
  const operation = input.operationStatus === 'ENABLE' ? 'e' : 'd';
  return [
    'mt',
    operation,
    encodeId(input.advertiserId),
    encodeId(input.smartPlusAdId),
    encodeId(input.adMaterialId),
    encodeId(input.campaignId),
    String(Math.max(0, input.page)),
  ].join(':');
}

export function parseMaterialToggleCallbackData(data: string): {
  advertiserId: string;
  smartPlusAdId: string;
  adMaterialId: string;
  campaignId: string;
  operationStatus: MaterialOperationStatus;
  page: number;
} | undefined {
  const match = data.match(/^mt:([ed]):([0-9a-z]+):([0-9a-z]+):([0-9a-z]+):([0-9a-z]+):(\d+)$/i);
  if (!match) return undefined;
  return {
    operationStatus: match[1].toLowerCase() === 'e' ? 'ENABLE' : 'DISABLE',
    advertiserId: decodeId(match[2]),
    smartPlusAdId: decodeId(match[3]),
    adMaterialId: decodeId(match[4]),
    campaignId: decodeId(match[5]),
    page: Number(match[6]) || 0,
  };
}
