import type { Telegraf } from 'telegraf';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function getCampaignDisplayName(campaignName: string): string {
  const parts = String(campaignName || '')
    .split(' - ')
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]} - ${parts[1]}`;
  }

  return String(campaignName || '').trim();
}

function formatLegacyCondition(condition: string, rawRule: string): string {
  const conditionIcon = condition === 'vượt giới hạn' ? '📈' : '✅';
  // ruleLine đã nằm trong HTML payload nên các toán tử có thể đang là &gt;/&lt;.
  // Decode trước rồi escape đúng một lần để Telegram render >, <, >=, <= thay vì hiện literal entity.
  const decodedRule = decodeHtmlEntities(rawRule);
  const parts = decodedRule.split('·').map(part => part.trim()).filter(Boolean);
  const metricPart = parts[0] || decodedRule;
  const conversionPart = (parts[1] || '').replace(/^Conversion\s*/i, '').trim();

  return `${conditionIcon} <b>${escapeHtml(condition)}</b>: 💰 <b>${escapeHtml(metricPart)}</b>` +
    (conversionPart ? ` · 🎯 <b>${escapeHtml(conversionPart)}</b>` : '');
}

/**
 * Chỉ khôi phục presentation của thông báo campaign Level 1 mới về bố cục cũ.
 * Không thay đổi rule, cooldown, dữ liệu, callback hay material write API.
 *
 * Output kiểu cũ:
 *   🔔 Ads đạt điều kiện (1 camp)
 *   ✅ đạt điều kiện: 💰 CPA < 0.7 · 🎯 >= 5
 *
 *   1. Tên ngắn - campaign_id
 *   metrics
 */
function rewriteCampaignAlertText(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 4) return text;

  const headingMatch = lines[0]?.match(/^🔔\s*<b>Campaign\s+(đạt điều kiện|vượt giới hạn)<\/b>\s*$/i);
  if (!headingMatch) return text;

  const campaignMatch = lines[1]?.match(/^<b>(.*?)<\/b>\s*-\s*<code>(\d{10,})<\/code>\s*$/);
  if (!campaignMatch) return text;

  const metricsLine = lines[2] || '';
  const ruleLine = String(lines[3] || '').replace(/^📏\s*/, '').trim();
  if (!ruleLine) return text;

  const condition = headingMatch[1].toLowerCase();
  const campaignName = getCampaignDisplayName(campaignMatch[1]);
  const campaignId = campaignMatch[2];
  const titleLine = `🔔 Ads ${condition} (1 camp)`;

  return [
    `<b>${escapeHtml(titleLine)}</b>`,
    formatLegacyCondition(condition, ruleLine),
    '',
    `<b>1. ${escapeHtml(campaignName)}</b> - <code>${escapeHtml(campaignId)}</code>`,
    metricsLine,
  ].join('\n');
}

function rewriteTelegramPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;

  const source = payload as Record<string, unknown>;
  if (String(source.parse_mode || '').toUpperCase() !== 'HTML' || typeof source.text !== 'string') {
    return payload;
  }

  const rewrittenText = rewriteCampaignAlertText(source.text);
  if (rewrittenText === source.text) return payload;

  return {
    ...source,
    text: rewrittenText,
  };
}

export function setupCampaignAlertUiCompatibility(bot: Telegraf): void {
  const telegram = bot.telegram as any;
  const originalCallApi = telegram.callApi.bind(telegram);

  telegram.callApi = (method: unknown, payload: unknown, ...rest: unknown[]) =>
    originalCallApi(method, rewriteTelegramPayload(payload), ...rest);
}
