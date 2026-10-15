import type { TikTokClient } from './client.js';
import { TikTokApiError, TikTokError, TikTokProtocolError } from './errors.js';
import { emitAudit, type AuditSink } from './audit.js';
import { compact, formatUtc, generateRequestId, InputValidationError, SafetyError } from './util.js';
import {
  CreateSmartPlusInputSchema,
  DM_CALL_TO_ACTION,
  PROMOTION_TYPE_TT_DM,
  PROMOTION_TYPE_WEB,
  type CreateSmartPlusInput,
  type ObjectiveType,
  type ParsedAd,
  type ParsedAdGroup,
  type ParsedCreateInput,
} from './schemas.js';
import { setCampaignStatus } from './status.js';

export interface CreateOptions {
  /** Return the payloads that WOULD be sent (no network). */
  dryRun?: boolean;
  /** Needed to create with operation_status ENABLE anywhere. Default false => any ENABLE is rejected. */
  allowEnable?: boolean;
  /**
   * If a step fails after the campaign exists, DELETE the campaign (status update). Default false:
   * we only return a rollback hint and the created IDs.
   * TODO(UNVERIFIED): whether DELETE on a campaign cascades to its ad groups/ads (expected, not confirmed).
   */
  rollbackOnFailure?: boolean;
  /** Safety cap: reject if any budget/budget-limit in the input exceeds this number (account currency). */
  maxBudget?: number;
  audit?: AuditSink;
  /** Who triggered it (e.g. telegram user id) - copied into audit events. */
  actor?: string;
  now?: () => Date;
}

export type CreateStep = 'campaign' | 'adgroup' | 'ad';

export interface CreatedAd {
  smart_plus_ad_id: string;
  ad_name?: string | undefined;
}
export interface CreatedAdGroup {
  adgroup_id: string;
  adgroup_name: string;
  ads: CreatedAd[];
}

export interface RollbackHint {
  /** What you can call to undo what was created. */
  hint: string;
  suggested_call: { path: string; body: Record<string, unknown> };
  performed: boolean;
  error?: string;
}

export interface CreateResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'DRY_RUN';
  advertiser_id: string;
  campaign_id?: string | undefined;
  adgroups: CreatedAdGroup[];
  /** Flat lists, handy for status updates / persisting. */
  ids: { campaign_id?: string | undefined; adgroup_ids: string[]; smart_plus_ad_ids: string[] };
  error?: {
    step: CreateStep;
    adgroup_index?: number | undefined;
    ad_index?: number | undefined;
    message: string;
    code?: number | undefined;
    request_id?: string | undefined;
  };
  rollback?: RollbackHint;
  /** Only for dryRun. */
  payloads?: CreatePayloads;
}

/** Index-aligned state for continuing a partial run: entries are skipped when present (holes/undefined = create). */
export interface ResumeState {
  campaign_id?: string | undefined;
  adgroups?: ({ adgroup_id: string; smart_plus_ad_ids: (string | undefined)[] } | undefined)[] | undefined;
}

export interface CreatePayloads {
  campaign: Record<string, unknown>;
  adgroups: { adgroup: Record<string, unknown>; ads: Record<string, unknown>[] }[];
}

/** Pure function: validate input and build the exact request bodies (campaign_id / adgroup_id are placeholders). */
export function buildCreatePayloads(rawInput: CreateSmartPlusInput, opts: CreateOptions = {}): { input: ParsedCreateInput; payloads: CreatePayloads } {
  const parsed = CreateSmartPlusInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new InputValidationError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const input = parsed.data;
  enforceSafety(input, opts);
  const now = opts.now?.() ?? new Date();
  const key = input.idempotencyKey;
  const seed = (suffix: string) => (key ? `${input.advertiser_id}|${key}|${suffix}` : undefined);

  const { campaign } = input;
  const objective = campaign.objective_type;
  const campaignBody = compact({
    ...campaign,
    advertiser_id: input.advertiser_id,
    request_id: generateRequestId(seed('campaign')),
    objective_type: objective,
    // immutable after creation. LEAD_GENERATION has no sales_destination.
    sales_destination: objective === 'WEB_CONVERSIONS' ? 'WEBSITE' : undefined,
  });

  const adgroups = input.adgroups.map((g, gi) => {
    const adgroup = buildAdGroupBody(g, {
      advertiser_id: input.advertiser_id,
      campaign_id: '<campaign_id>',
      request_id: generateRequestId(seed(`adgroup|${gi}`)),
      now,
      objective,
    });
    const ads = g.ads.map((a) => buildAdBody(a, { advertiser_id: input.advertiser_id, adgroup_id: '<adgroup_id>', objective }));
    return { adgroup, ads };
  });
  return { input, payloads: { campaign: campaignBody, adgroups } };
}

