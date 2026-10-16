import { buildDuplicateCampaignName } from './naming.js';
import { writeCampaignAudit } from './change-log.js';
import { buildPausedShellBody, isSignerFallbackEnabled, PartialDuplicateError } from './duplicate-safety.js';
import {
  classifyCampaign,
  commitBidChange,
  createWriteClient,
  describeMoneyError,
  findCampaignRow,
} from './money-edit.js';
import { TikTokClient } from '../tiktok/smartplus/client.js';
import { looksLikeAllowlistOrPermissionDenied, TikTokApiError } from '../tiktok/smartplus/errors.js';
import { cloneCampaignByRecreate } from '../tiktok/smartplus/clone-by-recreate.js';
import { formatOperatorSummary } from '../tiktok/smartplus/plan-summary.js';
import { enableCampaignTree } from '../tiktok/smartplus/status.js';
import { SafetyError, generateRequestId } from '../tiktok/smartplus/util.js';
import type { CopyCampaignInput } from '../tiktok/smartplus/schemas.js';

export interface OfficialDuplicateOptions {
  newName?: string;
  overrideBudget?: number;
  overrideBid?: number;
  /** Skip the official recreate and use the Playwright signer. Upgraded Smart+ only. */
  forceSignerFallback?: boolean;
  actor?: string;
}

export interface OfficialDuplicateResult {
  campaignId: string;
  advertiserId: string;
  campaignName?: string;
  overrideWarnings?: string[];
}

export interface DuplicatePreview {
  campaignId: string;
  advertiserId: string;
  sourceName: string;
  campaignName: string;
  kind: 'smart_plus' | 'manual' | 'spc' | 'unsupported_smart_plus';
  method: string;
  summary: string;
  blockers: string[];
  warnings: string[];
  canConfirm: boolean;
}

const PAUSED_NOTE = 'Bản vỏ không có quảng cáo nên vẫn tắt. Bản sao đủ nhóm và quảng cáo sẽ được bật.';

function clip(text: string, max = 3200): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}

function humanizeBlocker(raw: string): string {
  if (/[àáạảãâăèéêìíòóôơùúưỳýđ]/i.test(raw)) {
    return raw.replace(/^(campaign|adgroup\[[^\]]+\]|ad\[[^\]]+\])\s*:\s*/i, '');
  }
  if (/catalog/i.test(raw)) return 'Nhóm quảng cáo đang dùng catalog. Bot không sao chép catalog.';
  if (/search ads|is_search_campaign/i.test(raw)) return 'Đây là chiến dịch Search Ads. Bot không sao chép loại này.';
  if (/objective_type/i.test(raw)) return 'Mục tiêu campaign không thuộc loại bot đang hỗ trợ.';
  if (/auto_message|welcome message/i.test(raw)) return 'Thiếu tin nhắn chào. Quảng cáo tin nhắn TikTok cần tin nhắn chào.';
  if (/promotion_type|optimization location|instant form|phone call|multiple destinations|messaging_app/i.test(raw)) {
    return 'Đích của nhóm quảng cáo không phải tin nhắn TikTok hoặc website.';
  }
  return 'Có phần bot chưa hỗ trợ sao chép. Kiểm tra lại campaign trên TikTok.';
}

function copyInput(advertiserId: string, campaignId: string, campaignName: string, budget?: number): CopyCampaignInput {
  return {
    advertiser_id: advertiserId,
    campaign_id: campaignId,
    operation_status: 'DISABLE',
    campaign_name: campaignName,
    deep_copy_mode: 'DEFAULT',
    ...(budget != null ? { budget } : {}),
  };
}

