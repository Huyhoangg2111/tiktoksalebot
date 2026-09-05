import { Markup, type Context, type Telegraf } from 'telegraf';
import {
  getSmartPlusAppealStatusReport,
  getSmartPlusAppealTemplates,
  runSmartPlusAppealScan,
  type SmartPlusAppealRunSummary,
  type SmartPlusAppealStatusItem,
} from '../tiktok/smartplus-appeal-center.js';

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

function splitMessage(message: string, maxLength = 3500): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of message.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);
    current = line;
  }

  if (current) chunks.push(current);
  return chunks;
}

async function replyLongMessage(ctx: Context, message: string): Promise<void> {
  for (const chunk of splitMessage(message)) {
    await ctx.reply(chunk, { parse_mode: 'HTML' });
  }
}

function buildAppealModeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '🔎 Quét mới & kháng nghị',
        `${APPEAL_MODE_CALLBACK_PREFIX}:pending`
      ),
    ],
    [
      Markup.button.callback(
        '🔄 Quét lại toàn bộ',
        `${APPEAL_MODE_CALLBACK_PREFIX}:all`
      ),
    ],
    [
      Markup.button.callback(
        '📊 Đã kháng & trạng thái',
        `${APPEAL_MODE_CALLBACK_PREFIX}:status`
      ),
    ],
    [
      Markup.button.callback(
        '📝 Mẫu câu kháng nghị',
        `${APPEAL_MODE_CALLBACK_PREFIX}:templates`
      ),
    ],
  ]);
}

function formatAppealStatus(status?: string): string {
  if (!status) return 'Chưa có dữ liệu';
  const upper = status.toUpperCase();

  if (upper.includes('FAILED')) return `❌ ${status}`;
  if (upper.includes('SUCCESS') || upper.includes('APPROVED') || upper.includes('PASSED')) {
    return `✅ ${status}`;
  }
  if (upper.includes('PENDING') || upper.includes('REVIEW') || upper.includes('PROCESS')) {
    return `⏳ ${status}`;
  }
  if (upper === 'NOT_APPEALED') return `⚪ ${status}`;
  return status;
}

function formatSummary(summary: SmartPlusAppealRunSummary): string {
  const modeLabel = summary.forceRescan
    ? 'QUÉT LẠI TOÀN BỘ'
    : 'CHỈ QUẢNG CÁO CHƯA XỬ LÝ';
  const lines = [
    `📨 <b>Smart+ Appeal · ${modeLabel}</b>`,
    '',
    `TKQC: <b>${summary.advertiserCount}</b>`,
    `Smart+ Ads đã quét: <b>${summary.scannedAds}</b>`,
    `Ads có material bị từ chối: <b>${summary.rejectedAds}</b>`,
    `Đã gửi appeal lần này: <b>${summary.attempted}</b>`,
    '',
    `✅ API chấp nhận tạo appeal: <b>${summary.success}</b>`,
    `⚠️ Không tạo được ticket: <b>${summary.noTicket}</b>`,
    `⏱ QPS limit: <b>${summary.qpsLimit}</b>`,
    `🌐 Lỗi mạng/timeout: <b>${summary.transportError}</b>`,
    `❌ Lỗi khác: <b>${summary.otherError}</b>`,
    '',
    `⏭ Bỏ qua do đã có lịch sử local: <b>${summary.skippedHistory}</b>`,
    `⏭ Bỏ qua do TikTok đã có trạng thái appeal: <b>${summary.skippedAppealStatus}</b>`,
  ];

  if (summary.successfulAds.length > 0) {
    lines.push('', '<b>Đã gửi thành công:</b>');
    for (const item of summary.successfulAds.slice(0, 12)) {
      lines.push(
        `• <code>${escapeHtml(item.smartPlusAdId)}</code>` +
        `${item.campaignId ? ` · camp <code>${escapeHtml(item.campaignId)}</code>` : ''}` +
        ` · ${escapeHtml(formatAppealStatus(item.appealStatus))}` +
        ` · mẫu <code>${escapeHtml(item.templateKey)}</code>`
      );
    }
    if (summary.successfulAds.length > 12) {
      lines.push(`• … và ${summary.successfulAds.length - 12} quảng cáo khác.`);
    }
  }

  if (summary.scanErrors.length > 0) {
    lines.push('', '<b>Lỗi quét/trạng thái:</b>');
    for (const error of summary.scanErrors.slice(0, 10)) {
      lines.push(`• ${escapeHtml(error)}`);
    }
  }

  lines.push(
    '',
    'ℹ️ Mỗi lần gửi đều lưu ID quảng cáo, lý do từ chối, mẫu kháng nghị, câu đã gửi, response TikTok và trạng thái appeal.'
  );

  return lines.join('\n');
}