export function buildAdGroupBody(
  g: ParsedAdGroup,
  ctx: { advertiser_id: string; campaign_id: string; request_id: string; now: Date; objective?: ObjectiveType },
): Record<string, unknown> {
  const { ads: _ads, ...rest } = g;
  void _ads;
  const dm = ctx.objective === 'LEAD_GENERATION';
  return compact({
    ...rest,
    promotion_type: g.promotion_type ?? (dm ? PROMOTION_TYPE_TT_DM : PROMOTION_TYPE_WEB),
    // Doc table for TikTok Direct Messages: placement TikTok only.
    placement_type: g.placement_type ?? (dm ? 'PLACEMENT_TYPE_NORMAL' : undefined),
    placements: g.placements ?? (dm ? ['PLACEMENT_TIKTOK'] : undefined),
    advertiser_id: ctx.advertiser_id,
    request_id: ctx.request_id,
    campaign_id: ctx.campaign_id,
    billing_event: g.billing_event ?? (g.optimization_goal === 'CLICK' ? 'CPC' : 'OCPM'),
    schedule_start_time: g.schedule_start_time ?? formatUtc(new Date(ctx.now.getTime() + 60_000)),
  });
}

export function buildAdBody(a: ParsedAd, ctx: { advertiser_id: string; adgroup_id: string; objective?: ObjectiveType }): Record<string, unknown> {
  const { utm_params, call_to_action_id, ad_configuration, ...rest } = a;
  const cfg = compact({ ...(ad_configuration ?? {}), utm_params, call_to_action_id });
  const dm = ctx.objective === 'LEAD_GENERATION';
  // NOTE: /smart_plus/ad/create/ has NO request_id parameter => not idempotent.
  return compact({
    ...rest,
    // The official DM example sends exactly [{"call_to_action":"SEND_MESSAGE"}] (and no call_to_action_id).
    call_to_action_list: a.call_to_action_list ?? (dm ? [{ call_to_action: DM_CALL_TO_ACTION }] : undefined),
    advertiser_id: ctx.advertiser_id,
    adgroup_id: ctx.adgroup_id,
    ad_configuration: Object.keys(cfg).length ? cfg : undefined,
  });
}

/**
 * Creates an Upgraded Smart+ campaign (WEB_CONVERSIONS, or LEAD_GENERATION with TikTok Direct Messages):
 * campaign -> ad groups -> ads (3 endpoint families).
 * Never throws for API/network failures after validation: returns what was created + `error` + `rollback` hint.
 * Throws InputValidationError / SafetyError before any network call.
 */
export async function createSmartPlusCampaign(
  client: TikTokClient,
  rawInput: CreateSmartPlusInput,
  opts: CreateOptions = {},
): Promise<CreateResult> {
  const { input, payloads } = buildCreatePayloads(rawInput, opts);
  if (opts.dryRun) {
    return { status: 'DRY_RUN', advertiser_id: input.advertiser_id, adgroups: [], ids: { adgroup_ids: [], smart_plus_ad_ids: [] }, payloads };
  }
  return executeCreatePayloads(client, input.advertiser_id, payloads, opts, input.resume);
}

/** Kept for backwards compatibility: same function, now objective-aware (campaign.objective_type). */
export const createSmartPlusWebCampaign = createSmartPlusCampaign;

/**
 * Runs already-built payloads (used by createSmartPlusWebCampaign and by clone-by-recreate, which builds
 * payloads from GET responses and must bypass the strict zod input schema).
 * Stops at the first failing call.
 */
