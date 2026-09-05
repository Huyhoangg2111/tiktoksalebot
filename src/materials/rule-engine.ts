import * as googleSheets from '@googleapis/sheets';
import type { Telegraf } from 'telegraf';
import { db } from '../db/index.js';
import {
  getAlertRulesConfig,
  type AlertAction,
  type AlertActionRuleSheetRow,
  type AlertComparisonOperator,
  type AlertMetric,
} from '../google-sheets/api.js';
import {
  getTodaySpentCampaigns,
  type TikTokSpentCampaign,
} from '../tiktok/api.js';
import { buildMaterialDetailCallbackData } from './callbacks.js';
import {
  getCampaignMaterialSnapshot,
  setMaterialOperationStatusBatch,
  type CampaignMaterialItem,
  type MaterialOperationStatus,
} from './service.js';

const DEFAULT_CONFIG_SHEET_ID = '1f7bH43w8kv_iiqoy9X5TzSugDuWtsKrB3-Iq8IrxvAI';
const CAMPAIGN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const MATERIAL_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

interface MaterialRule {
  rowNumber: number;
  nameContains?: string;
  metric: AlertMetric;
  metricOperator: AlertComparisonOperator;
  metricThreshold: number;
  metricMinThreshold?: number;
  conversionsOperator: AlertComparisonOperator;
  conversionsThreshold: number;
  action: AlertAction;
  isActive: boolean;
  note?: string;
}

function getConfigSheetId(): string {
  return process.env.CONFIG_GOOGLE_SHEET_ID || process.env.GOOGLE_SHEET_ID || DEFAULT_CONFIG_SHEET_ID;
}

function createSheetsClient() {
  const auth = new googleSheets.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return googleSheets.sheets({ version: 'v4', auth });
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function parseEnabled(value: unknown): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  return !['false', '0', 'no', 'n', 'disabled', 'off'].includes(normalized);
}

function parseNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const raw = String(value ?? '').trim().replace(/\s/g, '');
  if (!raw) return Number.NaN;
  if (/^[+-]?\d+,\d{1,2}$/.test(raw)) return Number(raw.replace(',', '.'));
  return Number(raw.replace(/,/g, ''));
}

function normalizeOperator(value: unknown): AlertComparisonOperator | undefined {
  const normalized = normalizeText(value).replace(/\s+/g, '');
  if (['gt', '>', 'greaterthan'].includes(normalized)) return 'gt';
  if (['lt', '<', 'lessthan'].includes(normalized)) return 'lt';
  if (['gte', '>=', 'greaterthanorequal'].includes(normalized)) return 'gte';
  if (['lte', '<=', 'lessthanorequal'].includes(normalized)) return 'lte';
  if (['eq', '=', '==', 'equal'].includes(normalized)) return 'eq';
  if (['between', 'range', 'inrange', 'trongkhoang', '~', '..'].includes(normalized)) return 'between';
  return undefined;
}

function normalizeMetric(value: unknown): AlertMetric | undefined {
  const normalized = normalizeText(value).replace(/[\s-]+/g, '_');
  if (['cpa', 'cost_per_result', 'costperresult', 'cost_per_conversion'].includes(normalized)) return 'cpa';
  if (['spend', 'spent', 'cost', 'amount_spent', 'ad_spend', 'campaign_spend', 'chi_tieu', 'chitieu'].includes(normalized)) return 'spend';
  return undefined;
}

function normalizeAction(value: unknown): AlertAction | undefined {
  const normalized = normalizeText(value).replace(/[\s-]+/g, '_');
  if (['pause', 'disable', 'stop', 'tat'].includes(normalized)) return 'pause';
  if (['enable', 'start', 'bat', 'active', 'acitve', 'bat_lai', 'batlai', 'reenable', 're_enable'].includes(normalized)) return 'enable';
  if (['notify', 'alert', 'warning', 'bao', 'thong_bao'].includes(normalized)) return 'notify';
  return undefined;
}

function parseThreshold(value: unknown, operator: AlertComparisonOperator): {
  threshold: number;
  min?: number;
} {
  const raw = String(value ?? '').trim();
  if (operator === 'between') {
    const match = raw.match(/^([+-]?\d+(?:[.,]\d+)?)\s*(?:-|~|\.\.|–|—)\s*([+-]?\d+(?:[.,]\d+)?)$/);
    if (match) {
      const first = parseNumber(match[1]);
      const second = parseNumber(match[2]);
      if (Number.isFinite(first) && Number.isFinite(second)) {
        return { threshold: Math.max(first, second), min: Math.min(first, second) };
      }
    }
  }
  return { threshold: parseNumber(value) };
}

