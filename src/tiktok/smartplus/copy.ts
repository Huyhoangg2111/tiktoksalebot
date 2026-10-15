import type { TikTokClient } from './client.js';
import { realSleep, type SleepFn } from './client.js';
import { looksLikeAllowlistOrPermissionDenied, TikTokApiError, TikTokError, TikTokProtocolError } from './errors.js';
import { emitAudit, type AuditSink } from './audit.js';
import { compact, generateRequestId, InputValidationError, SafetyError } from './util.js';
import { CopyCampaignInputSchema, type CopyCampaignInput, type ParsedCopyInput } from './schemas.js';
import { cloneCampaignByRecreate, type RecreateOptions, type RecreateResult } from './clone-by-recreate.js';

export interface CopyOptions {
  /** Wait before the first status check. Docs recommend ~5 min. Default 300_000. Use 0/small in tests. */
  initialWaitMs?: number;
  /** Interval between checks while RUNNING. Default 30_000. */
  pollIntervalMs?: number;
  /** Give up polling after this long (counted after the initial wait). Default 20 min. Task keeps running at TikTok. */
  pollTimeoutMs?: number;
  /** false => return right after the task is created (status PENDING + task_id); poll later with checkCopyTask. */
  waitForResult?: boolean;
  /**
   * When the copy API is denied (allowlist / permission), fall back to clone-by-recreate. Default false.
   * Note: fallback creates a fresh campaign with ~separate semantics (see clone-by-recreate.ts header).
   */
  fallback?: boolean;
  fallbackOptions?: RecreateOptions;
  /** Override the heuristic that decides "denied => fallback". */
  isAllowlistDenied?: (err: unknown) => boolean;
  /** CUSTOM mode only: children without explicit operation_status get DISABLE (API default would be ENABLE). Default true. */
  forceChildrenDisabled?: boolean;
  allowEnable?: boolean;
  maxBudget?: number;
  audit?: AuditSink;
  actor?: string;
  /** Validate + build the request body, call nothing. Result: status PENDING, note 'dry run', `request_body` set. */
  dryRun?: boolean;
  sleep?: SleepFn;
  onProgress?: (msg: string) => void;
}

export type CopyTaskStatus = 'RUNNING' | 'SUCCESS' | 'FAILURE';

export interface CopiedAd {
  smart_plus_ad_id?: string | undefined;
  ad_name?: string | undefined;
  is_success: boolean;
  errors: string[];
}
export interface CopiedAdGroup {
  adgroup_id?: string | undefined;
  adgroup_name?: string | undefined;
  total_ad_count?: number | undefined;
  success_ad_count?: number | undefined;
  errors: string[];
  ads: CopiedAd[];
}

export interface CopyTaskResult {
  task_status: CopyTaskStatus;
  total_ad_count?: number | undefined;
  success_ad_count?: number | undefined;
  campaign_id?: string | undefined;
  campaign_name?: string | undefined;
  campaign_errors: string[];
  adgroups: CopiedAdGroup[];
  /** True only when SUCCESS and nothing reported an error and all ads copied. */
  fully_successful: boolean;
}

export interface CopyResult {
  method: 'COPY_API' | 'CLONE_BY_RECREATE';
  /** PENDING = task created but result unknown yet (timeout / check failed / waitForResult=false). */
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'PENDING';
  task_id?: string | undefined;
  campaign_id?: string | undefined;
  campaign_name?: string | undefined;
  adgroup_ids: string[];
  smart_plus_ad_ids: string[];
  /** Human readable problems (task errors, ad group errors returned by create...). */
  errors: string[];
  task?: CopyTaskResult | undefined;
  /** Set when the copy API was denied and we fell back. */
  fallback?: { reason: string; recreate: RecreateResult } | undefined;
  /** Only with dryRun: the exact JSON that would be POSTed to /smart_plus/campaign/copy/task/create/. */
  request_body?: Record<string, unknown> | undefined;
  /** Why polling stopped early, if it did. */
  note?: string | undefined;
}

