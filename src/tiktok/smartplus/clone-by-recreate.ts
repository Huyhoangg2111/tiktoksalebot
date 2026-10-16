import type { TikTokClient } from './client.js';
import { emitAudit, type AuditSink } from './audit.js';
import { compact, formatUtc, generateRequestId, InputValidationError, SafetyError } from './util.js';
import { CopyCampaignInputSchema, DM_CALL_TO_ACTION, PROMOTION_TYPE_TT_DM, type CopyCampaignInput, type ParsedCopyInput } from './schemas.js';
import { executeCreatePayloads, type CreatePayloads, type CreateResult, type ResumeState } from './create.js';

/**
 * Fallback "copy": read the source with
 *   GET /smart_plus/campaign/get/, /smart_plus/adgroup/get/, /smart_plus/ad/get/
 * then re-create with the three create endpoints.
 *
 * FIELD MAPPING get -> create:
 *  - Field NAMES below were cross-checked on 2026-10-15 against the official doc pages (get + create) and the
 *    official SDK OpenAPI yml: the get responses mirror the create parameters, plus read-only extras.
 *  - What is NOT verified is that every value returned by `get` is accepted back by `create` (e.g. defaults the
 *    server filled in, deprecated values, allowlist-only features). That is why we use EXPLICIT ALLOWLISTS, log every
 *    dropped field (`result.dropped`) and offer `dryRun` so you can eyeball the payloads before spending anything.
 *  - Creatives added automatically by TikTok (creator content, authorized posts, remixed images...) are NOT returned
 *    by /smart_plus/ad/get/ (doc note), so they are NOT cloned.
 *  - Scope (see SUPPORTED_SCOPE): WEB_CONVERSIONS + sales_destination WEBSITE, or LEAD_GENERATION with optimization
 *    location "TikTok direct messages" (ad group promotion_type LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE). No catalog, no
 *    search campaign. Anything else (instant messaging apps, instant form / website form, phone call, multi-destination)
 *    is refused with a message listing what was detected, rather than silently cloned wrong.
 *  - LEAD_GENERATION doc pages read 2026-10-15: create-an-upgraded-smart-lead-generation-campaign-with-optimization-
 *    location-as-tiktok-direct-messages/v1.3 (+ /creative/auto_message/get|create, targeting-settings-by-mode page).
 */

type Obj = Record<string, unknown>;

/* ------------------------------------------------------------------ allowlists */

// TODO(UNVERIFIED): every list below = documented create parameters that are also returned by get.
export const CAMPAIGN_ALLOW = [
  'campaign_name',
  'objective_type',
  'sales_destination',
  'budget_optimize_on',
  'budget_mode',
  'budget',
  'budget_auto_adjust_strategy',
  'special_industries',
  'po_number',
  'is_promotional_campaign',
] as const;

export const ADGROUP_ALLOW = [
  'adgroup_name',
  'operation_status',
  'promotion_type',
  'optimization_goal',
  'pixel_id',
  'optimization_event',
  'custom_conversion_id',
  'identity_type',
  'identity_id',
  'identity_authorized_bc_id',
  'bid_type',
  'bid_price',
  'conversion_bid_price',
  'deep_bid_type',
  'roas_bid',
  'click_attribution_window',
  'engaged_view_attribution_window',
  'view_attribution_window',
  'attribution_event_count',
  'billing_event',
  'budget_mode',
  'budget',
  'min_budget',
  'budget_auto_adjust_strategy',
  'schedule_type',
  'schedule_start_time',
  'schedule_end_time',
  'dayparting',
  'targeting_optimization_mode',
  'suggestion_audience_enabled',
  'targeting_spec',
  'placement_type',
  'placements',
  'tiktok_subplacements',
  'is_hfss',
  'is_lhf_compliance',
  'comment_disabled',
  'share_disabled',
  'video_download_disabled',
] as const;

export const TARGETING_ALLOW = [
  'location_ids',
  'zipcode_ids',
  'spc_audience_age',
  'languages',
  'operating_systems',
  'excluded_audience_ids',
  'age_groups',
  'gender',
  'audience_ids',
  'shopping_ads_retargeting_type',
  'shopping_ads_retargeting_actions_days',
  'included_custom_actions',
  'excluded_custom_actions',
  'shopping_ads_retargeting_custom_audience_relation',
  'included_pangle_audience_package_ids',
  'excluded_pangle_audience_package_ids',
  'interest_category_ids',
  'interest_keyword_ids',
  'purchase_intention_keyword_ids',
  'actions',
  'smart_interest_behavior_enabled',
  'smart_audience_enabled',
  'spending_power',
  'household_income',
  'min_android_version',
  'min_ios_version',
  'device_model_ids',
  'network_types',
  'carrier_ids',
  'isp_ids',
  'device_price_ranges',
  'saved_audience_id',
  'blocked_pangle_app_ids',
] as const;

export const AD_ALLOW = [
  'ad_name',
  'operation_status',
  'creative_list',
  'ad_text_list',
  'call_to_action_list',
  'landing_page_url_list',
  // TikTok Direct Messages: welcome message (required for LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE).
  'auto_message_list',
  // TODO(UNVERIFIED): sub-fields returned by get (e.g. disclaimer_clickable_texts) are accepted as-is by create.
  'interactive_add_on_list',
  'disclaimer',
  'ad_configuration',
] as const;

export const CREATIVE_INFO_ALLOW = [
  'ad_format',
  'material_name',
  'video_info',
  'image_info',
  'music_info',
  'aigc_disclosure_type',
  'tiktok_item_id',
  'identity_type',
  'identity_id',
  'identity_authorized_bc_id',
] as const;

export const AD_CONFIG_ALLOW = [
  'identity_type',
  'identity_id',
  'identity_authorized_bc_id',
  'utm_params',
  'call_to_action_id',
  'creative_auto_add_toggle',
  'creative_auto_enhancement_strategy_list',
  'deeplink_utm_params',
  'dark_post_status',
  'tracking_info',
] as const;

/** ad_configuration.tracking_info sub-fields we send back. Others (viewability/brand safety partners, app_tracking_info_list, message event set) are dropped. */
export const TRACKING_INFO_ALLOW = ['impression_tracking_url', 'click_tracking_url', 'tracking_app_id', 'tracking_pixel_id'] as const;

/** Targeting keys per doc "Available targeting settings for different targeting optimization modes in Upgraded Smart+ Ad Groups". */
export const TARGETING_AUTOMATIC_ALLOW = ['location_ids', 'zipcode_ids', 'spc_audience_age', 'languages', 'excluded_audience_ids'] as const;
export const TARGETING_AUTOMATIC_SUGGESTIONS_ALLOW = [
  ...TARGETING_AUTOMATIC_ALLOW,
  'age_groups',
  'gender',
  'audience_ids',
  'interest_category_ids',
  'interest_keyword_ids',
  'purchase_intention_keyword_ids',
  'actions',
] as const;

/** Ad group attribution settings: server-filled defaults in get; for lead gen they are dropped unless keepAttributionWindows. */
export const ATTRIBUTION_FIELDS = ['click_attribution_window', 'engaged_view_attribution_window', 'view_attribution_window', 'attribution_event_count'] as const;


