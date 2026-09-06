import type { Telegraf } from 'telegraf';

const APPEAL_MODE_CALLBACK_PREFIX = 'smartplus_appeal_mode';

/**
 * Xóa message menu cha ngay khi người dùng chọn một chức năng appeal.
 * Handler Smart+ hiện tại vẫn xử lý callback/action như cũ; module này chỉ
 * dọn message menu để tránh để lại một thông báo hướng dẫn dài, thừa trong chat.
 */
export function setupAppealMenuCleanup(bot: Telegraf): void {
  bot.action(new RegExp(`^${APPEAL_MODE_CALLBACK_PREFIX}:`), async (ctx, next) => {
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.error('Cannot delete stale Smart+ appeal menu message:', error);
    }

    return next();
  });
}
