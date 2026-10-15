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
