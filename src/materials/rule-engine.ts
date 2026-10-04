import type { Telegraf } from 'telegraf';
import { getTrackedAdvertiserIdSet } from '../accounts/tracking.js';
import { db } from '../db/index.js';
import {
  type AlertAction,
  type AlertComparisonOperator,
  type AlertMetric,
} from '../google-sheets/api.js';
import { getTodaySpentCampaigns, setCampaignStatus, type TikTokCampaignOperationStatus, type TikTokSpentCampaign } from '../tiktok/api.js';
import { getAutoActionMode, getRuntimeSettingNumber, RUNTIME_SETTING_DEFAULTS } from '../settings/runtime.js';
import { saveAlertHistory } from './alert-store.js';
import { checkAndSendLowBalanceAlert } from './balance-alert.js';
import { buildMaterialDetailCallbackData } from './callbacks.js';
import {
  getCampaignMaterialSnapshot,
  setMaterialOperationStatusBatch,
  type CampaignMaterialItem,
  type MaterialOperationStatus,
} from './service.js';

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
  note?: string;
}

interface Level1RuleSnapshot {
  campaignRules: MaterialRule[];
  materialRules: MaterialRule[];
  loadedAtMs: number;
}

interface RuleConditionShape {
  metric: AlertMetric;
  metricOperator: AlertComparisonOperator;
  metricThreshold: number;
  metricMinThreshold?: number;
  conversionsOperator: AlertComparisonOperator;
  conversionsThreshold: number;
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

function parseThreshold(
  value: unknown,
  operator: AlertComparisonOperator
): { threshold: number; min?: number } {
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

function parseRuleSide(
  row: any[],
  rowNumber: number,
  offset: number,
  actionIndex: number,
  note?: string
): MaterialRule | undefined {
  const metric = normalizeMetric(row[2]);
  const metricOperator = normalizeOperator(row[offset]);
  const conversionsOperator = normalizeOperator(row[offset + 2]);
  const action = normalizeAction(row[actionIndex]);
  if (!metric || !metricOperator || !conversionsOperator || !action) return undefined;

  const metricThreshold = parseThreshold(row[offset + 1], metricOperator);
  const conversionsThreshold = parseNumber(row[offset + 3]);
  if (!Number.isFinite(metricThreshold.threshold) || !Number.isFinite(conversionsThreshold)) return undefined;

  return {
    rowNumber,
    nameContains: String(row[1] || '').trim() || undefined,
    metric,
    metricOperator,
    metricThreshold: metricThreshold.threshold,
    metricMinThreshold: metricThreshold.min,
    conversionsOperator,
    conversionsThreshold,
    action,
    note,
  };
}

async function readDashboardRules(entity: 'campaign' | 'material'): Promise<MaterialRule[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT id,name_contains,metric,metric_operator,metric_threshold,metric_min_threshold,conversions_operator,conversions_threshold,action,is_active,note FROM alert_action_rules WHERE entity=? ORDER BY id',
    [entity]
  );
  return rows.flatMap(value => {
    const metric = normalizeMetric(value.metric);
    const metricOperator = normalizeOperator(value.metric_operator);
    const conversionsOperator = normalizeOperator(value.conversions_operator);
    const action = normalizeAction(value.action);
    const threshold = parseThreshold(value.metric_threshold, metricOperator || 'eq');
    const conversionsThreshold = parseNumber(value.conversions_threshold);
    if (!metric || !metricOperator || !conversionsOperator || !action || Number(value.is_active ?? 1) === 0 || !Number.isFinite(threshold.threshold) || !Number.isFinite(conversionsThreshold)) return [];
    return [{rowNumber:Number(value.id),nameContains:String(value.name_contains ?? '').trim()||undefined,metric,metricOperator,metricThreshold:threshold.threshold,metricMinThreshold:threshold.min ?? (value.metric_min_threshold == null ? undefined : Number(value.metric_min_threshold)),conversionsOperator,conversionsThreshold,action,note:String(value.note ?? '').trim()||undefined} satisfies MaterialRule];
  });
}

async function getLevel1RuleSnapshot(): Promise<Level1RuleSnapshot> {
  const [campaignRules, materialRules] = await Promise.all([
    readDashboardRules('campaign'),
    readDashboardRules('material'),
  ]);
  return { campaignRules, materialRules, loadedAtMs: Date.now() };
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
  if (operator === 'gt') {
    if (!(current > threshold)) return false;
  } else if (operator === 'gte') {
    if (!(current >= threshold)) return false;
  } else if (operator === 'lt') {
    if (!(current < threshold)) return false;
  } else if (operator === 'lte') {
    if (!(current <= threshold)) return false;
  } else if (current !== threshold) {
    return false;
  }
  // "Mức từ" áp dụng cho mọi toán tử (giống bản tham chiếu alerts): VD CPA < 1.2 và >= 0.5.
  if (Number.isFinite(min)) {
    return current >= Number(min);
  }
  return true;
}

function getCampaignRuleKey(name: string | undefined): string {
  const parts = String(name || '').split(/\s*-\s*/).map(part => part.trim()).filter(Boolean);
  const value = parts.length >= 2 ? `${parts[0]} - ${parts[1]}` : String(name || '');
  return value.replace(/\s+/g, ' ').trim().toLocaleUpperCase('vi-VN');
}

/** contains nhưng yêu cầu needle đứng trọn vẹn một "token": MKT.CT không khớp MKT.CT1. */
function containsStandaloneToken(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index === 0 ? '' : haystack[index - 1];
    const afterIndex = index + needle.length;
    const after = afterIndex >= haystack.length ? '' : haystack[afterIndex];
    const boundaryBefore = before === '' || /[^A-Za-z0-9]/.test(before);
    const boundaryAfter = after === '' || /[^A-Za-z0-9]/.test(after);
    if (boundaryBefore && boundaryAfter) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function matchesCampaignName(nameContains: string | undefined, campaignName: string | undefined): boolean {
  if (!nameContains) return true;
  const rule = getCampaignRuleKey(nameContains);
  const key = getCampaignRuleKey(campaignName);
  const full = String(campaignName || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('vi-VN');
  return key === rule || containsStandaloneToken(key, rule) || containsStandaloneToken(full, rule);
}

function campaignMatchesRule(campaign: TikTokSpentCampaign, rule: MaterialRule): boolean {
  if (!matchesCampaignName(rule.nameContains, campaign.campaign_name)) return false;
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
  const labels: Record<AlertComparisonOperator, string> = {
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    eq: '=',
    between: 'trong khoảng',
  };
  return labels[operator];
}

function formatRuleCondition(rule: RuleConditionShape): string {
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

async function sendMaterialPipelineWarning(bot: Telegraf, detail: string): Promise<void> {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;
  const key = 'material-pipeline-warning';
  if (!(await canNotify(key, 30 * 60 * 1000))) return;
  await bot.telegram.sendMessage(
    adminChatId,
    ['⚠️ <b>Ruler material đang gặp lỗi</b>', escapeHtml(detail), 'Bot sẽ tự thử lại ở lượt kế tiếp. Nếu lỗi lặp lại liên tục, hãy kiểm tra log container và token TikTok.'].join('\n'),
    { parse_mode: 'HTML' }
  );
  await saveAlertHistory('material_pipeline_warning', detail, 'high');
  await markNotified(key);
}

function campaignSubjectKey(campaign: TikTokSpentCampaign, rule: MaterialRule): string {
  return `campaign:${campaign.advertiser_id}:${campaign.campaign_id}:${rule.metric}:${rule.metricOperator}:${rule.metricThreshold}:${rule.metricMinThreshold ?? ''}:${rule.nameContains ?? ''}:${rule.conversionsOperator}:${rule.conversionsThreshold}:${rule.action}`;
}

function getMktGroupKey(mktCode: string | undefined | null): string {
  const value = String(mktCode || '').trim();
  return value || 'CHUA_GAN_MKT';
}

function getMktSectionLabel(mkt: string): string {
  return mkt === 'CHUA_GAN_MKT' ? 'Chưa gắn MKT' : mkt;
}

function shortCampaignLabel(name: string | undefined): string {
  const parts = String(name || '').split(/\s*-\s*/).map(part => part.trim()).filter(Boolean);
  const label = parts.length >= 2 ? `${parts[0]} - ${parts[1]}` : String(name || '');
  return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}

function chunkInlineButtons(
  buttons: Array<{ text: string; callback_data: string }>,
  perRow: number
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < buttons.length; index += perRow) {
    rows.push(buttons.slice(index, index + perRow));
  }
  return rows;
}

const TELEGRAM_MESSAGE_LIMIT = 3_800;

/** Chia dòng tin thành nhiều message dưới giới hạn 4096 của Telegram để không mất tin. */
function chunkLinesForTelegram(lines: string[], limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const rawLine of lines) {
    const line = rawLine.length > limit ? rawLine.slice(0, limit) : rawLine;
    const lineLength = line.length + 1;
    if (current.length > 0 && length + lineLength > limit) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += lineLength;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks.length > 0 ? chunks : [''];
}

async function sendChunkedMessage(
  bot: Telegraf,
  chatId: string,
  lines: string[],
  options?: { buttons?: Array<{ text: string; callback_data: string }> }
): Promise<void> {
  const chunks = chunkLinesForTelegram(lines);
  for (let index = 0; index < chunks.length; index++) {
    const isLast = index === chunks.length - 1;
    await bot.telegram.sendMessage(chatId, chunks[index], {
      parse_mode: 'HTML',
      ...(isLast && options?.buttons?.length ? { reply_markup: { inline_keyboard: chunkInlineButtons(options.buttons, 3) } } : {}),
    });
  }
}

async function sendGroupedCampaignNotification(
  bot: Telegraf,
  rule: MaterialRule,
  campaigns: TikTokSpentCampaign[]
): Promise<void> {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;
  const condition = rule.metricOperator === 'gt' || rule.metricOperator === 'gte'
    ? 'vượt giới hạn'
    : 'đạt điều kiện';

  const groups = new Map<string, TikTokSpentCampaign[]>();
  for (const campaign of campaigns) {
    const mkt = getMktGroupKey(campaign.mkt_code);
    const list = groups.get(mkt) || [];
    list.push(campaign);
    groups.set(mkt, list);
  }

  const lines: string[] = [
    `🔔 <b>Campaign ${escapeHtml(condition)}</b>`,
    `📏 ${escapeHtml(formatRuleCondition(rule))}`,
  ];
  const plainLines: string[] = [`Campaign ${condition}`, formatRuleCondition(rule)];
  const buttons: Array<{ text: string; callback_data: string }> = [];

  for (const [mkt, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi'))) {
    lines.push(`👤 <b>${escapeHtml(getMktSectionLabel(mkt))}</b>`);
    plainLines.push(`👤 ${getMktSectionLabel(mkt)}`);
    for (const campaign of list) {
      lines.push(
        `<b>${escapeHtml(campaign.campaign_name)}</b> - <code>${escapeHtml(campaign.campaign_id)}</code>`,
        `💵 $${campaign.spend.toFixed(2)} · 👆 ${campaign.clicks.toLocaleString()}/${campaign.ctr.toFixed(2)}% · 🎯 ${campaign.conversions.toLocaleString()} · 💰 $${campaign.cpa.toFixed(2)}`
      );
      plainLines.push(
        `${campaign.campaign_name} - ${campaign.campaign_id}`,
        `$${campaign.spend.toFixed(2)} · click ${campaign.clicks}/${campaign.ctr.toFixed(2)}% · conversion ${campaign.conversions} · CPA $${campaign.cpa.toFixed(2)}`
      );
      buttons.push({
        text: `🔎 ${shortCampaignLabel(campaign.campaign_name)}`,
        callback_data: buildMaterialDetailCallbackData(campaign.advertiser_id, campaign.campaign_id, 0),
      });
    }
  }

  lines.push('ℹ️ Campaign chỉ cảnh báo, không tự tắt/bật.');
  plainLines.push('Campaign chỉ cảnh báo, không tự tắt/bật.');

  await sendChunkedMessage(bot, adminChatId, lines, { buttons });
  const severityCampaign = campaigns[0];
  const severity = severityCampaign
    ? calculateCampaignActionSeverity(
      rule.metric === 'spend' ? severityCampaign.spend : severityCampaign.cpa,
      rule.metricThreshold
    )
    : 'low';
  await saveAlertHistory('campaign_notify', plainLines.join('\n'), severity);
}

async function evaluateCampaignNotifications(
  bot: Telegraf,
  campaigns: TikTokSpentCampaign[],
  sourceRules: MaterialRule[]
): Promise<void> {
  // Mọi toán tử đều thông báo được: lt/lte = "đạt điều kiện", gt/gte = "vượt giới hạn".
  const rules = sourceRules.filter(rule => rule.action === 'notify');

  for (const rule of rules) {
    const sendable: TikTokSpentCampaign[] = [];
    for (const campaign of campaigns) {
      if (!campaignMatchesRule(campaign, rule)) continue;
      const key = campaignSubjectKey(campaign, rule);
      if (!(await canNotify(key, CAMPAIGN_ALERT_COOLDOWN_MS))) continue;
      sendable.push(campaign);
    }
    if (sendable.length === 0) continue;
    await sendGroupedCampaignNotification(bot, rule, sendable);
    for (const campaign of sendable) {
      await markNotified(campaignSubjectKey(campaign, rule));
    }
  }
}

interface MaterialDecision {
  material: CampaignMaterialItem;
  operationStatus: MaterialOperationStatus;
}

interface CampaignDecision {
  campaign: TikTokSpentCampaign;
  operationStatus: TikTokCampaignOperationStatus;
  rule: MaterialRule;
}

function getMaterialDecision(material: CampaignMaterialItem, rules: MaterialRule[]): MaterialDecision | undefined {
  const matchingActions = rules
    .filter(rule => rule.action === 'pause' || rule.action === 'enable')
    .filter(rule => materialMatchesRule(material, rule));

  const desiredStatuses = new Set<MaterialOperationStatus>(
    matchingActions.map(rule => rule.action === 'pause' ? 'DISABLE' : 'ENABLE')
  );

  if (desiredStatuses.size !== 1) {
    if (desiredStatuses.size > 1) {
      console.warn(`[MaterialRules] conflicting rules for ad_material_id=${material.adMaterialId}; skipping write`);
    }
    return undefined;
  }

  const operationStatus = [...desiredStatuses][0];
  if (material.status === 'UNKNOWN' || material.status === operationStatus) return undefined;
  return { material, operationStatus };
}

async function sendMaterialNotifyRules(
  bot: Telegraf,
  campaign: TikTokSpentCampaign,
  materials: CampaignMaterialItem[],
  rules: MaterialRule[]
): Promise<void> {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;
  const notifyRules = rules.filter(rule => rule.action === 'notify');

  for (const material of materials) {
    for (const rule of notifyRules) {
      if (!materialMatchesRule(material, rule)) continue;
      const key = `material-notify:${material.advertiserId}:${material.adMaterialId}:${rule.rowNumber}:${rule.metric}:${rule.metricThreshold}:${rule.conversionsThreshold}`;
      if (!(await canNotify(key, MATERIAL_NOTIFY_COOLDOWN_MS))) continue;

      const plainMessage = [
        'Material đạt rule',
        campaign.campaign_name,
        `#${material.materialNumber} · ${material.tiktokItemId}`,
        `$${material.spend.toFixed(2)} · click ${material.clicks}/${material.ctr.toFixed(2)}% · conversion ${material.conversions} · CPA $${material.cpa.toFixed(2)}`,
        formatRuleCondition(rule),
      ].join('\n');
      await bot.telegram.sendMessage(adminChatId, [
        '🔔 <b>Material đạt rule</b>',
        `<b>${escapeHtml(campaign.campaign_name)}</b>`,
        `🎬 #${material.materialNumber} · <code>${escapeHtml(material.tiktokItemId)}</code>`,
        `💵 $${material.spend.toFixed(2)} · 👆 ${material.clicks}/${material.ctr.toFixed(2)}% · 🎯 ${material.conversions} · 💰 $${material.cpa.toFixed(2)}`,
        `📏 ${escapeHtml(formatRuleCondition(rule))}`,
      ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{
            text: '🔎 Xem chi tiết material',
            callback_data: buildMaterialDetailCallbackData(campaign.advertiser_id, campaign.campaign_id, 0),
          }]],
        },
      });
      await saveAlertHistory('material_notify', plainMessage, 'low');
      await markNotified(key);
    }
  }
}

/** Thực hiện ghi trạng thái material và trả về các dòng kết quả (chưa gửi Telegram). */
async function collectMaterialDecisionLines(
  campaign: TikTokSpentCampaign,
  decisions: MaterialDecision[]
): Promise<string[]> {
  const groups = new Map<string, MaterialDecision[]>();
  for (const decision of decisions) {
    // TikTok accepts one smart_plus_ad_id + one operation_status + a list of material IDs.
    const key = `${decision.material.smartPlusAdId}:${decision.operationStatus}`;
    const current = groups.get(key) || [];
    current.push(decision);
    groups.set(key, current);
  }

  const groupResults = await Promise.all(
    [...groups.values()].map(async group => {
      const first = group[0];

      try {
        const result = await setMaterialOperationStatusBatch(
          first.material.advertiserId,
          first.material.smartPlusAdId,
          group.map(item => item.material.adMaterialId),
          first.operationStatus
        );

        return group.map(decision => {
          const accepted = result.verified.includes(decision.material.adMaterialId);
          return `${accepted ? '✅' : '⚠️'} #${decision.material.materialNumber} ${decision.operationStatus === 'DISABLE' ? 'TẮT' : 'BẬT'} · $${decision.material.spend.toFixed(2)} · 🎯 ${decision.material.conversions} · CPA $${decision.material.cpa.toFixed(2)}`;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[MaterialRules] write failed campaign=${campaign.campaign_id} ad=${first.material.smartPlusAdId} status=${first.operationStatus}:`,
          error
        );
        return group.map(decision =>
          `⚠️ #${decision.material.materialNumber} ${decision.operationStatus === 'DISABLE' ? 'TẮT' : 'BẬT'} thất bại · ${message}`
        );
      }
    })
  );

  return groupResults.flat();
}

interface MaterialMktGroup {
  lines: string[];
  plainLines: string[];
}

async function sendGroupedMaterialActions(
  bot: Telegraf,
  groups: Map<string, MaterialMktGroup>
): Promise<void> {
  if (groups.size === 0) return;
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;

  const lines: string[] = ['🤖 <b>Material Rule Auto</b>'];
  const plainLines: string[] = ['Material Rule Auto'];
  for (const [mkt, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi'))) {
    lines.push(`— <b>${escapeHtml(getMktSectionLabel(mkt))}</b> —`, ...group.lines);
    plainLines.push(`— ${getMktSectionLabel(mkt)} —`, ...group.plainLines);
  }

  await sendChunkedMessage(bot, adminChatId, lines);
  await saveAlertHistory('material_auto_action', plainLines.join('\n'), 'low');
}

/** Thang mức như bản cũ: so khoảng cách giá trị với ngưỡng để xếp severity. */
function calculateCampaignActionSeverity(currentValue: number, threshold: number): 'low' | 'medium' | 'high' | 'critical' {
  if (threshold === 0) return currentValue === 0 ? 'low' : 'critical';
  const ratio = Math.abs(currentValue - threshold) / Math.abs(threshold);
  if (ratio >= 0.5) return 'critical';
  if (ratio >= 0.25) return 'high';
  if (ratio >= 0.1) return 'medium';
  return 'low';
}

async function applyCampaignDecisions(
  bot: Telegraf,
  decisions: CampaignDecision[]
): Promise<void> {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId || decisions.length === 0) return;

  interface CampaignActionGroup {
    lines: string[];
    plainLines: string[];
    buttons: Array<{ text: string; callback_data: string }>;
  }
  const groups = new Map<string, CampaignActionGroup>();

  for (const decision of decisions) {
    const { campaign, operationStatus, rule } = decision;
    const actionLabel = operationStatus === 'DISABLE' ? 'Pause' : 'Active';
    const metricValue = rule.metric === 'spend' ? campaign.spend : campaign.cpa;
    const severity = calculateCampaignActionSeverity(metricValue, rule.metricThreshold);
    let success = false;
    let failureReason: string | undefined;

    try {
      await setCampaignStatus(campaign.advertiser_id, campaign.campaign_id, operationStatus);
      success = true;
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
      console.error(
        `[CampaignRules] write failed campaign=${campaign.campaign_id} status=${operationStatus}:`,
        error
      );
    }

    const conditionLabel = rule.metricOperator === 'gt' || rule.metricOperator === 'gte'
      ? 'vượt giới hạn'
      : 'đạt điều kiện';
    const resultLine = `${actionLabel} ${success ? 'thành công' : `thất bại${failureReason ? `: ${failureReason}` : ''}`}`;
    const campaignPlainLines = [
      `Campaign ${conditionLabel}`,
      `${campaign.campaign_name} - ${campaign.campaign_id}`,
      `$${campaign.spend.toFixed(2)} · click ${campaign.clicks.toLocaleString()}/${campaign.ctr.toFixed(2)}% · conversion ${campaign.conversions.toLocaleString()} · CPA $${campaign.cpa.toFixed(2)}`,
      formatRuleCondition(rule),
      resultLine,
    ];
    await saveAlertHistory(
      operationStatus === 'DISABLE'
        ? (success ? 'campaign_paused' : 'campaign_pause_failed')
        : (success ? 'campaign_enabled' : 'campaign_enable_failed'),
      campaignPlainLines.join('\n'),
      severity
    );

    const mkt = getMktGroupKey(campaign.mkt_code);
    const group = groups.get(mkt) || { lines: [], plainLines: [], buttons: [] };
    group.lines.push(
      `<b>${escapeHtml(campaign.campaign_name)}</b> - <code>${escapeHtml(campaign.campaign_id)}</code>`,
      `💵 $${campaign.spend.toFixed(2)} · 👆 ${campaign.clicks.toLocaleString()}/${campaign.ctr.toFixed(2)}% · 🎯 ${campaign.conversions.toLocaleString()} · 💰 $${campaign.cpa.toFixed(2)}`,
      `📏 ${escapeHtml(formatRuleCondition(rule))}`,
      `${success ? '✅' : '⚠️'} <b>${escapeHtml(resultLine)}</b>`
    );
    group.plainLines.push(...campaignPlainLines);
    // Nút đảo chiều dùng lại handler campaign_action còn hoạt động ở bản hiện tại.
    const inverseStatus: TikTokCampaignOperationStatus = operationStatus === 'DISABLE' ? 'ENABLE' : 'DISABLE';
    group.buttons.push({
      text: `${inverseStatus === 'DISABLE' ? '⏸' : '✅'} ${shortCampaignLabel(campaign.campaign_name)}`,
      callback_data: `campaign_action:${inverseStatus}:${campaign.campaign_id}`,
    });
    groups.set(mkt, group);
  }

  const lines: string[] = ['🤖 <b>Campaign Rule Auto · chế độ Campaign</b>'];
  const buttons: Array<{ text: string; callback_data: string }> = [];
  for (const [mkt, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi'))) {
    lines.push(`— <b>${escapeHtml(getMktSectionLabel(mkt))}</b> —`, ...group.lines);
    buttons.push(...group.buttons);
  }

  await sendChunkedMessage(bot, adminChatId, lines, { buttons });
}

async function evaluateCampaignActions(
  bot: Telegraf,
  campaigns: TikTokSpentCampaign[],
  sourceRules: MaterialRule[]
): Promise<void> {
  const rules = sourceRules.filter(rule => rule.action === 'pause' || rule.action === 'enable');
  if (rules.length === 0) return;

  const decisions = campaigns
    .map(campaign => getCampaignDecision(campaign, rules))
    .filter((decision): decision is CampaignDecision => Boolean(decision));
  await applyCampaignDecisions(bot, decisions);
}

function getCampaignDecision(campaign: TikTokSpentCampaign, rules: MaterialRule[]): CampaignDecision | undefined {
  const matchingActionRules = rules
    .filter(rule => rule.action === 'pause' || rule.action === 'enable')
    .filter(rule => campaignMatchesRule(campaign, rule));
  if (matchingActionRules.length === 0) return undefined;

  const desiredStatuses = new Set<TikTokCampaignOperationStatus>(
    matchingActionRules.map(rule => rule.action === 'pause' ? 'DISABLE' : 'ENABLE')
  );

  if (desiredStatuses.size !== 1) {
    console.warn(`[CampaignRules] conflicting rules for campaign=${campaign.campaign_id}; skipping write`);
    return undefined;
  }

  const operationStatus = [...desiredStatuses][0];
  const currentStatus = campaign.status === 'active'
    ? 'ENABLE'
    : campaign.status === 'paused'
      ? 'DISABLE'
      : undefined;
  if (!currentStatus || currentStatus === operationStatus) return undefined;
  return { campaign, operationStatus, rule: matchingActionRules[0] };
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.trunc(concurrency)));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index]);
    }
  }));
}