export async function previewOfficialDuplicate(campaignId: string, options: OfficialDuplicateOptions = {}): Promise<DuplicatePreview> {
  const client = await createWriteClient();
  const found = await findCampaignRow(client, campaignId);
  const kind = classifyCampaign(found.row);
  const sourceName = String(found.row.campaign_name || campaignId);
  const campaignName = options.newName || buildDuplicateCampaignName(sourceName);
  const base = {
    campaignId,
    advertiserId: found.advertiserId,
    sourceName,
    campaignName,
  };

  if (kind === 'smart_plus') {
    return previewSmartPlus(client, base, options);
  }
  if (kind === 'spc') {
    return {
      ...base,
      kind: 'spc',
      method: 'POST /campaign/create/ (vỏ SPC)',
      summary: [
        `SPC "${sourceName}"`,
        `Tên bản sao: "${campaignName}"`,
        'Chưa có recreate SPC đã kiểm chứng. Xác nhận chỉ tạo vỏ campaign, không sao chép ad group/ad.',
        PAUSED_NOTE,
      ].join('\n'),
      blockers: [],
      warnings: ['Ad group và ad của SPC không được sao chép.'],
      canConfirm: true,
    };
  }

  return {
    ...base,
    kind: 'manual',
    method: 'POST /campaign/copy/task/create/',
    summary: [
      `Campaign thường "${sourceName}"`,
      `Tên bản sao: "${campaignName}"`,
      options.overrideBudget != null ? `Ngân sách gửi kèm: ${options.overrideBudget}` : 'Giữ ngân sách nguồn (API copy).',
      options.overrideBid != null ? `Giá thầu sẽ cập nhật sau khi copy xong: ${options.overrideBid}` : '',
      'Nếu app chưa được allowlist copy, hệ thống chỉ tạo vỏ campaign và ghi rõ ad group không được sao chép.',
      PAUSED_NOTE,
    ].filter(Boolean).join('\n'),
    blockers: [],
    warnings: [],
    canConfirm: true,
  };
}

async function previewSmartPlus(
  client: TikTokClient,
  base: Omit<DuplicatePreview, 'kind' | 'method' | 'summary' | 'blockers' | 'warnings' | 'canConfirm'>,
  options: OfficialDuplicateOptions
): Promise<DuplicatePreview> {
  const input = copyInput(base.advertiserId, base.campaignId, base.campaignName, options.overrideBudget);
  try {
    const dry = await cloneCampaignByRecreate(client, input, {
      dryRun: true,
      allowEnable: false,
      forceChildrenDisabled: true,
      rollbackOnFailure: false,
      overrideBid: options.overrideBid,
      actor: options.actor,
    });
    const unsupported = dry.plan.unsupported.length > 0;
    const signer = unsupported && isSignerFallbackEnabled(options.forceSignerFallback);
    const blockers = dry.plan.errors;
    return {
      ...base,
      kind: unsupported ? 'unsupported_smart_plus' : 'smart_plus',
      method: signer
        ? 'FALLBACK: Playwright signer (ngoài phạm vi recreate)'
        : 'GET /smart_plus/*/get/ rồi POST /smart_plus/campaign|adgroup|ad/create/',
      summary: clip(formatOperatorSummary(dry.plan, { willEnable: blockers.length === 0 && !signer })),
      blockers: signer ? [] : blockers.map(humanizeBlocker),
      warnings: [
        ...(signer ? ['Loại này không tạo lại được bằng API. Xác nhận sẽ dùng trình duyệt.'] : []),
        ...(!signer && unsupported ? ['Signer tắt. Đặt SMARTPLUS_SIGNER_FALLBACK=1 nếu muốn dùng trình duyệt.'] : []),
      ],
      canConfirm: signer || blockers.length === 0,
    };
  } catch (error) {
    if (error instanceof SafetyError) {
      const signer = isSignerFallbackEnabled(options.forceSignerFallback);
      return {
        ...base,
        kind: 'unsupported_smart_plus',
        method: signer ? 'FALLBACK: Playwright signer (ngoài phạm vi recreate)' : 'Bị chặn — ngoài phạm vi recreate',
        summary: error.message,
        blockers: signer ? [] : [error.message],
        warnings: signer
          ? [`FALLBACK: Playwright signer. ${PAUSED_NOTE}`]
          : ['Signer tắt mặc định. Chỉ bật khi SMARTPLUS_SIGNER_FALLBACK=1. Bot không dùng signer sau khi đã có campaign id.'],
        canConfirm: signer,
      };
    }
    throw error;
  }
}

export async function executeOfficialDuplicate(
  campaignId: string,
  options: OfficialDuplicateOptions = {}
): Promise<OfficialDuplicateResult> {
  const client = await createWriteClient();
  const found = await findCampaignRow(client, campaignId);
  const kind = classifyCampaign(found.row);
  const sourceName = String(found.row.campaign_name || campaignId);
  const campaignName = options.newName || buildDuplicateCampaignName(sourceName);
  const actor = options.actor || 'bot';

  if (kind === 'smart_plus') {
    return executeSmartPlus(client, found.advertiserId, campaignId, campaignName, options, actor);
  }
  if (kind === 'spc') {
    return createShell(client, found, campaignName, options, actor, [
      'SPC: chỉ tạo vỏ qua POST /campaign/create/. Ad group và ad không được sao chép.',
    ]);
  }
  return executeManualCopy(client, found, campaignName, options, actor);
}