/**
 * STRICT allowlists for LEAD_GENERATION + TikTok Direct Messages (promotion_type LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE).
 * TikTok rejects the WHOLE request on one param that is not allowed for the scenario (40002 "'x' is not allowed"), so for this
 * variant we send ONLY fields the DM guide / create docs / targeting-settings page list for it (audit 2026-10-15). First real
 * run failed on creative_auto_enhancement_strategy_list: the "Availability of Automatic Enhancements" doc marks TikTok direct
 * messages as NOT available (and the Feb-2026 SDK yml does not know that field at all).
 * Sources: .../create-an-upgraded-smart-lead-generation-campaign-with-optimization-location-as-tiktok-direct-messages/v1.3,
 *          .../automatic-enhancements/v1.3, .../available-targeting-settings-for-different-targeting-optimization-modes-in-upgraded-smart-ad-groups/v1.3
 */
export const DM_CAMPAIGN_ALLOW = ['campaign_name', 'objective_type', 'budget_optimize_on', 'budget_mode', 'budget', 'budget_auto_adjust_strategy', 'special_industries', 'po_number'] as const;

export const DM_ADGROUP_ALLOW = [
  'adgroup_name',
  'operation_status',
  'promotion_type',
  'optimization_goal',
  'optimization_event',
  'identity_type',
  'identity_id',
  'identity_authorized_bc_id',
  'bid_type',
  'bid_price',
  'conversion_bid_price',
  'billing_event',
  'budget_mode',
  'budget',
  'min_budget',
  'budget_auto_adjust_strategy',
  'schedule_type',
  'schedule_start_time',
  'schedule_end_time',
  'dayparting',
  'targeting_optimization_mode',
  'suggestion_audience_enabled',
  'targeting_spec',
  'placement_type',
  'placements',
  'tiktok_subplacements',
  'comment_disabled',
  'share_disabled',
  'video_download_disabled',
] as const;

/** MANUAL targeting keys listed on the targeting-settings page (no shopping retargeting, pangle, custom-action or spc_audience_age keys). */
export const DM_TARGETING_MANUAL_ALLOW = [
  'location_ids',
  'zipcode_ids',
  'age_groups',
  'gender',
  'languages',
  'audience_ids',
  'smart_audience_enabled',
  'excluded_audience_ids',
  'interest_category_ids',
  'interest_keyword_ids',
  'purchase_intention_keyword_ids',
  'actions',
  'smart_interest_behavior_enabled',
  'spending_power',
  'household_income',
  'operating_systems',
  'min_android_version',
  'min_ios_version',
  'device_model_ids',
  'network_types',
  'carrier_ids',
  'isp_ids',
  'device_price_ranges',
  'saved_audience_id',
] as const;

export const DM_AD_ALLOW = ['ad_name', 'operation_status', 'creative_list', 'ad_text_list', 'auto_message_list', 'call_to_action_list', 'interactive_add_on_list', 'disclaimer', 'ad_configuration'] as const;
export const DM_AD_CONFIG_ALLOW = ['tracking_info', 'dark_post_status'] as const;
export const DM_TRACKING_INFO_ALLOW = ['tracking_app_id', 'tracking_pixel_id', 'impression_tracking_url', 'click_tracking_url'] as const;
export const DM_DISCLAIMER_ALLOW = ['disclaimer_type', 'disclaimer_text', 'disclaimer_clickable_texts'] as const;
export const DM_CREATIVE_PULL_ALLOW = ['ad_format', 'tiktok_item_id', 'identity_type', 'identity_id', 'identity_authorized_bc_id'] as const;
export const DM_CREATIVE_PUSH_ALLOW = ['ad_format', 'video_info', 'image_info', 'music_info', 'identity_type', 'identity_id', 'identity_authorized_bc_id'] as const;

/** Settings worth telling the user about when the strict DM list leaves them out (value non-empty in the source). */
const DM_DROP_WARN: Record<string, string> = {
  'ad_configuration.creative_auto_enhancement_strategy_list': 'automatic enhancements are NOT available for TikTok direct messages (Availability of Automatic Enhancements doc); this field made the first real run fail with 40002',
  'ad_configuration.creative_auto_add_toggle': 'auto-add creatives is not listed as valid for TikTok direct messages',
  'ad_configuration.utm_params': 'utm_params are valid only for WEB_CONVERSIONS',
  'ad_configuration.deeplink_utm_params': 'only valid for WEB_CONVERSIONS + sales_destination APP',
  'ad_configuration.call_to_action_id': 'DM create doc: call_to_action_id not specified (use call_to_action_list SEND_MESSAGE)',
  'ad_configuration.identity_type': 'ad_configuration identity is for non-TikTok placements; DM uses creative_info identity',
  'ad_configuration.identity_id': 'ad_configuration identity is for non-TikTok placements; DM uses creative_info identity',
};

export const SUPPORTED_SCOPE =
  'WEB_CONVERSIONS (sales_destination WEBSITE), or LEAD_GENERATION with optimization location TikTok direct messages ' +
  `(ad group promotion_type ${PROMOTION_TYPE_TT_DM}); no catalog, no search`;

/* ------------------------------------------------------------------ types */

export interface RecreateOptions {
  /** Do the GET reads, build the payloads, but call NO create endpoint. */
  dryRun?: boolean;
  /** Needed for operation_status ENABLE anywhere. */
  allowEnable?: boolean;
  /** Children (ad groups/ads) are created DISABLED unless this is false. Default true. */
  forceChildrenDisabled?: boolean;
  maxBudget?: number;
  rollbackOnFailure?: boolean;
  audit?: AuditSink;
  actor?: string;
  now?: () => Date;
  /**
   * Lead gen only: also send click/engaged-view/view attribution windows and attribution_event_count from the source.
   * Default false (dropped, server defaults apply) because the docs do not say they are valid for TikTok DM ad groups.
   * Web campaigns always keep them (unchanged behaviour).
   */
  keepAttributionWindows?: boolean;
  /**
   * Optional cost-cap override applied to every cloned ad group.
   * CLICK goals write `bid_price`; other goals write `conversion_bid_price`.
   * `bid_type` becomes BID_TYPE_CUSTOM. The other price field is removed so TikTok does not 40002 the request.
   */
  overrideBid?: number;
  /**
   * Resume into an EXISTING copy (created earlier, e.g. a run that failed half-way): skip what already exists and create only the
   * missing ad groups / ads. Existing objects are found by reading the new campaign (GET) and matched by campaign id, then ad group
   * name (or the explicit adgroup_id when the plan has a single ad group), then ad name. Nothing existing is modified.
   */
  resume?: { campaign_id: string; adgroup_id?: string | undefined };
  /** Page size for GET list calls. TODO(UNVERIFIED): max for adgroup/ad get (campaign get: 1-1000). Default 100. */
  pageSize?: number;
}

export interface ResumePlan {
  campaign_id: string;
  campaign_name?: string | undefined;
  /** Same order as payloads.adgroups. existing_id undefined => will be created. */
  adgroups: { planned_name: string; existing_id?: string | undefined; ads: { planned_name: string; existing_id?: string | undefined }[] }[];
  to_create: { adgroups: number; ads: number };
}

