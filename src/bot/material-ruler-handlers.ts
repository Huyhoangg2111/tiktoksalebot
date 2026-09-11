import type { Context, Telegraf } from 'telegraf';
import { runMaterialRulerNow } from '../materials/daily-ruler.js';

let running = false;

function isAdmin(ctx: Context): boolean {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  return Boolean(adminChatId && String(ctx.chat?.id || '') === adminChatId);
}

export function setupMaterialRulerHandlers(bot: Telegraf): void {
  bot.command('materialruler', async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.reply('❌ Chỉ admin mới được chạy Material Ruler.');
      return;
    }
    if (running) {
      await ctx.reply('⏳ Material Ruler đang chạy. Vui lòng chờ lượt hiện tại hoàn tất.');
      return;
    }
    running = true;
    await ctx.reply('⏳ Đang chạy Material Ruler thủ công, không chờ giờ đã cài...');
    try {
      await runMaterialRulerNow(bot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Material Ruler thất bại: ${message.slice(0, 500)}`);
    } finally {
      running = false;
    }
  });
}
