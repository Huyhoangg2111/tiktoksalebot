import { RELAXED, type RecreatePlan } from './clone-by-recreate.js';

type Obj = Record<string, unknown>;

export interface AdGroupSummary {
  name: string;
  operation_status: string;
  promotion_type: string;
  optimization_location: string;
  optimization_goal: string;
  bid_strategy: string;
  /** Target cost per result (conversion_bid_price, or bid_price for CLICK) when cost cap. */
  target_cost?: number | undefined;
  billing_event?: string | undefined;
  /** Ad group budget (only when CBO is off). */
  budget_mode?: string | undefined;
  budget?: number | undefined;
  goal_based_budget_increase: boolean;
  schedule: string;
  ads: number;
  creatives: number;
  welcome_message_ids: string[];
}

export interface PlanSummary {
  source_campaign_id: string;
  source_campaign_name?: string | undefined;
  campaign_name: string;
  objective_type: string;
  operation_status: string;
  budget_strategy: string;
  budget_mode?: string | undefined;
  budget?: number | undefined;
  goal_based_budget_increase: boolean;
  source_current_budget?: number | undefined;
  adgroups: AdGroupSummary[];
  totals: { adgroups: number; ads: number; creatives: number };
  /** Dropped field paths with ids normalised (adgroup[*]/ad[*]) and counted. */
  dropped: { path: string; count: number }[];
  dropped_total: number;
  /** Tolerated findings that used to block (prefixed "[relaxed] "). */
  relaxed: string[];
  /** Other warnings (adjustments, dropped defaults). */
  warnings: string[];
  /** Real blockers (scope violations + would-fail problems). Non-empty => a real run is refused. */
  blockers: string[];
}

const LOCATION: Record<string, string> = {
  WEBSITE: 'Website',
  LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE: 'TikTok Direct Messages',
};
const GOAL: Record<string, string> = { CONVERSATION: 'Conversations (CONVERSATION)', CLICK: 'Click (CLICK)', CONVERT: 'Conversions (CONVERT)' };