async function evaluateMaterialRules(
  bot: Telegraf,
  campaigns: TikTokSpentCampaign[],
  rules: MaterialRule[]
): Promise<void> {
  if (rules.length === 0) {
    console.warn('[MaterialRules] No enabled material rules found in SQLite');
    await sendMaterialPipelineWarning(bot, 'Không tìm thấy rule material đang bật trong Ruler Auto.');
    return;
  }

  const configuredConcurrency = await getRuntimeSettingNumber(
    'tiktok_concurrency',
    RUNTIME_SETTING_DEFAULTS.tiktokConcurrency
  );
  const concurrency = Math.min(6, Math.max(1, Math.trunc(configuredConcurrency)));
  const startedAt = Date.now();
  const failures: string[] = [];
  let matchedCampaigns = 0;
  let materialCount = 0;
  let unknownStatusCount = 0;
  const mktGroups = new Map<string, MaterialMktGroup>();

  await forEachWithConcurrency(campaigns, concurrency, async campaign => {
    const campaignRules = rules.filter(rule => matchesCampaignName(rule.nameContains, campaign.campaign_name));
    if (campaignRules.length === 0) return;
    matchedCampaigns += 1;

    try {
      const snapshot = await getCampaignMaterialSnapshot(
        campaign.advertiser_id,
        campaign.campaign_id,
        campaign.campaign_name
      );
      materialCount += snapshot.materials.length;
      unknownStatusCount += snapshot.materials.filter(item => item.status === 'UNKNOWN').length;
      if (snapshot.materials.length === 0) return;

      await sendMaterialNotifyRules(bot, campaign, snapshot.materials, campaignRules);
      const decisions = snapshot.materials
        .map(material => getMaterialDecision(material, campaignRules))
        .filter((decision): decision is MaterialDecision => Boolean(decision));
      const decisionLines = await collectMaterialDecisionLines(campaign, decisions);
      if (decisionLines.length === 0) return;
      const mkt = getMktGroupKey(campaign.mkt_code);
      const group = mktGroups.get(mkt) || { lines: [], plainLines: [] };
      group.lines.push(
        `<b>${escapeHtml(campaign.campaign_name)}</b> - <code>${escapeHtml(campaign.campaign_id)}</code>`,
        ...decisionLines.map(line => escapeHtml(line))
      );
      group.plainLines.push(`${campaign.campaign_name} - ${campaign.campaign_id}`, ...decisionLines);
      mktGroups.set(mkt, group);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${campaign.campaign_id}: ${message}`);
      console.error(`[MaterialRules] campaign=${campaign.campaign_id} failed:`, error);
    }
  });

  await sendGroupedMaterialActions(bot, mktGroups);

  if (failures.length > 0) {
    await sendMaterialPipelineWarning(
      bot,
      `${failures.length}/${matchedCampaigns} campaign material lỗi. Ví dụ: ${failures.slice(0, 2).join(' | ')}`
    );
  } else if (materialCount > 0 && unknownStatusCount === materialCount) {
    await sendMaterialPipelineWarning(
      bot,
      `TikTok trả về ${materialCount} material nhưng toàn bộ thiếu trạng thái ENABLE/DISABLE; bot không thể quyết định pause/active.`
    );
  }

  console.log(
    `[MaterialRules] scanned ${campaigns.length} campaigns, matched=${matchedCampaigns}, materials=${materialCount}, unknown_status=${unknownStatusCount}, failures=${failures.length}, concurrency=${concurrency} in ${Date.now() - startedAt}ms`
  );
}
/**
 * Level 1 architecture:
 * - Rule cấp 1 được đọc trực tiếp từ SQLite/dashboard;
 * - if that read fails, the last-known-good in-memory snapshot is used;
 * - chế độ 'material' (mặc định): campaign rules chỉ notify; ad rules bị bỏ qua;
 *   material rules được đánh giá theo chỉ số hôm nay và điều khiển ad_material_id;
 * - chế độ 'campaign' (bản đầu): campaign rules pause/enable tự tắt/bật campaign,
 *   material rules không chạy; low-balance monitoring remains active.
 */
export async function checkAndSendCampaignMaterialAlerts(bot: Telegraf): Promise<void> {
  try {
    await checkAndSendLowBalanceAlert(bot);
  } catch (error) {
    console.error('[MaterialRules] low-balance check failed:', error);
  }

  const ruleSnapshot = await getLevel1RuleSnapshot();
  const campaigns = await getTodaySpentCampaigns();
  const trackedAdvertiserIds = await getTrackedAdvertiserIdSet(
    campaigns.map(campaign => ({
      advertiserId: campaign.advertiser_id,
      advertiserName: campaign.advertiser_name,
    }))
  );
  const filteredCampaigns = campaigns.filter(campaign =>
    trackedAdvertiserIds.has(campaign.advertiser_id)
  );

  await evaluateCampaignNotifications(bot, filteredCampaigns, ruleSnapshot.campaignRules);

  const mode = await getAutoActionMode();
  if (mode === 'campaign') {
    await evaluateCampaignActions(bot, filteredCampaigns, ruleSnapshot.campaignRules);
    return;
  }

  await evaluateMaterialRules(bot, filteredCampaigns, ruleSnapshot.materialRules);
}