function formatStatusItem(item: SmartPlusAppealStatusItem, index: number): string[] {
  const sourceLabel = item.source === 'BOT_SUCCESS'
    ? '✅ Bot đã gửi API thành công'
    : '🟦 TikTok đã có lịch sử kháng nghị';

  const lines = [
    `<b>${index}. Smart+ Ad <code>${escapeHtml(item.smartPlusAdId)}</code></b>`,
    `${sourceLabel}`,
    item.campaignId ? `Campaign: <code>${escapeHtml(item.campaignId)}</code>` : '',
    `Appeal: ${escapeHtml(formatAppealStatus(item.appealStatus))}`,
    `Review: <code>${escapeHtml(item.reviewStatus || '-')}</code>`,
    item.lastSubmissionAt ? `Gửi gần nhất: <code>${escapeHtml(item.lastSubmissionAt)}</code>` : '',
    item.templateKey ? `Mẫu: <code>${escapeHtml(item.templateKey)}</code>` : '',
    item.rejectReason ? `Lý do reject: ${escapeHtml(item.rejectReason)}` : '',
  ].filter(Boolean);

  if (item.appealRejectReasons.length > 0) {
    lines.push(`TikTok appeal reject: ${escapeHtml(item.appealRejectReasons.join(' | '))}`);
  }

  return lines;
}