/** Pure: validated input -> request body for POST /smart_plus/campaign/copy/task/create/. */
export function buildCopyBody(raw: CopyCampaignInput, opts: Pick<CopyOptions, 'forceChildrenDisabled' | 'allowEnable' | 'maxBudget'> = {}): Record<string, unknown> {
  const parsed = CopyCampaignInputSchema.safeParse(raw);
  if (!parsed.success) throw new InputValidationError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  const c = parsed.data;
  const forceDisabled = opts.forceChildrenDisabled ?? true;

  let adgroup_list: unknown[] | undefined;
  if (c.deep_copy_mode === 'CUSTOM') {
    adgroup_list = (c.adgroup_list ?? []).map((g) => ({
      ...g,
      operation_status: g.operation_status ?? (forceDisabled ? 'DISABLE' : undefined),
      ad_list: g.ad_list.map((a) => ({ ...a, operation_status: a.operation_status ?? (forceDisabled ? 'DISABLE' : undefined) })),
    }));
  }
  // ENABLE anywhere requires explicit permission
  const statuses: (string | undefined)[] = [c.operation_status];
  for (const g of adgroup_list ?? []) {
    const gg = g as { operation_status?: string; ad_list: { operation_status?: string }[] };
    statuses.push(gg.operation_status, ...gg.ad_list.map((x) => x.operation_status));
  }
  if (statuses.includes('ENABLE') && !opts.allowEnable) throw new SafetyError('ENABLE requested without options.allowEnable');
  if (opts.maxBudget !== undefined) {
    const budgets = [c.budget, ...(c.adgroup_list ?? []).map((g) => g.budget)].filter((b): b is number => typeof b === 'number');
    const over = budgets.find((b) => b > opts.maxBudget!);
    if (over !== undefined) throw new SafetyError(`Budget ${over} exceeds options.maxBudget ${opts.maxBudget}`);
  }

  const { idempotencyKey, adgroup_list: _a, ...rest } = c;
  void _a;
  return compact({
    ...rest,
    request_id: generateRequestId(idempotencyKey ? `${c.advertiser_id}|${idempotencyKey}|copy` : undefined),
    adgroup_list: adgroup_list?.map((g) => compact(g as Record<string, unknown>)),
  });
}

/**
 * Duplicate an Upgraded Smart+ campaign with the official async copy API
 * (allowlist-only per developer app; docs: https://business-api.tiktok.com/portal/docs/copy-an-upgraded-smart-campaign/v1.3).
 *
 * Throws typed errors if the task cannot even be created (unless `fallback` handles it).
 * Once a task exists, never throws: returns status PENDING with task_id if the outcome is unknown.
 */