function parseMaterialSide(row: any[], rowNumber: number, offset: 3, actionIndex: number, note?: string): MaterialRule | undefined {
  const metric = normalizeMetric(row[2]);
  const metricOperator = normalizeOperator(row[offset]);
  const action = normalizeAction(row[actionIndex]);
  const conversionsOperator = normalizeOperator(row[offset + 2]);
  if (!metric || !metricOperator || !action || !conversionsOperator) return undefined;

  const threshold = parseThreshold(row[offset + 1], metricOperator);
  const conversionsThreshold = parseNumber(row[offset + 3]);
  if (!Number.isFinite(threshold.threshold) || !Number.isFinite(conversionsThreshold)) return undefined;

  return {
    rowNumber,
    nameContains: String(row[1] || '').trim() || undefined,
    metric,
    metricOperator,
    metricThreshold: threshold.threshold,
    metricMinThreshold: threshold.min,
    conversionsOperator,
    conversionsThreshold,
    action,
    isActive: true,
    note,
  };
}

async function getMaterialRules(): Promise<MaterialRule[]> {
  const client = createSheetsClient();
  const response = await client.spreadsheets.values.get({
    spreadsheetId: getConfigSheetId(),
    range: 'Alerts!A:O',
  });
  const rows = response.data.values || [];
  const rules: MaterialRule[] = [];

  rows.slice(1).forEach((row, index) => {
    const entity = normalizeText(row[0]).replace(/[\s-]+/g, '_');
    if (!['material', 'materials', 'creative', 'creatives', 'video', 'videos', 'tu_lieu', 'tulieu'].includes(entity)) {
      return;
    }

    const rowNumber = index + 2;
    const enabled = parseEnabled(row[13] ?? row[8]);
    if (!enabled) return;
    const note = String(row[14] || row[9] || '').trim() || undefined;

    const left = parseMaterialSide(row, rowNumber, 3, 7, note ? `${note} [pause/primary]` : undefined);
    if (left) rules.push({ ...left, isActive: enabled });

    const rightOperator = normalizeOperator(row[8]);
    const rightAction = normalizeAction(row[12]);
    if (rightOperator && rightAction) {
      const right = parseMaterialSide(row, rowNumber, 8, 12, note ? `${note} [enable/secondary]` : undefined);
      if (right) rules.push({ ...right, isActive: enabled });
    }
  });

  return rules;
}

function compareValues(
  current: number,
  operator: AlertComparisonOperator,
  threshold: number,
  min?: number
): boolean {
  if (operator === 'between') {
    return Number.isFinite(min) && current >= Number(min) && current <= threshold;
  }
  if (operator === 'gt') return current > threshold;
  if (operator === 'gte') return current >= threshold;
  if (operator === 'lt') return current < threshold;
  if (operator === 'lte') return current <= threshold;
  return current === threshold;
}

function getCampaignRuleKey(name: string | undefined): string {
  const parts = String(name || '').split(/\s*-\s*/).map(part => part.trim()).filter(Boolean);
  const value = parts.length >= 2 ? `${parts[0]} - ${parts[1]}` : String(name || '');
  return value.replace(/\s+/g, ' ').trim().toLocaleUpperCase('vi-VN');
}

