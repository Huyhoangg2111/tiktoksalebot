import type { Telegraf } from 'telegraf';
import { getTrackedAdvertiserIdSet } from '../accounts/tracking.js';
import { db } from '../db/index.js';
import {
  type AlertAction,
  type AlertComparisonOperator,
  type AlertMetric,
} from '../google-sheets/api.js';
import { getTodaySpentCampaigns, setCampaignStatus, type TikTokCampaignOperationStatus, type TikTokSpentCampaign } from '../tiktok/api.js';
import { getRuntimeSettingNumber, RUNTIME_SETTING_DEFAULTS } from '../settings/runtime.js';
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

/** Quy tắc "Theo giờ" chạy theo múi giờ Việt Nam. */
export const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';

type TriggerKind = 'continuous' | 'scheduled';

interface MaterialRule {
  rowNumber: number;
  entity: 'campaign' | 'material';
  nameContains?: string;
  metric: AlertMetric;
  metricOperator: AlertComparisonOperator;
  metricThreshold: number;
  metricMinThreshold?: number;
  conversionsOperator: AlertComparisonOperator;
  conversionsThreshold: number;
  action: AlertAction;
  note?: string;
  triggerKind: TriggerKind;
  runTime?: string;
  period?: string;
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

interface DateRange {
  start: string;
  end: string;
  label: string;
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

function normalizeEntity(value: unknown): 'campaign' | 'material' | undefined {
  const normalized = normalizeText(value).replace(/[\s-]+/g, '_');
  if (['campaign', 'campaigns', 'camp'].includes(normalized)) return 'campaign';
  if (['material', 'materials'].includes(normalized)) return 'material';
  return undefined;
}

function normalizeTriggerKind(value: unknown): TriggerKind {
  const normalized = normalizeText(value).replace(/[\s-]+/g, '_');
  return ['scheduled', 'schedule', 'theo_gio', 'theo_lich'].includes(normalized) ? 'scheduled' : 'continuous';
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

/** Cảnh báo rule hỏng — mỗi ruột chỉ warn một lần để không spam log mỗi phút. */
const warnedInvalidRuleIds = new Set<string>();
function warnInvalidRuleOnce(ruleId: string, detail: string): void {
  const key = `${ruleId}:${detail}`;
  if (warnedInvalidRuleIds.has(key)) return;
  warnedInvalidRuleIds.add(key);
  console.warn(`[MaterialRules] rule ${ruleId} bị bỏ qua: ${detail}`);
}

const RULE_ROW_COLUMNS =
  'id,entity,trigger_kind,run_time,period,name_contains,metric,metric_operator,metric_threshold,' +
  'metric_min_threshold,conversions_operator,conversions_threshold,action,is_active,note';

/** Map + validate một dòng alert_action_rules thành MaterialRule. Trả undefined nếu dòng hỏng. */
function mapRuleRow(row: Record<string, unknown>): MaterialRule | undefined {
  const id = Number(row.id) || 0;
  const label = `#${id}`;
  const entity = normalizeEntity(row.entity);
  const metric = normalizeMetric(row.metric);
  const metricOperator = normalizeOperator(row.metric_operator);
  const conversionsOperator = normalizeOperator(row.conversions_operator);
  const action = normalizeAction(row.action);
  if (!entity) {
    warnInvalidRuleOnce(label, 'entity không hợp lệ (chỉ nhận campaign/material)');
    return undefined;
  }
  if (!metric || !metricOperator || !conversionsOperator || !action) {
    warnInvalidRuleOnce(label, 'thiếu metric/toán tử/hành động');
    return undefined;
  }
  if (conversionsOperator === 'between') {
    // Conversions chỉ có ngưỡng đơn — khoảng không hỗ trợ.
    warnInvalidRuleOnce(label, 'Điều kiện lượt chuyển đổi không hỗ trợ "trong khoảng"');
    return undefined;
  }
  if (Number(row.is_active ?? 1) === 0) return undefined;

  const threshold = parseThreshold(row.metric_threshold, metricOperator);
  const conversionsThreshold = parseNumber(row.conversions_threshold);
  if (!Number.isFinite(threshold.threshold) || !Number.isFinite(conversionsThreshold)) {
    warnInvalidRuleOnce(label, 'mức chỉ số hoặc lượt chuyển đổi không phải số');
    return undefined;
  }
  if (metricOperator === 'between' && !Number.isFinite(threshold.min) && row.metric_min_threshold == null) {
    warnInvalidRuleOnce(label, '"trong khoảng" thiếu Mức thấp nhất');
    return undefined;
  }

  const triggerKind = normalizeTriggerKind(row.trigger_kind);
  let runTime: string | undefined;
  let period: string | undefined;
  if (triggerKind === 'scheduled') {
    const rawRunTime = String(row.run_time ?? '').trim();
    if (/^\d{2}:\d{2}$/.test(rawRunTime)) {
      runTime = rawRunTime;
    } else {
      warnInvalidRuleOnce(label, 'kiểu "Theo giờ" nhưng Giờ không đúng định dạng HH:mm');
      return undefined;
    }
    period = String(row.period ?? '').trim() || 'today';
  }

  return {
    rowNumber: id,
    entity,
    nameContains: String(row.name_contains ?? '').trim() || undefined,
    metric,
    metricOperator,
    metricThreshold: threshold.threshold,
    metricMinThreshold: threshold.min ?? (row.metric_min_threshold == null ? undefined : Number(row.metric_min_threshold)),
    conversionsOperator,
    conversionsThreshold,
    action,
    note: String(row.note ?? '').trim() || undefined,
    triggerKind,
    runTime,
    period,
  } satisfies MaterialRule;
}

async function readDashboardRules(
  entity: 'campaign' | 'material',
  triggerKind?: TriggerKind
): Promise<MaterialRule[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${RULE_ROW_COLUMNS} FROM alert_action_rules WHERE entity=? ORDER BY id`,
    [entity]
  );
  return rows
    .map(mapRuleRow)
    .filter((rule): rule is MaterialRule => Boolean(rule))
    .filter(rule => rule.entity === entity)
    .filter(rule => !triggerKind || rule.triggerKind === triggerKind);
}

/** Quy tắc "Theo giờ" đang bật: trigger_kind='scheduled' + có run_time HH:mm. */
async function readScheduledRules(): Promise<MaterialRule[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${RULE_ROW_COLUMNS} FROM alert_action_rules WHERE trigger_kind='scheduled' AND is_active<>0 AND run_time IS NOT NULL ORDER BY run_time, id`
  );
  return rows
    .map(mapRuleRow)
    .filter((rule): rule is MaterialRule => Boolean(rule));
}

interface PeriodParts {
  dateKey: string;
  timeKey: string;
}

export function vnNow(): PeriodParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts();
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || '';
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, timeKey: `${get('hour')}:${get('minute')}` };
}

