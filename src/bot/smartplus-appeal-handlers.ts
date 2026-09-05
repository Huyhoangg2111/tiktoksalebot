import { type Context, type Telegraf } from 'telegraf';
import {
  runSmartPlusAppealScan,
  type SmartPlusAppealRunSummary,
} from '../tiktok/smartplus-appeals.js';

let isAppealRunActive = false;

function isAdmin(ctx: Context): boolean {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  return adminChatId ? ctx.chat?.id.toString() === adminChatId : false;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSummary(summary: SmartPlusAppealRunSummary): string {
  const modeLabel = summary.forceRescan
    ? 'QUÉT LẠI TOÀN BỘ (bỏ qua lịch sử local)'
    : 'CHỈ QUẢNG CÁO CHƯA XỬ LÝ';
  const lines = [
    `📨 <b>Smart+ Appeal · ${modeLabel}</b>`,
    '',
    `TKQC: <b>${summary.advertiserCount}</b>`,
    `Smart+ Ads đã quét: <b>${summary.scannedAds}</b>`,
    `Ads có material bị từ chối: <b>${summary.rejectedAds}</b>`,
    `Đã gửi appeal lần này: <b>${summary.attempted}</b>`,
    '',
    `✅ Thành công: <b>${summary.success}</b>`,
    `⚠️ Không tạo được ticket: <b>${summary.noTicket}</b>`,
    `⏱ QPS limit: <b>${summary.qpsLimit}</b>`,
    `🌐 Lỗi mạng/timeout: <b>${summary.transportError}</b>`,
    `❌ Lỗi khác: <b>${summary.otherError}</b>`,
    '',
    `⏭ Bỏ qua do đã có lịch sử: <b>${summary.skippedHistory}</b>`,
    `⏭ Bỏ qua do trạng thái appeal: <b>${summary.skippedAppealStatus}</b>`,
  ];

  if (summary.scanErrors.length > 0) {
    lines.push('', '<b>Lỗi quét:</b>');
    for (const error of summary.scanErrors.slice(0, 10)) {
      lines.push(`• ${escapeHtml(error)}`);
    }
  }

  if (!summary.forceRescan) {
    lines.push(
      '',
      'ℹ️ Lần chạy sau /appeal sẽ bỏ qua mọi Smart+ Ad đã từng được bot gửi appeal, kể cả lần trước TikTok trả lỗi.',
      'Dùng /appealall khi cần quét lại toàn bộ và bỏ qua lịch sử local.'
    );
  }

  return lines.join('\n');
}

async function handleAppealCommand(ctx: Context, forceRescan: boolean): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('❌ Chỉ admin mới có thể chạy Smart+ appeal.');
    return;
  }

  if (isAppealRunActive) {
    await ctx.reply('⏳ Một lượt Smart+ appeal đang chạy. Vui lòng chờ hoàn tất.');
    return;
  }

  isAppealRunActive = true;
  const statusMessage = await ctx.reply(
    forceRescan
      ? '🔄 Đang quét lại toàn bộ Smart+ Ads bị từ chối và bỏ qua lịch sử local...'
      : '🔎 Đang quét Smart+ Ads bị từ chối chưa từng được bot xử lý...'
  );
  const chatId = ctx.chat?.id;
  let lastProgressEditAt = 0;

  try {
    const summary = await runSmartPlusAppealScan({
      forceRescan,
      onProgress: async message => {
        if (!chatId || Date.now() - lastProgressEditAt < 4_000) {
          return;
        }

        lastProgressEditAt = Date.now();
        try {
          await ctx.telegram.editMessageText(
            chatId,
            statusMessage.message_id,
            undefined,
            `⏳ ${message}`
          );
        } catch (error) {
          console.error('Cannot update Smart+ appeal progress message:', error);
        }
      },
    });

    try {
      if (chatId) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMessage.message_id,
          undefined,
          formatSummary(summary),
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.reply(formatSummary(summary), { parse_mode: 'HTML' });
      }
    } catch (error) {
      console.error('Cannot edit Smart+ appeal summary message:', error);
      await ctx.reply(formatSummary(summary), { parse_mode: 'HTML' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Smart+ appeal command failed:', error);

    try {
      if (chatId) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMessage.message_id,
          undefined,
          `❌ Smart+ appeal thất bại: ${message.slice(0, 1000)}`
        );
      } else {
        await ctx.reply(`❌ Smart+ appeal thất bại: ${message}`);
      }
    } catch (notifyError) {
      console.error('Cannot send Smart+ appeal failure message:', notifyError);
    }
  } finally {
    isAppealRunActive = false;
  }
}

export function setupSmartPlusAppealHandlers(bot: Telegraf): void {
  bot.command('appeal', ctx => void handleAppealCommand(ctx, false));
  bot.command('appealall', ctx => void handleAppealCommand(ctx, true));
}