export interface RecreatePlan {
  source_campaign_id: string;
  payloads: CreatePayloads;
  /** Paths of fields present in the source but NOT sent (read-only, unknown or unsupported). */
  dropped: string[];
  warnings: string[];
  /**
   * REAL BLOCKERS: scope violations (see `unsupported`) and problems that WOULD make the create calls fail (e.g. DM ad without
   * welcome message). A real run refuses while non-empty; a dry run still emits the full plan and just reports them.
   */
  errors: string[];
  /** Subset of `errors` that are scope-guard findings (unsupported variants). */
  unsupported: string[];
  /** Present when options.resume was given: what exists already (skipped) and what will be created. */
  resume?: ResumePlan | undefined;
  /** Read-only facts of the source (not sent): objective, current_budget, names. */
  source: { objective_type?: string; campaign_name?: string; current_budget?: number; budget_auto_adjust_strategy?: string };
}

export interface RecreateResult {
  method: 'CLONE_BY_RECREATE';
  dry_run: boolean;
  plan: RecreatePlan;
  /** Absent in dry-run. */
  create?: CreateResult;
  status: 'DRY_RUN' | CreateResult['status'];
  campaign_id?: string | undefined;
}

/* ------------------------------------------------------------------ main */

export async function cloneCampaignByRecreate(
  client: TikTokClient,
  rawInput: CopyCampaignInput,
  opts: RecreateOptions = {},
): Promise<RecreateResult> {
  const parsed = CopyCampaignInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new InputValidationError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  const input = parsed.data;
  const plan = await buildRecreatePlan(client, input, opts);

  if (opts.dryRun) {
    return { method: 'CLONE_BY_RECREATE', dry_run: true, plan, status: 'DRY_RUN' };
  }

  if (plan.unsupported.length) throw new SafetyError(refusalMessage(plan.source_campaign_id, plan.unsupported, plan.warnings.filter((w) => w.startsWith(RELAXED))));
  if (plan.errors.length) throw new InputValidationError(plan.errors);
  await emitAudit(opts.audit, {
    action: 'smartplus.clone_by_recreate.start',
    advertiser_id: input.advertiser_id,
    actor: opts.actor,
    request: { source_campaign_id: input.campaign_id, dropped: plan.dropped, warnings: plan.warnings },
    ok: true,
  });
  const create = await executeCreatePayloads(client, input.advertiser_id, plan.payloads, opts, plan.resume ? toResumeState(plan.resume) : undefined);
  return { method: 'CLONE_BY_RECREATE', dry_run: false, plan, create, status: create.status, campaign_id: create.campaign_id };
}

