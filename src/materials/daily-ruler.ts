import * as googleSheets from '@googleapis/sheets';
import type { Telegraf } from 'telegraf';
import { db } from '../db/index.js';
import { getCampaigns, type TikTokCampaign } from '../tiktok/api.js';
import {
  getCampaignMaterialSnapshot,
  setMaterialOperationStatusBatch,
  type CampaignMaterialItem,
} from './service.js';

const DEFAULT_CONFIG_SHEET_ID = '1f7bH43w8kv_iiqoy9X5TzSugDuWtsKrB3-Iq8IrxvAI';
const SHEET_NAME = 'MaterialRuler';
const SHEET_HEADERS = [[
  'rule_id',
  'enabled',
  'timezone',
  'run_time',
  'advertiser_id',
  'campaign_id',
  'campaign_match',
  'note',
]];
const SHEET_DEMO_ROW = [[
  'daily-enable-all',
  'false',
  'Asia/Ho_Chi_Minh',
  '00:05',
  '',
  '',
  '',
  'Bật lại toàn bộ material mỗi ngày; đổi enabled thành true sau khi kiểm tra phạm vi.',
]];

interface DailyMaterialRule {
  id: string;
  timezone: string;
  runTime: string;
  advertiserId?: string;
  campaignId?: string;
  campaignMatch?: string;
  note?: string;
}

interface RuleRunResult {
  matchedCampaigns: number;
  changedMaterials: number;
  failedGroups: number;
}

function getConfigSheetId(): string {
  return process.env.CONFIG_GOOGLE_SHEET_ID || process.env.GOOGLE_SHEET_ID || DEFAULT_CONFIG_SHEET_ID;
}

function createSheetsClient(scopes: string[]) {
  const auth = new googleSheets.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes,
  });
  return googleSheets.sheets({ version: 'v4', auth });
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function parseEnabled(value: unknown): boolean {
  return ['true', '1', 'yes', 'on', 'enabled', 'bat', 'bật'].includes(
    normalizeText(value).toLocaleLowerCase('vi-VN')
  );
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseRules(rows: any[][]): DailyMaterialRule[] {
  const rules: DailyMaterialRule[] = [];
  const seenIds = new Set<string>();

  rows.slice(1).forEach((row, index) => {
    const id = normalizeText(row[0]);
    if (!id || seenIds.has(id) || !parseEnabled(row[1])) return;

    const timezone = normalizeText(row[2]) || 'Asia/Ho_Chi_Minh';
    const runTime = normalizeText(row[3]);
    if (!isValidTimeZone(timezone) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(runTime)) {
      console.warn(`[MaterialRuler] bỏ qua dòng ${index + 2}: timezone hoặc run_time không hợp lệ`);
      return;
    }

    seenIds.add(id);
    rules.push({
      id,
      timezone,
      runTime,
      advertiserId: normalizeText(row[4]) || undefined,
      campaignId: normalizeText(row[5]) || undefined,
      campaignMatch: normalizeText(row[6]) || undefined,
      note: normalizeText(row[7]) || undefined,
    });
  });

  return rules;
}

function getDateAndTime(timezone: string): { dateKey: string; timeKey: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value || '';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    timeKey: `${get('hour')}:${get('minute')}`,
  };
}

function campaignMatchesRule(campaign: TikTokCampaign, rule: DailyMaterialRule): boolean {
  if (rule.advertiserId && campaign.advertiser_id !== rule.advertiserId) return false;
  if (rule.campaignId && campaign.campaign_id !== rule.campaignId) return false;
  if (rule.campaignMatch) {
    const name = String(campaign.campaign_name || '').toLocaleUpperCase('vi-VN');
    if (!name.includes(rule.campaignMatch.toLocaleUpperCase('vi-VN'))) return false;
  }
  return true;
}