async function handleAppealStatus(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('❌ Chỉ admin mới có thể xem Smart+ appeal.');
    return;
  }

  if (isAppealRunActive) {
    await ctx.reply('⏳ Một lượt Smart+ appeal/status đang chạy. Vui lòng chờ hoàn tất.');
    return;
  }

  isAppealRunActive = true;
  const statusMessage = await ctx.reply('📊 Đang cập nhật trạng thái các quảng cáo đã kháng nghị từ TikTok...');
  const chatId = ctx.chat?.id;
  let lastEdit = 0;

  try {
    const report = await getSmartPlusAppealStatusReport(async progress => {
      if (!chatId || Date.now() - lastEdit < 4_000) return;
      lastEdit = Date.now();
      try {
        await ctx.telegram.editMessageText(chatId, statusMessage.message_id, undefined, `⏳ ${progress}`);
      } catch (error) {
        console.error('Cannot update Smart+ appeal status progress:', error);
      }
    });

    const lines = [
      '📊 <b>SMART+ APPEAL · LỊCH SỬ & TRẠNG THÁI</b>',
      '',
      `Tổng quảng cáo có lịch sử appeal: <b>${report.total}</b>`,
      `✅ Bot đã gửi API thành công: <b>${report.botSuccess}</b>`,
      `🟦 TikTok có lịch sử nhưng chưa có log bot: <b>${report.tiktokHistory}</b>`,
    ];

    const statusCounts = new Map<string, number>();
    for (const item of report.items) {
      const status = item.appealStatus || 'UNKNOWN';
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    }

    if (statusCounts.size > 0) {
      lines.push('', '<b>Theo trạng thái:</b>');
      for (const [status, count] of statusCounts) {
        lines.push(`• ${escapeHtml(formatAppealStatus(status))}: <b>${count}</b>`);
      }
    }

    if (report.scanErrors.length > 0) {
      lines.push('', `<b>Lỗi cập nhật:</b> ${report.scanErrors.length}`);
    }

    if (chatId) {
      try {
        await ctx.telegram.editMessageText(
          chatId,
          statusMessage.message_id,
          undefined,
          lines.join('\n'),
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('Cannot edit Smart+ appeal status summary:', error);
      }
    }

    if (report.items.length === 0) {
      return;
    }

    const detailLines: string[] = [];
    for (const [index, item] of report.items.slice(0, 50).entries()) {
      if (detailLines.length > 0) detailLines.push('');
      detailLines.push(...formatStatusItem(item, index + 1));
    }

    if (report.items.length > 50) {
      detailLines.push('', `… còn ${report.items.length - 50} quảng cáo khác.`);
    }

    await replyLongMessage(ctx, detailLines.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Không lấy được trạng thái Smart+ appeal: ${escapeHtml(message)}`, {
      parse_mode: 'HTML',
    });
  } finally {
    isAppealRunActive = false;
  }
}

async function showAppealTemplates(ctx: Context): Promise<void> {
  const templates = getSmartPlusAppealTemplates();
  const lines = [
    '📝 <b>MẪU CÂU KHÁNG NGHỊ SMART+</b>',
    '',
    'Bot tự chọn mẫu theo lý do reject TikTok trả về và gửi trong field <code>appeal_reason</code>.',
  ];

  for (const [index, template] of templates.entries()) {
    lines.push(
      '',
      `<b>${index + 1}. ${escapeHtml(template.label)}</b>`,
      `Nhận diện: ${escapeHtml(template.matches)}`,
      `Key: <code>${escapeHtml(template.key)}</code>`,
      '',
      escapeHtml(template.text)
    );
  }

  await replyLongMessage(ctx, lines.join('\n'));
}

async function showAppealModeMenu(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('❌ Chỉ admin mới có thể chạy Smart+ appeal.');
    return;
  }

  if (isAppealRunActive) {
    await ctx.reply('⏳ Một lượt Smart+ appeal/status đang chạy. Vui lòng chờ hoàn tất.');
    return;
  }

  await ctx.reply(
    [
      '📨 <b>Quảng cáo Smart+ bị từ chối</b>',
      '',
      'Chọn chức năng:',
      '• <b>Quét mới & kháng nghị</b>: chỉ xử lý quảng cáo chưa từng kháng; quảng cáo đã thử hoặc TikTok đã có lịch sử appeal sẽ bỏ qua.',
      '• <b>Quét lại toàn bộ</b>: bỏ qua lịch sử local và thử lại các trạng thái TikTok cho phép thử.',
      '• <b>Đã kháng & trạng thái</b>: cập nhật trạng thái appeal mới nhất từ TikTok.',
      '• <b>Mẫu câu kháng nghị</b>: xem câu bot tự chọn cho từng nhóm lý do reject.',
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
    await ctx.reply('⏳ Một lượt Smart+ appeal/status đang chạy. Vui lòng chờ hoàn tất.');
    return;
  }

  isAppealRunActive = true;
  const statusMessage = await ctx.reply(
    forceRescan
      ? '🔄 Đang quét lại toàn bộ Smart+ Ads bị từ chối...'
      : '🔎 Đang quét Smart+ Ads bị từ chối chưa từng được xử lý...'
  );
  const chatId = ctx.chat?.id;
  let lastProgressEditAt = 0;

  try {
    const summary = await runSmartPlusAppealScan({
      forceRescan,
      onProgress: async message => {
        if (!chatId || Date.now() - lastProgressEditAt < 4_000) return;
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
        await replyLongMessage(ctx, formatSummary(summary));
      }
    } catch (error) {
      console.error('Cannot edit Smart+ appeal summary message:', error);
      await replyLongMessage(ctx, formatSummary(summary));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Smart+ appeal command failed:', error);
    await ctx.reply(`❌ Smart+ appeal thất bại: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
  } finally {
    isAppealRunActive = false;
  }
}

export function setupSmartPlusAppealHandlers(bot: Telegraf): void {
  bot.command('appeal', ctx => void showAppealModeMenu(ctx));

  bot.action(
    new RegExp(`^${APPEAL_MODE_CALLBACK_PREFIX}:(pending|all|status|templates)$`),
    async ctx => {
      if (!isAdmin(ctx)) {
        await ctx.answerCbQuery('Không có quyền thực hiện.');
        return;
      }

      const mode = ctx.match[1];

      if (mode === 'templates') {
        await ctx.answerCbQuery('Mở mẫu câu kháng nghị.');
        void showAppealTemplates(ctx);
        return;
      }

      if (isAppealRunActive) {
        await ctx.answerCbQuery('Một lượt appeal/status đang chạy. Vui lòng chờ.', {
          show_alert: true,
        });
        return;
      }

      if (mode === 'status') {
        await ctx.answerCbQuery('Đang cập nhật trạng thái kháng nghị.');
        try {
          await ctx.editMessageReplyMarkup(undefined);
        } catch (error) {
          console.error('Cannot remove Smart+ appeal menu keyboard:', error);
        }
        void handleAppealStatus(ctx);
        return;
      }

      const forceRescan = mode === 'all';
      await ctx.answerCbQuery(
        forceRescan ? 'Đã chọn quét lại toàn bộ.' : 'Đã chọn quét quảng cáo mới.'
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