async function executeSmartPlus(
  client: TikTokClient,
  advertiserId: string,
  campaignId: string,
  campaignName: string,
  options: OfficialDuplicateOptions,
  actor: string
): Promise<OfficialDuplicateResult> {
  if (options.forceSignerFallback) {
    return runSignerFallback(advertiserId, campaignId, campaignName, options, actor, 'forceSignerFallback');
  }

  const input = copyInput(advertiserId, campaignId, campaignName, options.overrideBudget);
  const recreateOptions = {
    dryRun: false as const,
    allowEnable: false,
    forceChildrenDisabled: true,
    rollbackOnFailure: false,
    overrideBid: options.overrideBid,
    actor,
  };

  try {
    const created = await cloneCampaignByRecreate(client, input, recreateOptions);
    const createdId = created.campaign_id || created.create?.campaign_id || '';
    if (created.status === 'PARTIAL' || (created.status !== 'SUCCESS' && createdId)) {
      throw partialError(createdId, created.create?.error?.message || created.status);
    }
    if (created.status !== 'SUCCESS' || !created.campaign_id) {
      throw new Error(created.create?.error?.message || `Nhân bản Smart+ không thành công (${created.status}).`);
    }
    const enableWarning = await enableCreatedSmartPlus(client, advertiserId, created.campaign_id, created.create?.ids, actor);
    await writeCampaignAudit({
      actor,
      action: 'duplicate.smart_plus',
      advertiserId,
      campaignId: created.campaign_id,
      before: { sourceCampaignId: campaignId },
      after: { campaignId: created.campaign_id, campaignName, method: 'CLONE_BY_RECREATE', enabled: !enableWarning },
      ok: true,
      detail: [enableWarning, ...created.plan.warnings].filter(Boolean).slice(0, 8).join('\n'),
    });
    return {
      campaignId: created.campaign_id,
      advertiserId,
      campaignName,
      overrideWarnings: [
        ...(enableWarning ? [enableWarning] : []),
        ...created.plan.warnings.filter(item => /bid override|budget/i.test(item)),
      ].slice(0, 6),
    };
  } catch (error) {
    const partialId = error instanceof PartialDuplicateError ? error.partialCampaignId : undefined;
    const message = error instanceof Error ? error.message : String(error);
    await writeCampaignAudit({
      actor,
      action: 'duplicate.smart_plus',
      advertiserId,
      campaignId: partialId || campaignId,
      before: { sourceCampaignId: campaignId },
      after: partialId ? { partialCampaignId: partialId } : undefined,
      ok: false,
      detail: message,
    });
    if (!partialId && error instanceof SafetyError && isSignerFallbackEnabled(options.forceSignerFallback)) {
      return runSignerFallback(advertiserId, campaignId, campaignName, options, actor, message);
    }
    throw error;
  }
}

async function enableCreatedSmartPlus(
  client: TikTokClient,
  advertiserId: string,
  campaignId: string,
  ids: { adgroup_ids: string[]; smart_plus_ad_ids: string[] } | undefined,
  actor: string
): Promise<string | undefined> {
  try {
    await enableCampaignTree(client, advertiserId, {
      campaign_id: campaignId,
      adgroup_ids: ids?.adgroup_ids ?? [],
      smart_plus_ad_ids: ids?.smart_plus_ad_ids ?? [],
    }, { allowEnable: true, actor });
    return undefined;
  } catch (error) {
    return `Đã tạo campaign ${campaignId} nhưng chưa bật được campaign, nhóm hoặc quảng cáo: ${describeMoneyError(error)}. Chúng vẫn đang tắt.`;
  }
}

function partialError(newId: string, detail: string): PartialDuplicateError {
  const partialCampaignId = /^\d+$/.test(newId) ? newId : undefined;
  return new PartialDuplicateError(
    [
      `Nhân bản dừng giữa chừng. Campaign ${partialCampaignId || '(chưa có id)'} đã được tạo ở trạng thái DISABLE nhưng chưa đủ ad group/ad.`,
      detail,
      'Không tạo thêm một campaign mới cho cùng lần lỗi này.',
    ].filter(Boolean).join('\n'),
    partialCampaignId
  );
}

