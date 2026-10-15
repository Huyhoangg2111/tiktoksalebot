import { z } from 'zod';

/**
 * Zod schemas for the Upgraded Smart+ create flow. Supported variants:
 *   - WEB_CONVERSIONS + sales_destination WEBSITE
 *   - LEAD_GENERATION with optimization location "TikTok direct messages"
 *     (ad group promotion_type LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE, non-catalog)
 * Docs for the lead-gen variant (read 2026-10-15):
 *   https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-lead-generation-campaign-with-optimization-location-as-tiktok-direct-messages/v1.3
 * Field names / enums were checked on 2026-10-15 against the official doc pages
 *   create-an-upgraded-smart-campaign, create-an-upgraded-smart-ad-group, create-an-upgraded-smart-ad (v1.3)
 * and the official SDK OpenAPI files (tiktok-business-api-sdk/yml_files/smart_plus_*.yml).
 * Objects are `.passthrough()` so rarely used documented fields can be passed without changing this file;
 * passthrough fields are NOT validated.
 */

const nonEmpty = z.string().min(1);
export const UtcDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'expected "YYYY-MM-DD HH:MM:SS" (UTC)');
export const NumericId = z.string().regex(/^\d+$/, 'must be a numeric string');

/* ------------------------------------------------------------- creative / ad */

export const IDENTITY_TYPES = ['AUTH_CODE', 'TT_USER', 'BC_AUTH_TT'] as const;

export const CreativeInfoSchema = z
  .object({
    ad_format: z.enum(['SINGLE_VIDEO', 'CAROUSEL_ADS', 'CATALOG_CAROUSEL']),
    material_name: z.string().optional(),
    video_info: z.object({ video_id: nonEmpty, file_name: z.string().optional() }).passthrough().optional(),
    image_info: z.array(z.object({ web_uri: nonEmpty }).passthrough()).max(35).optional(),
    music_info: z.object({ music_id: nonEmpty }).passthrough().optional(),
    aigc_disclosure_type: z.enum(['SELF_DISCLOSURE', 'NOT_DECLARED']).optional(),
    tiktok_item_id: nonEmpty.optional(),
    identity_type: z.enum(IDENTITY_TYPES).optional(),
    identity_id: nonEmpty.optional(),
    identity_authorized_bc_id: nonEmpty.optional(),
  })
  .passthrough()
  .superRefine((c, ctx) => {
    const add = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path });
    if (c.tiktok_item_id) {
      // Spark Ads (Pull): identity is required.
      if (!c.identity_type || !c.identity_id) add('identity_type and identity_id are required with tiktok_item_id (Spark Ads)');
    } else if (c.ad_format === 'SINGLE_VIDEO') {
      if (!c.video_info) add('SINGLE_VIDEO needs video_info.video_id (or tiktok_item_id)', ['video_info']);
    } else if (c.ad_format === 'CAROUSEL_ADS') {
      if (!c.image_info?.length) add('CAROUSEL_ADS needs image_info[] (or tiktok_item_id)', ['image_info']);
      if (!c.music_info) add('CAROUSEL_ADS needs music_info.music_id (or tiktok_item_id)', ['music_info']);
    }
    // TODO(UNVERIFIED): CATALOG_CAROUSEL requires catalog_enabled at campaign level - not supported by this module.
    if (c.identity_type === 'BC_AUTH_TT' && !c.identity_authorized_bc_id) {
      add('identity_authorized_bc_id is required when identity_type is BC_AUTH_TT', ['identity_authorized_bc_id']);
    }
  });

export const UtmParamSchema = z.object({ key: nonEmpty.max(100), value: nonEmpty.max(600) });

