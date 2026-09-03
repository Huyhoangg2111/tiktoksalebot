import * as googleSheets from '@googleapis/sheets';
import type { sheets_v4 } from '@googleapis/sheets';
import {
  getRuntimeSettingNumber,
  RUNTIME_SETTING_DEFAULTS,
} from '../settings/runtime.js';

type SheetsClient = sheets_v4.Sheets;
type Sheet = sheets_v4.Schema$Sheet;

const DEFAULT_CONFIG_SHEET_ID = '1f7bH43w8kv_iiqoy9X5TzSugDuWtsKrB3-Iq8IrxvAI';
const DEFAULT_TARGET_MKT_CODE = 'MKT80.HOÀNG-TH';
const DEFAULT_EXCHANGE_RATE = 28119;

function getConfigSheetId(): string {
  const configSheetId = process.env.CONFIG_GOOGLE_SHEET_ID || process.env.GOOGLE_SHEET_ID || DEFAULT_CONFIG_SHEET_ID;

  if (!configSheetId) {
    throw new Error('Missing CONFIG_GOOGLE_SHEET_ID or GOOGLE_SHEET_ID in environment variables');
  }

  return configSheetId;
}

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
  {
    displayName: 'HÀN QUỐC',
    aliases: ['hàn quốc', 'han quoc'],
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

export function parseSalesDate(value: unknown): Date | undefined {
  if (typeof value === 'number' && value > 20000) {
    const wholeDays = Math.floor(value);
    const timestamp = (wholeDays - 25569) * 86400 * 1000 + 12 * 60 * 60 * 1000;
    return new Date(timestamp);
  }

  const rawValue = String(value ?? '').trim();

  if (!rawValue) {
    return undefined;
  }

  const dateMatch = rawValue.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const yearValue = Number(dateMatch[3]);
    const year = yearValue < 100 ? yearValue + 2000 : yearValue;
    const hour = Number(dateMatch[4] || 0);
    const minute = Number(dateMatch[5] || 0);
    const second = Number(dateMatch[6] || 0);
    const parsedDate = new Date(year, month - 1, day, hour, minute, second);

    if (
      parsedDate.getFullYear() === year &&
      parsedDate.getMonth() === month - 1 &&
      parsedDate.getDate() === day
    ) {
      return parsedDate;
    }
  }

  const directDate = new Date(rawValue);
  return Number.isNaN(directDate.getTime()) ? undefined : directDate;
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

export type AlertComparisonOperator = 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
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
  variantName: string; // Tên dài trên sheet doanh số
  shortName: string;   // Tên ngắn (KEY MAP) trên tên chiến dịch
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
  const targetMktCode = normalizeKey(options.targetMktCode || getTargetMktCode());

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
      (options.includeAllMkt || normalizeKey(permission.mktCode) === targetMktCode)
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
    .replace(/[\s-]+/g, '_');

  if (['pause', 'disable', 'stop', 'tat'].includes(normalized)) {
    return 'pause';
  }

  if (['enable', 'start', 'bat'].includes(normalized)) {
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

  return undefined;
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

function parseAlertRuleRows(rows: any[][]): AlertActionRuleSheetRow[] {
  type ParsedAlertRow = {
    entity?: AlertEntity;
    nameContains?: string;
    metric?: AlertMetric;
    metricOperator?: AlertComparisonOperator;
    threshold: number;
    conversionsOperator?: AlertComparisonOperator;
    conversionsThreshold: number;
    action?: AlertAction;
    campaignStatus?: AlertCampaignStatus;
    isActive: boolean;
    note?: string;
  };

  return rows
    .slice(1)
    .map<ParsedAlertRow>(row => {
      const entity = normalizeAlertEntity(row[0]);
      const nameContains = String(row[1] || '').trim() || undefined;
      const metric = normalizeAlertMetric(row[2]);
      const metricOperator = normalizeComparisonOperator(row[3]);
      const threshold = parseNumber(row[4]);
      const conversionsOperator = normalizeComparisonOperator(row[5]);
      const conversionsThreshold = parseNumber(row[6]);
      const inlineStatus = normalizeAlertCampaignStatus(row[7]);
      const actionInDefaultColumn = normalizeAlertAction(row[7]);
      const action = actionInDefaultColumn || normalizeAlertAction(row[8]);
      const campaignStatus = actionInDefaultColumn
        ? normalizeAlertCampaignStatus(row[10])
        : inlineStatus;
      const enabledIndex = actionInDefaultColumn ? 8 : 9;
      const noteIndex = actionInDefaultColumn ? 9 : 10;

      return {
        entity,
        nameContains,
        metric,
        metricOperator,
        threshold,
        conversionsOperator,
        conversionsThreshold,
        action,
        campaignStatus,
        isActive: parseAlertEnabled(row[enabledIndex]),
        note: String(row[noteIndex] || '').trim() || undefined,
      };
    })
    .filter((rule): rule is Required<Pick<ParsedAlertRow, 'entity' | 'metric' | 'metricOperator' | 'conversionsOperator' | 'action'>> & ParsedAlertRow =>
      Boolean(rule.entity) &&
      Boolean(rule.metric) &&
      Boolean(rule.metricOperator) &&
      Boolean(rule.conversionsOperator) &&
      Boolean(rule.action) &&
      Number.isFinite(rule.threshold) &&
      Number.isFinite(rule.conversionsThreshold)
    )
    .map(rule => ({
      entity: rule.entity,
      nameContains: rule.nameContains,
      metric: rule.metric,
      metricOperator: rule.metricOperator,
      metricThreshold: rule.threshold,
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

  return pageMap.find(mapping => {
    const normalizedPageHandle = normalizeKey(mapping.pageHandle);
    const normalizedPageUrl = normalizeKey(mapping.pageUrl);
    const normalizedPageName = normalizeKey(mapping.pageName);

    return Boolean(
      (normalizedChannelLink && normalizedPageHandle && normalizedChannelLink.includes(normalizedPageHandle)) ||
      (normalizedChannelLink && normalizedPageUrl && normalizedChannelLink.includes(normalizedPageUrl)) ||
      (normalizedInputPageName && normalizedPageName && normalizedInputPageName === normalizedPageName) ||
      (normalizedInputPageName && normalizedPageName && normalizedInputPageName.includes(normalizedPageName))
    );
  });
}

/**
 * Get TikTok Business Center ID from the "BC" tab.
 */
export async function getBusinessCenterId(): Promise<string | undefined> {
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: getConfigSheetId(),
    range: 'BC!A2:A',
  });

  const businessCenterIds = (response.data.values || [])
    .flat()
    .map(value => String(value).trim())
    .filter(Boolean);

  return businessCenterIds[0];
}

/**
 * Get enabled TikTok advertisers from the "Permissions" tab.
 */
export async function getAdvertiserPermissions(options: MktScopeOptions = {}): Promise<AdvertiserPermission[]> {
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: getConfigSheetId(),
    range: 'Permissions!A:E',
  });

  const rows = response.data.values || [];

  return parseAdvertiserPermissionRows(rows, options);
}

export async function getAlertRulesConfig(): Promise<AlertActionRuleSheetRow[]> {
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: getConfigSheetId(),
    range: 'Alerts!A:K',
  });

  return parseAlertRuleRows(response.data.values || []);
}