async function ensureRunTable(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS material_daily_ruler_runs (
      rule_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      timezone TEXT NOT NULL,
      run_time TEXT NOT NULL,
      matched_campaigns INTEGER DEFAULT 0,
      changed_materials INTEGER DEFAULT 0,
      completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (rule_id, date_key)
    )
  `);
}

async function wasCompleted(ruleId: string, dateKey: string): Promise<boolean> {
  const row = await db.get<{ rule_id: string }>(
    'SELECT rule_id FROM material_daily_ruler_runs WHERE rule_id = ? AND date_key = ?',
    [ruleId, dateKey]
  );
  return Boolean(row);
}

async function markCompleted(rule: DailyMaterialRule, dateKey: string, result: RuleRunResult): Promise<void> {
  await db.run(
    `INSERT INTO material_daily_ruler_runs (
      rule_id, date_key, timezone, run_time, matched_campaigns, changed_materials, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(rule_id, date_key) DO NOTHING`,
    [rule.id, dateKey, rule.timezone, rule.runTime, result.matchedCampaigns, result.changedMaterials]
  );
}

export async function ensureMaterialRulerSheetTemplate(): Promise<{ created: boolean }> {
  const client = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
  const spreadsheetId = getConfigSheetId();
  const spreadsheet = await client.spreadsheets.get({ spreadsheetId });
  const existing = spreadsheet.data.sheets?.find(sheet => sheet.properties?.title === SHEET_NAME);

  if (!existing) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    });
  }

  await client.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A1:H1`,
    valueInputOption: 'RAW',
    requestBody: { values: SHEET_HEADERS },
  });

  if (!existing) {
    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!A2:H2`,
      valueInputOption: 'RAW',
      requestBody: { values: SHEET_DEMO_ROW },
    });
  }

  return { created: !existing };
}

async function getRules(): Promise<DailyMaterialRule[]> {
  await ensureMaterialRulerSheetTemplate();
  const client = createSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const response = await client.spreadsheets.values.get({
    spreadsheetId: getConfigSheetId(),
    range: `${SHEET_NAME}!A:H`,
  });
  return parseRules(response.data.values || []);
}

async function enableDisabledMaterials(materials: CampaignMaterialItem[]): Promise<RuleRunResult> {
  const disabled = materials.filter(material => material.status === 'DISABLE');
  const groups = new Map<string, CampaignMaterialItem[]>();
  for (const material of disabled) {
    const group = groups.get(material.smartPlusAdId) || [];
    group.push(material);
    groups.set(material.smartPlusAdId, group);
  }

  let changedMaterials = 0;
  let failedGroups = 0;
  for (const group of groups.values()) {
    const first = group[0];
    try {
      const result = await setMaterialOperationStatusBatch(
        first.advertiserId,
        first.smartPlusAdId,
        group.map(material => material.adMaterialId),
        'ENABLE'
      );
      changedMaterials += result.verified.length;
      if (result.verified.length !== group.length) failedGroups += 1;
    } catch (error) {
      failedGroups += 1;
      console.error(`[MaterialRuler] bật material thất bại smart_plus_ad_id=${first.smartPlusAdId}:`, error);
    }
  }

  return { matchedCampaigns: 0, changedMaterials, failedGroups };
}

async function runRule(rule: DailyMaterialRule, campaigns: TikTokCampaign[]): Promise<RuleRunResult> {
  const matched = campaigns.filter(campaign => campaignMatchesRule(campaign, rule));
  const result: RuleRunResult = { matchedCampaigns: matched.length, changedMaterials: 0, failedGroups: 0 };

  for (const campaign of matched) {
    try {
      const snapshot = await getCampaignMaterialSnapshot(
        campaign.advertiser_id,
        campaign.campaign_id,
        campaign.campaign_name
      );
      const campaignResult = await enableDisabledMaterials(snapshot.materials);
      result.changedMaterials += campaignResult.changedMaterials;
      result.failedGroups += campaignResult.failedGroups;
    } catch (error) {
      result.failedGroups += 1;
      console.error(`[MaterialRuler] campaign=${campaign.campaign_id} thất bại:`, error);
    }
  }
  return result;
}

async function notifyResult(bot: Telegraf, rule: DailyMaterialRule, result: RuleRunResult): Promise<void> {
  const chatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!chatId || (result.changedMaterials === 0 && result.failedGroups === 0)) return;
  await bot.telegram.sendMessage(chatId, [
    '⏰ <b>Material Ruler hằng ngày</b>',
    `Rule: <code>${rule.id.replace(/[&<>]/g, '')}</code> · ${rule.runTime} (${rule.timezone})`,
    `Campaign khớp: <b>${result.matchedCampaigns}</b>`,
    `Material đã bật: <b>${result.changedMaterials}</b>`,
    result.failedGroups > 0 ? `Lỗi/thiếu xác nhận: <b>${result.failedGroups}</b>` : '',
  ].filter(Boolean).join('\n'), { parse_mode: 'HTML' });
}

/** Chạy từ Level 1. Rule đến giờ sẽ chạy một lần/ngày; lỗi một phần được thử lại ở lượt sau. */
export async function checkAndRunDailyMaterialRuler(bot: Telegraf): Promise<void> {
  await ensureRunTable();
  const rules = await getRules();
  if (rules.length === 0) return;

  const dueRules: Array<{ rule: DailyMaterialRule; dateKey: string }> = [];
  for (const rule of rules) {
    const { dateKey, timeKey } = getDateAndTime(rule.timezone);
    if (timeKey < rule.runTime || await wasCompleted(rule.id, dateKey)) continue;
    dueRules.push({ rule, dateKey });
  }
  if (dueRules.length === 0) return;

  const campaigns = await getCampaigns();
  for (const { rule, dateKey } of dueRules) {
    const result = await runRule(rule, campaigns);
    await notifyResult(bot, rule, result);
    if (result.failedGroups === 0) {
      await markCompleted(rule, dateKey, result);
    }
  }
}