export async function executeCreatePayloads(
  client: TikTokClient,
  advertiser_id: string,
  payloads: CreatePayloads,
  opts: CreateOptions = {},
  resume?: ResumeState,
): Promise<CreateResult> {
  const result: CreateResult = {
    status: 'FAILED',
    advertiser_id,
    adgroups: [],
    ids: { adgroup_ids: [], smart_plus_ad_ids: [] },
  };

  const audit = (action: string, request: unknown, response: unknown, ok: boolean) =>
    emitAudit(opts.audit, { action, advertiser_id, actor: opts.actor, request, response, ok });

  let step: CreateStep = 'campaign';
  let gi: number | undefined;
  let ai: number | undefined;
  try {
    /* ---- 1) campaign */
    let campaign_id = resume?.campaign_id;
    if (!campaign_id) {
      const res = await client.post<{ campaign_id?: string }>('/smart_plus/campaign/create/', payloads.campaign, { idempotent: true });
      // TODO(UNVERIFIED): response field name. Doc's Response section only shows the standard envelope; `data.campaign_id` assumed.
      campaign_id = res.data?.campaign_id;
      if (!campaign_id) throw new TikTokProtocolError('campaign create succeeded but data.campaign_id is missing');
      await audit('smartplus.create.campaign', payloads.campaign, { campaign_id, request_id: res.request_id }, true);
    }
    result.campaign_id = campaign_id;
    result.ids.campaign_id = campaign_id;

    /* ---- 2) ad groups, 3) ads */
    for (gi = 0; gi < payloads.adgroups.length; gi++) {
      step = 'adgroup';
      ai = undefined;
      const plan = payloads.adgroups[gi]!;
      const resumed = resume?.adgroups?.[gi];
      let adgroup_id = resumed?.adgroup_id;
      if (!adgroup_id) {
        const body = { ...plan.adgroup, campaign_id };
        const res = await client.post<{ adgroup_id?: string }>('/smart_plus/adgroup/create/', body, { idempotent: true });
        adgroup_id = res.data?.adgroup_id;
        if (!adgroup_id) throw new TikTokProtocolError('adgroup create succeeded but data.adgroup_id is missing');
        await audit('smartplus.create.adgroup', body, { adgroup_id, request_id: res.request_id }, true);
      }
      const created: CreatedAdGroup = { adgroup_id, adgroup_name: String(plan.adgroup.adgroup_name ?? ''), ads: [] };
      result.adgroups.push(created);
      result.ids.adgroup_ids.push(adgroup_id);

      step = 'ad';
      const alreadyAds = resumed?.smart_plus_ad_ids ?? [];
      for (ai = 0; ai < plan.ads.length; ai++) {
        const existing = alreadyAds[ai];
        if (existing) {
          created.ads.push({ smart_plus_ad_id: existing });
          result.ids.smart_plus_ad_ids.push(existing);
          continue;
        }
        const body = { ...plan.ads[ai]!, adgroup_id };
        // Not idempotent (no request_id) => NO automatic retry on network errors / 5xx.
        const res = await client.post<{ smart_plus_ad_id?: string; ad_name?: string }>('/smart_plus/ad/create/', body, { idempotent: false });
        const adId = res.data?.smart_plus_ad_id;
        if (!adId) throw new TikTokProtocolError('ad create succeeded but data.smart_plus_ad_id is missing');
        created.ads.push({ smart_plus_ad_id: adId, ad_name: res.data.ad_name });
        result.ids.smart_plus_ad_ids.push(adId);
        await audit('smartplus.create.ad', body, { smart_plus_ad_id: adId, request_id: res.request_id }, true);
      }
    }
    result.status = 'SUCCESS';
    return result;
  } catch (e) {
    const err = e instanceof TikTokError ? e : new TikTokError(String(e), { cause: e });
    result.error = {
      step,
      adgroup_index: step === 'campaign' ? undefined : gi,
      ad_index: step === 'ad' ? ai : undefined,
      message: err.message,
      code: err instanceof TikTokApiError ? err.code : undefined,
      request_id: err instanceof TikTokApiError ? err.requestId : undefined,
    };
    await audit(`smartplus.create.${step}`, undefined, result.error, false);
    result.status = result.campaign_id ? 'PARTIAL' : 'FAILED';

    if (result.campaign_id) {
      const body = { advertiser_id, campaign_ids: [result.campaign_id], operation_status: 'DELETE' };
      result.rollback = {
        hint:
          `Created so far: campaign ${result.campaign_id}, ${result.ids.adgroup_ids.length} ad group(s), ${result.ids.smart_plus_ad_ids.length} ad(s). ` +
          `Everything is DISABLED unless you changed that. Either delete the campaign (suggested_call) or fix the input and re-run with ` +
          `\`resume\` set to the IDs in result.ids to continue without duplicating.`,
        suggested_call: { path: '/smart_plus/campaign/status/update/', body },
        performed: false,
      };
      if (opts.rollbackOnFailure) {
        try {
          await setCampaignStatus(client, advertiser_id, [result.campaign_id], 'DELETE', { audit: opts.audit, actor: opts.actor });
          result.rollback.performed = true;
        } catch (re) {
          result.rollback.error = re instanceof Error ? re.message : String(re);
        }
      }
    }
    return result;
  }
}

function enforceSafety(input: ParsedCreateInput, opts: CreateOptions): void {
  const statuses = [input.campaign.operation_status, ...input.adgroups.flatMap((g) => [g.operation_status, ...g.ads.map((a) => a.operation_status)])];
  if (statuses.includes('ENABLE') && !opts.allowEnable) {
    throw new SafetyError('operation_status ENABLE requested but options.allowEnable is not true. Create as DISABLE, then enable after human confirmation.');
  }
  if (opts.maxBudget !== undefined) {
    const budgets = [input.campaign.budget, ...input.adgroups.map((g) => g.budget)].filter((b): b is number => typeof b === 'number');
    const over = budgets.find((b) => b > opts.maxBudget!);
    if (over !== undefined) throw new SafetyError(`Budget ${over} exceeds options.maxBudget ${opts.maxBudget}`);
  }
}
