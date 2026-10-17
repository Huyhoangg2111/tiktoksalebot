import {
  formatSalesDateKey,
  getConfigSnapshot,
  getSalesData,
  parseSalesDate,
  type ConfigData,
  type SalesData,
  type SpMapping,
} from '../google-sheets/api.js';
import { getTodaySpentCampaigns, type TikTokSpentCampaign } from '../tiktok/api.js';
import { getRuntimeSettingNumber, RUNTIME_SETTING_DEFAULTS } from '../settings/runtime.js';

const DEFAULT_TARGET_MKT_CODE = 'MKT80.HOÀNG-TH';
const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const SUCCESS_STATUS_PATTERN = /thành công|đã nhận|hoàn thành|done|success/i;

export interface BcReportPeriod {
  startDate: string;
  endDate: string;
  label: string;
}

export interface BcReportOptions extends BcReportPeriod {
  targetMktCode?: string;
}

export interface BcSalesDataIssue {
  source: string;
  sourceName?: string;
  sourceTabName?: string;
  sourceRowNumber?: number;
  productName?: string;
  shopName?: string;
  channelLink?: string;
  marketCode?: string;
  amountVnd: number;
  reason: string;
}

export interface BcSalesReportResult {
  message: string;
  issues: BcSalesDataIssue[];
}

export interface ProductMarketSummary {
  productShortName: string;
  marketCode: string;
  mktCode: string;
  orders: number;
  campaignIds: Set<string>;
  advertiserLabels: Set<string>;
  spendUsd: number;
  spendVnd: number;
  impressions: number;
  clicks: number;
  conversions: number;
  grossSalesVnd: number;
  deliveredSalesVnd: number;
}

interface BcAllMktSummary {
  mktCode: string;
  spendUsd: number;
  spendVnd: number;
  grossSalesVnd: number;
  campaignIds: Set<string>;
}