export const AdSchema = z
  .object({
    ad_name: z.string().max(512).optional(),
    /** Default DISABLE (API default would be ENABLE). */
    operation_status: z.enum(['ENABLE', 'DISABLE']).default('DISABLE'),
    creative_list: z.array(z.object({ creative_info: CreativeInfoSchema })).min(1).max(50),
    ad_text_list: z.array(z.object({ ad_text: nonEmpty })).max(5).optional(),
    call_to_action_list: z.array(z.object({ call_to_action: nonEmpty })).max(3).optional(),
    landing_page_url_list: z.array(z.object({ landing_page_url: z.string().url() })).max(1).optional(),
    /**
     * TikTok Direct Messages (LEAD_GENERATION): welcome message from /creative/auto_message/get/ (max 1).
     * REQUIRED when the ad group promotion_type is LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE.
     */
    auto_message_list: z.array(z.object({ auto_message_id: nonEmpty })).max(1).optional(),
    /** Convenience: goes to ad_configuration.utm_params (max 14). Macros e.g. CAMPAIGN_ID, AID, CID are documented. */
    utm_params: z.array(UtmParamSchema).max(14).optional(),
    /** Convenience: goes to ad_configuration.call_to_action_id (CTA portfolio / dynamic CTA). */
    call_to_action_id: nonEmpty.optional(),
    ad_configuration: z.object({}).passthrough().optional(),
  })
  .passthrough()
  .superRefine((ad, ctx) => {
    const allSpark = ad.creative_list.every((c) => !!c.creative_info.tiktok_item_id);
    if (!allSpark && !ad.ad_text_list?.length) {
      ctx.addIssue({ code: 'custom', path: ['ad_text_list'], message: 'ad_text_list is required when a creative has no tiktok_item_id' });
    }
  });

/* ------------------------------------------------------------- ad group */

export const OPTIMIZATION_GOALS = ['CLICK', 'CONVERT', 'TRAFFIC_LANDING_PAGE_VIEW', 'VALUE', 'CONVERSATION'] as const;
/** Goals valid for LEAD_GENERATION + TikTok Direct Messages (doc: CLICK or CONVERSATION). */
export const LEAD_GEN_DM_GOALS = ['CLICK', 'CONVERSATION'] as const;

export const OBJECTIVE_TYPES = ['WEB_CONVERSIONS', 'LEAD_GENERATION'] as const;
export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number];
export const PROMOTION_TYPE_WEB = 'WEBSITE';
export const PROMOTION_TYPE_TT_DM = 'LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE';
/** Welcome-message CTA used in the official DM example. */
export const DM_CALL_TO_ACTION = 'SEND_MESSAGE';
export const BUDGET_MODES = ['BUDGET_MODE_DYNAMIC_DAILY_BUDGET', 'BUDGET_MODE_TOTAL', 'BUDGET_MODE_DAY', 'BUDGET_MODE_INFINITE'] as const;