export async function copyCampaign(client: TikTokClient, rawInput: CopyCampaignInput, opts: CopyOptions = {}): Promise<CopyResult> {
  const body = buildCopyBody(rawInput, opts);
  const advertiser_id = String(body.advertiser_id);
  const sleep = opts.sleep ?? realSleep;
  const say = (m: string) => opts.onProgress?.(m);
  const denied = opts.isAllowlistDenied ?? looksLikeAllowlistOrPermissionDenied;
  if (opts.dryRun) return { method: 'COPY_API', status: 'PENDING', adgroup_ids: [], smart_plus_ad_ids: [], errors: [], request_body: body, note: 'dry run: nothing was sent' };

  /* ---- 1) create task */
  let task_id: string;
  let createErrors: string[] = [];
  try {
    // Idempotent for ~10 seconds only (documented cache time), so network-level retries are OK but a late re-run may duplicate.
    const res = await client.post<{ task_id?: string; adgroup_error_list?: { adgroup_id?: string; error_message?: string }[] }>(
      '/smart_plus/campaign/copy/task/create/',
      body,
      { bucket: 'copy_create', idempotent: true },
    );
    if (!res.data?.task_id) throw new TikTokProtocolError('copy task create returned no data.task_id');
    task_id = res.data.task_id;
    createErrors = (res.data.adgroup_error_list ?? []).map((e) => `ad group ${e.adgroup_id ?? '?'}: ${e.error_message ?? 'unknown error'}`);
    await emitAudit(opts.audit, { action: 'smartplus.copy.task_create', advertiser_id, actor: opts.actor, request: body, response: { task_id, createErrors, request_id: res.request_id }, ok: true });
  } catch (e) {
    await emitAudit(opts.audit, { action: 'smartplus.copy.task_create', advertiser_id, actor: opts.actor, request: body, response: String(e), ok: false });
    if (opts.fallback && denied(e)) {
      const reason = e instanceof TikTokApiError ? `copy API denied: code ${e.code} ${e.apiMessage}` : String(e);
      say(`Copy API denied (${reason}) -> falling back to clone-by-recreate`);
      const recreate = await cloneCampaignByRecreate(client, rawInput, {
        forceChildrenDisabled: opts.forceChildrenDisabled,
        allowEnable: opts.allowEnable,
        maxBudget: opts.maxBudget,
        audit: opts.audit,
        actor: opts.actor,
        ...opts.fallbackOptions,
      });
      return fromRecreate(recreate, reason);
    }
    throw e;
  }

  const base: CopyResult = { method: 'COPY_API', status: 'PENDING', task_id, adgroup_ids: [], smart_plus_ad_ids: [], errors: createErrors };
  if (opts.waitForResult === false) return { ...base, note: 'waitForResult=false: poll with checkCopyTask()' };

  /* ---- 2) poll */
  const initial = opts.initialWaitMs ?? 300_000;
  const interval = Math.max(1, opts.pollIntervalMs ?? 30_000);
  const timeout = opts.pollTimeoutMs ?? 20 * 60_000;
  say(`Copy task ${task_id} created; waiting ${Math.round(initial / 1000)}s before first check`);
  if (initial > 0) await sleep(initial);

  let waited = 0;
  for (;;) {
    let task: CopyTaskResult;
    try {
      task = await checkCopyTask(client, advertiser_id, task_id);
    } catch (e) {
      // task exists at TikTok; do not lose the id
      return { ...base, note: `status check failed: ${e instanceof TikTokError ? e.message : String(e)}. Task ${task_id} may still finish; call checkCopyTask().` };
    }
    if (task.task_status !== 'RUNNING') return finish(base, task, advertiser_id, opts);
    if (waited >= timeout) return { ...base, task, note: `still RUNNING after ${Math.round((initial + waited) / 1000)}s; call checkCopyTask() later` };
    say(`Task ${task_id} RUNNING...`);
    await sleep(interval);
    waited += interval;
  }
}

/** GET /smart_plus/campaign/copy/task/check/ - exported so a bot can poll later (e.g. from a cron job) using only task_id. */
export async function checkCopyTask(client: TikTokClient, advertiser_id: string, task_id: string): Promise<CopyTaskResult> {
  const res = await client.get<RawCheckData>('/smart_plus/campaign/copy/task/check/', { advertiser_id, task_id });
  return parseCheck(res.data);
}

/* ------------------------------------------------------------------ internals */

interface RawCheckData {
  task_status?: CopyTaskStatus;
  task_info?: { total_ad_count?: number; success_ad_count?: number };
  task_result?: {
    campaign_id?: string;
    campaign_name?: string;
    campaign_error_infos?: string[];
    adgroup_result_list?: {
      adgroup_id?: string;
      adgroup_name?: string;
      total_ad_count?: number;
      success_ad_count?: number;
      adgroup_error_list?: string[];
      ad_status?: string;
      ad_result_list?: { is_success?: boolean; smart_plus_ad_id?: string; ad_name?: string; ad_error_list?: string[] }[];
    }[];
  };
}