interface BcAllProductSummary {
  productName: string;
  grossSalesVnd: number;
  orders: number;
}
function normalizeKey(value: unknown): string {
  return String(value ?? '').trim().toLocaleUpperCase('vi-VN');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTargetMktCode(): string {
  return process.env.TARGET_MKT_CODE?.trim() || DEFAULT_TARGET_MKT_CODE;
}

function getDateParts(date: Date): { year: string; month: string; day: string } {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return {
    year: dateParts.find(part => part.type === 'year')?.value || '1970',
    month: dateParts.find(part => part.type === 'month')?.value || '01',
    day: dateParts.find(part => part.type === 'day')?.value || '01',
  };
}

function formatDateKey(date: Date): string {
  const parts = getDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function formatCompactDisplayDate(dateKey: string): string {
  const [, month, day] = dateKey.split('-');
  return `${day}/${month}`;
}

function formatCompactPeriod(period: BcReportPeriod): string {
  if (period.startDate === period.endDate) {
    return formatCompactDisplayDate(period.startDate);
  }

  return `${formatCompactDisplayDate(period.startDate)}-${formatCompactDisplayDate(period.endDate)}`;
}

function formatCheckTime(date: Date): string {
  const dateParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: REPORT_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const hour = dateParts.find(part => part.type === 'hour')?.value || '00';
  const minute = dateParts.find(part => part.type === 'minute')?.value || '00';
  const day = dateParts.find(part => part.type === 'day')?.value || '01';
  const month = dateParts.find(part => part.type === 'month')?.value || '01';

  return `${hour}:${minute} ${day}/${month}`;
}

function isValidDatePart(year: number, month: number, day: number): boolean {
  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  return (
    parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day
  );
}

function formatDatePartKey(year: string, month: string, day: number): string {
  return `${year}-${month}-${String(day).padStart(2, '0')}`;
}
function formatCompactVnd(amount: number): string {
  const roundedAmount = Math.round(amount);
  const sign = roundedAmount < 0 ? '-' : '';
  const absoluteAmount = Math.abs(roundedAmount);

  if (absoluteAmount >= 1_000_000) {
    const roundedMillions = Math.round(absoluteAmount / 100_000) / 10;
    const [millions, decimal] = roundedMillions.toFixed(1).split('.');
    const compactValue = decimal === '0' ? `${millions}tr` : `${millions}.${decimal}tr`;

    return `${sign}${compactValue}`;
  }

  if (absoluteAmount >= 1_000) {
    return `${sign}${Math.floor(absoluteAmount / 1_000)}k`;
  }

  return `${sign}${absoluteAmount.toLocaleString('vi-VN')}đ`;
}

function getAdvertiserShortLabel(campaign: TikTokSpentCampaign): string {
  const accountName = campaign.advertiser_name || campaign.advertiser_id;
  const aaNumberMatch = accountName.match(/\bAA\s*(\d+)\b/i);

  if (aaNumberMatch) {
    return aaNumberMatch[1].padStart(2, '0');
  }

  return accountName;
}

function compareAccountLabels(labelA: string, labelB: string): number {
  const numberA = Number(labelA.match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);
  const numberB = Number(labelB.match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);

  if (numberA !== numberB) {
    return numberA - numberB;
  }

  return labelA.localeCompare(labelB, 'vi');
}
function formatAdvertiserLabels(labels: Set<string>): string {
  const sortedLabels = [...labels].sort(compareAccountLabels);

  return sortedLabels.map(escapeHtml).join(' · ');
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatCpAdsPercent(spendVnd: number, grossSalesVnd: number): string {
  if (spendVnd > 0 && grossSalesVnd > 0) {
    return formatPercent((spendVnd / grossSalesVnd) * 100);
  }

  if (spendVnd > 0 && grossSalesVnd <= 0) {
    return '‼️';
  }

  if (spendVnd <= 0 && grossSalesVnd > 0) {
    return '‼️';
  }

  return 'N/A';
}
function isDateInRange(dateKey: string, period: BcReportPeriod): boolean {
  return dateKey >= period.startDate && dateKey <= period.endDate;
}
function splitShortNames(shortName: string): string[] {
  return shortName
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function findSalesProductMappings(
  productName: string | undefined,
  config: ConfigData
): SpMapping[] {
  const normalizedProductName = normalizeKey(productName);

  if (!normalizedProductName) {
    return [];
  }

  const byCategory = config.spMap.filter(
    sp => normalizeKey(sp.variantName) === normalizedProductName
  );
  if (byCategory.length > 0) {
    return byCategory;
  }

  // Fallback 1: sheet F sometimes stores Tên vật tư (SpMap col B).
  const byMaterial = config.spMap.filter(
    sp => normalizeKey(sp.materialName) === normalizedProductName
  );
  if (byMaterial.length > 0) {
    return byMaterial;
  }

  // Fallback 2 (theo từ khóa — đúng hành vi ghi trong Sale_AI_CONTEXT.md):
  // sheet F chỉ cần CHỨA từ khóa chiến dịch đã cấu hình, không phân biệt hoa/thường.
  // VD: F = "BRA CÁI TRƯỚC NÂU 36" khớp từ khóa "bra cái trước".
  return config.spMap.filter(sp =>
    splitShortNames(sp.shortName).some(alias => {
      const normalizedAlias = normalizeKey(alias);
      return normalizedAlias.length > 0 && normalizedProductName.includes(normalizedAlias);
    })
  );
}
function getSalesProductShortName(productName: string | undefined, config: ConfigData): string {
  const mappings = findSalesProductMappings(productName, config);
  if (mappings.length === 0) {
    return String(productName || 'Unknown').trim() || 'Unknown';
  }

  const shortNames = [
    ...new Set(
      mappings.flatMap(mapping => splitShortNames(mapping.shortName)).filter(Boolean)
    ),
  ];

  if (shortNames.length === 1) {
    return shortNames[0];
  }

  return mappings[0].variantName || shortNames[0] || String(productName || 'Unknown').trim() || 'Unknown';
}

function getSalesDateKey(salesDate: unknown): string | undefined {
  const directKey = formatSalesDateKey(salesDate);
  if (directKey) {
    return directKey;
  }

  const parsed = parseSalesDate(salesDate);
  return parsed ? formatSalesDateKey(parsed) : undefined;
}

function getKnownMarketCodes(config: ConfigData): Set<string> {
  return new Set(
    config.pageMap
      .map(page => normalizeKey(page.marketCode))
      .filter(Boolean)
  );
}

/** Tên campaign có thể phân tách bằng ' · ' (mới) hoặc ' - ' (cũ); tách về cùng một bộ phận. */
function splitCampaignNameParts(campaignName: string): string[] {
  return String(campaignName || '')
    .split(/\s*·\s*|-/)
    .map(part => part.trim())
    .filter(Boolean);
}

function extractCampaignMarketCode(campaignName: string, knownMarketCodes: Set<string>): string {
  const nameParts = splitCampaignNameParts(campaignName)
    .map(part => normalizeKey(part))
    .filter(Boolean);

  if (nameParts.length > 1 && knownMarketCodes.has(nameParts[1])) {
    return nameParts[1];
  }

  const marketInParts = nameParts.find(part => knownMarketCodes.has(part));
  if (marketInParts) {
    return marketInParts;
  }

  const normalizedCampaignName = normalizeKey(campaignName);
  const marketInName = [...knownMarketCodes].find(marketCode =>
    new RegExp(`(?:^|[-·\\s])${escRegExp(marketCode)}(?:[-·\\s]|$)`).test(normalizedCampaignName)
  );

  return marketInName || 'UNKNOWN';
}

function escRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCampaignProductShortName(campaignName: string, config: ConfigData): string {
  const rawName = String(campaignName || '').trim();
  if (!rawName) {
    return 'Unknown';
  }

  const nameParts = splitCampaignNameParts(rawName);
  const firstPart = nameParts[0]?.trim() || '';
  const normalizedFirst = normalizeKey(firstPart);
  const normalizedFull = normalizeKey(rawName);

  let bestMatch:
    | { score: number; variantName: string }
    | undefined;

  for (const mapping of config.spMap) {
    const candidates = [
      ...splitShortNames(mapping.shortName),
      mapping.variantName,
      mapping.materialName || '',
    ].filter(Boolean);

    for (const candidate of candidates) {
      const normalizedCandidate = normalizeKey(candidate);
      if (!normalizedCandidate) {
        continue;
      }

      let score = 0;
      if (normalizedFirst === normalizedCandidate) {
        score = 200 + normalizedCandidate.length;
      } else if (
        normalizedFull.startsWith(`${normalizedCandidate} -`) ||
        normalizedFull.startsWith(`${normalizedCandidate} ·`) ||
        normalizedFull.startsWith(`${normalizedCandidate}-`) ||
        normalizedFull.startsWith(`${normalizedCandidate}·`)
      ) {
        score = 150 + normalizedCandidate.length;
      } else if (normalizedFirst.startsWith(normalizedCandidate) && normalizedCandidate.length >= 3) {
        score = 50 + normalizedCandidate.length;
      } else {
        continue;
      }

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          score,
          variantName: mapping.variantName || candidate,
        };
      }
    }
  }

  if (bestMatch) {
    return getSalesProductShortName(bestMatch.variantName, config);
  }

  return firstPart || 'Unknown';
}

function getSummaryKey(productShortName: string, marketCode: string, mktCode: string): string {
  return `${normalizeKey(mktCode)}|${normalizeKey(productShortName)}|${normalizeKey(marketCode)}`;
}

/**
 * Gom mã MKT thô (cột E sheet doanh số / mkt_code campaign) về đúng mã đã gắn
 * trên dashboard: khớp CHÍNH XÁC (không phân biệt hoa/thường) để MKT.CT và
 * MKT.CT1 là hai nhóm riêng biệt. Không cấu hình mã nào thì gom chung ALL
 * (hành vi cũ); mã không khớp bất kỳ mã đã gắn nào thì rơi vào CHUA_GAN_MKT.
 */
function buildMktResolver(
  configuredCodes: string[],
  hasTargetFilter: boolean
): (raw: unknown) => string {
  if (hasTargetFilter || configuredCodes.length === 0) return () => 'ALL';
  const byKey = new Map<string, string>();
  for (const code of configuredCodes) {
    const trimmed = code.trim();
    const key = normalizeKey(trimmed);
    if (key && !byKey.has(key)) byKey.set(key, trimmed);
  }
  return (raw: unknown) => {
    const value = String(raw || '').trim();
    if (!value) return 'CHUA_GAN_MKT';
    return byKey.get(normalizeKey(value)) || 'CHUA_GAN_MKT';
  };
}
function ensureSummary(
  summaryMap: Map<string, ProductMarketSummary>,
  productShortName: string,
  marketCode: string,
  mktCode: string
): ProductMarketSummary {
  const normalizedMarketCode = normalizeKey(marketCode) || 'UNKNOWN';
  const normalizedMktCode = mktCode || 'ALL';
  const key = getSummaryKey(productShortName, normalizedMarketCode, normalizedMktCode);
  const existingSummary = summaryMap.get(key);

  if (existingSummary) {
    return existingSummary;
  }

  const summary: ProductMarketSummary = {
    productShortName,
    marketCode: normalizedMarketCode,
    mktCode: normalizedMktCode,
    orders: 0,
    campaignIds: new Set<string>(),
    advertiserLabels: new Set<string>(),
    spendUsd: 0,
    spendVnd: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    grossSalesVnd: 0,
    deliveredSalesVnd: 0,
  };

  summaryMap.set(key, summary);
  return summary;
}

function addSalesRowsToSummary(
  summaryMap: Map<string, ProductMarketSummary>,
  salesRows: SalesData[],
  config: ConfigData,
  period: BcReportPeriod,
  targetMktCode: string,
  mktResolver: (raw: unknown) => string
): void {
  const normalizedTargetMktCode = normalizeKey(targetMktCode);

  for (const salesRow of salesRows) {
    if (normalizedTargetMktCode && normalizeKey(salesRow.mktCode) !== normalizedTargetMktCode) {
      continue;
    }

    const salesDateKey = getSalesDateKey(salesRow.date);
    if (!salesDateKey || !isDateInRange(salesDateKey, period)) {
      continue;
    }

    const productShortName = getSalesProductShortName(salesRow.productName, config);
    const marketCode = salesRow.marketCode || 'UNKNOWN';
    const summary = ensureSummary(summaryMap, productShortName, marketCode, mktResolver(salesRow.mktCode));

    summary.orders += 1;
    summary.grossSalesVnd += salesRow.amountVnd;

    if (SUCCESS_STATUS_PATTERN.test(String(salesRow.status || ''))) {
      summary.deliveredSalesVnd += salesRow.amountVnd;
    }
  }
}

function collectSalesDataIssues(
  salesRows: SalesData[],
  config: ConfigData,
  period: BcReportPeriod,
  targetMktCode: string
): BcSalesDataIssue[] {
  const normalizedTargetMktCode = normalizeKey(targetMktCode);
  const issues: BcSalesDataIssue[] = [];

  for (const salesRow of salesRows) {
    if (normalizeKey(salesRow.mktCode) !== normalizedTargetMktCode) {
      continue;
    }

    const salesDateKey = getSalesDateKey(salesRow.date);
    if (!salesDateKey || !isDateInRange(salesDateKey, period)) {
      continue;
    }

    const productName = String(salesRow.productName || '').trim();
    const reasons: string[] = [];

    if (!productName) {
      reasons.push('Thiếu tên sản phẩm trong sheet');
    } else if (findSalesProductMappings(productName, config).length === 0) {
      reasons.push('Sản phẩm chưa có trong SpMap');
    }

    if (!salesRow.marketCode) {
      reasons.push('Không map được thị trường từ shop/page');
    }

    if (reasons.length === 0) {
      continue;
    }

    issues.push({
      source: salesRow.source,
      sourceName: salesRow.sourceName,
      sourceTabName: salesRow.sourceTabName,
      sourceRowNumber: salesRow.sourceRowNumber,
      productName,
      shopName: salesRow.shopName,
      channelLink: salesRow.channelLink,
      marketCode: salesRow.marketCode,
      amountVnd: salesRow.amountVnd,
      reason: reasons.join('; '),
    });
  }

  return issues;
}

function addCampaignsToSummary(
  summaryMap: Map<string, ProductMarketSummary>,
  campaigns: TikTokSpentCampaign[],
  config: ConfigData,
  mktResolver: (raw: unknown) => string
): void {
  const knownMarketCodes = getKnownMarketCodes(config);

  for (const campaign of campaigns) {
    const productShortName = extractCampaignProductShortName(campaign.campaign_name, config);
    const marketCode = extractCampaignMarketCode(campaign.campaign_name, knownMarketCodes);
    const summary = ensureSummary(summaryMap, productShortName, marketCode, mktResolver(campaign.mkt_code));

    summary.campaignIds.add(`${campaign.advertiser_id}:${campaign.campaign_id}`);
    summary.advertiserLabels.add(getAdvertiserShortLabel(campaign));
    summary.spendUsd += campaign.spend;
    summary.spendVnd += campaign.spend * config.exchangeRate;
    summary.impressions += campaign.impressions;
    summary.clicks += campaign.clicks;
    summary.conversions += campaign.conversions;
  }
}

function summarizeTotals(summaries: ProductMarketSummary[]): ProductMarketSummary {
  const total: ProductMarketSummary = {
    productShortName: 'Tổng',
    marketCode: 'ALL',
    mktCode: 'ALL',
    orders: 0,
    campaignIds: new Set<string>(),
    advertiserLabels: new Set<string>(),
    spendUsd: 0,
    spendVnd: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    grossSalesVnd: 0,
    deliveredSalesVnd: 0,
  };

  for (const summary of summaries) {
    total.orders += summary.orders;
    summary.campaignIds.forEach(campaignId => total.campaignIds.add(campaignId));
    summary.advertiserLabels.forEach(label => total.advertiserLabels.add(label));
    total.spendUsd += summary.spendUsd;
    total.spendVnd += summary.spendVnd;
    total.impressions += summary.impressions;
    total.clicks += summary.clicks;
    total.conversions += summary.conversions;
    total.grossSalesVnd += summary.grossSalesVnd;
    total.deliveredSalesVnd += summary.deliveredSalesVnd;
  }

  return total;
}
function getProductRankIcon(index: number): string {
  if (index === 0) return '🥇';
  if (index === 1) return '🥈';
  if (index === 2) return '🥉';
  return '🔸';
}

function renderProductLine(summary: ProductMarketSummary, index: number): string {
  const cpaVnd = summary.conversions > 0 ? summary.spendVnd / summary.conversions : 0;
  const marketCode = summary.marketCode || 'UNKNOWN';
  const advertiserLabelText = formatAdvertiserLabels(summary.advertiserLabels);
  const campaignText = advertiserLabelText
    ? `📊 ${summary.campaignIds.size.toLocaleString('vi-VN')} camp - ${advertiserLabelText}`
    : `📊 ${summary.campaignIds.size.toLocaleString('vi-VN')} camp`;
  const metricLine = [
    `💸 ${formatCompactVnd(summary.spendVnd)}`,
    `🎯 ${summary.conversions.toLocaleString('vi-VN')}`,
    `💰 ${formatCompactVnd(cpaVnd)}`,
    `🧾 ${formatCompactVnd(summary.grossSalesVnd)}`,
    `📈 ${formatCpAdsPercent(summary.spendVnd, summary.grossSalesVnd)}`,
  ].join(' ');

  return `${getProductRankIcon(index)} <b>${escapeHtml(summary.productShortName)} (${escapeHtml(marketCode)})</b> ${campaignText}\n${metricLine}`;
}

function renderReport(
  summaries: ProductMarketSummary[],
  period: BcReportPeriod,
  targetMktCode: string
): string {
  const activeSummaries = summaries
    .filter(summary => summary.orders > 0 || summary.spendUsd > 0 || summary.grossSalesVnd > 0)
    .sort((summaryA, summaryB) =>
      summaryB.grossSalesVnd - summaryA.grossSalesVnd ||
      summaryB.spendVnd - summaryA.spendVnd ||
      summaryB.orders - summaryA.orders ||
      summaryA.productShortName.localeCompare(summaryB.productShortName, 'vi')
    );
  const totals = summarizeTotals(activeSummaries);
  const cpaUsd = totals.conversions > 0 ? totals.spendUsd / totals.conversions : 0;
  const cpaVnd = totals.conversions > 0 ? totals.spendVnd / totals.conversions : 0;
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const lines: string[] = [
    `<b>BC ${escapeHtml(targetMktCode)} ${escapeHtml(formatCompactPeriod(period))} - ${escapeHtml(formatCheckTime(new Date()))}</b>`,
    `💸 ${formatCompactVnd(totals.spendVnd)} (${formatUsd(totals.spendUsd)}) 🧾 ${formatCompactVnd(totals.grossSalesVnd)} 📈 ${formatCpAdsPercent(totals.spendVnd, totals.grossSalesVnd)}`,
    `📊 ${totals.campaignIds.size.toLocaleString('vi-VN')} camp 👆 ${totals.clicks.toLocaleString('vi-VN')}/${formatPercent(ctr)} 🎯 ${totals.conversions.toLocaleString('vi-VN')} 💰 ${formatCompactVnd(cpaVnd)} (${formatUsd(cpaUsd)})`,
    '=============================',
  ];

  if (activeSummaries.length === 0) {
    lines.push('<i>Không có dữ liệu trong khoảng thời gian này.</i>');
    return lines.join('\n');
  }

  lines.push(...activeSummaries.map((summary, index) => renderProductLine(summary, index)));

  return lines.join('\n');
}

export function getTodayBcReportPeriod(now = new Date()): BcReportPeriod {
  const today = formatDateKey(now);
  return {
    startDate: today,
    endDate: today,
    label: 'Hôm nay',
  };
}

export function getMonthBcReportPeriod(now = new Date()): BcReportPeriod {
  const parts = getDateParts(now);

  return {
    startDate: `${parts.year}-${parts.month}-01`,
    endDate: `${parts.year}-${parts.month}-${parts.day}`,
    label: 'Tháng này',
  };
}

export function parseCustomBcReportPeriod(input: string): BcReportPeriod {
  const dateTokens = input.match(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}/g) || [];

  if (dateTokens.length === 0) {
    const dayOnlyPeriod = parseCurrentMonthDayPeriod(input);

    if (dayOnlyPeriod) {
      return dayOnlyPeriod;
    }

    throw new Error('Không tìm thấy ngày. Nhập ví dụ: 02, 02-27, 02/04/2026 hoặc 02/04/2026 - 26/04/2026.');
  }

  const startDate = parseSalesDate(dateTokens[0]);
  const endDate = parseSalesDate(dateTokens[1] || dateTokens[0]);

  if (!startDate || !endDate) {
    throw new Error('Ngày không hợp lệ. Nhập theo dạng dd/mm/yyyy hoặc yyyy-mm-dd.');
  }

  const startDateKey = formatDateKey(startDate);
  const endDateKey = formatDateKey(endDate);

  if (startDateKey > endDateKey) {
    throw new Error('Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc.');
  }

  return {
    startDate: startDateKey,
    endDate: endDateKey,
    label: startDateKey === endDateKey ? 'Tùy chỉnh' : 'Tùy chỉnh',
  };
}

function parseCurrentMonthDayPeriod(input: string, now = new Date()): BcReportPeriod | undefined {
  const dayRangeMatch = input.trim().match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);

  if (!dayRangeMatch) {
    return undefined;
  }

  const currentParts = getDateParts(now);
  const year = Number(currentParts.year);
  const month = Number(currentParts.month);
  const startDay = Number(dayRangeMatch[1]);
  const endDay = Number(dayRangeMatch[2] || dayRangeMatch[1]);

  if (
    !isValidDatePart(year, month, startDay) ||
    !isValidDatePart(year, month, endDay)
  ) {
    throw new Error('Ngày trong tháng hiện tại không hợp lệ. Nhập ví dụ: 02 hoặc 02-27.');
  }

  const startDateKey = formatDatePartKey(currentParts.year, currentParts.month, startDay);
  const endDateKey = formatDatePartKey(currentParts.year, currentParts.month, endDay);

  if (startDateKey > endDateKey) {
    throw new Error('Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc.');
  }

  return {
    startDate: startDateKey,
    endDate: endDateKey,
    label: 'Tùy chỉnh',
  };
}
async function getBcTikTokFetchOptions(
  advertiserIds: string[],
  advertiserAccounts?: Array<{ advertiserId: string; advertiserName?: string; mktCode?: string }>
) {
  const concurrency = await getRuntimeSettingNumber(
    'tiktok_concurrency',
    RUNTIME_SETTING_DEFAULTS.tiktokConcurrency
  );

  return {
    includeCache: false as const,
    skipStatusMap: true,
    skipAdSupplement: true,
    concurrency,
    advertiserIds,
    advertiserAccounts,
  };
}

