import { Markup, type Context, type Telegraf } from 'telegraf';
import {
  runSmartPlusAppealScan,
  type SmartPlusAppealRunSummary,
} from '../tiktok/smartplus-appeals.js';

const APPEAL_MODE_CALLBACK_PREFIX = 'smartplus_appeal_mode';

let isAppealRunActive = false;

function isAdmin(ctx: Context): boolean {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  return adminChatId ? ctx.chat?.id.toString() === adminChatId : false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureAppealParentCommandMenu(bot: Telegraf): Promise<void> {
  const adminChatId = process.env.ADMIN_CHAT_ID?.trim();
  if (!adminChatId) {
    return;
  }

  const scope = {
    type: 'chat',
    chat_id: Number(adminChatId) || adminChatId,
  } as any;

  // setupBotHandlers() configures the existing admin menu asynchronously.
  // Wait until that menu is visible, then append exactly one appeal parent entry.
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(500);

    try {
      const commands = await bot.telegram.getMyCommands({ scope } as any);
      const baseMenuReady = commands.some(command => command.command === 'xcamp');

      if (!baseMenuReady) {
        continue;
      }

      if (commands.some(command => command.command === 'appeal')) {
        return;
      }

      await bot.telegram.setMyCommands(
        [
          ...commands,
          {
            command: 'appeal',
            description: '📨 Quét quảng cáo từ chối',
          },
        ],
        { scope } as any
      );

      console.log('Smart+ appeal parent command added to admin Telegram menu');
      return;
    } catch (error) {
      if (attempt === 19) {
        console.error('Cannot add Smart+ appeal parent command to admin menu:', error);
      }
    }
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildAppealModeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '🔎 Chỉ quảng cáo chưa xử lý',
        `${APPEAL_MODE_CALLBACK_PREFIX}:pending`
      ),
    ],
    [
      Markup.button.callback(
        '🔄 Quét lại toàn bộ',
        `${APPEAL_MODE_CALLBACK_PREFIX}:all`
      ),
    ],
  ]);
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
      'ℹ️ Lần chạy sau chọn “Chỉ quảng cáo chưa xử lý” sẽ bỏ qua mọi Smart+ Ad đã từng được bot gửi appeal, kể cả lần trước TikTok trả lỗi.',
      'Chọn “Quét lại toàn bộ” khi cần bỏ qua lịch sử local và thử lại toàn bộ quảng cáo đang bị từ chối.'
    );
  }

  return lines.join('\n');
}

async function showAppealModeMenu(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('❌ Chỉ admin mới có thể chạy Smart+ appeal.');
    return;
  }

  if (isAppealRunActive) {
    await ctx.reply('⏳ Một lượt Smart+ appeal đang chạy. Vui lòng chờ hoàn tất.');
    return;
  }

  await ctx.reply(
    [
      '📨 <b>Quét quảng cáo Smart+ bị từ chối</b>',
      '',
      'Chọn cách chạy:',
      '• <b>Chỉ quảng cáo chưa xử lý</b>: bỏ qua các ad bot đã từng thử kháng nghị.',
      '• <b>Quét lại toàn bộ</b>: bỏ qua lịch sử local và thử lại toàn bộ ad đang bị từ chối.',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      ...buildAppealModeKeyboard(),
    }
  );
}

async function handleAppealRun(ctx: Context, forceRescan: boolean): Promise<void> {
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
  // Một lệnh cha duy nhất. Người dùng chọn chế độ bằng nút con sau đó.
  bot.command('appeal', ctx => void showAppealModeMenu(ctx));

  bot.action(
    new RegExp(`^${APPEAL_MODE_CALLBACK_PREFIX}:(pending|all)$`),
    async ctx => {
      if (!isAdmin(ctx)) {
        await ctx.answerCbQuery('Không có quyền thực hiện.');
        return;
      }

      if (isAppealRunActive) {
        await ctx.answerCbQuery('Một lượt appeal đang chạy. Vui lòng chờ.', {
          show_alert: true,
        });
        return;
      }

      const forceRescan = ctx.match[1] === 'all';
      await ctx.answerCbQuery(
        forceRescan ? 'Đã chọn quét lại toàn bộ.' : 'Đã chọn chỉ quảng cáo chưa xử lý.'
      );

      try {
        await ctx.editMessageReplyMarkup(undefined);
      } catch (error) {
        console.error('Cannot remove Smart+ appeal mode keyboard:', error);
      }

      void handleAppealRun(ctx, forceRescan);
    }
  );

  void ensureAppealParentCommandMenu(bot);
}