export const AdGroupSchema = z
  .object({
    adgroup_name: nonEmpty.max(512),
    operation_status: z.enum(['ENABLE', 'DISABLE']).default('DISABLE'),
    /** Derived from campaign.objective_type when omitted: WEBSITE, or LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE. */
    promotion_type: z.enum([PROMOTION_TYPE_WEB, PROMOTION_TYPE_TT_DM]).optional(),
    optimization_goal: z.enum(OPTIMIZATION_GOALS),
    pixel_id: nonEmpty.optional(), // from GET /pixel/list/
    optimization_event: nonEmpty.optional(), // e.g. a pixel standard event; see "Conversion events" doc
    custom_conversion_id: nonEmpty.optional(),
    /**
     * TikTok account used in TikTok Direct Messaging Ads at AD GROUP level. ALLOWLIST-ONLY feature per doc.
     * Without the allowlist, put the identity in each creative_info instead.
     */
    identity_type: z.enum(['TT_USER', 'BC_AUTH_TT']).optional(),
    identity_id: nonEmpty.optional(),
    identity_authorized_bc_id: nonEmpty.optional(),
    bid_type: z.enum(['BID_TYPE_NO_BID', 'BID_TYPE_CUSTOM']).default('BID_TYPE_NO_BID'),
    bid_price: z.number().positive().optional(), // CLICK + CUSTOM
    conversion_bid_price: z.number().positive().optional(), // CONVERT/TRAFFIC_LANDING_PAGE_VIEW/CONVERSATION + CUSTOM (= target cost per result)
    deep_bid_type: z.enum(['DEFAULT', 'AEO', 'VO_MIN_ROAS', 'VO_HIGHEST_VALUE']).optional(), // VALUE
    roas_bid: z.number().positive().optional(), // VO_MIN_ROAS
    /** Derived when omitted: CLICK -> CPC, otherwise OCPM (documented rule, also for CONVERSATION). */
    billing_event: z.enum(['CPC', 'OCPM']).optional(),
    schedule_type: z.enum(['SCHEDULE_FROM_NOW', 'SCHEDULE_START_END']).default('SCHEDULE_FROM_NOW'),
    /** UTC. Default: now + 60s at build time. TODO(UNVERIFIED): minimum lead time TikTok accepts. */
    schedule_start_time: UtcDateTime.optional(),
    schedule_end_time: UtcDateTime.optional(),
    dayparting: z.string().regex(/^[01]{336}$/, '48 x 7 chars of 0/1').optional(),
    targeting_optimization_mode: z.enum(['AUTOMATIC', 'MANUAL']).optional(),
    suggestion_audience_enabled: z.boolean().optional(),
    /** Required by the API (object). Common keys: location_ids, age_groups, gender, languages, audience_ids... */
    targeting_spec: z.record(z.unknown()).default({}),
    placement_type: z.enum(['PLACEMENT_TYPE_AUTOMATIC', 'PLACEMENT_TYPE_NORMAL']).optional(),
    placements: z.array(z.enum(['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE', 'PLACEMENT_GLOBAL_APP_BUNDLE'])).optional(),
    /** Only when CBO is OFF at campaign level (budget_optimize_on=false). Ignored by API otherwise. */
    budget_mode: z.enum(BUDGET_MODES).optional(),
    budget: z.number().positive().optional(),
    ads: z.array(AdSchema).min(1).max(30),
  })
  .passthrough()
  .superRefine((g, ctx) => {
    const add = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
    const goalNeedsPixel = g.optimization_goal === 'CONVERT' || g.optimization_goal === 'VALUE';
    if (goalNeedsPixel && !g.pixel_id) add('pixel_id is required for CONVERT/VALUE (get it from /pixel/list/)', ['pixel_id']);
    if (!goalNeedsPixel && g.pixel_id) add('pixel_id is not supported for CLICK/TRAFFIC_LANDING_PAGE_VIEW', ['pixel_id']);
    if ((g.pixel_id || g.optimization_goal === 'VALUE') && !g.optimization_event) {
      add('optimization_event is required when pixel_id is set (or goal is VALUE)', ['optimization_event']);
    }
    if (g.bid_type === 'BID_TYPE_CUSTOM') {
      if (g.optimization_goal === 'CLICK' && g.bid_price === undefined) add('bid_price required for CLICK + BID_TYPE_CUSTOM', ['bid_price']);
      if (
        (g.optimization_goal === 'CONVERT' || g.optimization_goal === 'TRAFFIC_LANDING_PAGE_VIEW' || g.optimization_goal === 'CONVERSATION') &&
        g.conversion_bid_price === undefined
      ) {
        add('conversion_bid_price required for CONVERT/TRAFFIC_LANDING_PAGE_VIEW/CONVERSATION + BID_TYPE_CUSTOM', ['conversion_bid_price']);
      }
    }
    if (g.optimization_goal === 'VALUE') {
      if (!g.deep_bid_type) add('deep_bid_type is required when optimization_goal is VALUE', ['deep_bid_type']);
      if (g.deep_bid_type === 'VO_MIN_ROAS' && g.roas_bid === undefined) add('roas_bid required for VO_MIN_ROAS', ['roas_bid']);
    }
    if (g.schedule_type === 'SCHEDULE_START_END' && !g.schedule_end_time) add('schedule_end_time required for SCHEDULE_START_END', ['schedule_end_time']);
    if (g.schedule_type === 'SCHEDULE_FROM_NOW' && g.schedule_end_time) add('schedule_end_time must not be set with SCHEDULE_FROM_NOW', ['schedule_end_time']);
    if (g.placement_type === 'PLACEMENT_TYPE_NORMAL' && !g.placements?.length) add('placements required for PLACEMENT_TYPE_NORMAL', ['placements']);
    if (g.identity_type === 'BC_AUTH_TT' && !g.identity_authorized_bc_id) add('identity_authorized_bc_id is required when identity_type is BC_AUTH_TT', ['identity_authorized_bc_id']);
    if (g.identity_type && !g.identity_id) add('identity_id is required with identity_type', ['identity_id']);
  });