/** Reads the source campaign tree and builds create payloads (no create calls). */
export async function buildRecreatePlan(client: TikTokClient, input: ParsedCopyInput, opts: RecreateOptions = {}): Promise<RecreatePlan> {
  const { advertiser_id, campaign_id } = input;
  const pageSize = opts.pageSize ?? 100;
  const now = opts.now?.() ?? new Date();
  const forceChildrenDisabled = opts.forceChildrenDisabled ?? true;
  const dropped: string[] = [];
  const warnings: string[] = [
    'Automatically added creatives (creator content, authorized posts, remixed images) are not returned by /smart_plus/ad/get/ and are not cloned.',
  ];

  // ---- read
  const [campaigns, adgroups, ads] = await Promise.all([
    fetchAll(client, '/smart_plus/campaign/get/', advertiser_id, { campaign_ids: [campaign_id] }, pageSize),
    fetchAll(client, '/smart_plus/adgroup/get/', advertiser_id, { campaign_ids: [campaign_id] }, pageSize),
    fetchAll(client, '/smart_plus/ad/get/', advertiser_id, { campaign_ids: [campaign_id] }, pageSize),
  ]);
  const src = campaigns.find((c) => String(c.campaign_id) === campaign_id);
  if (!src) throw new InputValidationError([`source campaign ${campaign_id} not found for advertiser ${advertiser_id}`]);

  const live = (o: Obj) => !isDeleted(o);
  let srcGroups = adgroups.filter(live);
  const adsByGroup = new Map<string, Obj[]>();
  for (const a of ads.filter(live)) {
    const k = String(a.adgroup_id);
    (adsByGroup.get(k) ?? adsByGroup.set(k, []).get(k)!).push(a);
  }
  if (!srcGroups.length) throw new InputValidationError(['source campaign has no undeleted ad groups']);

  // ---- scope guard (checked on the undeleted children, before anything is built)
  const scope = analyzeScope(src, srcGroups, ads.filter(live));
  // An unknown objective cannot be planned at all. Other findings are reported in plan.errors so a dry run still emits the full plan.
  if (scope.hard.length) throw new SafetyError(refusalMessage(campaign_id, scope.blockers, scope.warnings));
  warnings.push(...scope.warnings);
  const leadGen = src.objective_type === 'LEAD_GENERATION';
  const errors: string[] = scope.blockers.map((b) => `UNSUPPORTED: ${b}`);

  // ---- CUSTOM selection
  type Sel = NonNullable<ParsedCopyInput['adgroup_list']>[number];
  const selByGroup = new Map<string, Sel>();
  if (input.deep_copy_mode === 'CUSTOM') {
    for (const sel of input.adgroup_list ?? []) selByGroup.set(sel.adgroup_id, sel);
    const missing = [...selByGroup.keys()].filter((id) => !srcGroups.some((g) => String(g.adgroup_id) === id));
    if (missing.length) throw new InputValidationError([`adgroup_list references ad groups not in the source campaign: ${missing.join(', ')}`]);
    srcGroups = srcGroups.filter((g) => selByGroup.has(String(g.adgroup_id)));
  }

  // ---- campaign body
  const cbo = src.budget_optimize_on !== false;
  const cBody = pick(src, leadGen ? DM_CAMPAIGN_ALLOW : CAMPAIGN_ALLOW, 'campaign', dropped);
  if (leadGen && src.is_promotional_campaign === true) warnings.push('campaign.is_promotional_campaign=true not sent (create doc: valid only for WEB_CONVERSIONS)');
  // Bot policy: never prefix COPIED_/Copy. Caller passes the exact name the existing bot derives
  // (`<base> - API`). If omitted, keep the source campaign name unchanged.
  cBody.campaign_name = input.campaign_name ?? String(src.campaign_name ?? campaign_id);
  cBody.operation_status = input.operation_status; // DISABLE by default
  cBody.objective_type = leadGen ? 'LEAD_GENERATION' : 'WEB_CONVERSIONS';
  if (leadGen) {
    delete cBody.sales_destination; // LEAD_GENERATION has no sales_destination
    if (src.sales_destination) dropped.push('campaign.sales_destination');
  } else {
    cBody.sales_destination = 'WEBSITE';
  }
  // get returns budget 0 with BUDGET_MODE_INFINITE (CBO off); create wants budget unspecified then.
  if (cBody.budget_mode === 'BUDGET_MODE_INFINITE') delete cBody.budget;
  // TODO(UNVERIFIED): get may return budget_auto_adjust_strategy "UNSET"; the campaign create doc only lists AUTO_BUDGET_INCREASE ("not specified" to disable).
  if (cBody.budget_auto_adjust_strategy === 'UNSET') delete cBody.budget_auto_adjust_strategy;
  if (cBody.budget_auto_adjust_strategy === 'AUTO_BUDGET_INCREASE') {
    warnings.push(
      `campaign: Goal-based budget increase (AUTO_BUDGET_INCREASE) is kept. "budget" is the INITIAL budget (${String(src.budget)}); source current_budget ${String(src.current_budget ?? 'n/a')} is not sent. Allowlist-only feature.`,
    );
  }
    if (input.budget !== undefined) {
    if (cbo && budgetModeAllowsAmount(cBody.budget_mode)) {
      cBody.budget = input.budget;
    } else if (cbo) {
      errors.push(`campaign: không ghi ngân sách ${input.budget} vì budget_mode=${String(cBody.budget_mode || 'trống')} không phải ngày hoặc trọn đời.`);
    } else {
      warnings.push(`override budget ${input.budget} is applied on each ad group only when that ad group's budget_mode is daily or total`);
    }
  }
  cBody.advertiser_id = advertiser_id;
  cBody.request_id = generateRequestId(input.idempotencyKey ? `${advertiser_id}|${input.idempotencyKey}|recreate|campaign` : undefined);

  // ---- ad groups + ads
  const outGroups: CreatePayloads['adgroups'] = [];
  srcGroups.forEach((g, gi) => {
    const gid = String(g.adgroup_id);
    const sel = selByGroup.get(gid);
    const path = `adgroup[${gid}]`;
    const body = pick(g, leadGen ? [...DM_ADGROUP_ALLOW, ...ATTRIBUTION_FIELDS] : ADGROUP_ALLOW, path, dropped);
    if (leadGen && g.targeting_optimization_mode === 'MANUAL') {
      // targeting page lists HFSS / LHF only for custom targeting; send only when they are switched ON
      for (const k of ['is_hfss', 'is_lhf_compliance']) if (g[k] === true) body[k] = true;
    }
    body.targeting_spec = cleanTargeting(g, body, path, dropped, warnings, leadGen);
    // get returns placement_type as string[] in the docs' field table, create takes a string
    if (Array.isArray(body.placement_type)) body.placement_type = body.placement_type[0];
    if (cbo) {
      // With CBO on the doc says ad group budget_mode / budget are not supported (campaign budget is used).
      for (const k of ['budget_mode', 'budget', 'budget_auto_adjust_strategy']) {
        if (k in body) {
          delete body[k];
          dropped.push(`${path}.${k} (CBO on)`);
        }
      }
    }
    // get returns 0 for "not set" numbers (e.g. budget 0 with BUDGET_MODE_INFINITE, min_budget 0, bid 0 with NO_BID)
    for (const k of ['budget', 'min_budget', 'bid_price', 'conversion_bid_price', 'roas_bid']) {
      if (body[k] === 0) {
        delete body[k];
        dropped.push(`${path}.${k} (zero = unset)`);
      }
    }
    if (body.budget_auto_adjust_strategy === 'AUTO_BUDGET_INCREASE') {
      warnings.push(
        `${path}: Goal-based budget increase (AUTO_BUDGET_INCREASE) is kept. "budget" is the INITIAL ad group budget (${String(body.budget)}); source current_budget ${String(g.current_budget ?? 'n/a')} is not sent. The increase steps/cap are platform rules, not create parameters. Allowlist-only feature.`,
      );
    }
    if (leadGen) {
      if (!opts.keepAttributionWindows) {
        const seen: string[] = [];
        for (const k of ATTRIBUTION_FIELDS) {
          if (k in body) {
            seen.push(`${k}=${String(body[k])}`);
            delete body[k];
            dropped.push(`${path}.${k} (lead gen default)`);
          }
        }
        if (seen.length) warnings.push(`${path}: attribution settings not sent, server defaults apply (source: ${seen.join(', ')}); set keepAttributionWindows to send them`);
      }
      // doc: with CONVERSATION omit optimization_event or MESSAGE; minimum budget only with NO_BID
      if (body.min_budget !== undefined && body.bid_type !== 'BID_TYPE_NO_BID') {
        delete body.min_budget;
        dropped.push(`${path}.min_budget (only valid with BID_TYPE_NO_BID)`);
      }
      body.placement_type ??= 'PLACEMENT_TYPE_NORMAL';
      body.placements ??= ['PLACEMENT_TIKTOK'];
    }

    // overrides (same semantics as the official copy API)
    if (sel?.adgroup_name) body.adgroup_name = sel.adgroup_name;
    if (!cbo && input.budget !== undefined) applyGroupBudgetOverride(body, input.budget, path, errors, 'ngân sách');
    if (sel?.budget !== undefined && !cbo) applyGroupBudgetOverride(body, sel.budget, path, errors, 'ngân sách ad group');
    if (sel?.min_budget !== undefined) body.min_budget = sel.min_budget;
    if (sel?.targeting_spec) body.targeting_spec = { ...(body.targeting_spec as Obj), ...sel.targeting_spec };
    if (input.schedule_type) {
      body.schedule_type = input.schedule_type;
      body.schedule_start_time = input.schedule_start_time;
      if (input.schedule_type === 'SCHEDULE_START_END') body.schedule_end_time = input.schedule_end_time;
      else delete body.schedule_end_time;
    } else {
      fixPastSchedule(body, now, path, warnings);
    }
    if (input.dayparting) body.dayparting = input.dayparting;
    if (opts.overrideBid != null && Number.isFinite(opts.overrideBid) && opts.overrideBid > 0) {
      const decision = bidOverrideDecision(body);
      if (!decision.ok) errors.push(`${path}: ${decision.reason}`);
      else applyBidOverride(body, opts.overrideBid, path, warnings);
    }

    body.operation_status = sel?.operation_status ?? (forceChildrenDisabled ? 'DISABLE' : (g.operation_status === 'ENABLE' ? 'ENABLE' : 'DISABLE'));
    body.advertiser_id = advertiser_id;
    body.request_id = generateRequestId(input.idempotencyKey ? `${advertiser_id}|${input.idempotencyKey}|recreate|adgroup|${gi}` : undefined);

    // ads
    let srcAds = adsByGroup.get(gid) ?? [];
    const adSel = new Map((sel?.ad_list ?? []).map((a) => [a.smart_plus_ad_id, a]));
    if (sel) {
      const missingAds = [...adSel.keys()].filter((id) => !srcAds.some((a) => String(a.smart_plus_ad_id) === id));
      if (missingAds.length) throw new InputValidationError([`ad_list references ads not in source ad group ${gid}: ${missingAds.join(', ')}`]);
      srcAds = srcAds.filter((a) => adSel.has(String(a.smart_plus_ad_id)));
    }
    if (!srcAds.length) throw new InputValidationError([`source ad group ${gid} has no undeleted ads to clone`]);

    const adBodies = srcAds.map((a) => {
      const aid = String(a.smart_plus_ad_id);
      const apath = `ad[${aid}]`;
      const o = adSel.get(aid);
      const ab = pick(a, leadGen ? DM_AD_ALLOW : AD_ALLOW, apath, dropped);
      const creatives = cleanCreatives(a.creative_list, apath, dropped, warnings, leadGen);
      ab.creative_list = creatives;
      const rawCfg = a.ad_configuration && typeof a.ad_configuration === 'object' ? (a.ad_configuration as Obj) : undefined;
      if (rawCfg) {
        const cpath = `${apath}.ad_configuration`;
        const cfg = pick(rawCfg, leadGen ? DM_AD_CONFIG_ALLOW : AD_CONFIG_ALLOW, cpath, dropped);
        if (cfg.tracking_info && typeof cfg.tracking_info === 'object') {
          cfg.tracking_info = pick(cfg.tracking_info as Obj, leadGen ? DM_TRACKING_INFO_ALLOW : TRACKING_INFO_ALLOW, `${cpath}.tracking_info`, dropped);
        }
        if (leadGen) {
          for (const [k, why] of Object.entries(DM_DROP_WARN)) {
            const key = k.replace('ad_configuration.', '');
            const v = rawCfg[key];
            if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0) && v !== false) warnings.push(`${cpath}.${key} not sent: ${why}`);
          }
          // dark_post_status is documented only for Spark Ads PUSH (video_info/image_info creatives), not for pulled posts (tiktok_item_id)
          const hasPush = creatives.some((c) => !(c.creative_info as Obj).tiktok_item_id);
          if (cfg.dark_post_status !== undefined && !hasPush) {
            warnings.push(`${cpath}.dark_post_status=${String(cfg.dark_post_status)} not sent: valid only for Spark Ads Push (all creatives here are pulled TikTok posts)`);
            delete cfg.dark_post_status;
            dropped.push(`${cpath}.dark_post_status (Spark Ads Pull)`);
          }
        }
        ab.ad_configuration = cfg;
      }
      if (leadGen) {
        if (ab.disclaimer && typeof ab.disclaimer === 'object') ab.disclaimer = pick(ab.disclaimer as Obj, DM_DISCLAIMER_ALLOW, `${apath}.disclaimer`, dropped);
        if (Array.isArray(ab.interactive_add_on_list)) ab.interactive_add_on_list = (ab.interactive_add_on_list as Obj[]).map((x) => pick(x, ['card_id'], `${apath}.interactive_add_on_list[]`, dropped));
        // creative combinations doc: Spark Ads PULL => do not specify video_info, image_info, music_info and ad_text_list
        if (creatives.length && creatives.every((c) => (c.creative_info as Obj).tiktok_item_id) && ab.ad_text_list) {
          warnings.push(`${apath}.ad_text_list not sent: all creatives are pulled TikTok posts (creative combinations doc: do not specify ad_text_list with tiktok_item_id)`);
          delete ab.ad_text_list;
          dropped.push(`${apath}.ad_text_list (Spark Ads Pull)`);
        }
        if (!Array.isArray(ab.call_to_action_list) || !ab.call_to_action_list.length) {
          ab.call_to_action_list = [{ call_to_action: DM_CALL_TO_ACTION }];
          warnings.push(`${apath}: no call_to_action_list in source; defaulted to [{call_to_action: ${DM_CALL_TO_ACTION}}] (as in the official DM example)`);
        }
      }
      // Keep the source ad name exactly. The official copy API would default to COPIED_<name>_<id>; this bot must not.
      ab.ad_name = o?.ad_name ?? String(ab.ad_name ?? a.ad_name ?? aid);
      if (o?.creative_list) ab.creative_list = o.creative_list;
      else if (o?.creative_info) ab.creative_list = [{ creative_info: o.creative_info }];
      if (o?.ad_text_list) ab.ad_text_list = o.ad_text_list;
      if (o?.call_to_action_list) ab.call_to_action_list = o.call_to_action_list;
      if (o?.landing_page_url_list) ab.landing_page_url_list = o.landing_page_url_list;
      if (o?.ad_configuration) ab.ad_configuration = { ...(ab.ad_configuration as Obj | undefined), ...o.ad_configuration };
      if (o?.auto_message_list) ab.auto_message_list = o.auto_message_list;
      if (leadGen && !(Array.isArray(ab.auto_message_list) && ab.auto_message_list.length)) {
        errors.push(`${apath}: no auto_message_list (welcome message) in source; TikTok Direct Messaging ads require one (use /creative/auto_message/get/ and pass it via adgroup_list[].ad_list[].auto_message_list)`);
      }
      ab.operation_status = o?.operation_status ?? (forceChildrenDisabled ? 'DISABLE' : (a.operation_status === 'ENABLE' ? 'ENABLE' : 'DISABLE'));
      ab.advertiser_id = advertiser_id;
      return compact(ab);
    });
    outGroups.push({ adgroup: compact(body), ads: adBodies });
  });

  const payloads: CreatePayloads = { campaign: compact(cBody), adgroups: outGroups };
  enforceRecreateSafety(payloads, opts);
  const source: RecreatePlan['source'] = { objective_type: String(src.objective_type) };
  if (typeof src.campaign_name === 'string') source.campaign_name = src.campaign_name;
  if (typeof src.current_budget === 'number') source.current_budget = src.current_budget;
  if (typeof src.budget_auto_adjust_strategy === 'string') source.budget_auto_adjust_strategy = src.budget_auto_adjust_strategy;
  let resume: ResumePlan | undefined;
  if (opts.resume) {
    resume = await planResume(client, advertiser_id, campaign_id, payloads, opts.resume, pageSize, errors, warnings, String(src.objective_type));
  }
  return { source_campaign_id: campaign_id, payloads, dropped, warnings: [...new Set(warnings)], errors, unsupported: scope.blockers, resume, source };
}