/** Pure: compact, human-oriented view of what a recreate plan would send. */
export function summarizePlan(plan: RecreatePlan): PlanSummary {
  const c = plan.payloads.campaign as Obj;
  const cbo = c.budget_optimize_on !== false;
  const adgroups: AdGroupSummary[] = plan.payloads.adgroups.map(({ adgroup: g, ads }) => {
    const custom = g.bid_type === 'BID_TYPE_CUSTOM';
    const target = (g.conversion_bid_price ?? g.bid_price) as number | undefined;
    const creatives = ads.reduce((n, a) => n + (Array.isArray(a.creative_list) ? a.creative_list.length : 0), 0);
    const ids = ads.flatMap((a) => (Array.isArray(a.auto_message_list) ? (a.auto_message_list as Obj[]).map((m) => String(m.auto_message_id)) : []));
    const pt = String(g.promotion_type ?? '?');
    return {
      name: String(g.adgroup_name ?? ''),
      operation_status: String(g.operation_status ?? '?'),
      promotion_type: pt,
      optimization_location: LOCATION[pt] ?? pt,
      optimization_goal: GOAL[String(g.optimization_goal)] ?? String(g.optimization_goal ?? '?'),
      bid_strategy: custom ? 'Cost cap (BID_TYPE_CUSTOM)' : g.bid_type === 'BID_TYPE_NO_BID' ? 'Maximum delivery (BID_TYPE_NO_BID)' : String(g.bid_type ?? '?'),
      target_cost: custom ? target : undefined,
      billing_event: g.billing_event as string | undefined,
      budget_mode: g.budget_mode as string | undefined,
      budget: g.budget as number | undefined,
      goal_based_budget_increase: g.budget_auto_adjust_strategy === 'AUTO_BUDGET_INCREASE',
      schedule: `${String(g.schedule_type ?? '?')} from ${String(g.schedule_start_time ?? '?')}${g.schedule_end_time ? ` to ${String(g.schedule_end_time)}` : ''}`,
      ads: ads.length,
      creatives,
      welcome_message_ids: [...new Set(ids)],
    };
  });

  const counts = new Map<string, number>();
  for (const d of plan.dropped) {
    const k = d.replace(/\[\d+\]/g, '[*]');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return {
    source_campaign_id: plan.source_campaign_id,
    source_campaign_name: plan.source.campaign_name,
    campaign_name: String(c.campaign_name ?? ''),
    objective_type: String(c.objective_type ?? '?'),
    operation_status: String(c.operation_status ?? '?'),
    budget_strategy: cbo ? 'Campaign budget (CBO)' : 'Ad group budget',
    budget_mode: c.budget_mode as string | undefined,
    budget: c.budget as number | undefined,
    goal_based_budget_increase: c.budget_auto_adjust_strategy === 'AUTO_BUDGET_INCREASE',
    source_current_budget: plan.source.current_budget,
    adgroups,
    totals: {
      adgroups: adgroups.length,
      ads: adgroups.reduce((n, g) => n + g.ads, 0),
      creatives: adgroups.reduce((n, g) => n + g.creatives, 0),
    },
    dropped: [...counts.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
    dropped_total: plan.dropped.length,
    relaxed: plan.warnings.filter((w) => w.startsWith(RELAXED)).map((w) => w.slice(RELAXED.length)),
    warnings: plan.warnings.filter((w) => !w.startsWith(RELAXED)),
    blockers: plan.errors,
  };
}

function statusLabel(status: string): string {
  if (status === 'DISABLE') return 'Tắt';
  if (status === 'ENABLE') return 'Đang bật';
  return 'Không rõ';
}

function objectiveLabel(objective: string): string {
  if (objective === 'LEAD_GENERATION') return 'Tìm khách hàng tiềm năng';
  if (objective === 'WEB_CONVERSIONS') return 'Chuyển đổi trên website';
  return objective || 'Không rõ';
}

function locationLabel(promotionType: string): string {
  if (promotionType === 'LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE') return 'Tin nhắn TikTok';
  if (promotionType === 'WEBSITE') return 'Website';
  return 'Đích khác';
}

function goalLabel(goal: string): string {
  if (goal.includes('CONVERSATION')) return 'Hội thoại, khách nhắn tin';
  if (goal.includes('CLICK')) return 'Lượt nhấp';
  if (goal.includes('CONVERT')) return 'Chuyển đổi';
  if (goal.includes('VALUE')) return 'Giá trị đơn hàng';
  return 'Theo campaign gốc';
}

function budgetLabel(summary: PlanSummary): string {
  const shared = summary.budget_strategy.includes('Campaign') ? 'dùng chung cả campaign' : 'đặt trên từng nhóm quảng cáo';
  if (summary.budget_mode === 'BUDGET_MODE_INFINITE') return `Không giới hạn, ${shared}`;
  const amount = summary.budget !== undefined ? String(summary.budget) : 'giữ như campaign gốc';
  const period = summary.budget_mode === 'BUDGET_MODE_TOTAL' ? 'trọn đời' : 'mỗi ngày';
  const increase = summary.goal_based_budget_increase ? '. Có tăng theo mục tiêu, số này là mức ban đầu' : '';
  return `${amount} ${period}, ${shared}${increase}`;
}

function bidLabel(group: AdGroupSummary): string {
  if (group.bid_strategy.includes('NO_BID')) return 'Để TikTok tự đặt giá';
  if (group.target_cost !== undefined) return `${group.target_cost} mỗi kết quả`;
  if (group.bid_strategy.includes('CUSTOM')) return 'Có đặt giá, chưa đọc được số tiền';
  return 'Theo campaign gốc';
}

function vnDate(isoDay: string): string {
  const [year, month, day] = isoDay.split('-');
  if (!year || !month || !day) return isoDay;
  return `${day}/${month}/${year}`;
}

function scheduleLabel(raw: string): string {
  const from = raw.match(/from (\d{4}-\d{2}-\d{2})/);
  const to = raw.match(/to (\d{4}-\d{2}-\d{2})/);
  const start = from ? vnDate(from[1]) : '';
  const endYear = to ? Number(to[1].slice(0, 4)) : 0;
  const farEnd = endYear >= new Date().getUTCFullYear() + 5;
  if (raw.includes('SCHEDULE_FROM_NOW')) {
    if (to && !farEnd) return `Chạy từ ${start} đến ${vnDate(to[1])}`;
    return start ? `Chạy liên tục từ ${start}` : 'Chạy liên tục';
  }
  if (from && to) return `Chạy từ ${vnDate(from[1])} đến ${vnDate(to[1])}`;
  return start ? `Bắt đầu ${start}` : 'Theo lịch campaign gốc';
}

function humanBlocker(raw: string): string {
  if (/[àáạảãâăèéêìíòóôơùúưỳýđ]/i.test(raw)) {
    return raw.replace(/^(campaign|adgroup\[[^\]]+\]|ad\[[^\]]+\])\s*:\s*/i, '');
  }
  if (/catalog/i.test(raw)) return 'Nhóm quảng cáo đang dùng catalog. Bot không sao chép catalog.';
  if (/search ads|is_search_campaign/i.test(raw)) return 'Đây là chiến dịch Search Ads. Bot không sao chép loại này.';
  if (/objective_type/i.test(raw)) return 'Mục tiêu campaign không thuộc loại bot đang hỗ trợ.';
  if (/promotion_type|optimization location|instant form|phone call|multiple destinations|messaging_app/i.test(raw)) {
    return 'Đích của nhóm quảng cáo không phải tin nhắn TikTok hoặc website.';
  }
  if (/auto_message|welcome message/i.test(raw)) return 'Thiếu tin nhắn chào. Quảng cáo tin nhắn TikTok cần tin nhắn chào.';
  if (/RESUME:/i.test(raw)) return 'Không tiếp tục được bản dở. Bản đã tạo phải đang tắt và không phải campaign gốc.';
  return 'Có phần bot chưa hỗ trợ sao chép. Kiểm tra lại campaign trên TikTok.';
}