async function applyBidAfterCreate(campaignId: string, bid: number, actor: string): Promise<string[]> {
  try {
    await commitBidChange(campaignId, bid, actor);
    return [];
  } catch (error) {
    return [`Đã tạo campaign nhưng chưa đổi được giá thầu: ${describeMoneyError(error)}. Dùng /bid ${campaignId} ${bid}`];
  }
}

async function runSignerFallback(
  advertiserId: string,
  campaignId: string,
  campaignName: string,
  options: OfficialDuplicateOptions,
  actor: string,
  reason: string
): Promise<OfficialDuplicateResult> {
  const warning = `FALLBACK: Playwright signer. ${reason}`;
  console.warn(`[duplicate] ${warning} campaign=${campaignId}`);
  const { duplicateSmartPlusCampaign } = await import('./smartplus-duplicator.js');
  const result = await duplicateSmartPlusCampaign(advertiserId, campaignId, {
    newName: campaignName,
    overrideBudget: options.overrideBudget,
    overrideBid: options.overrideBid,
  });
  await writeCampaignAudit({
    actor,
    action: 'duplicate.smart_plus.signer_fallback',
    advertiserId,
    campaignId: result.campaignId,
    before: { sourceCampaignId: campaignId },
    after: { status: result.status, campaignId: result.campaignId, taskId: result.taskId },
    ok: result.status === 'created' && !!result.campaignId,
    detail: warning,
  });
  if (result.status === 'created' && result.campaignId) {
    return {
      campaignId: result.campaignId,
      advertiserId: result.advertiserId,
      campaignName: result.campaignName || campaignName,
      overrideWarnings: [warning],
    };
  }
  if (result.status === 'draft' && result.campaignId) {
    throw new Error(`FALLBACK: Playwright signer đã tạo bản nháp ${result.campaignId}, chưa phải campaign chính thức. Task: ${result.taskId || 'không rõ'}.`);
  }
  throw new Error(`FALLBACK: Playwright signer chưa tạo xong campaign. Task: ${result.taskId || 'không rõ'}.`);
}

async function executeManualCopy(
  client: TikTokClient,
  found: { advertiserId: string; row: Record<string, unknown> },
  campaignName: string,
  options: OfficialDuplicateOptions,
  actor: string
): Promise<OfficialDuplicateResult> {
  const campaignId = String(found.row.campaign_id);
  const body: Record<string, unknown> = {
    advertiser_id: found.advertiserId,
    campaign_id: campaignId,
    request_id: generateRequestId(),
    campaign_name: campaignName,
    operation_status: 'ENABLE',
    deep_copy_mode: 'DEFAULT',
  };
  if (options.overrideBudget != null) body.budget = options.overrideBudget;

  try {
    const created = await client.post<{ task_id?: string }>('/campaign/copy/task/create/', body, {
      bucket: 'copy_create',
      idempotent: true,
    });
    const taskId = created.data?.task_id;
    if (!taskId) {
      throw new Error('Copy task không trả task_id.');
    }
    const outcome = await pollManualCopy(client, found.advertiserId, taskId);
    const newId = findNumericId(outcome, 'campaign_id');
    const status = findTaskStatus(outcome);
    if (status === 'FAILURE' || !newId) {
      const detail = collectMessages(outcome).join('; ') || status || 'không rõ';
      throw new Error(`Copy campaign thất bại (task ${taskId}): ${detail}`);
    }
    if (status && status !== 'SUCCESS') {
      throw new Error(`Copy task ${taskId} chưa xong (${status}). Campaign ${newId}. Không tạo thêm bản sao.`);
    }
    const warnings: string[] = [];
    if (options.overrideBid != null) {
      warnings.push(...(await applyBidAfterCreate(newId, options.overrideBid, actor)));
    }
    await writeCampaignAudit({
      actor,
      action: 'duplicate.manual',
      advertiserId: found.advertiserId,
      campaignId: newId,
      before: { sourceCampaignId: campaignId },
      after: { campaignId: newId, campaignName, taskId },
      ok: true,
    });
    return {
      campaignId: newId,
      advertiserId: found.advertiserId,
      campaignName: findName(outcome) || campaignName,
      overrideWarnings: warnings,
    };
  } catch (error) {
    if (!looksLikeAllowlistOrPermissionDenied(error)) {
      await writeCampaignAudit({
        actor,
        action: 'duplicate.manual',
        advertiserId: found.advertiserId,
        campaignId,
        ok: false,
        detail: describeMoneyError(error),
      });
      throw error;
    }
    const reason = error instanceof TikTokApiError ? `${error.code} ${error.apiMessage}` : describeMoneyError(error);
    return createShell(client, found, campaignName, options, actor, [
      `FALLBACK: POST /campaign/create/ vì copy API bị từ chối (${reason}). Ad group và ad KHÔNG được sao chép.`,
    ]);
  }
}