/** Converts a ResumePlan into the index-aligned state executeCreatePayloads understands. */
export function toResumeState(r: ResumePlan): ResumeState {
  return {
    campaign_id: r.campaign_id,
    adgroups: r.adgroups.map((g) => (g.existing_id ? { adgroup_id: g.existing_id, smart_plus_ad_ids: g.ads.map((a) => a.existing_id) } : undefined)),
  };
}

/**
 * READ-ONLY: looks at the already-created copy (GET campaign/ad groups/ads of the new campaign) and decides what is missing.
 * Matching: ad group by name (or the explicit id when the plan has exactly one ad group), ad by name within the matched ad group.
 * Problems are pushed to `errors` (a real run refuses). Existing objects are never modified.
 */
export async function planResume(
  client: TikTokClient,
  advertiser_id: string,
  source_campaign_id: string,
  payloads: CreatePayloads,
  r: NonNullable<RecreateOptions['resume']>,
  pageSize: number,
  errors: string[],
  warnings: string[],
  objective: string,
): Promise<ResumePlan> {
  const out: ResumePlan = {
    campaign_id: r.campaign_id,
    adgroups: payloads.adgroups.map((g) => ({ planned_name: String(g.adgroup.adgroup_name ?? ''), ads: g.ads.map((a) => ({ planned_name: String(a.ad_name ?? '') })) })),
    to_create: { adgroups: 0, ads: 0 },
  };
  const tally = () => {
    out.to_create.adgroups = out.adgroups.filter((g) => !g.existing_id).length;
    out.to_create.ads = out.adgroups.reduce((n, g) => n + g.ads.filter((a) => !a.existing_id).length, 0);
  };
  if (r.campaign_id === source_campaign_id) {
    errors.push('RESUME: the resume campaign is the SOURCE campaign; pass the id of the copy that was created');
    tally();
    return out;
  }
  const filtering = { campaign_ids: [r.campaign_id] };
  const [camps, groups, ads] = await Promise.all([
    fetchAll(client, '/smart_plus/campaign/get/', advertiser_id, filtering, pageSize),
    fetchAll(client, '/smart_plus/adgroup/get/', advertiser_id, filtering, pageSize),
    fetchAll(client, '/smart_plus/ad/get/', advertiser_id, filtering, pageSize),
  ]);
  const camp = camps.find((c) => String(c.campaign_id) === r.campaign_id && !isDeleted(c));
  if (!camp) {
    errors.push(`RESUME: campaign ${r.campaign_id} not found (or deleted) for advertiser ${advertiser_id}`);
    tally();
    return out;
  }
  out.campaign_name = typeof camp.campaign_name === 'string' ? camp.campaign_name : undefined;
  if (String(camp.objective_type) !== objective) errors.push(`RESUME: campaign ${r.campaign_id} has objective_type=${String(camp.objective_type)}, expected ${objective}`);
  if (camp.operation_status === 'ENABLE') errors.push(`RESUME: campaign ${r.campaign_id} is ENABLE; resume only into a DISABLED copy (children would be added to a live campaign)`);

  const liveGroups = groups.filter((g) => !isDeleted(g) && String(g.campaign_id ?? r.campaign_id) === r.campaign_id);
  const used = new Set<string>();
  if (r.adgroup_id) {
    const g = liveGroups.find((x) => String(x.adgroup_id) === r.adgroup_id);
    if (!g) errors.push(`RESUME: ad group ${r.adgroup_id} is not an undeleted ad group of campaign ${r.campaign_id}`);
    else if (out.adgroups.length !== 1) errors.push(`RESUME: --resume-adgroup is ambiguous because the plan has ${out.adgroups.length} ad groups; omit it to match by name`);
    else {
      out.adgroups[0]!.existing_id = r.adgroup_id;
      used.add(r.adgroup_id);
      if (String(g.adgroup_name) !== out.adgroups[0]!.planned_name) warnings.push(`RESUME: ad group ${r.adgroup_id} is named "${String(g.adgroup_name)}", the plan expects "${out.adgroups[0]!.planned_name}"; using the id you gave`);
    }
  }
  for (const pg of out.adgroups) {
    if (pg.existing_id) continue;
    const cands = liveGroups.filter((x) => String(x.adgroup_name) === pg.planned_name && !used.has(String(x.adgroup_id)));
    if (cands.length > 1) errors.push(`RESUME: ${cands.length} existing ad groups are named "${pg.planned_name}" (${cands.map((x) => String(x.adgroup_id)).join(', ')}); pass --resume-adgroup <id> (single ad group) or delete the duplicates`);
    else if (cands.length === 1) {
      pg.existing_id = String(cands[0]!.adgroup_id);
      used.add(pg.existing_id);
    }
  }
  const liveAds = ads.filter((a) => !isDeleted(a));
  for (const pg of out.adgroups) {
    if (!pg.existing_id) continue;
    const mine = liveAds.filter((a) => String(a.adgroup_id) === pg.existing_id);
    const usedAds = new Set<string>();
    for (const pa of pg.ads) {
      const cands = mine.filter((a) => String(a.ad_name) === pa.planned_name && !usedAds.has(String(a.smart_plus_ad_id)));
      if (cands.length > 1) errors.push(`RESUME: ${cands.length} existing ads named "${pa.planned_name}" in ad group ${pg.existing_id}; delete the duplicates`);
      else if (cands.length === 1) {
        pa.existing_id = String(cands[0]!.smart_plus_ad_id);
        usedAds.add(pa.existing_id);
      }
    }
    const extra = mine.filter((a) => !usedAds.has(String(a.smart_plus_ad_id)));
    if (extra.length) warnings.push(`RESUME: ad group ${pg.existing_id} also has ${extra.length} ad(s) that do not match the plan by name (left untouched): ${extra.map((a) => String(a.smart_plus_ad_id)).join(', ')}`);
  }
  tally();
  if (out.to_create.adgroups === 0 && out.to_create.ads === 0) warnings.push('RESUME: nothing is missing - every planned ad group and ad already exists');
  warnings.push('RESUME: existing ad groups/ads are matched by name only; their settings are NOT compared with the plan or modified');
  return out;
}