function operatorNotes(summary: PlanSummary): string[] {
  const notes: string[] = [];
  const blob = [...summary.warnings, ...summary.relaxed].join('\n');
  if (/Automatically added creatives/i.test(blob)) {
    notes.push('Video do TikTok tự thêm (bài của creator, ảnh remix) không được sao chép.');
  }
  if (/targeting_spec/i.test(blob)) {
    notes.push('Targeting tự động: bot gửi vị trí, độ tuổi, giới tính và nhóm đối tượng. TikTok tự điền phần còn lại.');
  }
  if (/attribution settings not sent/i.test(blob)) {
    notes.push('Không gửi lại cửa sổ ghi nhận chuyển đổi. TikTok dùng mặc định.');
  }
  return notes;
}

/** Short Vietnamese preview for Telegram and the dashboard. Field paths stay out of this text. */
export function formatOperatorSummary(plan: RecreatePlan, opts: { willEnable?: boolean } = {}): string {
  const summary = summarizePlan(plan);
  const shownStatus = (status: string) => opts.willEnable ? 'Đang bật' : statusLabel(status);
  const lines = [
    `Campaign gốc: ${summary.source_campaign_name || summary.source_campaign_id}`,
    `ID: ${summary.source_campaign_id}`,
    '',
    `Bản sao: ${summary.campaign_name}`,
    `Trạng thái: ${shownStatus(summary.operation_status)}`,
    `Mục tiêu: ${objectiveLabel(summary.objective_type)}`,
    `Ngân sách: ${budgetLabel(summary)}`,
    `Sao chép: ${summary.totals.adgroups} nhóm quảng cáo, ${summary.totals.ads} quảng cáo, ${summary.totals.creatives} video/ảnh`,
  ];

  if (plan.resume) {
    const resume = plan.resume;
    lines.push('', `Tiếp tục bản đã tạo: ${resume.campaign_id}${resume.campaign_name ? ` (${resume.campaign_name})` : ''}`);
    lines.push(`Phần còn thiếu: ${resume.to_create.adgroups} nhóm quảng cáo, ${resume.to_create.ads} quảng cáo`);
  }

  summary.adgroups.forEach((group, index) => {
    lines.push(
      '',
      `Nhóm ${index + 1}: ${group.name || 'Không tên'}`,
      `Trạng thái: ${shownStatus(group.operation_status)}`,
      `Đích: ${locationLabel(group.promotion_type)}`,
      `Tối ưu: ${goalLabel(group.optimization_goal)}`,
      `Giá thầu: ${bidLabel(group)}`,
      `Lịch: ${scheduleLabel(group.schedule)}`,
      `Quảng cáo: ${group.ads}, gồm ${group.creatives} video/ảnh${group.welcome_message_ids.length ? ', có tin nhắn chào' : ''}`,
    );
  });

  const notes = operatorNotes(summary);
  if (notes.length) {
    lines.push('', 'Lưu ý');
    for (const note of notes) lines.push(`• ${note}`);
  }

  const blockers = [...new Set(summary.blockers.map(humanBlocker))];
  if (blockers.length) {
    lines.push('', 'Không tạo được');
    for (const blocker of blockers) lines.push(`• ${blocker}`);
  } else if (opts.willEnable) {
    lines.push('', 'Sau khi tạo xong, campaign, nhóm quảng cáo và quảng cáo đều được bật.');
  }

  return lines.join('\n');
}

