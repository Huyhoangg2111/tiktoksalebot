import type { Telegraf } from 'telegraf';

const MAX_DETAIL_LINES = 12;

function isMaterialAutoActionText(text: string): boolean {
  return /^🤖\s*<b>Material Rule Auto<\/b>/i.test(text.trim());
}

function summarizeAutoActionText(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 3 || !isMaterialAutoActionText(text)) {
    return text;
  }

  const campaignLine = lines[1] || '';
  const resultLines = lines.slice(2).filter(Boolean);

  let pauseSuccess = 0;
  let activeSuccess = 0;
  let unverified = 0;

  const compactDetails = resultLines.map(line => {
    const isVerified = line.startsWith('✅');
    const isPause = /\sTẮT\s/.test(line);
    const isActive = /\sBẬT\s/.test(line);

    if (isVerified && isPause) pauseSuccess += 1;
    if (isVerified && isActive) activeSuccess += 1;
    if (!isVerified) unverified += 1;

    return line
      .replace(/^✅\s*/, isPause ? '⏸ ' : isActive ? '▶️ ' : '✅ ')
      .replace(/^⚠️\s*/, '⚠️ ')
      .replace(/\sTẮT\s·/, ' ·')
      .replace(/\sBẬT\s·/, ' ·');
  });

  const headerLines: string[] = [];
  if (pauseSuccess > 0 && activeSuccess === 0 && unverified === 0) {
    headerLines.push(`✅ <b>Pause thành công</b>${pauseSuccess > 1 ? ` (${pauseSuccess} material)` : ''}`);
  } else if (activeSuccess > 0 && pauseSuccess === 0 && unverified === 0) {
    headerLines.push(`✅ <b>Active thành công</b>${activeSuccess > 1 ? ` (${activeSuccess} material)` : ''}`);
  } else {
    headerLines.push('🤖 <b>Ruler material tự động</b>');
    if (pauseSuccess > 0) headerLines.push(`✅ <b>Pause thành công</b>: ${pauseSuccess} material`);
    if (activeSuccess > 0) headerLines.push(`✅ <b>Active thành công</b>: ${activeSuccess} material`);
    if (unverified > 0) headerLines.push(`⚠️ <b>Chưa xác minh</b>: ${unverified} material`);
  }

  const visibleDetails = compactDetails.slice(0, MAX_DETAIL_LINES);
  const hiddenCount = compactDetails.length - visibleDetails.length;

  return [
    ...headerLines,
    campaignLine,
    ...(visibleDetails.length > 0 ? ['', ...visibleDetails] : []),
    ...(hiddenCount > 0 ? [`… và ${hiddenCount} material khác`] : []),
  ].join('\n');
}

function rewriteTelegramPayload(method: unknown, payload: unknown): unknown {
  if (String(method) !== 'sendMessage' || !payload || typeof payload !== 'object') {
    return payload;
  }

  const source = payload as Record<string, unknown>;
  if (String(source.parse_mode || '').toUpperCase() !== 'HTML' || typeof source.text !== 'string') {
    return payload;
  }

  const text = summarizeAutoActionText(source.text);
  if (text === source.text) return payload;

  return {
    ...source,
    text,
  };
}

/**
 * Khôi phục feedback tự động của rule sau khi material đã được TikTok xác minh:
 * - hiển thị rõ `Pause thành công` / `Active thành công`;
 * - giữ nút `Chi tiết camp` hiện có;
 * - rút gọn danh sách để tránh Telegram từ chối message quá dài khi nhiều material cùng đổi trạng thái.
 *
 * Chỉ đổi presentation của Telegram payload `Material Rule Auto`; không can thiệp rule,
 * quyết định ENABLE/DISABLE, mapping hay TikTok write API.
 */
export function setupMaterialAutoActionFeedback(bot: Telegraf): void {
  const telegram = bot.telegram as any;
  const originalCallApi = telegram.callApi.bind(telegram);

  telegram.callApi = (method: unknown, payload: unknown, ...rest: unknown[]) =>
    originalCallApi(method, rewriteTelegramPayload(method, payload), ...rest);
}
