import * as googleSheets from '@googleapis/sheets';
import type { sheets_v4 } from '@googleapis/sheets';
import { db } from '../db/index.js';
import {
  getRuntimeSettingNumber,
  RUNTIME_SETTING_DEFAULTS,
} from '../settings/runtime.js';

type SheetsClient = sheets_v4.Sheets;
type Sheet = sheets_v4.Schema$Sheet;

const DEFAULT_TARGET_MKT_CODE = 'MKT80.HOÀNG-TH';
const DEFAULT_EXCHANGE_RATE = 28119;

function createSheetsClient(scopes: string[]): SheetsClient {
  const auth = new googleSheets.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes,
  });

  return googleSheets.sheets({ version: 'v4', auth });
}

function parseEnabled(value: unknown): boolean {
  return ['true', '1', 'yes', 'y', 'enabled'].includes(String(value ?? '').trim().toLowerCase());
}

function normalizeKey(value: unknown): string {
  return String(value ?? '').trim().toLocaleUpperCase('vi-VN');
}

function extractGoogleSpreadsheetId(value: unknown): string | undefined {
  const rawValue = String(value ?? '').trim();

  if (!rawValue) {
    return undefined;
  }

  const spreadsheetUrlMatch = rawValue.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{30,})/);
  if (spreadsheetUrlMatch?.[1]) {
    return spreadsheetUrlMatch[1];
  }

  return rawValue.match(/[a-zA-Z0-9-_]{30,}/)?.[0];
}

interface SalesSheetTarget {
  displayName: string;
  aliases: string[];
}

/**
 * Tabs doanh số được cộng vào báo cáo chốt.
 *
 * Không gồm Hàn Quốc: tab này đang đẩy tổng chốt lệch so với kiểm tra tay
 * (tháng/ngày MKT80 cao hơn đúng bằng các dòng HÀN QUỐC / VNKR).
 * Chỉ lấy các tab sale chính đã dùng khi đối soát sheet.
 */
const SALES_SHEET_TARGETS: SalesSheetTarget[] = [
  {
    displayName: 'ĐÀI LOAN',
    aliases: ['đài loan', 'dai loan', 'taiwan'],
  },
  {
    displayName: 'VIỆT NAM',
    aliases: ['việt nam', 'viet nam'],
  },
  {
    displayName: 'NHẬT',
    aliases: ['nhật', 'nhat'],
  },
];

function getSalesSheetScore(title: unknown, target: SalesSheetTarget): number {
  const normalizedTitle = String(title ?? '').trim().toLocaleLowerCase('vi-VN');

  if (target.aliases.includes(normalizedTitle)) {
    return 2;
  }

  if (target.aliases.some(alias => normalizedTitle.includes(alias))) {
    return 1;
  }

  return 0;
}

function findSalesSheet(sheets: Sheet[] = [], target: SalesSheetTarget): Sheet | undefined {
  return (
    sheets.find(sheet => getSalesSheetScore(sheet.properties?.title, target) === 2) ||
    sheets.find(sheet => getSalesSheetScore(sheet.properties?.title, target) === 1)
  );
}

function findSalesSheets(sheets: Sheet[] = []): Array<{ sheet: Sheet; target: SalesSheetTarget }> {
  const matchedSheetTitles = new Set<string>();
  const matchedSheets: Array<{ sheet: Sheet; target: SalesSheetTarget }> = [];

  for (const target of SALES_SHEET_TARGETS) {
    const sheet = findSalesSheet(sheets, target);
    const sheetTitle = sheet?.properties?.title;

    if (!sheet || !sheetTitle || matchedSheetTitles.has(sheetTitle)) {
      continue;
    }

    matchedSheetTitles.add(sheetTitle);
    matchedSheets.push({ sheet, target });
  }

  return matchedSheets;
}

function findTaiwanSalesSheet(sheets: Sheet[] = []): Sheet | undefined {
  return findSalesSheet(sheets, SALES_SHEET_TARGETS[0]);
}