function matchesCampaignName(nameContains: string | undefined, campaignName: string | undefined): boolean {
  if (!nameContains) return true;
  const rule = getCampaignRuleKey(nameContains);
  const key = getCampaignRuleKey(campaignName);
  const full = String(campaignName || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('vi-VN');
  return key === rule || key.includes(rule) || full.includes(rule);
}

function campaignMatchesRule(campaign: TikTokSpentCampaign, rule: AlertActionRuleSheetRow): boolean {
  if (!rule.isActive || !matchesCampaignName(rule.nameContains, campaign.campaign_name)) return false;
  if (rule.campaignStatus && campaign.status !== rule.campaignStatus) return false;
  const metric = rule.metric === 'spend' ? campaign.spend : campaign.cpa;
  return compareValues(metric, rule.metricOperator, rule.metricThreshold, rule.metricMinThreshold) &&
    compareValues(campaign.conversions, rule.conversionsOperator, rule.conversionsThreshold);
}

function materialMatchesRule(material: CampaignMaterialItem, rule: MaterialRule): boolean {
  const metric = rule.metric === 'spend' ? material.spend : material.cpa;
  return compareValues(metric, rule.metricOperator, rule.metricThreshold, rule.metricMinThreshold) &&
    compareValues(material.conversions, rule.conversionsOperator, rule.conversionsThreshold);
}

function formatOperator(operator: AlertComparisonOperator): string {
  return ({ gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', between: 'trong khoảng' } as const)[operator];
}

function formatRuleCondition(rule: Pick<AlertActionRuleSheetRow, 'metric' | 'metricOperator' | 'metricThreshold' | 'metricMinThreshold' | 'conversionsOperator' | 'conversionsThreshold'>): string {
  const metricLabel = rule.metric === 'spend' ? 'Spend' : 'CPA';
  const metricPart = rule.metricOperator === 'between' && Number.isFinite(rule.metricMinThreshold)
    ? `${metricLabel} ${rule.metricMinThreshold}-${rule.metricThreshold}`
    : `${metricLabel} ${formatOperator(rule.metricOperator)} ${rule.metricThreshold}`;
  return `${metricPart} · Conversion ${formatOperator(rule.conversionsOperator)} ${rule.conversionsThreshold}`;
}

async function ensureStateTable(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_material_rule_notifications (
      subject_key TEXT PRIMARY KEY,
      last_sent_ms INTEGER NOT NULL
    )
  `);
}

async function canNotify(subjectKey: string, cooldownMs: number): Promise<boolean> {
  await ensureStateTable();
  const row = await db.get<{ last_sent_ms: number }>(
    'SELECT last_sent_ms FROM campaign_material_rule_notifications WHERE subject_key = ?',
    [subjectKey]
  );
  return !row || Date.now() - Number(row.last_sent_ms || 0) >= cooldownMs;
}

async function markNotified(subjectKey: string): Promise<void> {
  await ensureStateTable();
  await db.run(
    `INSERT INTO campaign_material_rule_notifications(subject_key, last_sent_ms)
     VALUES (?, ?)
     ON CONFLICT(subject_key) DO UPDATE SET last_sent_ms = excluded.last_sent_ms`,
    [subjectKey, Date.now()]
  );
}

function campaignRuleSubjectKey(campaign: TikTokSpentCampaign, rule: AlertActionRuleSheetRow): string {
  return `campaign:${campaign.advertiser_id}:${campaign.campaign_id}:${rule.metric}:${rule.metricOperator}:${rule.metricThreshold}:${rule.conversionsOperator}:${rule.conversionsThreshold}:${rule.action}`;
}

async function sendCampaignNotification(
  bot: Telegraf,
  campaign: TikTokSpentCampaign,
  rule: AlertActionRuleSheetRow
): Promise<void> {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;
  const condition = rule.metricOperator === 'gt' || rule.metricOperator === 'gte' ? 'vượt giới hạn' : 'đạt điều kiện';
  const text = [
    `🔔 <b>Campaign ${escapeHtml(condition)}</b>`,
    `<b>${escapeHtml(campaign.campaign_name)}</b> - <code>${escapeHtml(campaign.campaign_id)}</code>`,
    `💵 $${campaign.spend.toFixed(2)} · 👆 ${campaign.clicks.toLocaleString()}/${campaign.ctr.toFixed(2)}% · 🎯 ${campaign.conversions.toLocaleString()} · 💰 $${campaign.cpa.toFixed(2)}`,
    `📏 ${escapeHtml(formatRuleCondition(rule))}`,
    `ℹ️ Campaign chỉ cảnh báo, không tự tắt/bật.`,
  ].join('\n');

  await bot.telegram.sendMessage(adminChatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{
        text: '🔎 Xem chi tiết material',
        callback_data: buildMaterialDetailCallbackData(campaign.advertiser_id, campaign.campaign_id, 0),
      }]],
    },
  });
}

async function evaluateCampaignNotifications(bot: Telegraf, campaigns: TikTokSpentCampaign[]): Promise<void> {
  const rules = (await getAlertRulesConfig()).filter(rule => rule.entity === 'campaign' && rule.isActive);
  for (const campaign of campaigns) {
    for (const rule of rules) {
      if (!campaignMatchesRule(campaign, rule)) continue;
      const subjectKey = campaignRuleSubjectKey(campaign, rule);
      if (!(await canNotify(subjectKey, CAMPAIGN_ALERT_COOLDOWN_MS))) continue;
      await sendCampaignNotification(bot, campaign, rule);
      await markNotified(subjectKey);
    }
  }
}

interface MaterialDecision {
  material: CampaignMaterialItem;
  operationStatus: MaterialOperationStatus;
  rules: MaterialRule[];
}

function getMaterialDecision(material: CampaignMaterialItem, rules: MaterialRule[]): MaterialDecision | undefined {
  const matching = rules.filter(rule => materialMatchesRule(material, rule));
  const actionRules = matching.filter(rule => rule.action === 'pause' || rule.action === 'enable');
  const desired = new Set(actionRules.map(rule => rule.action === 'pause' ? 'DISABLE' : 'ENABLE'));
  if (desired.size !== 1) {
    if (desired.size > 1) {
      console.warn(`[MaterialRules] conflicting rules for ad_material_id=${material.adMaterialId}; skipping write`);
    }
    return undefined;
  }

  const operationStatus = [...desired][0] as MaterialOperationStatus;
  if (material.status === operationStatus) return undefined;
  if (material.status === 'UNKNOWN') return undefined;
  return { material, operationStatus, rules: actionRules };
}

async function sendMaterialNotifyRules(
  bot: Telegraf,
  campaign: TikTokSpentCampaign,
  materials: CampaignMaterialItem[],
  rules: MaterialRule[]
): Promise<void> {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;

  for (const material of materials) {
    for (const rule of rules.filter(item => item.action === 'notify')) {
      if (!materialMatchesRule(material, rule)) continue;
      const key = `material-notify:${material.advertiserId}:${material.adMaterialId}:${rule.rowNumber}:${rule.metric}:${rule.metricThreshold}:${rule.conversionsThreshold}`;
      if (!(await canNotify(key, MATERIAL_NOTIFY_COOLDOWN_MS))) continue;
      await bot.telegram.sendMessage(adminChatId, [
        `🔔 <b>Material đạt rule</b>`,
        `<b>${escapeHtml(campaign.campaign_name)}</b>`,
        `🎬 #${material.materialNumber} · <code>${escapeHtml(material.tiktokItemId)}</code>`,
        `💵 $${material.spend.toFixed(2)} · 👆 ${material.clicks}/${material.ctr.toFixed(2)}% · 🎯 ${material.conversions} · 💰 $${material.cpa.toFixed(2)}`,
        `📏 ${escapeHtml(formatRuleCondition(rule as any))}`,
      ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{
            text: '🔎 Xem chi tiết material',
            callback_data: buildMaterialDetailCallbackData(campaign.advertiser_id, campaign.campaign_id, 0),
          }]],
        },
      });
      await markNotified(key);
    }
  }
}

