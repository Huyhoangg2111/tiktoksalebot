import type { Context, Telegraf } from 'telegraf';

const RETIRED_CALLBACK_PREFIXES = [
  'duplicate_camp:',
  'cad:',
] as const;

function isRetiredCallbackData(value: unknown): boolean {
  const callbackData = String(value || '');
  return RETIRED_CALLBACK_PREFIXES.some(prefix => callbackData.startsWith(prefix));
}

function normalizeButton(button: Record<string, unknown>): Record<string, unknown> {
  if (button?.text === '🔎 Xem chi tiết material') {
    return {
      ...button,
      text: '🔎 Chi tiết camp',
    };
  }

  return button;
}

function sanitizeReplyMarkup(replyMarkup: unknown): unknown {
  if (!replyMarkup || typeof replyMarkup !== 'object') {
    return replyMarkup;
  }

  const markup = replyMarkup as {
    inline_keyboard?: Array<Array<Record<string, unknown>>>;
    [key: string]: unknown;
  };

  if (!Array.isArray(markup.inline_keyboard)) {
    return replyMarkup;
  }

  const inlineKeyboard = markup.inline_keyboard
    .map(row => Array.isArray(row)
      ? row
          .filter(button => !isRetiredCallbackData(button?.callback_data))
          .map(normalizeButton)
      : [])
    .filter(row => row.length > 0);

  if (inlineKeyboard.length === 0) {
    return undefined;
  }

  return {
    ...markup,
    inline_keyboard: inlineKeyboard,
  };
}

function sanitizeTelegramPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const nextPayload = { ...(payload as Record<string, unknown>) };
  if (!('reply_markup' in nextPayload)) {
    return nextPayload;
  }

  const replyMarkup = sanitizeReplyMarkup(nextPayload.reply_markup);
  if (replyMarkup === undefined) {
    delete nextPayload.reply_markup;
  } else {
    nextPayload.reply_markup = replyMarkup;
  }

  return nextPayload;
}

async function answerRetiredAction(ctx: Context, label: string): Promise<void> {
  if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
    await ctx.answerCbQuery(`${label} đã được gỡ bỏ khỏi bot.`, { show_alert: true });
  }
}

/**
 * Gỡ hoàn toàn 2 thao tác cũ khỏi trải nghiệm Telegram:
 * - 🚀 X / duplicate_camp: nhân bản campaign từ alert.
 * - 🔕 Bỏ TD / cad: bỏ theo dõi campaign trong ngày.
 *
 * Đồng thời chuẩn hoá nhãn nút chi tiết campaign về "🔎 Chi tiết camp".
 * Nút retired bị lọc khỏi mọi send/edit Telegram. Callback từ tin nhắn cũ cũng bị
 * chặn trước legacy handlers, nên hai chức năng không còn có thể thực thi.
 */
export function setupRetiredAlertActions(bot: Telegraf): void {
  const telegram = bot.telegram as any;
  const originalCallApi = telegram.callApi.bind(telegram);

  telegram.callApi = (method: unknown, payload: unknown, ...rest: unknown[]) =>
    originalCallApi(method, sanitizeTelegramPayload(payload), ...rest);

  bot.action(/^duplicate_camp:/, async ctx => {
    await answerRetiredAction(ctx, 'Chức năng nhân bản campaign');
  });

  bot.action(/^cad:/, async ctx => {
    await answerRetiredAction(ctx, 'Chức năng bỏ theo dõi hôm nay');
  });
}
