/**
 * Pure guards for duplication, delete, and the signer fallback.
 * Network code calls these so the rules can be tested without TikTok.
 */

export const MAX_COPIES_BEFORE_FIRST_SUCCESS = 3;
export const MAX_COPIES_AFTER_FIRST_SUCCESS = 10;

export class PartialDuplicateError extends Error {
  readonly partialCampaignId?: string;
  constructor(message: string, partialCampaignId?: string) {
    super(message);
    this.name = 'PartialDuplicateError';
    this.partialCampaignId = partialCampaignId;
  }
}

export function maxCopiesForHistory(successfulClones: number): number {
  return successfulClones > 0 ? MAX_COPIES_AFTER_FIRST_SUCCESS : MAX_COPIES_BEFORE_FIRST_SUCCESS;
}

export function assertCopyQuantity(quantity: number, successfulClones: number): number {
  const max = maxCopiesForHistory(successfulClones);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Số lượng phải là số nguyên lớn hơn 0.');
  }
  if (quantity > max) {
    throw new Error(
      successfulClones > 0
        ? `Mỗi lệnh tối đa ${max} bản sao.`
        : `Chưa có bản sao thành công trong campaign_clone_log, nên mỗi lệnh tối đa ${max} bản. Sau lần đầu thành công, tối đa ${MAX_COPIES_AFTER_FIRST_SUCCESS}.`
    );
  }
  return quantity;
}

/** Signer stays off unless the operator passes an explicit flag or sets SMARTPLUS_SIGNER_FALLBACK=1. */
export function isSignerFallbackEnabled(explicit = false): boolean {
  if (explicit) return true;
  return process.env.SMARTPLUS_SIGNER_FALLBACK === '1';
}

export function canDeletePartialClone(input: {
  campaignName: string;
  operationStatus: string;
  adCount: number;
  loggedAsClone: boolean;
}): { ok: boolean; reason: string } {
  if (input.operationStatus === 'ENABLE') {
    return { ok: false, reason: 'Campaign đang ENABLE. Lệnh này không xóa campaign đang chạy.' };
  }
  if (!input.campaignName.endsWith(' - API')) {
    return { ok: false, reason: 'Chỉ xóa campaign có tên kết thúc bằng " - API". Campaign tắt hợp lệ không bị xóa chỉ vì đang DISABLE.' };
  }
  if (!input.loggedAsClone && input.adCount > 0) {
    return {
      ok: false,
      reason: 'Campaign có ad và không nằm trong campaign_clone_log. Không xóa một campaign đã tắt nếu bot không ghi nhận đó là bản sao.',
    };
  }
  return {
    ok: true,
    reason: input.loggedAsClone
      ? 'Tên kết thúc bằng " - API" và id có trong campaign_clone_log.'
      : 'Tên kết thúc bằng " - API" và campaign chưa có ad.',
  };
}

export interface CopyLoopOutcome<T> {
  created: T[];
  partialIds: string[];
  error?: string;
  stopped: boolean;
}

/** Stops at the first failure and keeps every id created before that failure. */
export async function runCopyLoop<T>(quantity: number, createOne: () => Promise<T>): Promise<CopyLoopOutcome<T>> {
  const created: T[] = [];
  const partialIds: string[] = [];
  for (let index = 0; index < quantity; index += 1) {
    try {
      created.push(await createOne());
    } catch (error) {
      if (error instanceof PartialDuplicateError && error.partialCampaignId) {
        partialIds.push(error.partialCampaignId);
      }
      return {
        created,
        partialIds,
        error: error instanceof Error ? error.message : String(error),
        stopped: true,
      };
    }
  }
  return { created, partialIds, stopped: false };
}

export function formatCopyLoop(outcome: CopyLoopOutcome<{ campaignId: string; campaignName?: string }>, quantity: number): string {
  const lines = [
    outcome.stopped
      ? `Đã dừng sau lỗi. Tạo xong ${outcome.created.length}/${quantity}. Các bản còn lại không được tạo.`
      : `Đã tạo ${outcome.created.length}/${quantity}.`,
  ];
  if (outcome.created.length) {
    lines.push('Campaign đã tạo:');
    for (const item of outcome.created) lines.push(`- ${item.campaignId}${item.campaignName ? ` ${item.campaignName}` : ''}`);
  }
  if (outcome.partialIds.length) {
    lines.push(`Campaign tạo dở: ${outcome.partialIds.join(', ')}`);
    lines.push('Tiếp tục bằng /xcamp_resume hoặc xóa bằng /xcamp_xoa nếu tên kết thúc bằng " - API".');
  }
  if (outcome.error) lines.push(outcome.error);
  return lines.join('\n');
}

export function buildPausedShellBody(input: {
  advertiserId: string;
  campaignName: string;
  objectiveType: unknown;
  budgetMode?: unknown;
  budget?: unknown;
  requestId: string;
}): Record<string, unknown> {
  if (!/^\d+$/.test(input.requestId)) {
    throw new Error('Vỏ campaign cần request_id để lần gửi lại không tạo campaign thứ hai.');
  }
  const body: Record<string, unknown> = {
    advertiser_id: input.advertiserId,
    campaign_name: input.campaignName,
    objective_type: input.objectiveType,
    operation_status: 'DISABLE',
    request_id: input.requestId,
  };
  if (input.budgetMode) body.budget_mode = input.budgetMode;
  if (input.budget != null && input.budget !== '') body.budget = Number(input.budget);
  return body;
}