export async function buildBcProductMarketSummaries(options: BcReportOptions): Promise<ProductMarketSummary[]> {
  const targetMktCode = options.targetMktCode?.trim() || '';
  const config = await getConfigSnapshot({ includeAllMkt: true });
  const advertiserAccounts = config.permissions
    .filter(permission => permission.enabled)
    .map(permission => ({
      advertiserId: permission.advertiserId,
      advertiserName: permission.advertiserName,
      mktCode: permission.mktCode,
    }));
  const advertiserIds = advertiserAccounts.map(account => account.advertiserId);

  const configuredMktCodes = [...new Set(
    advertiserAccounts.map(account => account.mktCode).filter(code => String(code || '').trim())
  )];
  const mktResolver = buildMktResolver(configuredMktCodes, Boolean(targetMktCode));

  const tiktokOptions = await getBcTikTokFetchOptions(advertiserIds, advertiserAccounts);
  const [salesRows, campaigns] = await Promise.all([
    getSalesData(targetMktCode ? { targetMktCode } : { includeAllMkt: true }),
    advertiserIds.length > 0
      ? getTodaySpentCampaigns(options.startDate, options.endDate, tiktokOptions)
      : Promise.resolve([] as Awaited<ReturnType<typeof getTodaySpentCampaigns>>),
  ]);

  const summaryMap = new Map<string, ProductMarketSummary>();
  addSalesRowsToSummary(summaryMap, salesRows, config, options, targetMktCode, mktResolver);
  addCampaignsToSummary(summaryMap, campaigns, config, mktResolver);

  return [...summaryMap.values()];
}
export async function buildBcSalesReport(options: BcReportOptions): Promise<BcSalesReportResult> {
  const targetMktCode = options.targetMktCode?.trim() || getTargetMktCode();
  const startedAt = Date.now();
  const config = await getConfigSnapshot({ includeAllMkt: true });
  // /bc báo cáo cho đúng một mã MKT: doanh số lọc theo MKT, chi tiêu cũng chỉ lấy
  // TKQC thuộc MKT đó — nếu không sẽ pha loãng %CP Ads với spend của MKT khác.
  const advertiserAccounts = config.permissions
    .filter(permission => permission.enabled && normalizeKey(permission.mktCode) === normalizeKey(targetMktCode))
    .map(permission => ({
      advertiserId: permission.advertiserId,
      advertiserName: permission.advertiserName,
      mktCode: permission.mktCode,
    }));
  const advertiserIds = advertiserAccounts.map(account => account.advertiserId);

  // Sales sheets + TikTok reports run in parallel (main /bc latency win).
  const tiktokOptions = await getBcTikTokFetchOptions(advertiserIds, advertiserAccounts);
  const [salesRows, campaigns] = await Promise.all([
    getSalesData({ targetMktCode }),
    advertiserIds.length > 0
      ? getTodaySpentCampaigns(options.startDate, options.endDate, tiktokOptions)
      : Promise.resolve([] as Awaited<ReturnType<typeof getTodaySpentCampaigns>>),
  ]);

  const summaryMap = new Map<string, ProductMarketSummary>();
  addSalesRowsToSummary(summaryMap, salesRows, config, options, targetMktCode, () => 'ALL');
  addCampaignsToSummary(summaryMap, campaigns, config, () => 'ALL');

  const issues = collectSalesDataIssues(salesRows, config, options, targetMktCode);
  let message = renderReport(
    [...summaryMap.values()],
    options,
    targetMktCode
  );

  if (issues.length > 0) {
    message += `\n\n⚠️ Có ${issues.length.toLocaleString('vi-VN')} dòng dữ liệu sale cần kiểm tra.`;
  }

  console.log(
    `[bc] report ${options.label || options.startDate} mkt=${targetMktCode} ` +
    `sales=${salesRows.length} camps=${campaigns.length} advertisers=${advertiserIds.length} ` +
    `in ${Date.now() - startedAt}ms`
  );

  return {
    message,
    issues,
  };
}