function shiftDate(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Khoảng dữ liệu của quy tắc: today/yesterday/month_to_date/last_N_days/YYYY-MM-DD..YYYY-MM-DD. */
export function resolvePeriodValue(value: string | undefined, today: string): DateRange | undefined {
  const normalized = String(value || 'today').trim().toLowerCase();
  if (['today', 'hom_nay', 'hôm_nay'].includes(normalized)) {
    return { start: today, end: today, label: today };
  }
  if (['yesterday', 'hom_qua', 'hôm_qua'].includes(normalized)) {
    const yesterday = shiftDate(today, -1);
    return { start: yesterday, end: yesterday, label: yesterday };
  }
  if (['month_to_date', 'mtd', 'thang_nay'].includes(normalized)) {
    return { start: `${today.slice(0, 8)}01`, end: today, label: `${today.slice(0, 8)}01..${today}` };
  }
  const lastMatch = normalized.match(/^last_(\d{1,3})_days$/);
  if (lastMatch) {
    const days = Math.max(1, Math.min(90, Number(lastMatch[1])));
    return { start: shiftDate(today, -(days - 1)), end: today, label: `${shiftDate(today, -(days - 1))}..${today}` };
  }
  const fixedMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (fixedMatch && fixedMatch[1] <= fixedMatch[2]) {
    return { start: fixedMatch[1], end: fixedMatch[2], label: normalized };
  }
  return undefined;
}

interface Level1RuleSnapshotOptions {
  triggerKind?: TriggerKind;
}

async function getLevel1RuleSnapshot(options: Level1RuleSnapshotOptions = {}): Promise<Level1RuleSnapshot> {
  const [campaignRules, materialRules] = await Promise.all([
    readDashboardRules('campaign', options.triggerKind),
    readDashboardRules('material', options.triggerKind),
  ]);
  return { campaignRules, materialRules, loadedAtMs: Date.now() };
}

async function getTikTokRuleConcurrency(): Promise<number> {
  const configuredConcurrency = await getRuntimeSettingNumber(
    'tiktok_concurrency',
    RUNTIME_SETTING_DEFAULTS.tiktokConcurrency
  );
  return Math.min(6, Math.max(1, Math.trunc(configuredConcurrency)));
}

async function getTrackedCampaigns(startDate?: string, endDate?: string): Promise<TikTokSpentCampaign[]> {
  const campaigns = await getTodaySpentCampaigns(startDate, endDate, {
    concurrency: await getTikTokRuleConcurrency(),
  });
  const trackedAdvertiserIds = await getTrackedAdvertiserIdSet(
    campaigns.map(campaign => ({
      advertiserId: campaign.advertiser_id,
      advertiserName: campaign.advertiser_name,
    }))
  );
  return campaigns.filter(campaign => trackedAdvertiserIds.has(campaign.advertiser_id));
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
    ['⚠️ <b>Quy tắc material đang gặp lỗi</b>', escapeHtml(detail), 'Bot sẽ tự thử lại ở lượt kế tiếp. Nếu lỗi lặp lại liên tục, hãy kiểm tra log container và token TikTok.'].join('\n'),
    { parse_mode: 'HTML' }
  );
  await saveAlertHistory('material_pipeline_warning', detail, 'high');
  await markNotified(key);
}