function formatSheetRange(sheetName: string, range: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${range}`;
}

function getSourceSpreadsheetIds(rows: any[][]): string[] {
  const sourceIds = rows
    .flatMap(row => row.map(extractGoogleSpreadsheetId))
    .filter((id): id is string => Boolean(id));

  return [...new Set(sourceIds)];
}

function getTargetMktCode(): string {
  return process.env.TARGET_MKT_CODE?.trim() || DEFAULT_TARGET_MKT_CODE;
}

function parseNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  const rawValue = String(value ?? '').trim();

  if (!rawValue) {
    return NaN;
  }

  const normalized = rawValue.replace(/\s/g, '');
  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    const parsed = normalized
      .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
      .replace(decimalSeparator, '.')
      .replace(/[^\d.-]/g, '');

    return Number(parsed);
  }

  if (lastComma !== -1) {
    const parsed = /,\d{1,2}$/.test(normalized)
      ? normalized.replace(',', '.')
      : normalized.replace(/,/g, '');
    return Number(parsed.replace(/[^\d.-]/g, ''));
  }

  if (lastDot !== -1) {
    const parsed = /\.\d{1,2}$/.test(normalized)
      ? normalized
      : normalized.replace(/\./g, '');
    return Number(parsed.replace(/[^\d.-]/g, ''));
  }

  return Number(normalized.replace(/[^\d.-]/g, ''));
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Parse a sheet date into calendar parts (dd/mm/yyyy or Excel serial).
 * Time-of-day is ignored so day boundaries stay stable on UTC VPS.
 */
export function parseSalesDateParts(
  value: unknown
): { year: number; month: number; day: number } | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000) {
    const wholeDays = Math.floor(value);
    // Excel/Google serial epoch 1899-12-30, anchor at UTC noon.
    const timestamp = (wholeDays - 25569) * 86400 * 1000 + 12 * 60 * 60 * 1000;
    const serialDate = new Date(timestamp);

    return {
      year: serialDate.getUTCFullYear(),
      month: serialDate.getUTCMonth() + 1,
      day: serialDate.getUTCDate(),
    };
  }

  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return undefined;
  }

  // Vietnamese sheet format: dd/mm/yyyy [hh:mm[:ss]] — ignore time for day key.
  const dmyMatch = rawValue.match(
    /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const yearValue = Number(dmyMatch[3]);
    const year = yearValue < 100 ? yearValue + 2000 : yearValue;

    if (isValidCalendarDate(year, month, day)) {
      return { year, month, day };
    }
  }

  // ISO date (optionally with time): yyyy-mm-dd
  const isoMatch = rawValue.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/
  );
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);

    if (isValidCalendarDate(year, month, day)) {
      return { year, month, day };
    }
  }

  return undefined;
}

export function formatSalesDateKey(value: unknown): string | undefined {
  // Dates created by parseSalesDate() are UTC noon of the calendar day.
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }

  const parts = parseSalesDateParts(value);
  if (!parts) {
    return undefined;
  }

  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function parseSalesDate(value: unknown): Date | undefined {
  const parts = parseSalesDateParts(value);
  if (!parts) {
    return undefined;
  }

  // UTC noon keeps the calendar day stable under Asia/Ho_Chi_Minh formatting.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
}

// Define interface for sales data
export interface SalesData {
  date: string;
  amount: number; // USD
  amountVnd: number;
  source: string; // e.g., 'Sheet1', 'Sheet2', etc.
  sourceName?: string;
  sourceTabName?: string;
  sourceRowNumber?: number;
  shopName?: string;
  mktCode?: string;
  productName?: string;
  channelLink?: string;
  status?: string;

  pageHandle?: string;
  pageName?: string;
  marketCode?: string;
}

// Define interface for configuration data
export interface ConfigData {
  sources: string[];
  exchangeRate: number;
  permissions: AdvertiserPermission[];
  pageMap: PageMapping[];
  spMap: SpMapping[];
}

export interface MktScopeOptions {
  targetMktCode?: string;
  includeAllMkt?: boolean;
}

export type AlertComparisonOperator = 'gt' | 'lt' | 'eq' | 'gte' | 'lte' | 'between';
export type AlertEntity = 'campaign' | 'ad';
export type AlertMetric = 'cpa' | 'spend';
export type AlertAction = 'pause' | 'enable' | 'notify';
export type AlertCampaignStatus = 'active' | 'paused' | 'deleted';

export interface AlertActionRuleSheetRow {
  entity: AlertEntity;
  nameContains?: string;
  metric: AlertMetric;
  metricOperator: AlertComparisonOperator;
  metricThreshold: number;
  /** Lower bound for metric range (used with operator `between` or as floor with upper threshold). */
  metricMinThreshold?: number;
  conversionsOperator: AlertComparisonOperator;
  conversionsThreshold: number;
  action: AlertAction;
  campaignStatus?: AlertCampaignStatus;
  isActive: boolean;
  note?: string;
}

export interface PageMapping {
  pageHandle: string;
  marketCode: string;
  pageName: string;
  pageUrl: string;
}

export interface SpMapping {
  /** DANH MỤC — tên trên sheet doanh số (cột F). */
  variantName: string;
  /** KEY MAP — key trên tên campaign TikTok. */
  shortName: string;
  /** Tên vật tư chi tiết (SpMap cột B), dùng fallback khi sheet ghi SKU. */
  materialName?: string;
}

export interface AdvertiserPermission {
  mktCode: string;
  advertiserId: string;
  enabled: boolean;
  note?: string;
  advertiserName?: string;
}

export interface TikTokTokenConfig {
  readAccessToken?: string;
  writeAccessToken?: string;
}

export interface AccountBotCredentials {
  email: string;
  password: string;
  totpSecret: string;
}

function parseAdvertiserPermissionRows(rows: any[][], options: MktScopeOptions = {}): AdvertiserPermission[] {
  const targetMktCode = options.targetMktCode?.trim();

  return rows
    .slice(1)
    .map(row => ({
      mktCode: String(row[0] || '').trim(),
      advertiserId: String(row[1] || '').trim(),
      enabled: parseEnabled(row[2]),
      note: String(row[3] || '').trim() || undefined,
      advertiserName: String(row[4] || '').trim() || undefined,
    }))
    .filter(permission =>
      permission.enabled &&
      permission.advertiserId &&
      (!targetMktCode || normalizeKey(permission.mktCode) === normalizeKey(targetMktCode))
    );
}

function parseTokenRows(rows: any[][]): TikTokTokenConfig {
  const values = new Map<string, string>();

  for (const row of rows) {
    const key = normalizeKey(row[0]);
    const value = String(row[1] || '').trim();

    if (!key || !value) {
      continue;
    }

    values.set(key, value);
  }

  return {
    readAccessToken: values.get('TIKTOK_READ_ACCESS_TOKEN'),
    writeAccessToken: values.get('TIKTOK_WRITE_ACCESS_TOKEN'),
  };
}

function parseAccountBotRow(rows: any[][]): AccountBotCredentials | undefined {
  for (const row of rows) {
    const key = normalizeKey(row[0]);
    if (key !== 'ACCOUNT_BOT') continue;

    const rawValue = String(row[1] || '').trim();
    if (!rawValue) return undefined;

    const parts = rawValue.split('|');
    if (parts.length < 3) {
      console.warn('ACCOUNT_BOT format khong dung, can: email|password|totp_secret');
      return undefined;
    }

    return {
      email: parts[0].trim(),
      password: parts[1].trim(),
      totpSecret: parts[2].trim(),
    };
  }

  return undefined;
}

function normalizeAlertEntity(value: unknown): AlertEntity | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (['campaign', 'campaigns', 'camp'].includes(normalized)) {
    return 'campaign';
  }

  if (['ad', 'ads', 'advertisement', 'advertisements'].includes(normalized)) {
    return 'ad';
  }

  return undefined;
}

function normalizeAlertMetric(value: unknown): AlertMetric | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\s-]+/g, '_');

  if (['cpa', 'cost_per_result', 'costperresult', 'cost_per_conversion'].includes(normalized)) {
    return 'cpa';
  }

  if ([
    'spend',
    'spent',
    'cost',
    'amount_spent',
    'ad_spend',
    'campaign_spend',
    'chi_tieu',
    'chitieu',
  ].includes(normalized)) {
    return 'spend';
  }

  return undefined;
}

function normalizeAlertAction(value: unknown): AlertAction | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\s-]+/g, '_');

  if (['pause', 'disable', 'stop', 'tat'].includes(normalized)) {
    return 'pause';
  }

  // Re-enable paused campaigns (sheet may use enable / active / bat).
  // "acitve" = typo thường gặp trên sheet.
  if ([
    'enable',
    'start',
    'bat',
    'active',
    'acitve',
    'bat_lai',
    'batlai',
    'reenable',
    're_enable',
  ].includes(normalized)) {
    return 'enable';
  }

  if (['notify', 'alert', 'warning', 'bao', 'thong_bao'].includes(normalized)) {
    return 'notify';
  }

  return undefined;
}

function normalizeAlertCampaignStatus(value: unknown): AlertCampaignStatus | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\s-]+/g, '_');

  if (['active', 'enable', 'enabled', 'bat', 'dang_chay'].includes(normalized)) {
    return 'active';
  }

  if (['pause', 'paused', 'disable', 'disabled', 'tat', 'tam_dung'].includes(normalized)) {
    return 'paused';
  }

  if (['delete', 'deleted', 'removed', 'xoa'].includes(normalized)) {
    return 'deleted';
  }

  return undefined;
}

function normalizeComparisonOperator(
  value: unknown
): AlertComparisonOperator | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, '');

  if (['gt', '>', 'greaterthan'].includes(normalized)) {
    return 'gt';
  }

  if (['lt', '<', 'lessthan'].includes(normalized)) {
    return 'lt';
  }

  if (['gte', '>=', 'greaterthanorequal'].includes(normalized)) {
    return 'gte';
  }

  if (['lte', '<=', 'lessthanorequal'].includes(normalized)) {
    return 'lte';
  }

  if (['eq', '=', '==', 'equal'].includes(normalized)) {
    return 'eq';
  }

  if ([
    'between',
    'range',
    'inrange',
    'in_range',
    'trongkhoang',
    'trong_khoang',
    '~',
    '..',
  ].includes(normalized)) {
    return 'between';
  }

  return undefined;
}

/**
 * Parse metric threshold that may be a single number or a range.
 * Supported range forms: `0.5-1.2`, `0.5~1.2`, `0.5..1.2`, `0.5,1.2`, `0.5 – 1.2`.
 */
function parseMetricThresholdBounds(value: unknown): {
  min?: number;
  max?: number;
  single?: number;
} {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { single: value };
  }

  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return {};
  }

  const rangeMatch = rawValue.match(
    /^([+-]?\d+(?:[.,]\d+)?)\s*(?:-|~|\.\.|,|–|—)\s*([+-]?\d+(?:[.,]\d+)?)$/
  );

  if (rangeMatch) {
    const first = parseNumber(rangeMatch[1]);
    const second = parseNumber(rangeMatch[2]);

    if (Number.isFinite(first) && Number.isFinite(second)) {
      return {
        min: Math.min(first, second),
        max: Math.max(first, second),
      };
    }
  }

  const single = parseNumber(rawValue);
  return Number.isFinite(single) ? { single } : {};
}

function parseAlertEnabled(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'disabled', 'off'].includes(normalized)) {
    return false;
  }

  if (['true', '1', 'yes', 'y', 'enabled', 'on'].includes(normalized)) {
    return true;
  }

  return true;
}

/**
 * Parse one side of an alert rule (metric operator/threshold + conversions).
 * Supports single number or range threshold (between).
 */
function parseMetricSide(
  operatorValue: unknown,
  thresholdValue: unknown,
  conversionsOperatorValue: unknown,
  conversionsThresholdValue: unknown,
  metricMinValue?: unknown
): {
  metricOperator?: AlertComparisonOperator;
  threshold: number;
  metricMinThreshold?: number;
  conversionsOperator?: AlertComparisonOperator;
  conversionsThreshold: number;
} {
  let metricOperator = normalizeComparisonOperator(operatorValue);
  const thresholdBounds = parseMetricThresholdBounds(thresholdValue);
  const conversionsOperator = normalizeComparisonOperator(conversionsOperatorValue);
  const conversionsThreshold = parseNumber(conversionsThresholdValue);
  const explicitMetricMin = parseNumber(metricMinValue);

  if (thresholdBounds.min !== undefined && thresholdBounds.max !== undefined) {
    metricOperator = 'between';
  }

  let threshold = Number.NaN;
  let metricMinThreshold: number | undefined;

  if (metricOperator === 'between') {
    metricMinThreshold = thresholdBounds.min;
    threshold = thresholdBounds.max ?? Number.NaN;

    if (
      !Number.isFinite(metricMinThreshold) &&
      Number.isFinite(explicitMetricMin) &&
      thresholdBounds.single !== undefined &&
      Number.isFinite(thresholdBounds.single)
    ) {
      const singleThreshold = thresholdBounds.single;
      metricMinThreshold = Math.min(explicitMetricMin, singleThreshold);
      threshold = Math.max(explicitMetricMin, singleThreshold);
    }
  } else {
    threshold = thresholdBounds.single ?? thresholdBounds.max ?? Number.NaN;
    if (Number.isFinite(explicitMetricMin)) {
      metricMinThreshold = explicitMetricMin;
    } else if (thresholdBounds.min !== undefined) {
      metricMinThreshold = thresholdBounds.min;
    }
  }

  return {
    metricOperator,
    threshold,
    metricMinThreshold,
    conversionsOperator,
    conversionsThreshold,
  };
}

function isValidParsedAlertSide(side: {
  metricOperator?: AlertComparisonOperator;
  threshold: number;
  metricMinThreshold?: number;
  conversionsOperator?: AlertComparisonOperator;
  conversionsThreshold: number;
  action?: AlertAction;
}): boolean {
  return Boolean(
    side.metricOperator &&
    side.conversionsOperator &&
    side.action &&
    Number.isFinite(side.threshold) &&
    Number.isFinite(side.conversionsThreshold) &&
    (side.metricOperator !== 'between' || Number.isFinite(side.metricMinThreshold))
  );
}

/**
 * Dual-action row (pause + active trên 1 dòng), đúng format sheet:
 * entity | match | metric |
 *   pause_op | pause_thr | pause_cv_op | pause_cv_thr | pause |
 *   active_op | active_thr | active_cv_op | active_cv_thr | active |
 *   [enabled] | [note]
 *
 * Ví dụ:
 * campaign | Mặt nạ mắt - ID | cpa | > | 0.7 | >= | 1 | pause | < | 0.7 | >= | 1 | active
 */
function isDualActionAlertRow(row: any[]): boolean {
  const leftAction = normalizeAlertAction(row[7]);
  const rightMetricOperator = normalizeComparisonOperator(row[8]);
  const rightAction = normalizeAlertAction(row[12]);

  return Boolean(
    leftAction &&
    (leftAction === 'pause' || leftAction === 'enable') &&
    rightMetricOperator &&
    rightAction &&
    (rightAction === 'pause' || rightAction === 'enable') &&
    leftAction !== rightAction
  );
}

function defaultCampaignStatusForAction(action: AlertAction): AlertCampaignStatus | undefined {
  if (action === 'enable') {
    return 'paused';
  }

  if (action === 'pause') {
    return 'active';
  }

  return undefined;
}

function parseAlertRuleRows(rows: any[][]): AlertActionRuleSheetRow[] {
  type ParsedAlertRow = {
    entity?: AlertEntity;
    nameContains?: string;
    metric?: AlertMetric;
    metricOperator?: AlertComparisonOperator;
    threshold: number;
    metricMinThreshold?: number;
    conversionsOperator?: AlertComparisonOperator;
    conversionsThreshold: number;
    action?: AlertAction;
    campaignStatus?: AlertCampaignStatus;
    isActive: boolean;
    note?: string;
  };

  const parsedRows = rows.slice(1).flatMap<ParsedAlertRow>((row) => {
    const entity = normalizeAlertEntity(row[0]);
    const nameContains = String(row[1] || '').trim() || undefined;
    const metric = normalizeAlertMetric(row[2]);

    // ---- Format 1 dòng = tắt + bật lại ----
    if (isDualActionAlertRow(row)) {
      const leftAction = normalizeAlertAction(row[7]);
      const rightAction = normalizeAlertAction(row[12]);
      const leftSide = parseMetricSide(row[3], row[4], row[5], row[6]);
      const rightSide = parseMetricSide(row[8], row[9], row[10], row[11]);
      const isActive = parseAlertEnabled(row[13]);
      const note = String(row[14] || '').trim() || undefined;

      return [
        {
          entity,
          nameContains,
          metric,
          metricOperator: leftSide.metricOperator,
          threshold: leftSide.threshold,
          metricMinThreshold: leftSide.metricMinThreshold,
          conversionsOperator: leftSide.conversionsOperator,
          conversionsThreshold: leftSide.conversionsThreshold,
          action: leftAction,
          campaignStatus: defaultCampaignStatusForAction(leftAction!),
          isActive,
          note: note ? `${note} [${leftAction}]` : undefined,
        },
        {
          entity,
          nameContains,
          metric,
          metricOperator: rightSide.metricOperator,
          threshold: rightSide.threshold,
          metricMinThreshold: rightSide.metricMinThreshold,
          conversionsOperator: rightSide.conversionsOperator,
          conversionsThreshold: rightSide.conversionsThreshold,
          action: rightAction,
          campaignStatus: defaultCampaignStatusForAction(rightAction!),
          isActive,
          note: note ? `${note} [${rightAction}]` : undefined,
        },
      ];
    }

    // ---- Format 1 action / 1 dòng (cũ) ----
    const leftSide = parseMetricSide(row[3], row[4], row[5], row[6], row[11]);
    let metricOperator = leftSide.metricOperator;
    let threshold = leftSide.threshold;
    let metricMinThreshold = leftSide.metricMinThreshold;
    const conversionsOperator = leftSide.conversionsOperator;
    const conversionsThreshold = leftSide.conversionsThreshold;

    const inlineStatus = normalizeAlertCampaignStatus(row[7]);
    const actionInDefaultColumn = normalizeAlertAction(row[7]);
    const action = actionInDefaultColumn || normalizeAlertAction(row[8]);
    let campaignStatus = actionInDefaultColumn
      ? normalizeAlertCampaignStatus(row[10])
      : inlineStatus;
    const enabledIndex = actionInDefaultColumn ? 8 : 9;
    const noteIndex = actionInDefaultColumn ? 9 : 10;

    if (action && !campaignStatus) {
      campaignStatus = defaultCampaignStatusForAction(action);
    }

    return [{
      entity,
      nameContains,
      metric,
      metricOperator,
      threshold,
      metricMinThreshold,
      conversionsOperator,
      conversionsThreshold,
      action,
      campaignStatus,
      isActive: parseAlertEnabled(row[enabledIndex]),
      note: String(row[noteIndex] || '').trim() || undefined,
    }];
  });

  return parsedRows
    .filter((rule): rule is Required<Pick<ParsedAlertRow, 'entity' | 'metric' | 'metricOperator' | 'conversionsOperator' | 'action'>> & ParsedAlertRow =>
      Boolean(rule.entity) &&
      Boolean(rule.metric) &&
      isValidParsedAlertSide(rule)
    )
    .map(rule => ({
      entity: rule.entity,
      nameContains: rule.nameContains,
      metric: rule.metric,
      metricOperator: rule.metricOperator,
      metricThreshold: rule.threshold,
      metricMinThreshold: rule.metricMinThreshold,
      conversionsOperator: rule.conversionsOperator,
      conversionsThreshold: rule.conversionsThreshold,
      action: rule.action,
      campaignStatus: rule.campaignStatus,
      isActive: rule.isActive,
      note: rule.note,
    }));
}

function findPageMapping(pageMap: PageMapping[], channelLink: string, pageName?: string): PageMapping | undefined {
  const normalizedChannelLink = normalizeKey(channelLink);
  const normalizedInputPageName = normalizeKey(pageName);

  if (!normalizedChannelLink && !normalizedInputPageName) {
    return undefined;
  }

  // Chấm điểm thay vì lấy dòng đầu tiên khớp: khớp chính xác tên page được ưu tiên,
  // và handle/url khớp dài hơn thắng — tránh "VN" bắt nhầm "VN2" theo thứ tự dòng.
  let best: PageMapping | undefined;
  let bestScore = 0;
  for (const mapping of pageMap) {
    const normalizedPageHandle = normalizeKey(mapping.pageHandle);
    const normalizedPageUrl = normalizeKey(mapping.pageUrl);
    const normalizedPageName = normalizeKey(mapping.pageName);
    let score = 0;

    if (normalizedChannelLink && normalizedPageHandle && normalizedChannelLink.includes(normalizedPageHandle)) {
      score = Math.max(score, 1 + normalizedPageHandle.length);
    }
    if (normalizedChannelLink && normalizedPageUrl && normalizedChannelLink.includes(normalizedPageUrl)) {
      score = Math.max(score, 1 + normalizedPageUrl.length);
    }
    if (normalizedInputPageName && normalizedPageName) {
      if (normalizedInputPageName === normalizedPageName) score = Math.max(score, 100 + normalizedPageName.length);
      else if (normalizedInputPageName.includes(normalizedPageName)) score = Math.max(score, 1 + normalizedPageName.length);
    }

    if (score > bestScore) {
      best = mapping;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Get TikTok Business Center ID from the "BC" tab.
 */
export async function getBusinessCenterId(): Promise<string | undefined> {
  const local = await db.get<{ data_json: string }>(
    'SELECT data_json FROM admin_config_rows WHERE section = ? ORDER BY position, id LIMIT 1',
    ['tiktok']
  ).catch(() => undefined);
  if (local?.data_json) {
    const value = JSON.parse(local.data_json);
    const businessCenterId = String(value.business_center_id || '').trim();
    if (businessCenterId) return businessCenterId;
  }

  return undefined;
}

/** Get enabled TikTok advertisers from the local admin dashboard. */
export async function getAdvertiserPermissions(options: MktScopeOptions = {}): Promise<AdvertiserPermission[]> {
  const rows = await db.all<{ data_json: string }>(
    'SELECT data_json FROM admin_config_rows WHERE section = ? ORDER BY position, id',
    ['advertisers']
  ).catch(() => []);
  const table = [['market_code', 'advertiser_id', 'enabled', 'note', 'advertiser_name']];
  for (const row of rows) {
    const value = JSON.parse(row.data_json);
    table.push([String(value.market_code || '').trim(), value.advertiser_id, value.enabled, value.note, value.advertiser_name]);
  }
  if (rows.length === 0) {
    for (const advertiserId of String(process.env.TIKTOK_ADVERTISER_IDS || '').split(',').map(value => value.trim()).filter(Boolean)) {
      table.push([getTargetMktCode(), advertiserId, 'true', 'Biến môi trường', '']);
    }
  }
  return parseAdvertiserPermissionRows(table, options);
}

export async function getTikTokTokenConfig(): Promise<TikTokTokenConfig> {
  const local = await db.get<{ data_json: string }>(
    'SELECT data_json FROM admin_config_rows WHERE section = ? ORDER BY position, id LIMIT 1',
    ['tiktok']
  ).catch(() => undefined);
  if (local?.data_json) {
    const value = JSON.parse(local.data_json);
    if (value.read_token || value.write_token) {
      return { readAccessToken: String(value.read_token || ''), writeAccessToken: String(value.write_token || '') };
    }
  }

  return {
    readAccessToken: process.env.TIKTOK_READ_ACCESS_TOKEN?.trim(),
    writeAccessToken: process.env.TIKTOK_WRITE_ACCESS_TOKEN?.trim(),
  };
}

/**
 * Get ACCOUNT_BOT credentials from the "Token" tab.
 * Format in sheet: ACCOUNT_BOT | email|password|totp_secret
 */
export async function getAccountBotCredentials(): Promise<AccountBotCredentials | undefined> {
  const local = await db.get<{ data_json: string }>(
    'SELECT data_json FROM admin_config_rows WHERE section = ? ORDER BY position, id LIMIT 1',
    ['signer']
  ).catch(() => undefined);
  if (local?.data_json) {
    const value = JSON.parse(local.data_json);
    const email = String(value.email || '').trim();
    const password = String(value.password || '').trim();
    const totpSecret = String(value.totp_secret || '').trim();
    if (email && password && totpSecret) return { email, password, totpSecret };
  }
  const email = String(process.env.TIKTOK_ACCOUNT_EMAIL || '').trim();
  const password = String(process.env.TIKTOK_ACCOUNT_PASSWORD || '').trim();
  const totpSecret = String(process.env.TIKTOK_ACCOUNT_TOTP_SECRET || '').trim();
  return email && password && totpSecret ? { email, password, totpSecret } : undefined;
}

const ALERTS_SHEET_NAME = 'Alerts';
/**
 * Dual row (1 sản phẩm = tắt + bật lại):
 * A entity | B campaign_match | C metric |
 * D-G pause side | H pause |
 * I-L active side | M active |
 * N enabled | O note
 *
 * Single row (cũ) vẫn dùng: A-H action + enabled/note/status...
 */
const ALERTS_SHEET_HEADERS = [[
  'entity',
  'campaign_match',
  'metric',
  'metric_operator',
  'metric_threshold',
  'conversions_operator',
  'conversions_threshold',
  'action',
  'enable_metric_operator',
  'enable_metric_threshold',
  'enable_conversions_operator',
  'enable_conversions_threshold',
  'enable_action',
  'enabled',
  'note',
]];

const ALERTS_SHEET_DEMO_ROWS = [
  // 1 dòng = pause + active. Phía active PHẢI dùng < / <= (metric tốt), KHÔNG dùng > (sẽ bị bot bỏ qua).
  ['campaign', 'Mặt nạ mắt - ID', 'cpa', '>', '0.7', '>=', '1', 'pause', '<', '0.7', '>=', '3', 'active', 'true', 'CPA cao tat, CPA tot bat lai'],
  ['campaign', 'VN', 'cpa', '<', '0.70', '>=', '5', 'notify', '', '', '', '', '', 'true', 'Chi bao CPA tot VN'],
];

function normalizeSheetCell(value: unknown): string {
  return String(value ?? '').trim();
}

function trimTrailingEmptyCells(row: any[]): string[] {
  const normalizedRow = row.map(normalizeSheetCell);

  while (normalizedRow.length > 0 && !normalizedRow[normalizedRow.length - 1]) {
    normalizedRow.pop();
  }

  return normalizedRow;
}

function isLegacyAlertDemoRows(rows: any[][]): boolean {
  if (rows.length !== ALERTS_SHEET_DEMO_ROWS.length) {
    return false;
  }

  return rows.every((row, rowIndex) => {
    const normalizedRow = trimTrailingEmptyCells(row);
    const demoRow = trimTrailingEmptyCells(ALERTS_SHEET_DEMO_ROWS[rowIndex]);

    if (normalizedRow.length !== demoRow.length) {
      return false;
    }

    return normalizedRow.every((cell, cellIndex) =>
      cell === demoRow[cellIndex]
    );
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
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
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

/**
 * Get sales data from configured Google Sheets
 */
export async function getSalesData(options: MktScopeOptions = {}): Promise<SalesData[]> {
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const targetMktCode = normalizeKey(options.targetMktCode || getTargetMktCode());

  // Get configuration data first
  const configData = await getConfigData(options);

  // Read team sheets in parallel (bounded) — concurrency from /settings.
  const sheetsConcurrency = await getRuntimeSettingNumber(
    'sheets_concurrency',
    RUNTIME_SETTING_DEFAULTS.sheetsConcurrency
  );
  const perSourceRows = await mapWithConcurrency(configData.sources, sheetsConcurrency, async (teamSheetId) => {
    const salesData: SalesData[] = [];

    try {
      const spreadsheet = await sheetsClient.spreadsheets.get({
        spreadsheetId: teamSheetId,
      });
      const spreadsheetName = spreadsheet.data.properties?.title || teamSheetId;
      const salesSheets = findSalesSheets(spreadsheet.data.sheets || []);

      if (salesSheets.length === 0) {
        console.warn(`Could not find supported sales tabs in sheet: ${teamSheetId}`);
        return salesData;
      }

      // Fetch market tabs in parallel within one source workbook.
      const tabResults = await Promise.all(
        salesSheets.map(async (salesSheet) => {
          const sheetName = salesSheet.sheet.properties?.title;
          if (!sheetName) {
            return [] as SalesData[];
          }

          const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: teamSheetId,
            range: formatSheetRange(sheetName, 'A:Z'),
            valueRenderOption: 'UNFORMATTED_VALUE',
            dateTimeRenderOption: 'SERIAL_NUMBER',
          });

          const rows = response.data.values;
          if (!rows || rows.length === 0) {
            return [] as SalesData[];
          }

          const tabSales: SalesData[] = [];

          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];

            const date = row[0];
            const shopName = row[3];
            const mktCode = String(row[4] || '').trim();
            const productName = row[5];
            const channelLink = String(row[6] || '').trim();
            // O = DT thực, Q = status. Do not require length >= 15: Google omits
            // trailing empty cells, so blank DT thực rows were being dropped.
            const rawAmount = row.length > 14 ? row[14] : undefined;
            const status = row.length > 16 ? String(row[16] || '').trim() : '';

            if (!date) continue;
            if (!options.includeAllMkt && normalizeKey(mktCode) !== targetMktCode) continue;

            const hasAmount = String(rawAmount ?? '').trim() !== '';
            const amountVnd = hasAmount ? parseNumber(rawAmount) : 0;
            if (hasAmount && !Number.isFinite(amountVnd)) continue;

            const usdAmount = amountVnd / configData.exchangeRate;
            const pageMapping = findPageMapping(configData.pageMap, channelLink, shopName);

            tabSales.push({
              date,
              amount: usdAmount,
              amountVnd,
              source: teamSheetId,
              sourceName: spreadsheetName,
              sourceTabName: sheetName,
              sourceRowNumber: i + 1,
              shopName,
              mktCode,
              productName,
              channelLink,
              status,
              pageHandle: pageMapping?.pageHandle,
              pageName: pageMapping?.pageName,
              marketCode: pageMapping?.marketCode,
            });
          }

          return tabSales;
        })
      );

      for (const tabSales of tabResults) {
        salesData.push(...tabSales);
      }
    } catch (error) {
      console.error(`Error reading team sheet ${teamSheetId}:`, error);
    }

    return salesData;
  });

  const salesData = perSourceRows.flat();

  salesData.sort((a, b) => {
    const dateA = parseSalesDate(a.date)?.getTime() || 0;
    const dateB = parseSalesDate(b.date)?.getTime() || 0;
    return dateB - dateA;
  });

  return salesData;
}

export async function getConfigSnapshot(options: MktScopeOptions = {}): Promise<ConfigData> {
  return getConfigData(options);
}

/**
 * Get configuration data from the configuration sheet
 */
async function getConfigData(options: MktScopeOptions = {}): Promise<ConfigData> {
  const readAdminRows = async (section: string): Promise<Record<string, any>[]> => {
    const rows = await db.all<{ data_json: string }>(
      'SELECT data_json FROM admin_config_rows WHERE section = ? ORDER BY position, id',
      [section]
    ).catch(() => []);
    return rows.map(row => JSON.parse(row.data_json));
  };
  const [adminSources, adminPages, adminProducts] = await Promise.all([
    readAdminRows('sources'), readAdminRows('pages'), readAdminRows('products')
  ]);

  // Chỉ danh sách Sheet doanh số còn được cấu hình trong SQLite.
  const sources = adminSources
    .filter(row => parseEnabled(row.enabled))
    .map(row => extractGoogleSpreadsheetId(row.sheet_id))
    .filter((value): value is string => Boolean(value));
  const exchangeRate = await getRuntimeSettingNumber(
    'exchange_rate',
    RUNTIME_SETTING_DEFAULTS.exchangeRate
  );
  const permissions = await getAdvertiserPermissions(options);
  
  // Get page mapping from local dashboard storage.
  const pageMap: PageMapping[] = adminPages.filter(row => parseEnabled(row.enabled)).map(row => ({ pageHandle: String(row.page_handle || ''), marketCode: String(row.market_code || ''), pageName: String(row.page_name || ''), pageUrl: String(row.page_url || '') }));

  // Get product-name mapping from local dashboard storage.
  // Layout thực tế: A=STT | B=Tên vật tư | C=DANH MỤC | D=? | E=KEY MAP
  // Sales sheet cột F map với DANH MỤC (C); campaign name map với KEY MAP (E).
  const spMap: SpMapping[] = adminProducts.filter(row => parseEnabled(row.enabled)).map(row => ({ variantName: String(row.variant_name || row.material_name || ''), shortName: String(row.campaign_key || row.variant_name || ''), materialName: String(row.material_name || '') || undefined })).filter(row => row.variantName && row.shortName);

  return {
    sources,
    exchangeRate,
    permissions,
    pageMap,
    spMap
  };
}

/**
 * Add sales data to a specific sheet
 */
export async function addSalesData(
  sheetName: string,
  salesData: Omit<SalesData, 'source'>,
  teamSheetId: string
): Promise<boolean> {
  if (!teamSheetId) {
    throw new Error('Missing team sheet ID for adding sales data');
  }

  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);

  try {
    // Find the "Đài Loan" tab in the team sheet
    const spreadsheet = await sheetsClient.spreadsheets.get({
      spreadsheetId: teamSheetId,
    });

    // Prefer the exact "Đài Loan" tab, then fall back to legacy variants.
    const taiwanSheet = findTaiwanSalesSheet(spreadsheet.data.sheets || []);

    if (!taiwanSheet || !taiwanSheet.properties?.title) {
      console.error(`Could not find "Đài Loan" tab in sheet: ${teamSheetId}`);
      return false;
    }

    const targetSheetName = taiwanSheet.properties.title;

    // Prepare the row data according to your specification:
    // A = Time, D = Shop Name, E = MKT Code, F = Product, G = Channel Link, O = Sales Amount (VND)
    // Need to create an array with empty values for columns B, C, H-N
    const rowData: (string | number | undefined)[] = new Array(15).fill('');
    rowData[0] = salesData.date; // Column A (time)
    rowData[3] = salesData.shopName || ''; // Column D (shop name)
    rowData[4] = salesData.mktCode || getTargetMktCode(); // Column E (MKT code, default to fixed value)
    rowData[5] = salesData.productName || ''; // Column F (product)
    rowData[6] = salesData.channelLink || ''; // Column G (channel link)
    
    // Convert USD amount back to VND before saving
    const configData = await getConfigData();
    rowData[14] = salesData.amountVnd || salesData.amount * configData.exchangeRate; // Column O (sales amount VND)

    // Append the new sales data to the specified sheet
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: teamSheetId,
      range: formatSheetRange(targetSheetName, 'A:O'), // Specify the range to cover up to column O
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [rowData],
      },
    });

    return true;
  } catch (error) {
    console.error(`Error adding sales data to sheet ${teamSheetId}, tab ${sheetName}:`, error);
    return false;
  }
}