/** Plain-text rendering of summarizePlan (no secrets are ever present in a plan). */
export function formatPlanSummary(plan: RecreatePlan, opts: { maxDropped?: number; fromScratch?: boolean } = {}): string {
  const s = summarizePlan(plan);
  const maxDropped = opts.maxDropped ?? 30;
  const L: string[] = [];
  L.push(opts.fromScratch ? 'Source campaign : (none - created from scratch from a JSON config)' : `Source campaign : ${s.source_campaign_id}${s.source_campaign_name ? ` "${s.source_campaign_name}"` : ''}`);
  L.push(`New campaign    : "${s.campaign_name}"  status=${s.operation_status}`);
  L.push(`Objective       : ${s.objective_type}`);
  L.push(
    `Budget          : ${s.budget_strategy}${s.budget_mode ? `, ${s.budget_mode}` : ''}${s.budget !== undefined ? `, budget=${s.budget}` : ''}` +
      `${s.goal_based_budget_increase ? ' (goal-based increase ON; this is the INITIAL budget' + (s.source_current_budget !== undefined ? `, source current_budget=${s.source_current_budget}` : '') + ')' : ''}`,
  );
  L.push(`Totals          : ${s.totals.adgroups} ad group(s), ${s.totals.ads} ad(s), ${s.totals.creatives} creative(s)`);
  if (plan.resume) {
    const r = plan.resume;
    L.push(`RESUME into    : campaign ${r.campaign_id}${r.campaign_name ? ` "${r.campaign_name}"` : ''} (campaign is NOT created again)`);
    r.adgroups.forEach((g, i) => {
      L.push(`  ad group #${i + 1} "${g.planned_name}": ${g.existing_id ? `EXISTS (${g.existing_id}), skipped` : 'MISSING, will be created'}`);
      g.ads.forEach((a) => L.push(`    ad "${a.planned_name}": ${a.existing_id ? `EXISTS (${a.existing_id}), skipped` : 'MISSING, will be created'}`));
    });
    L.push(`  => will create ${r.to_create.adgroups} ad group(s) and ${r.to_create.ads} ad(s)`);
  }
  s.adgroups.forEach((g, i) => {
    L.push(`Ad group #${i + 1}     : "${g.name}"  status=${g.operation_status}`);
    L.push(`  goal          : ${g.optimization_goal}`);
    L.push(`  location      : ${g.optimization_location} [${g.promotion_type}]`);
    L.push(`  bid           : ${g.bid_strategy}${g.target_cost !== undefined ? `, target cost per result=${g.target_cost}` : ''}${g.billing_event ? `, billing=${g.billing_event}` : ''}`);
    if (g.budget !== undefined || g.budget_mode) L.push(`  budget        : ${g.budget_mode ?? ''}${g.budget !== undefined ? ` ${g.budget}` : ''}${g.goal_based_budget_increase ? ' (goal-based increase ON, this is the INITIAL budget)' : ''}`);
    L.push(`  schedule      : ${g.schedule}`);
    L.push(`  ads/creatives : ${g.ads} ad(s), ${g.creatives} creative(s)${g.welcome_message_ids.length ? `, welcome message id(s): ${g.welcome_message_ids.join(', ')}` : ''}`);
  });
  L.push(`Dropped fields  : ${s.dropped_total} (read-only / unsupported / server defaults)`);
  for (const d of s.dropped.slice(0, maxDropped)) L.push(`  - ${d.path}${d.count > 1 ? ` x${d.count}` : ''}`);
  if (s.dropped.length > maxDropped) L.push(`  ... +${s.dropped.length - maxDropped} more path(s), see dry-run-plan.json`);
  L.push('');
  L.push(`BLOCKERS        : ${s.blockers.length}${s.blockers.length ? ' - a real clone is REFUSED until resolved' : ' (none)'}`);
  for (const e of s.blockers) L.push(`  x ${e}`);
  L.push(`RELAXED         : ${s.relaxed.length} (used to block; now tolerated, field dropped/handled)`);
  for (const w of s.relaxed) L.push(`  ~ ${w}`);
  L.push(`WARNINGS        : ${s.warnings.length}`);
  for (const w of s.warnings) L.push(`  ! ${w}`);
  return L.join('\n');
}