function parseCheck(d: RawCheckData | undefined): CopyTaskResult {
  const status = d?.task_status;
  if (status !== 'RUNNING' && status !== 'SUCCESS' && status !== 'FAILURE') {
    throw new TikTokProtocolError(`unexpected task_status: ${String(status)}`);
  }
  const r = d?.task_result;
  const adgroups: CopiedAdGroup[] = (r?.adgroup_result_list ?? []).map((g) => ({
    adgroup_id: g.adgroup_id,
    adgroup_name: g.adgroup_name,
    total_ad_count: g.total_ad_count,
    success_ad_count: g.success_ad_count,
    errors: g.adgroup_error_list ?? [],
    ads: (g.ad_result_list ?? []).map((a) => ({
      smart_plus_ad_id: a.smart_plus_ad_id,
      ad_name: a.ad_name,
      is_success: a.is_success === true,
      errors: a.ad_error_list ?? [],
    })),
  }));
  const campaign_errors = r?.campaign_error_infos ?? [];
  const noErrors = campaign_errors.length === 0 && adgroups.every((g) => g.errors.length === 0 && g.ads.every((a) => a.is_success && a.errors.length === 0));
  const counts = d?.task_info;
  const allCopied = counts?.total_ad_count === undefined || counts.total_ad_count === counts.success_ad_count;
  return {
    task_status: status,
    total_ad_count: counts?.total_ad_count,
    success_ad_count: counts?.success_ad_count,
    campaign_id: r?.campaign_id,
    campaign_name: r?.campaign_name,
    campaign_errors,
    adgroups,
    fully_successful: status === 'SUCCESS' && noErrors && allCopied,
  };
}

async function finish(base: CopyResult, task: CopyTaskResult, advertiser_id: string, opts: CopyOptions): Promise<CopyResult> {
  const errors = [...base.errors, ...task.campaign_errors];
  for (const g of task.adgroups) {
    errors.push(...g.errors.map((e) => `ad group ${g.adgroup_name ?? g.adgroup_id ?? '?'}: ${e}`));
    for (const a of g.ads) errors.push(...a.errors.map((e) => `ad ${a.ad_name ?? a.smart_plus_ad_id ?? '?'}: ${e}`));
  }
  const adgroup_ids = task.adgroups.map((g) => g.adgroup_id).filter((x): x is string => !!x);
  const smart_plus_ad_ids = task.adgroups.flatMap((g) => g.ads.filter((a) => a.is_success).map((a) => a.smart_plus_ad_id)).filter((x): x is string => !!x);
  // SUCCESS in task_status only means "processed" (doc) -> inspect errors to decide.
  const status: CopyResult['status'] = task.task_status === 'FAILURE' ? (task.campaign_id ? 'PARTIAL' : 'FAILED') : task.fully_successful ? 'SUCCESS' : 'PARTIAL';
  const result: CopyResult = {
    ...base,
    status,
    campaign_id: task.campaign_id,
    campaign_name: task.campaign_name,
    adgroup_ids,
    smart_plus_ad_ids,
    errors,
    task,
  };
  await emitAudit(opts.audit, { action: 'smartplus.copy.task_result', advertiser_id, actor: opts.actor, response: { task_id: base.task_id, status, campaign_id: task.campaign_id, errors }, ok: status === 'SUCCESS' });
  return result;
}

function fromRecreate(r: RecreateResult, reason: string): CopyResult {
  const c = r.create;
  const status: CopyResult['status'] = r.status === 'SUCCESS' ? 'SUCCESS' : r.status === 'PARTIAL' ? 'PARTIAL' : r.status === 'DRY_RUN' ? 'PENDING' : 'FAILED';
  return {
    method: 'CLONE_BY_RECREATE',
    status,
    campaign_id: r.campaign_id,
    campaign_name: String(r.plan.payloads.campaign.campaign_name ?? ''),
    adgroup_ids: c?.ids.adgroup_ids ?? [],
    smart_plus_ad_ids: c?.ids.smart_plus_ad_ids ?? [],
    errors: c?.error ? [`${c.error.step}: ${c.error.message}`] : [],
    fallback: { reason, recreate: r },
    note: r.dry_run ? 'dry run: nothing was created' : undefined,
  };
}