export function budgetModeAllowsAmount(mode: unknown): boolean {
  const value = String(mode || '');
  return value === 'BUDGET_MODE_DAY' || value === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET' || value === 'BUDGET_MODE_TOTAL';
}

function applyGroupBudgetOverride(body: Obj, amount: number, path: string, errors: string[], label: string): void {
  if (budgetModeAllowsAmount(body.budget_mode)) {
    body.budget = amount;
    return;
  }
  errors.push(`${path}: không ghi ${label} ${amount} vì budget_mode=${String(body.budget_mode || 'trống')} không phải ngày hoặc trọn đời. INFINITE sẽ bị 40002.`);
}

export type BidPriceField = 'bid_price' | 'conversion_bid_price' | 'roas_bid';

/** CUSTOM sources can take a new price. CONVERSATION with a daily budget may switch to CUSTOM. Anything else is a preview blocker. */
export function bidOverrideDecision(body: Obj): { ok: true; field: BidPriceField; setCustom: boolean } | { ok: false; reason: string } {
  const goal = String(body.optimization_goal || '');
  const bidType = String(body.bid_type || '');
  const budgetMode = String(body.budget_mode || '');
  const daily = budgetMode === 'BUDGET_MODE_DAY' || budgetMode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET';
  const alreadyCustom = bidType === 'BID_TYPE_CUSTOM';
  if (!alreadyCustom && !(goal === 'CONVERSATION' && daily)) {
    return {
      ok: false,
      reason: `không ghi đè giá thầu khi bid_type=${bidType || 'trống'}, goal=${goal || 'trống'}, budget_mode=${budgetMode || 'trống'}. Chỉ khi nguồn đã BID_TYPE_CUSTOM, hoặc CONVERSATION với ngân sách ngày.`,
    };
  }
  const field: BidPriceField = goal === 'CLICK' ? 'bid_price' : goal === 'VALUE' ? 'roas_bid' : 'conversion_bid_price';
  return { ok: true, field, setCustom: !alreadyCustom };
}

/** Writes one bid field. Sending both bid_price and conversion_bid_price can make TikTok reject the whole request (40002). */
export function applyBidOverride(body: Obj, bid: number, path: string, warnings: string[]): void {
  const decision = bidOverrideDecision(body);
  if (!decision.ok) throw new Error(`${path}: ${decision.reason}`);
  if (decision.setCustom) body.bid_type = 'BID_TYPE_CUSTOM';
  delete body.bid_price;
  delete body.conversion_bid_price;
  delete body.roas_bid;
  body[decision.field] = bid;
  if (body.min_budget !== undefined && body.bid_type !== 'BID_TYPE_NO_BID') {
    delete body.min_budget;
  }
  warnings.push(`${path}: bid override ${bid} via ${decision.field}${decision.setCustom ? ' (bid_type=BID_TYPE_CUSTOM)' : ''}`);
}