async function pollManualCopy(client: TikTokClient, advertiserId: string, taskId: string): Promise<unknown> {
  const initial = 3_000;
  const interval = 3_000;
  const timeout = 90_000;
  await sleep(initial);
  let waited = 0;
  let last: unknown;
  for (;;) {
    const response = await client.get('/campaign/copy/task/check/', {
      advertiser_id: advertiserId,
      task_id: taskId,
    });
    last = response.data;
    const status = findTaskStatus(last);
    if (status && status !== 'RUNNING') return last;
    if (waited >= timeout) {
      throw new Error(`Copy task ${taskId} vẫn RUNNING sau ${Math.round((initial + waited) / 1000)}s. Không tạo thêm bản sao. Kiểm tra sau bằng task id này.`);
    }
    await sleep(interval);
    waited += interval;
  }
}

async function createShell(
  client: TikTokClient,
  found: { advertiserId: string; row: Record<string, unknown> },
  campaignName: string,
  options: OfficialDuplicateOptions,
  actor: string,
  warnings: string[]
): Promise<OfficialDuplicateResult> {
  const sourceId = String(found.row.campaign_id);
  const body = buildPausedShellBody({
    advertiserId: found.advertiserId,
    campaignName,
    objectiveType: found.row.objective_type,
    budgetMode: found.row.budget_mode,
    budget: options.overrideBudget != null ? options.overrideBudget : found.row.budget,
    requestId: generateRequestId(),
  });

  try {
    const response = await client.post<{ campaign_id?: string }>('/campaign/create/', body, { idempotent: true });
    const newId = response.data?.campaign_id;
    if (!newId) throw new Error('Tạo vỏ campaign không trả campaign_id.');
    if (options.overrideBid != null) {
      warnings.push(`Giá thầu ${options.overrideBid} chưa ghi được vì bản sao không có ad group. Dùng /bid sau khi có ad group.`);
    }
    await writeCampaignAudit({
      actor,
      action: 'duplicate.shell',
      advertiserId: found.advertiserId,
      campaignId: newId,
      before: { sourceCampaignId: sourceId },
      after: { campaignId: newId, campaignName, requestId: body.request_id },
      ok: true,
      detail: warnings.join('\n'),
    });
    return {
      campaignId: String(newId),
      advertiserId: found.advertiserId,
      campaignName,
      overrideWarnings: warnings,
    };
  } catch (error) {
    await writeCampaignAudit({
      actor,
      action: 'duplicate.shell',
      advertiserId: found.advertiserId,
      campaignId: sourceId,
      before: { sourceCampaignId: sourceId },
      ok: false,
      detail: describeMoneyError(error),
    });
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findTaskStatus(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTaskStatus(item);
      if (found) return found;
    }
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const direct = row.task_status;
  if (typeof direct === 'string' && /^(RUNNING|SUCCESS|FAILURE)$/.test(direct)) return direct;
  for (const child of Object.values(row)) {
    const found = findTaskStatus(child);
    if (found) return found;
  }
  return undefined;
}

function findNumericId(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericId(item, key);
      if (found) return found;
    }
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const direct = row[key];
  if (typeof direct === 'string' && /^\d+$/.test(direct)) return direct;
  if (typeof direct === 'number' && Number.isFinite(direct)) return String(Math.trunc(direct));
  for (const child of Object.values(row)) {
    const found = findNumericId(child, key);
    if (found) return found;
  }
  return undefined;
}

function findName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findName(item);
      if (found) return found;
    }
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.campaign_name === 'string' && row.campaign_name.trim()) return row.campaign_name;
  for (const child of Object.values(row)) {
    const found = findName(child);
    if (found) return found;
  }
  return undefined;
}

function collectMessages(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(item => (typeof item === 'string' ? [item] : collectMessages(item)));
  const row = value as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, child] of Object.entries(row)) {
    if (typeof child === 'string' && /error|message|fail/i.test(key) && child.trim()) out.push(child);
    else out.push(...collectMessages(child));
  }
  return out.slice(0, 6);
}