export async function getTikTokTokenConfig(): Promise<TikTokTokenConfig> {
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: getConfigSheetId(),
      range: 'Token!A:B',
    });

    return parseTokenRows(response.data.values || []);
  } catch (error) {
    console.warn('Could not fetch token config from Token tab, falling back to .env');
    return {};
  }
}

/**
 * Get ACCOUNT_BOT credentials from the "Token" tab.
 * Format in sheet: ACCOUNT_BOT | email|password|totp_secret
 */
export async function getAccountBotCredentials(): Promise<AccountBotCredentials | undefined> {
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: getConfigSheetId(),
      range: 'Token!A:B',
    });

    return parseAccountBotRow(response.data.values || []);
  } catch (error) {
    console.warn('Could not fetch ACCOUNT_BOT from Token tab:', error);
    return undefined;
  }
}

const ALERTS_SHEET_NAME = 'Alerts';
const ALERTS_SHEET_HEADERS = [[
  'entity',
  'campaign_match',
  'metric',
  'metric_operator',
  'metric_threshold',
  'conversions_operator',
  'conversions_threshold',
  'action',
  'enabled',
  'note',
  'campaign_status',
]];

const ALERTS_SHEET_DEMO_ROWS = [
  ['campaign', 'VN', 'cpa', '>', '1.20', '<', '3', 'pause', 'true', 'Camp VN CPA cao thi tat', ''],
  ['campaign', 'VN', 'cpa', '<', '0.90', '>=', '3', 'enable', 'true', 'Camp VN CPA tot thi bat lai', ''],
  ['campaign', 'VN', 'cpa', '<', '0.70', '>=', '1', 'notify', 'true', 'Camp VN CPA tot dang pause thi bao', 'paused'],
  ['campaign', 'ID', 'cpa', '>', '1.60', '<', '3', 'pause', 'true', 'Camp ID CPA cao thi tat', ''],
  ['campaign', 'ID', 'cpa', '<', '1.10', '>=', '3', 'enable', 'true', 'Camp ID CPA tot thi bat lai', ''],
  ['ad', 'VN', 'cpa', '>', '1.20', '<', '3', 'notify', 'true', 'Ad thuoc camp VN CPA cao thi bao', ''],
  ['ad', 'VN', 'cpa', '<', '0.90', '>=', '3', 'notify', 'true', 'Ad thuoc camp VN CPA tot thi bao', ''],
  ['ad', 'ID', 'cpa', '>', '1.60', '<', '3', 'notify', 'true', 'Ad thuoc camp ID CPA cao thi bao', ''],
  ['ad', 'ID', 'cpa', '<', '1.10', '>=', '3', 'notify', 'true', 'Ad thuoc camp ID CPA tot thi bao', ''],
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

export async function ensureAlertsSheetTemplate(): Promise<{
  created: boolean;
  clearedLegacyDemo: boolean;
}> {
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
  const spreadsheetId = getConfigSheetId();
  const spreadsheet = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const existingSheet = spreadsheet.data.sheets?.find(
    sheet => sheet.properties?.title === ALERTS_SHEET_NAME
  );

  let created = false;

  if (!existingSheet) {
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: ALERTS_SHEET_NAME,
              },
            },
          },
        ],
      },
    });
    created = true;
  }

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${ALERTS_SHEET_NAME}!A1:K1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: ALERTS_SHEET_HEADERS,
    },
  });

  const currentRows = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${ALERTS_SHEET_NAME}!A2:K`,
  });

  const dataRows = currentRows.data.values || [];
  const clearedLegacyDemo = isLegacyAlertDemoRows(dataRows);

  if (clearedLegacyDemo) {
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId,
      range: `${ALERTS_SHEET_NAME}!A2:K`,
    });
  }

  return { created, clearedLegacyDemo };
}

/**
 * Get sales data from configured Google Sheets
 */
export async function getSalesData(options: MktScopeOptions = {}): Promise<SalesData[]> {
  const configSheetId = getConfigSheetId();
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const targetMktCode = normalizeKey(options.targetMktCode || getTargetMktCode());

  // Get configuration data first
  const configData = await getConfigData(configSheetId, sheetsClient, options);
  
  const salesData: SalesData[] = [];

  // Read from each team sheet
  for (const teamSheetId of configData.sources) {
    try {
      // Get all sheet names in the team spreadsheet to find supported market tabs.
      const spreadsheet = await sheetsClient.spreadsheets.get({
        spreadsheetId: teamSheetId,
      });
      const spreadsheetName = spreadsheet.data.properties?.title || teamSheetId;

      const salesSheets = findSalesSheets(spreadsheet.data.sheets || []);

      if (salesSheets.length === 0) {
        console.warn(`Could not find supported sales tabs in sheet: ${teamSheetId}`);
        continue;
      }

      for (const salesSheet of salesSheets) {
        const sheetName = salesSheet.sheet.properties?.title;

        if (!sheetName) {
          continue;
        }

        // Fetch data from the market tab
        const response = await sheetsClient.spreadsheets.values.get({
          spreadsheetId: teamSheetId,
          range: formatSheetRange(sheetName, 'A:Z'), // Read from columns A to Z
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
          console.log(`No data found in sheet: ${teamSheetId}, tab: ${sheetName}`);
          continue;
        }

        for (let i = 1; i < rows.length; i++) { // Skip header row
          const row = rows[i];

          // Check if row has enough columns
          if (row.length < 15) continue;

          // Extract data according to your specification:
          // A(0)=Time, D(3)=Shop Name, E(4)=MKT Code, F(5)=Product, G(6)=Channel Link, O(14)=Sales Amount, Q(16)=Status
          const date = row[0]; // Column A (time)
          const shopName = row[3]; // Column D (shop name)
          const mktCode = String(row[4] || '').trim(); // Column E (MKT code)
          const productName = row[5]; // Column F (product)
          const channelLink = String(row[6] || '').trim(); // Column G (channel link)
          const rawAmount = row[14]; // Column O (sales amount VND)
          const status = String(row[16] || '').trim(); // Column Q (status)

          // Verify that we have the required data
          if (!date) continue;
          if (!options.includeAllMkt && normalizeKey(mktCode) !== targetMktCode) continue;

          // Convert the raw amount to a number
          const hasAmount = String(rawAmount ?? '').trim() !== '';
          const amountVnd = hasAmount ? parseNumber(rawAmount) : 0;

          if (hasAmount && !Number.isFinite(amountVnd)) continue;

          // Convert VND to USD using the exchange rate from config
          const usdAmount = amountVnd / configData.exchangeRate;
          const pageMapping = findPageMapping(configData.pageMap, channelLink, shopName);

          salesData.push({
            date: date,
            amount: usdAmount, // Store amount in USD
            amountVnd,
            source: teamSheetId,
            sourceName: spreadsheetName,
            sourceTabName: sheetName,
            sourceRowNumber: i + 1,
            shopName: shopName,
            mktCode: mktCode,
            productName: productName,
            channelLink: channelLink,
            status: status,
            pageHandle: pageMapping?.pageHandle,
            pageName: pageMapping?.pageName,
            marketCode: pageMapping?.marketCode,
          });
        }
      }
    } catch (error) {
      console.error(`Error reading team sheet ${teamSheetId}:`, error);
      continue; // Continue with next sheet
    }
  }

  // Sort by date (assuming various date formats)
  salesData.sort((a, b) => {
    const dateA = parseSalesDate(a.date)?.getTime() || 0;
    const dateB = parseSalesDate(b.date)?.getTime() || 0;
    return dateB - dateA;
  });

  return salesData;
}

export async function getConfigSnapshot(options: MktScopeOptions = {}): Promise<ConfigData> {
  const configSheetId = getConfigSheetId();
  const sheetsClient = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);

  return getConfigData(configSheetId, sheetsClient, options);
}

/**
 * Get configuration data from the configuration sheet
 */
async function getConfigData(
  configSheetId: string,
  sheetsClient: SheetsClient,
  options: MktScopeOptions = {}
): Promise<ConfigData> {
  // Get sources from "Sources" tab
  const sourcesResponse = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: configSheetId,
    range: 'Sources!A:E',
  });

  const sources = getSourceSpreadsheetIds(sourcesResponse.data.values || []);
  
  // Get exchange rate from "Settings" tab
  let exchangeRate = DEFAULT_EXCHANGE_RATE; // Default value in case we can't fetch it
  
  try {
    const settingsResponse = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: configSheetId,
      range: 'Settings!A:B', // Assuming settings are in columns A (key) and B (value)
    });
    
    const settingsRows = settingsResponse.data.values || [];
    for (const row of settingsRows) {
      if (row[0]?.toLowerCase().includes('vnd') && row[0]?.toLowerCase().includes('usd')) {
        const parsedExchangeRate = parseNumber(row[1]);
        if (Number.isFinite(parsedExchangeRate) && parsedExchangeRate > 0) {
          exchangeRate = parsedExchangeRate;
        }
        break;
      }
    }
  } catch (error) {
    console.warn('Could not fetch exchange rate from Settings tab, using default value');
  }
  exchangeRate = await getRuntimeSettingNumber(
    'exchange_rate',
    exchangeRate || RUNTIME_SETTING_DEFAULTS.exchangeRate
  );
  
  // Get permissions from "Permissions" tab
  let permissions: AdvertiserPermission[] = [];
  
  try {
    const permissionsResponse = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: configSheetId,
      range: 'Permissions!A:E',
    });
    
    permissions = parseAdvertiserPermissionRows(permissionsResponse.data.values || [], options);
  } catch (error) {
    console.warn('Could not fetch permissions from Permissions tab');
  }
  
  // Get page mapping from "PageMap" tab
  let pageMap: PageMapping[] = [];
  
  try {
    const pageMapResponse = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: configSheetId,
      range: 'PageMap!A:D', // Assuming PageMap has columns: page_handle, market_code, page_name, page_url
    });
    
    const pageMapRows = (pageMapResponse.data.values || []).slice(1);
    for (const row of pageMapRows) {
      if (row.length >= 2) {
        pageMap.push({
          pageHandle: String(row[0] || '').trim(),
          marketCode: String(row[1] || '').trim(),
          pageName: String(row[2] || '').trim(),
          pageUrl: String(row[3] || '').trim()
        });
      }
    }
  } catch (error) {
    console.warn('Could not fetch page mapping from PageMap tab');
  }

  // Get SpMap from "SpMap" tab
  let spMap: SpMapping[] = [];
  try {
    const spMapResponse = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: configSheetId,
      range: 'SpMap!A:E',
    });

    const spMapRows = (spMapResponse.data.values || []).slice(1);
    for (const row of spMapRows) {
      const variantName = String(row[2] || row[1] || row[0] || '').trim();
      const shortName = String(row[4] || row[3] || row[1] || '').trim();

      if (variantName && shortName && !/^(stt|no\.?|#)$/i.test(variantName)) {
        spMap.push({
          variantName,
          shortName,
        });
      }
    }
  } catch (error) {
    console.warn('Could not fetch spMap from SpMap tab');
  }
  
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
    const configSheetId = process.env.CONFIG_GOOGLE_SHEET_ID || process.env.GOOGLE_SHEET_ID;
    if (configSheetId) {
      const configData = await getConfigData(configSheetId, sheetsClient);
      rowData[14] = salesData.amountVnd || salesData.amount * configData.exchangeRate; // Column O (sales amount VND)
    } else {
      // If we can't get exchange rate, save as is
      rowData[14] = salesData.amount;
    }

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