/* ------------------------------------------------------------------ helpers */

/** Describes why an ad group is not a TikTok-DM lead-gen / web ad group (used in the scope-guard message). */
function describePromotion(g: Obj): string {
  const pt = String(g.promotion_type ?? '');
  const id = `adgroup[${String(g.adgroup_id)}]`;
  switch (pt) {
    case 'LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE':
      return `${id} optimization location = instant messaging app (${pt}, messaging_app_type=${String(g.messaging_app_type ?? 'n/a')})`;
    case 'LEAD_GENERATION':
      return `${id} optimization location = ${g.promotion_target_type === 'INSTANT_PAGE' ? 'instant form' : g.promotion_target_type === 'EXTERNAL_WEBSITE' ? 'website form' : 'lead form / website'} (${pt}, promotion_target_type=${String(g.promotion_target_type ?? 'n/a')})`;
    case 'LEAD_GEN_CLICK_TO_CALL':
      return `${id} optimization location = phone call (${pt})`;
    case 'LEAD_GENERATION_MULTI_DESTINATION':
      return `${id} optimization location = multiple destinations (${pt})`;
    default:
      return `${id} promotion_type=${pt || '(missing)'}`;
  }
}

export const RELAXED = '[relaxed] ';

export interface ScopeAnalysis {
  /** Real blockers: the variant cannot be cloned faithfully by this module. */
  blockers: string[];
  /** Subset of blockers that make planning meaningless (unknown objective): always thrown. */
  hard: string[];
  /** Findings that used to block but are tolerated; each is prefixed with RELAXED and the field is dropped/handled. */
  warnings: string[];
}

export function refusalMessage(campaign_id: string, blockers: string[], relaxed: string[]): string {
  return (
    `clone-by-recreate refused source campaign ${campaign_id}. ` +
    `BLOCKERS (${blockers.length}): ${blockers.join('; ')}. ` +
    (relaxed.length ? `NOT blocking (relaxed, handled with warnings): ${relaxed.map((w) => w.replace(RELAXED, '')).join('; ')}. ` : '') +
    `Supported: ${SUPPORTED_SCOPE}. For other variants use copyCampaign (official async copy, allowlist) instead.`
  );
}

/**
 * Scope guard. Pure; exported for tests / callers that want to pre-check.
 * Only a campaign with is_search_campaign=true counts as Search Ads. On ad groups, search_result_enabled / automated_keywords_enabled /
 * search_keywords are NOT blockers: search_result_enabled=true is the default "TikTok incl. search results" placement flag (read-only,
 * not a create parameter) and automated_keywords_enabled / search_keywords are valid only for search campaigns (create docs) => dropped + warning.
 * landing_page_url_list on a lead-gen (DM) ad is dropped with a warning (DM ads use no landing page).
 * TODO(UNVERIFIED): field availability in get responses (e.g. promotion_type on ad group, catalog_enabled on campaign) is taken from the get docs.
 */
export function analyzeScope(src: Obj, groups: Obj[], ads: Obj[]): ScopeAnalysis {
  const out: string[] = [];
  const hard: string[] = [];
  const warn: string[] = [];
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  // GET returns catalog_id "0" when the ad group has no catalog. That string is truthy, but it is not a catalog.
  const isRealId = (v: unknown) => {
    const text = String(v ?? '').trim();
    return text !== '' && text !== '0';
  };
  const objective = String(src.objective_type);
  if (objective !== 'WEB_CONVERSIONS' && objective !== 'LEAD_GENERATION') {
    hard.push(`objective_type=${objective}`);
    out.push(`objective_type=${objective}`);
  }
  if (objective === 'WEB_CONVERSIONS' && src.sales_destination && src.sales_destination !== 'WEBSITE') out.push(`sales_destination=${String(src.sales_destination)} (only WEBSITE)`);
  if (src.catalog_enabled) out.push(`catalog_enabled=true${src.catalog_type ? ` (catalog_type=${String(src.catalog_type)})` : ''}`);
  if (src.is_search_campaign) out.push('is_search_campaign=true (Search Ads campaign)');
  if (src.campaign_type && src.campaign_type !== 'REGULAR_CAMPAIGN') out.push(`campaign_type=${String(src.campaign_type)} (iOS 14 dedicated campaign)`);
  if (objective === 'LEAD_GENERATION' && (src.app_id || src.campaign_app_profile_page_state)) out.push('campaign has app_id / campaign_app_profile_page_state (app campaign, not TikTok DM)');

  for (const g of groups) {
    const id = `adgroup[${String(g.adgroup_id)}]`;
    if (isRealId(g.catalog_id)) out.push(`${id} catalog_id=${String(g.catalog_id)} (catalog)`);
    if (g.search_result_enabled === true) {
      warn.push(`${RELAXED}${id} search_result_enabled=true is the default "TikTok incl. search results" placement, not a Search Ads campaign; read-only (create has no such parameter), not sent - TikTok decides it on create`);
    }
    if (g.automated_keywords_enabled === true && !src.is_search_campaign) {
      warn.push(`${RELAXED}${id} automated_keywords_enabled=true is valid only for Search Ads campaigns (is_search_campaign=false here); not sent`);
    }
    if (nonEmpty(g.search_keywords) && !src.is_search_campaign) {
      warn.push(`${RELAXED}${id} search_keywords returned although is_search_campaign=false (create does not support them for non-search campaigns); not sent`);
    }
    if (objective === 'LEAD_GENERATION') {
      if (g.promotion_type !== PROMOTION_TYPE_TT_DM) out.push(describePromotion(g));
      else {
        if (g.messaging_app_type) out.push(`${id} messaging_app_type=${String(g.messaging_app_type)} (instant messaging app)`);
        if (g.promotion_target_type) out.push(`${id} promotion_target_type=${String(g.promotion_target_type)} (instant form / website form)`);
        if (nonEmpty(g.optimization_locations)) out.push(`${id} optimization_locations (multi-destination)`);
      }
    } else if (g.promotion_type && g.promotion_type !== 'WEBSITE') {
      out.push(`${id} promotion_type=${String(g.promotion_type)} (only WEBSITE)`);
    }
  }
  for (const a of ads) {
    const id = `ad[${String(a.smart_plus_ad_id)}]`;
    const cfg = (a.ad_configuration ?? {}) as Obj;
    if (cfg.catalog_creative_toggle === true) out.push(`${id} catalog_creative_toggle=true (catalog creatives)`);
    if (objective === 'LEAD_GENERATION') {
      if (nonEmpty(a.page_list)) out.push(`${id} page_list set (instant page / instant form destination)`);
      if (nonEmpty(a.multi_dest_list)) out.push(`${id} multi_dest_list set (multi-destination)`);
      if (nonEmpty(a.deeplink_list)) out.push(`${id} deeplink_list set (app destination)`);
      if (cfg.phone_info && typeof cfg.phone_info === 'object' && Object.keys(cfg.phone_info as Obj).length) out.push(`${id} phone_info set (phone call destination)`);
      if (nonEmpty(a.landing_page_url_list)) {
        const urls = (a.landing_page_url_list as Obj[]).map((u) => String(u.landing_page_url ?? '')).join(', ');
        warn.push(`${RELAXED}${id} landing_page_url_list [${urls}] dropped: TikTok Direct Messaging ads use no landing page (DM create doc: not specified)`);
      }
    }
  }
  return { blockers: [...new Set(out)], hard, warnings: [...new Set(warn)] };
}