async function applyMaterialDecisions(
  bot: Telegraf,
  campaign: TikTokSpentCampaign,
  decisions: MaterialDecision[]
): Promise<void> {
  const grouped = new Map<string, MaterialDecision[]>();
  for (const decision of decisions) {
    const key = `${decision.material.smartPlusAdId}:${decision.operationStatus}`;
    const list = grouped.get(key) || [];
    list.push(decision);
    grouped.set(key, list);
  }

  const resultLines: string[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    const result = await setMaterialOperationStatusBatch(
      first.material.advertiserId,
      first.material.smartPlusAdId,
      group.map(item => item.material.adMaterialId),
      first.operationStatus
    );
    for (const decision of group) {
      const ok = result.verified.includes(decision.material.adMaterialId);
      resultLines.push(
        `${ok ? '✅' : '⚠️'} #${decision.material.materialNumber} ${first.operationStatus === 'DISABLE' ? 'TẮT' : 'BẬT'} · $${decision.material.spend.toFixed(2)} · 🎯 ${decision.material.conversions} · CPA $${decision.material.cpa.toFixed(2)}`
      );
    }
  }

  if (resultLines.length === 0) return;
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;
  await bot.telegram.sendMessage(adminChatId, [
    `🤖 <b>Material Rule Auto</b>`,
    `<b>${escapeHtml(campaign.campaign_name)}</b> - <code>${escapeHtml(campaign.campaign_id)}</code>`,
    ...resultLines.map(escapeHtml),
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{
        text: '🔎 Xem chi tiết material',
        callback_data: buildMaterialDetailCallbackData(campaign.advertiser_id, campaign.campaign_id, 0),
      }]],
    },
  });
}

async function evaluateMaterialRules(bot: Telegraf, campaigns: TikTokSpentCampaign[]): Promise<void> {
  const rules = await getMaterialRules();
  if (rules.length === 0) return;

  for (const campaign of campaigns) {
    const campaignRules = rules.filter(rule => matchesCampaignName(rule.nameContains, campaign.campaign_name));
    if (campaignRules.length === 0) continue;

    try {
      const snapshot = await getCampaignMaterialSnapshot(
        campaign.advertiser_id,
        campaign.campaign_id,
        campaign.campaign_name
      );
      if (snapshot.materials.length === 0) continue;

      await sendMaterialNotifyRules(bot, campaign, snapshot.materials, campaignRules);
      const decisions = snapshot.materials
        .map(material => getMaterialDecision(material, campaignRules))
        .filter((decision): decision is MaterialDecision => Boolean(decision));
      await applyMaterialDecisions(bot, campaign, decisions);
    } catch (error) {
      console.error(`[MaterialRules] campaign=${campaign.campaign_id} failed:`, error);
    }
  }
}

/**
 * Level 1 architecture:
 * - campaign rules: notify/report only, never write campaign status;
 * - ad rules: intentionally ignored;
 * - material rules: evaluate today's material metrics and control only ad_material_id.
 */
export async function checkAndSendCampaignMaterialAlerts(bot: Telegraf): Promise<void> {
  const campaigns = await getTodaySpentCampaigns();
  await evaluateCampaignNotifications(bot, campaigns);
  await evaluateMaterialRules(bot, campaigns);
}