/* ------------------------------------------------------------- campaign + whole input */

export const CampaignSchema = z
  .object({
    campaign_name: nonEmpty.max(512),
    /** WEB_CONVERSIONS (default, + sales_destination WEBSITE) or LEAD_GENERATION (TikTok Direct Messages only). */
    objective_type: z.enum(OBJECTIVE_TYPES).default('WEB_CONVERSIONS'),
    /** Catalog is NOT supported by this module. */
    catalog_enabled: z.literal(false).optional(),
    /** Default DISABLE (API default would be ENABLE!). ENABLE needs `allowEnable: true` in options. */
    operation_status: z.enum(['ENABLE', 'DISABLE']).default('DISABLE'),
    /** CBO. API default true. */
    budget_optimize_on: z.boolean().default(true),
    budget_mode: z.enum(BUDGET_MODES).optional(),
    budget: z.number().positive().optional(),
    budget_auto_adjust_strategy: z.literal('AUTO_BUDGET_INCREASE').optional(), // allowlist-only feature
    special_industries: z.array(z.enum(['HOUSING', 'EMPLOYMENT', 'CREDIT'])).optional(),
    po_number: z.string().optional(),
  })
  .passthrough();

export const CreateSmartPlusInputSchema = z
  .object({
    advertiser_id: NumericId,
    /**
     * Seeds the 64-bit `request_id`s (campaign + each ad group) so re-running the SAME logical request is
     * idempotent for those two levels. Use e.g. the Telegram callback id. Ads have NO request_id in the API.
     */
    idempotencyKey: z.string().min(1).optional(),
    campaign: CampaignSchema,
    // TODO(UNVERIFIED): max ad groups per campaign on create. 10 is the documented limit for copy sources.
    adgroups: z.array(AdGroupSchema).min(1).max(10),
    /** Continue a previously failed run: skip steps whose IDs you already have. */
    resume: z
      .object({
        campaign_id: NumericId.optional(),
        adgroups: z.array(z.object({ adgroup_id: NumericId, smart_plus_ad_ids: z.array(NumericId).default([]) })).optional(),
      })
      .optional(),
  })
  .superRefine((inp, ctx) => {
    const add = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
    const c = inp.campaign;
    if (c.budget_optimize_on) {
      // CBO on: campaign budget is required (default mode is DYNAMIC_DAILY_BUDGET).
      if (c.budget === undefined) add('campaign.budget is required when budget_optimize_on is true', ['campaign', 'budget']);
      if (c.budget_mode === 'BUDGET_MODE_INFINITE' || c.budget_mode === 'BUDGET_MODE_DAY') {
        add('with CBO on, budget_mode must be BUDGET_MODE_DYNAMIC_DAILY_BUDGET or BUDGET_MODE_TOTAL', ['campaign', 'budget_mode']);
      }
    } else {
      if (c.budget_mode && c.budget_mode !== 'BUDGET_MODE_INFINITE' && c.budget === undefined) {
        add('campaign.budget required for this budget_mode', ['campaign', 'budget']);
      }
      inp.adgroups.forEach((g, i) => {
        if (!g.budget_mode) add('adgroup.budget_mode is required when CBO is off', ['adgroups', i, 'budget_mode']);
        if (g.budget === undefined) add('adgroup.budget is required when CBO is off', ['adgroups', i, 'budget']);
      });
    }
    const dynamicDaily = (mode?: string, cbo?: boolean) => (cbo ? (mode ?? 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET') === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET' : mode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET');
    inp.adgroups.forEach((g, i) => {
      if (g.schedule_type === 'SCHEDULE_FROM_NOW') {
        const mode = c.budget_optimize_on ? c.budget_mode : g.budget_mode;
        if (!dynamicDaily(mode, c.budget_optimize_on)) {
          add('SCHEDULE_FROM_NOW is only allowed with BUDGET_MODE_DYNAMIC_DAILY_BUDGET; use SCHEDULE_START_END', ['adgroups', i, 'schedule_type']);
        }
      }
    });

    if (c.objective_type === 'WEB_CONVERSIONS') {
      inp.adgroups.forEach((g, i) => {
        if (g.promotion_type && g.promotion_type !== PROMOTION_TYPE_WEB) add(`promotion_type ${g.promotion_type} does not match objective WEB_CONVERSIONS`, ['adgroups', i, 'promotion_type']);
        if (g.optimization_goal === 'CONVERSATION') add('optimization_goal CONVERSATION is only for LEAD_GENERATION (TikTok Direct Messages)', ['adgroups', i, 'optimization_goal']);
        g.ads.forEach((a, j) => {
          if (a.auto_message_list?.length) add('auto_message_list is only for TikTok Direct Messaging Ads (LEAD_GENERATION)', ['adgroups', i, 'ads', j, 'auto_message_list']);
        });
      });
    } else {
      validateLeadGenDm(inp, add);
    }
  });


type AddIssue = (message: string, path: (string | number)[]) => void;

/**
 * Rules for LEAD_GENERATION + TikTok Direct Messages (non-catalog). Source: the "optimization location as TikTok direct
 * messages" guide + create endpoints (read 2026-10-15). Everything here is checked on OUR side only; the API may reject more.
 */
function validateLeadGenDm(
  inp: { campaign: z.output<typeof CampaignSchema>; adgroups: z.output<typeof AdGroupSchema>[] },
  add: AddIssue,
): void {
  const c = inp.campaign;
  const cbo = c.budget_optimize_on;
  if (c.budget_auto_adjust_strategy && !(cbo && c.budget_mode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET')) {
    add('budget_auto_adjust_strategy AUTO_BUDGET_INCREASE at campaign level needs CBO on and budget_mode BUDGET_MODE_DYNAMIC_DAILY_BUDGET (allowlist-only feature)', ['campaign', 'budget_auto_adjust_strategy']);
  }
  const first = inp.adgroups[0];
  inp.adgroups.forEach((g, i) => {
    const p = ['adgroups', i];
    if (g.promotion_type && g.promotion_type !== PROMOTION_TYPE_TT_DM) add(`promotion_type must be ${PROMOTION_TYPE_TT_DM} for LEAD_GENERATION here (instant messaging apps / lead form / call are not supported)`, [...p, 'promotion_type']);
    if (!(LEAD_GEN_DM_GOALS as readonly string[]).includes(g.optimization_goal)) add('optimization_goal must be CLICK or CONVERSATION for TikTok Direct Messages', [...p, 'optimization_goal']);
    if (g.pixel_id) add('pixel_id is not used by TikTok Direct Messaging ad groups', [...p, 'pixel_id']);
    if (g.optimization_goal === 'CONVERSATION' && g.optimization_event && g.optimization_event !== 'MESSAGE') add('with CONVERSATION omit optimization_event or set MESSAGE', [...p, 'optimization_event']);
    if (g.deep_bid_type || g.roas_bid !== undefined) add('deep_bid_type / roas_bid must not be specified for TikTok Direct Messages', [...p, 'deep_bid_type']);
    if (g.placement_type && g.placement_type !== 'PLACEMENT_TYPE_NORMAL') add('placement_type must be PLACEMENT_TYPE_NORMAL with placements ["PLACEMENT_TIKTOK"]', [...p, 'placement_type']);
    if (g.placements && (g.placements.length !== 1 || g.placements[0] !== 'PLACEMENT_TIKTOK')) add('placements must be ["PLACEMENT_TIKTOK"]', [...p, 'placements']);
    if (g.bid_type === 'BID_TYPE_CUSTOM') {
      const daily = cbo ? c.budget_mode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET' : g.budget_mode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET';
      if (!daily) add('Cost cap (BID_TYPE_CUSTOM) requires a DAILY budget (BUDGET_MODE_DYNAMIC_DAILY_BUDGET)', [...p, 'bid_type']);
    }
    if (cbo) {
      if (g.budget_mode !== undefined || g.budget !== undefined) add('with CBO on, ad group budget_mode/budget are not supported', [...p, 'budget']);
      if (first && (g.optimization_goal !== first.optimization_goal || g.bid_type !== first.bid_type || g.conversion_bid_price !== first.conversion_bid_price || g.bid_price !== first.bid_price)) {
        add('with CBO on, optimization_goal, bid_type and target cost must be identical across ad groups', [...p, 'optimization_goal']);
      }
    }
    g.ads.forEach((a, j) => {
      const ap = [...p, 'ads', j];
      if (!a.auto_message_list?.length) add('auto_message_list (welcome message id from /creative/auto_message/get/) is required for TikTok Direct Messaging Ads', [...ap, 'auto_message_list']);
      if (a.landing_page_url_list?.length) add('landing_page_url_list must not be specified for TikTok Direct Messages', [...ap, 'landing_page_url_list']);
      if (a.call_to_action_id) add('call_to_action_id must not be specified for TikTok Direct Messages (use call_to_action_list [SEND_MESSAGE], the default)', [...ap, 'call_to_action_id']);
      if (a.utm_params?.length) add('utm_params are only valid for WEB_CONVERSIONS', [...ap, 'utm_params']);
      if (a.page_list && (a.page_list as unknown[]).length) add('page_list must not be specified for TikTok Direct Messages', [...ap, 'page_list']);
      if (a.call_to_action_list?.some((x) => x.call_to_action !== DM_CALL_TO_ACTION)) add(`call_to_action_list must be [{"call_to_action":"${DM_CALL_TO_ACTION}"}] (or omitted: default)`, [...ap, 'call_to_action_list']);
      a.creative_list.forEach((cr, k) => {
        const ci = cr.creative_info;
        if (ci.ad_format === 'CATALOG_CAROUSEL') add('catalog creatives are not supported', [...ap, 'creative_list', k, 'creative_info', 'ad_format']);
        // TODO(UNVERIFIED): doc says non-Spark ads on the TikTok placement are no longer supported and every example sends identity in creative_info.
        if (!ci.identity_type && !g.identity_type) {
          add('TikTok Direct Messaging Ads need a TikTok account: set creative_info.identity_type/identity_id (or the ad group-level identity if allowlisted)', [...ap, 'creative_list', k, 'creative_info', 'identity_type']);
        }
      });
    });
  });
}

/** Backwards-compatible names (the schema now also covers LEAD_GENERATION + TikTok Direct Messages). */
export const CreateSmartPlusWebInputSchema = CreateSmartPlusInputSchema;
export type CreateSmartPlusInput = z.input<typeof CreateSmartPlusInputSchema>;
export type CreateSmartPlusWebInput = CreateSmartPlusInput;
export type ParsedCreateInput = z.output<typeof CreateSmartPlusInputSchema>;
export type ParsedAdGroup = z.output<typeof AdGroupSchema>;
export type ParsedAd = z.output<typeof AdSchema>;

/* ------------------------------------------------------------- copy */

export const CopyAdOverrideSchema = z
  .object({
    smart_plus_ad_id: NumericId, // NOTE: copy uses `smart_plus_ad_id` (not `ad_id`) in ad_list
    operation_status: z.enum(['ENABLE', 'DISABLE']).optional(),
    ad_name: z.string().max(512).optional(),
    // TODO(UNVERIFIED): the doc text says `creative_list[].creative_info` but its curl example sends a flat
    // `creative_info` on the ad. Both are accepted here and passed through as given.
    creative_list: z.array(z.object({ creative_info: CreativeInfoSchema })).max(50).optional(),
    creative_info: CreativeInfoSchema.optional(),
    ad_text_list: z.array(z.object({ ad_text: nonEmpty })).max(5).optional(),
    call_to_action_list: z.array(z.object({ call_to_action: nonEmpty })).max(3).optional(),
    landing_page_url_list: z.array(z.object({ landing_page_url: z.string().url() })).max(1).optional(),
    ad_configuration: z.object({}).passthrough().optional(), // utm_params, call_to_action_id live here
  })
  .passthrough();

export const CopyAdGroupOverrideSchema = z
  .object({
    adgroup_id: NumericId,
    operation_status: z.enum(['ENABLE', 'DISABLE']).optional(),
    adgroup_name: z.string().max(512).optional(),
    budget: z.number().positive().optional(), // only used when CBO is off on the source campaign
    min_budget: z.number().positive().optional(),
    targeting_spec: z
      .object({
        location_ids: z.array(z.string()).optional(),
        zipcode_ids: z.array(z.string()).optional(),
        audience_ids: z.array(z.string()).optional(),
        excluded_audience_ids: z.array(z.string()).optional(),
        saved_audience_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    ad_list: z.array(CopyAdOverrideSchema).min(1).max(30),
  })
  .passthrough();

export const CopyCampaignInputSchema = z
  .object({
    advertiser_id: NumericId,
    campaign_id: NumericId,
    idempotencyKey: z.string().min(1).optional(),
    /** Default DISABLE (also the API default). */
    operation_status: z.enum(['ENABLE', 'DISABLE']).default('DISABLE'),
    campaign_name: z.string().max(512).optional(), // bot always passes the exact derived name; never let TikTok default to COPIED_
    budget: z.number().positive().optional(),
    schedule_type: z.enum(['SCHEDULE_START_END', 'SCHEDULE_FROM_NOW']).optional(),
    schedule_start_time: UtcDateTime.optional(),
    schedule_end_time: UtcDateTime.optional(),
    dayparting: z.string().regex(/^[01]{336}$/).optional(),
    deep_copy_mode: z.enum(['DEFAULT', 'CUSTOM']).default('DEFAULT'),
    // TODO(UNVERIFIED): doc says "Max size: 10" for adgroup_list, but the deep_copy_mode text says up to 30 ad groups.
    adgroup_list: z.array(CopyAdGroupOverrideSchema).min(1).max(10).optional(),
  })
  .superRefine((c, ctx) => {
    const add = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
    if (c.deep_copy_mode === 'CUSTOM' && !c.adgroup_list?.length) add('adgroup_list (with ad_list) is required for CUSTOM mode', ['adgroup_list']);
    if (c.deep_copy_mode === 'DEFAULT' && c.adgroup_list?.length) add('adgroup_list is ignored by the API in DEFAULT mode; use CUSTOM', ['adgroup_list']);
    if (c.schedule_type && !c.schedule_start_time) add('schedule_start_time is required when schedule_type is set', ['schedule_start_time']);
    if (c.schedule_type === 'SCHEDULE_START_END' && !c.schedule_end_time) add('schedule_end_time is required for SCHEDULE_START_END', ['schedule_end_time']);
    if (c.schedule_type === 'SCHEDULE_FROM_NOW' && c.schedule_end_time) add('schedule_end_time is not supported with SCHEDULE_FROM_NOW', ['schedule_end_time']);
  });

export type CopyCampaignInput = z.input<typeof CopyCampaignInputSchema>;
export type ParsedCopyInput = z.output<typeof CopyCampaignInputSchema>;