/** Blockers only (back-compat helper). */
export function detectUnsupported(src: Obj, groups: Obj[], ads: Obj[]): string[] {
  return analyzeScope(src, groups, ads).blockers;
}

/** Targeting is filtered by targeting_optimization_mode (doc: Available targeting settings for different targeting optimization modes). */
function cleanTargeting(g: Obj, body: Obj, path: string, dropped: string[], warnings: string[], strictDm = false): Obj {
  const raw = (g.targeting_spec && typeof g.targeting_spec === 'object' ? g.targeting_spec : {}) as Obj;
  const mode = String(body.targeting_optimization_mode ?? 'AUTOMATIC');
  const allow: readonly string[] =
    mode === 'MANUAL' ? (strictDm ? DM_TARGETING_MANUAL_ALLOW : TARGETING_ALLOW) : body.suggestion_audience_enabled === true ? TARGETING_AUTOMATIC_SUGGESTIONS_ALLOW : TARGETING_AUTOMATIC_ALLOW;
  const out = pick(raw, allow, `${path}.targeting_spec`, dropped);
  if (mode !== 'MANUAL' && Object.keys(raw).some((k) => !allow.includes(k) && raw[k] !== null && !(Array.isArray(raw[k]) && (raw[k] as unknown[]).length === 0))) {
    warnings.push(`${path}.targeting_spec: AUTOMATIC targeting${body.suggestion_audience_enabled === true ? ' (with suggestions)' : ''} only accepts ${allow.join(', ')}; other returned values (server defaults such as age_groups/gender/spending_power) were not sent`);
  }
  return out;
}

/** Copy only allowlisted keys; record every other key (path.key) in `dropped`. Null / '' / [] are treated as unset. */
function pick(src: Obj, allow: readonly string[], path: string, dropped: string[]): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(src)) {
    if (!allow.includes(k)) {
      dropped.push(`${path}.${k}`);
      continue;
    }
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

function cleanCreatives(list: unknown, path: string, dropped: string[], warnings: string[], strictDm = false): Obj[] {
  if (!Array.isArray(list)) return [];
  const out: Obj[] = [];
  for (const [i, raw] of list.entries()) {
    const c = raw as Obj;
    if (c.material_operation_status === 'DISABLE') {
      warnings.push(`${path}.creative_list[${i}] skipped: material_operation_status=DISABLE`);
      continue;
    }
    for (const k of Object.keys(c)) if (k !== 'creative_info') dropped.push(`${path}.creative_list[].${k}`); // ad_material_id, smart_plus_creative_id, material_operation_status
    const ci = (c.creative_info ?? {}) as Obj;
    const cpath = `${path}.creative_list[].creative_info`;
    if (!strictDm) {
      out.push({ creative_info: pick(ci, CREATIVE_INFO_ALLOW, cpath, dropped) });
      continue;
    }
    // strict DM: pulled post (tiktok_item_id) => only format + post + identity; pushed video/carousel => media objects reduced to their documented ids
    const pull = !!ci.tiktok_item_id;
    const info = pick(ci, pull ? DM_CREATIVE_PULL_ALLOW : DM_CREATIVE_PUSH_ALLOW, cpath, dropped);
    if (!pull) {
      if (ci.ad_format === 'CAROUSEL_ADS' && ci.material_name) info.material_name = ci.material_name; // doc: valid only for CAROUSEL_ADS
      if (info.video_info && typeof info.video_info === 'object') info.video_info = pick(info.video_info as Obj, ['video_id'], `${cpath}.video_info`, dropped);
      if (Array.isArray(info.image_info)) info.image_info = (info.image_info as Obj[]).map((x) => pick(x, ['web_uri'], `${cpath}.image_info[]`, dropped));
      if (info.music_info && typeof info.music_info === 'object') info.music_info = pick(info.music_info as Obj, ['music_id'], `${cpath}.music_info`, dropped);
    }
    out.push({ creative_info: info });
  }
  return out;
}

export function isDeleted(o: Obj): boolean {
  return o.operation_status === 'DELETE' || o.effective_status === 'DELETED' || o.operation_status === 'DELETED';
}

/**
 * Source schedules may already be in the past. TODO(UNVERIFIED): how TikTok treats a past start time on create
 * (the copy doc says up to 12h in the past is accepted). We move a past start to now+60s and keep the duration.
 */
function fixPastSchedule(body: Obj, now: Date, path: string, warnings: string[]): void {
  const start = parseUtc(body.schedule_start_time);
  const floor = new Date(now.getTime() + 60_000);
  if (!start || start >= floor) return;
  const old = String(body.schedule_start_time);
  body.schedule_start_time = formatUtc(floor);
  warnings.push(`${path}: source schedule_start_time ${old} was in the past; moved to now+60s`);
  if (body.schedule_type === 'SCHEDULE_START_END') {
    const end = parseUtc(body.schedule_end_time);
    if (!end || end <= floor) {
      throw new InputValidationError([`${path}: source schedule already ended; pass schedule_type/schedule_start_time/schedule_end_time to set a new one`]);
    }
  }
}

function parseUtc(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function enforceRecreateSafety(p: CreatePayloads, opts: RecreateOptions): void {
  const statuses = [p.campaign.operation_status, ...p.adgroups.flatMap((g) => [g.adgroup.operation_status, ...g.ads.map((a) => a.operation_status)])];
  if (statuses.includes('ENABLE') && !opts.allowEnable) throw new SafetyError('ENABLE requested without options.allowEnable');
  if (opts.maxBudget !== undefined) {
    const budgets = [p.campaign.budget, ...p.adgroups.map((g) => g.adgroup.budget)].filter((b): b is number => typeof b === 'number');
    const over = budgets.find((b) => b > opts.maxBudget!);
    if (over !== undefined) throw new SafetyError(`Budget ${over} exceeds options.maxBudget ${opts.maxBudget}`);
  }
}

/** Paginated GET on the three smart_plus *get endpoints (data.list + data.page_info.total_page). */
export async function fetchAll(client: TikTokClient, path: string, advertiser_id: string, filtering: Obj, pageSize: number): Promise<Obj[]> {
  const out: Obj[] = [];
  for (let page = 1; ; page++) {
    const res = await client.get<{ list?: Obj[]; page_info?: { total_page?: number } }>(path, { advertiser_id, filtering, page, page_size: pageSize });
    out.push(...(res.data?.list ?? []));
    const totalPages = res.data?.page_info?.total_page ?? 1;
    if (page >= totalPages) break;
  }
  return out;
}