function campaignSubjectKey(campaign: TikTokSpentCampaign, rule: MaterialRule): string {
  return `campaign:${campaign.advertiser_id}:${campaign.campaign_id}:${rule.metric}:${rule.metricOperator}:${rule.metricThreshold}:${rule.metricMinThreshold ?? ''}:${rule.nameContains ?? ''}:${rule.conversionsOperator}:${rule.conversionsThreshold}:${rule.action}`;
}

/** Khóa cooldown theo NỘI DUNG quy tắc: sửa/tái lưu rule trên dashboard không reset cooldown. */
function materialRuleContentKey(rule: MaterialRule): string {
  return `${rule.nameContains || ''}|${rule.metric}|${rule.metricOperator}|${rule.metricThreshold}|${rule.metricMinThreshold || ''}|${rule.action}|${rule.conversionsOperator}|${rule.conversionsThreshold}`;
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
  const keyboard = options?.buttons?.length ? { inline_keyboard: chunkInlineButtons(options.buttons, 3) } : undefined;
  for (const chunk of chunks) {
    await bot.telegram.sendMessage(chatId, chunk, {
      parse_mode: 'HTML',
      // Buttons gắn ở MỌI chunk: nếu chỉ gắn chunk cuối, các chunk trước bị
      // rewrite/đọc riêng và người dùng không thấy nút từ đầu thông báo.
      ...(keyboard ? { reply_markup: keyboard } : {}),
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
      // Khóa theo nội dung quy tắc (không theo id dòng): lưu lại rule trên dashboard không reset cooldown.
      const contentKey = materialRuleContentKey(rule);
      const key = `material-notify:${material.advertiserId}:${material.adMaterialId}:${contentKey}`;
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

  const lines: string[] = ['🤖 <b>Campaign Rule Auto</b>'];
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

interface EvaluateMaterialRulesOptions {
  /** Khoảng dữ liệu cho snapshot material; bỏ trống = hôm nay (kiểu "Liên tục"). */
  dateRange?: { start: string; end: string };
}

async function evaluateMaterialRules(
  bot: Telegraf,
  campaigns: TikTokSpentCampaign[],
  rules: MaterialRule[],
  options: EvaluateMaterialRulesOptions = {}
): Promise<void> {
  if (rules.length === 0) {
    console.log('[MaterialRules] no enabled material rules, skipping material evaluation');
    return;
  }

  const concurrency = await getTikTokRuleConcurrency();
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
        campaign.campaign_name,
        options.dateRange?.start,
        options.dateRange?.end
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
 * Level 1 architecture (bản hợp nhất):
 * - Toàn bộ quy tắc đọc trực tiếp từ bảng alert_action_rules, một engine duy nhất;
 * - Mỗi quy tắc tự chọn entity (campaign/material) và kiểu chạy:
 *   "Liên tục" (continuous) — đánh giá mỗi tick của lịch cấp 1 theo dữ liệu hôm nay;
 *   "Theo giờ" (scheduled) — chỉ chạy trong checkAndRunScheduledRules() theo run_time;
 * - Không còn setting auto_action_mode toàn cục; quota/low-balance vẫn chạy trước.
 */
export async function checkAndSendCampaignMaterialAlerts(bot: Telegraf): Promise<void> {
  try {
    await checkAndSendLowBalanceAlert(bot);
  } catch (error) {
    console.error('[MaterialRules] low-balance check failed:', error);
  }

  const ruleSnapshot = await getLevel1RuleSnapshot({ triggerKind: 'continuous' });
  const filteredCampaigns = await getTrackedCampaigns();

  await evaluateCampaignNotifications(bot, filteredCampaigns, ruleSnapshot.campaignRules);
  await evaluateCampaignActions(bot, filteredCampaigns, ruleSnapshot.campaignRules);
  await evaluateMaterialRules(bot, filteredCampaigns, ruleSnapshot.materialRules);
}

// ---------------------------------------------------------------------------
// Quy tắc theo lịch (scheduled): chạy theo run_time từng quy tắc, múi giờ Việt Nam.
// ---------------------------------------------------------------------------

let rulerRunning = false;
/** Đang có lượt áp quy tắc (theo lịch hoặc thủ công) chạy → lượt khác phải chờ. */
export function isMaterialRulerRunning(): boolean {
  return rulerRunning;
}

async function ensureRulerRunsTable(): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS material_daily_ruler_runs(
    rule_id TEXT NOT NULL,date_key TEXT NOT NULL,timezone TEXT NOT NULL,run_time TEXT NOT NULL,
    matched_campaigns INTEGER DEFAULT 0,changed_materials INTEGER DEFAULT 0,completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(rule_id,date_key))`);
}

async function isRulerRunCompleted(dateKey: string, markerId: string): Promise<boolean> {
  return Boolean(await db.get('SELECT 1 FROM material_daily_ruler_runs WHERE rule_id=? AND date_key=?', [markerId, dateKey]));
}

async function markRulerRun(dateKey: string, markerId: string, runTime: string, matchedCampaigns: number, changed: number): Promise<void> {
  await db.run(`INSERT INTO material_daily_ruler_runs
    (rule_id,date_key,timezone,run_time,matched_campaigns,changed_materials) VALUES(?,?,?,?,?,?)
    ON CONFLICT(rule_id,date_key) DO UPDATE SET matched_campaigns=excluded.matched_campaigns,changed_materials=excluded.changed_materials,completed_at=CURRENT_TIMESTAMP`,
    [markerId, dateKey, VN_TIMEZONE, runTime, matchedCampaigns, changed]);
}

interface ScheduledRulesSummary {
  manual: boolean;
  runTime?: string;
  ruleCount: number;
  campaignRuleCount: number;
  notifyRuleCount: number;
  materialRuleCount: number;
  evaluatedCampaigns: number;
  periodLabels: string[];
  failures: string[];
}

function formatScheduledRulesSummary(summary: ScheduledRulesSummary): string {
  const failLine = summary.failures.length
    ? `Lỗi: <b>${summary.failures.length}</b> (ví dụ <code>${escapeHtml(summary.failures[0].slice(0, 160))}</code>)`
    : '';
  return [
    `<b>${summary.manual ? '▶ Quy tắc theo lịch — chạy thủ công' : '⏳ Quy tắc theo lịch — hoàn tất'}</b>`,
    summary.runTime ? `Giờ chạy: <code>${escapeHtml(summary.runTime)}</code> · giờ Việt Nam` : 'Chạy thủ công, không chờ giờ',
    `Quy tắc: <b>${summary.ruleCount}</b> (campaign ${summary.campaignRuleCount} · material ${summary.materialRuleCount}${summary.notifyRuleCount ? ` · notify ${summary.notifyRuleCount}` : ''})`,
    `Campaign đã xét: <b>${summary.evaluatedCampaigns}</b>`,
    `Khoảng dữ liệu: <code>${escapeHtml([...new Set(summary.periodLabels)].join(', '))}</code>`,
    failLine,
    'Báo cáo chi tiết (thông báo/tắt/bật) đã được gửi ở các tin nhắn phía trên.',
  ].filter(Boolean).join('\n');
}

async function sendRulerStartMessage(bot: Telegraf, summary: ScheduledRulesSummary): Promise<void> {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;
  await sendChunkedMessage(bot, adminChatId, [
    `<b>${summary.manual ? '⏳ Bắt đầu Quy tắc theo lịch (thủ công)' : '⏳ Bắt đầu Quy tắc theo lịch'}</b>`,
    summary.runTime ? `Giờ cài đặt: <code>${escapeHtml(summary.runTime)}</code>` : 'Chạy thủ công',
    `Số quy tắc: <b>${summary.ruleCount}</b>`,
    'Kết quả sẽ được gửi ngay sau khi chạy xong.',
  ]);
}

/**
 * Chạy MỘT nhóm quy tắc theo lịch (cùng run_time).
 * Mỗi quy tắc dùng khoảng dữ liệu (period) của chính nó: gom nhóm theo period trong nhóm
 * để chỉ cần lấy danh sách campaign theo period một lần.
 */
async function runScheduledRuleGroup(
  bot: Telegraf,
  rules: MaterialRule[],
  options: { manual: boolean; runTime?: string }
): Promise<ScheduledRulesSummary> {
  const summary: ScheduledRulesSummary = {
    manual: options.manual,
    runTime: options.runTime,
    ruleCount: rules.length,
    campaignRuleCount: rules.filter(rule => rule.entity === 'campaign').length,
    notifyRuleCount: rules.filter(rule => rule.action === 'notify').length,
    materialRuleCount: rules.filter(rule => rule.entity === 'material').length,
    evaluatedCampaigns: 0,
    periodLabels: [],
    failures: [],
  };

  if (rulerRunning) {
    throw new Error('Quy tắc đang có một lượt khác chạy, vui lòng chờ.');
  }
  rulerRunning = true;
  try {
    await sendRulerStartMessage(bot, summary);
    const today = vnNow().dateKey;
    const byPeriod = new Map<string, MaterialRule[]>();
    for (const rule of rules) {
      const periodKey = (rule.period || 'today').trim().toLowerCase() || 'today';
      const list = byPeriod.get(periodKey) || [];
      list.push(rule);
      byPeriod.set(periodKey, list);
    }

    for (const [periodValue, periodRules] of byPeriod) {
      const range = resolvePeriodValue(periodValue, today);
      if (!range) {
        summary.failures.push(`Khoảng dữ liệu không hợp lệ: ${periodValue}`);
        console.warn(`[ScheduledRules] invalid period "${periodValue}", skipping its rules`);
        continue;
      }
      summary.periodLabels.push(range.label);

      const campaigns = await getTrackedCampaigns(range.start, range.end);
      summary.evaluatedCampaigns += campaigns.length;
      console.log(
        `[ScheduledRules] run_time=${options.runTime || 'manual'} period=${periodValue} (${range.label}) campaigns=${campaigns.length}`
      );

      const campaignRules = periodRules.filter(rule => rule.entity === 'campaign');
      const materialRules = periodRules.filter(rule => rule.entity === 'material');

      // Campaign: notify + tắt/bật tự động (rule nhận biết action bên trong).
      await evaluateCampaignNotifications(bot, campaigns, campaignRules);
      await evaluateCampaignActions(bot, campaigns, campaignRules);

      // Material: notify + tắt/bật theo snapshot trong khoảng dữ liệu.
      await evaluateMaterialRules(bot, campaigns, materialRules, {
        dateRange: { start: range.start, end: range.end },
      });
    }
  } finally {
    rulerRunning = false;
  }

  await sendChunkedMessageIfAdmin(bot, formatScheduledRulesSummary(summary));
  return summary;
}

async function sendChunkedMessageIfAdmin(bot: Telegraf, text: string): Promise<void> {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return;
  await sendChunkedMessage(bot, adminChatId, [text]);
}

/**
 * Lịch cấp 1 gọi hàm này mỗi tick: với mỗi nhóm run_time đã đến giờ trong ngày
 * mà chưa được ghi nhận (marker rule_id='rt:<HH:mm>') → chạy đúng một lần.
 */
export async function checkAndRunScheduledRules(bot: Telegraf): Promise<void> {
  await ensureRulerRunsTable();
  const rules = await readScheduledRules();
  if (rules.length === 0) return;

  const now = vnNow();
  const groups = new Map<string, MaterialRule[]>();
  for (const rule of rules) {
    const runTime = rule.runTime;
    if (!runTime) continue;
    const list = groups.get(runTime) || [];
    list.push(rule);
    groups.set(runTime, list);
  }

  for (const [runTime, groupRules] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (now.timeKey < runTime) continue;
    const markerId = `rt:${runTime}`;
    if (await isRulerRunCompleted(now.dateKey, markerId)) continue;

    try {
      const summary = await runScheduledRuleGroup(bot, groupRules, { manual: false, runTime });
      // Lượt nào cũng được ghi nhận (kể cả có lỗi nhỏ): tránh scheduler chạy lại và gửi tin suốt ngày.
      await markRulerRun(now.dateKey, markerId, runTime, summary.evaluatedCampaigns, summary.periodLabels.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ScheduledRules] run_time=${runTime} failed:`, error);
      const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
      if (adminChatId) {
        await bot.telegram.sendMessage(
          adminChatId,
          `❌ <b>Quy tắc theo lịch (${escapeHtml(runTime)}) thất bại</b>\n<code>${escapeHtml(message.slice(0, 1000))}</code>`,
          { parse_mode: 'HTML' }
        ).catch(sendError => console.error('[ScheduledRules] cannot report failure:', sendError));
      }
      // Vẫn đánh dấu là đã chạy để không spam thử lại; lỗi đã báo Telegram cho admin.
      await markRulerRun(now.dateKey, markerId, runTime, 0, 0);
    }
  }
}

/** Chạy manual (lệnh /materialruler): toàn bộ quy tắc "Theo giờ" chạy ngay, bỏ qua marker. */
export async function runMaterialRulerNow(bot: Telegraf): Promise<ScheduledRulesSummary[]> {
  const rules = await readScheduledRules();
  if (rules.length === 0) {
    await sendChunkedMessageIfAdmin(bot,
      'ℹ️ Chưa có quy tắc "Theo giờ" nào đang bật. Hãy tạo quy tắc trong tab <b>Quy tắc</b> của dashboard và chọn Chạy = "Theo giờ".');
    return [];
  }

  const groups = new Map<string, MaterialRule[]>();
  for (const rule of rules) {
    const runTime = rule.runTime || '00:00';
    const list = groups.get(runTime) || [];
    list.push(rule);
    groups.set(runTime, list);
  }

  const summaries: ScheduledRulesSummary[] = [];
  for (const [runTime, groupRules] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    summaries.push(await runScheduledRuleGroup(bot, groupRules, { manual: true, runTime }));
  }
  return summaries;
}
