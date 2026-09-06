import type { Telegraf } from 'telegraf';

/**
 * THỬ NGHIỆM UI Telegram:
 * - Ẩn campaign_id khỏi phần text nhìn thấy.
 * - Gắn campaign_id vào chính tên campaign bằng tg://copy?text=...
 *
 * Telegram chỉ tài liệu hoá copy_text cho inline keyboard; tg://copy hiện không phải
 * Bot API contract chính thức. Module này được tách riêng để có thể revert nhanh nếu
 * client Telegram không hỗ trợ hành vi copy khi bấm trực tiếp vào text link.
 */
function buildExperimentalCopyLink(labelHtml: string, campaignId: string): string {
  return `<a href="tg://copy?text=${encodeURIComponent(campaignId)}"><b>${labelHtml}</b></a>`;
}

function rewriteCampaignIdsInHtml(html: string): string {
  let nextHtml = html;

  // Dạng mới: <b>Cao răng - ID</b> - <code>1864...</code>
  nextHtml = nextHtml.replace(
    /<b>(?:(\d+\.\s*))?([^<\n]+)<\/b>\s*-\s*<code>(\d{10,})<\/code>/g,
    (_match, numberPrefix: string | undefined, campaignName: string, campaignId: string) => {
      const prefix = numberPrefix ? `<b>${numberPrefix}</b>` : '';
      return `${prefix}${buildExperimentalCopyLink(campaignName, campaignId)}`;
    }
  );

  // Dạng alert nhóm cũ:
  // <b>1. Cao răng - ID - 1864... · 14 · ...</b>
  // -> <b>1. </b><a ...><b>Cao răng - ID</b></a><b> · 14 · ...</b>
  nextHtml = nextHtml.replace(
    /<b>(\d+\.\s*)([^<\n]*?)\s+-\s+(\d{10,})([^<\n]*)<\/b>/g,
    (_match, numberPrefix: string, campaignName: string, campaignId: string, suffix: string) =>
      `<b>${numberPrefix}</b>${buildExperimentalCopyLink(campaignName, campaignId)}<b>${suffix}</b>`
  );

  return nextHtml;
}

function rewriteTelegramPayload(payload: unknown): { payload: unknown; changed: boolean } {
  if (!payload || typeof payload !== 'object') {
    return { payload, changed: false };
  }

  const source = payload as Record<string, unknown>;
  if (String(source.parse_mode || '').toUpperCase() !== 'HTML') {
    return { payload, changed: false };
  }

  const nextPayload = { ...source };
  let changed = false;

  for (const field of ['text', 'caption'] as const) {
    if (typeof source[field] !== 'string') continue;
    const rewritten = rewriteCampaignIdsInHtml(source[field] as string);
    if (rewritten !== source[field]) {
      nextPayload[field] = rewritten;
      changed = true;
    }
  }

  return { payload: changed ? nextPayload : payload, changed };
}

function isTelegramEntityLinkError(error: unknown): boolean {
  const candidate = error as {
    response?: { error_code?: number; description?: string };
    description?: string;
    message?: string;
  };
  const errorCode = Number(candidate?.response?.error_code || 0);
  const description = String(
    candidate?.response?.description || candidate?.description || candidate?.message || ''
  ).toLowerCase();

  return errorCode === 400 && (
    description.includes('parse entities') ||
    description.includes('unsupported url') ||
    description.includes('wrong http url') ||
    description.includes('url protocol')
  );
}

export function setupCampaignNameIdLinkExperiment(bot: Telegraf): void {
  const telegram = bot.telegram as any;
  const originalCallApi = telegram.callApi.bind(telegram);

  telegram.callApi = async (method: unknown, payload: unknown, ...rest: unknown[]) => {
    const rewritten = rewriteTelegramPayload(payload);

    try {
      return await originalCallApi(method, rewritten.payload, ...rest);
    } catch (error) {
      // Nếu Bot API từ chối tg://copy ở text entity, fallback đúng payload cũ.
      // Chỉ retry lỗi parse 400 để tránh gửi message trùng do lỗi mạng/timeout.
      if (rewritten.changed && isTelegramEntityLinkError(error)) {
        console.warn('[CampaignNameIdLink] Telegram rejected direct copy link; falling back to visible campaign ID.');
        return originalCallApi(method, payload, ...rest);
      }
      throw error;
    }
  };
}
