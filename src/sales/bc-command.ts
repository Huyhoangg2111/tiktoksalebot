import { Markup, Telegraf, type Context } from 'telegraf';
import { getAdvertiserPermissions } from '../google-sheets/api.js';
import {
  getConfiguredOtherMktCode,
  getPrimaryMktCode,
  resolveOtherMktCodes,
} from './bc-mkt-codes.js';
import {
  buildBcSalesReport,
  getMonthBcReportPeriod,
  getTodayBcReportPeriod,
  parseCustomBcReportPeriod,
  type BcReportPeriod,
  type BcSalesDataIssue,
} from './bc-report.js';

type NextFunction = () => Promise<void>;
type BcReportKind = 'primary' | 'other';

const BC_CALLBACK_PREFIX = 'bc_report';
const BC_OTHER_CALLBACK_PREFIX = 'bckhac_report';
const BC_ISSUES_CALLBACK_PREFIX = 'bc_issues';
const CUSTOM_PENDING_TTL_MS = 10 * 60 * 1000;
const BC_ISSUES_TTL_MS = 30 * 60 * 1000;
const BC_ISSUES_PAGE_SIZE = 8;

const pendingCustomReports = new Map<string, { createdAt: number; kind: BcReportKind }>();
const bcIssueCallbacks = new Map<string, { createdAt: number; issues: BcSalesDataIssue[] }>();

function getPendingKey(ctx: Context): string | undefined {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  if (!chatId || !userId) {
    return undefined;
  }

  return `${chatId}:${userId}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getMessageText(ctx: Context): string {
  return String((ctx.message as { text?: string } | undefined)?.text || '');
}

function splitMessage(message: string, maxLength = 3500): string[] {
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of message.split('\n')) {
    const nextChunk = currentChunk ? `${currentChunk}\n${line}` : line;

    if (nextChunk.length <= maxLength) {
      currentChunk = nextChunk;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = '';
    }

    if (line.length <= maxLength) {
      currentChunk = line;
      continue;
    }

    for (let index = 0; index < line.length; index += maxLength) {
      chunks.push(line.slice(index, index + maxLength));
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function clearExpiredBcIssueCallbacks(): void {
  const now = Date.now();

  for (const [token, callbackContext] of bcIssueCallbacks.entries()) {
    if (now - callbackContext.createdAt > BC_ISSUES_TTL_MS) {
      bcIssueCallbacks.delete(token);
    }
  }
}

function createBcIssueCallbackToken(issues: BcSalesDataIssue[]): string {
  clearExpiredBcIssueCallbacks();

  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  bcIssueCallbacks.set(token, {
    createdAt: Date.now(),
    issues,
  });

  return token;
}

function callbackPrefixForKind(kind: BcReportKind): string {
  return kind === 'other' ? BC_OTHER_CALLBACK_PREFIX : BC_CALLBACK_PREFIX;
}

function commandLabelForKind(kind: BcReportKind): string {
  return kind === 'other' ? '/bckhac' : '/bc';
}

function buildBcMenuKeyboard(kind: BcReportKind) {
  const prefix = callbackPrefixForKind(kind);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Hôm nay', `${prefix}:today`),
      Markup.button.callback('Tháng này', `${prefix}:month`),
    ],
    [
      Markup.button.callback('Custom', `${prefix}:custom`),
    ],
  ]);
}

function buildBcIssueKeyboard(issues: BcSalesDataIssue[]) {
  if (issues.length === 0) {
    return undefined;
  }

  const token = createBcIssueCallbackToken(issues);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `🔎 Xem ${issues.length.toLocaleString('vi-VN')} dòng lỗi dữ liệu`,
        `${BC_ISSUES_CALLBACK_PREFIX}:${token}:0`
      ),
    ],
  ]);
}

function buildBcIssuePageKeyboard(token: string, pageIndex: number, totalPages: number) {
  const buttons: Array<ReturnType<typeof Markup.button.callback>> = [];

  if (pageIndex > 0) {
    buttons.push(Markup.button.callback('⬅️ Trước', `${BC_ISSUES_CALLBACK_PREFIX}:${token}:${pageIndex - 1}`));
  }

  if (pageIndex < totalPages - 1) {
    buttons.push(Markup.button.callback('Tiếp ➡️', `${BC_ISSUES_CALLBACK_PREFIX}:${token}:${pageIndex + 1}`));
  }

  return buttons.length > 0 ? Markup.inlineKeyboard([buttons]) : undefined;
}

function formatBcIssuePage(issues: BcSalesDataIssue[], pageIndex: number): string {
  const totalPages = Math.max(1, Math.ceil(issues.length / BC_ISSUES_PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), totalPages - 1);
  const startIndex = safePageIndex * BC_ISSUES_PAGE_SIZE;
  const pageIssues = issues.slice(startIndex, startIndex + BC_ISSUES_PAGE_SIZE);
  const lines = [
    '<b>Dòng sale cần kiểm tra</b>',
    `Trang ${safePageIndex + 1}/${totalPages} · ${issues.length.toLocaleString('vi-VN')} dòng`,
    '',
  ];

  for (const [index, issue] of pageIssues.entries()) {
    const sheetName = issue.sourceName || issue.source;
    const sheetText = issue.sourceTabName ? `${sheetName}/${issue.sourceTabName}` : sheetName;
    const rowText = issue.sourceRowNumber ? issue.sourceRowNumber : '?';
    const productText = issue.productName?.trim() || '(trống)';

    lines.push(
      `${startIndex + index + 1}. <b>${escapeHtml(sheetText)}</b> - dòng <code>${escapeHtml(rowText)}</code> - <code>${escapeHtml(productText)}</code>`
    );
  }

  return lines.join('\n').trim();
}

async function listDashboardMktCodes(): Promise<string[]> {
  const permissions = await getAdvertiserPermissions({ includeAllMkt: true }).catch(error => {
    console.error('[bc] không đọc được danh sách TKQC:', error);
    return [];
  });

  return [...new Set(
    permissions
      .filter(permission => permission.enabled && permission.mktCode.trim())
      .map(permission => permission.mktCode.trim())
  )];
}

async function getMktCodesForKind(kind: BcReportKind): Promise<string[]> {
  if (kind === 'primary') {
    return [getPrimaryMktCode()];
  }

  return resolveOtherMktCodes({
    primaryMktCode: getPrimaryMktCode(),
    configuredOther: getConfiguredOtherMktCode(),
    dashboardCodes: await listDashboardMktCodes(),
  });
}

export async function sendBcMenu(ctx: Context): Promise<void> {
  const targetMktCode = getPrimaryMktCode();

  await ctx.reply(
    [
      '<b>BÁO CÁO DOANH SỐ MKT</b>',
      `MKT: <code>${escapeHtml(targetMktCode)}</code>`,
      '',
      'Chọn khung thời gian cần xem:',
      '',
      '<i>Mã MKT khác: dùng /bckhac</i>',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      ...buildBcMenuKeyboard('primary'),
    }
  );
}

export async function sendBcOtherMenu(ctx: Context): Promise<void> {
  const codes = await getMktCodesForKind('other');

  if (codes.length === 0) {
    await ctx.reply(
      [
        '<b>BÁO CÁO DOANH SỐ MKT KHÁC</b>',
        '',
        'Chưa có mã MKT khác để báo cáo.',
        'Cách cấu hình:',
        '• Đặt <code>OTHER_MKT_CODE</code> trong .env (ví dụ <code>MKT.CT</code>)',
        '• hoặc gắn Mã MKT khác trên TKQC đang bật trong dashboard (khác <code>TARGET_MKT_CODE</code>)',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.reply(
    [
      '<b>BÁO CÁO DOANH SỐ MKT KHÁC</b>',
      `MKT: <code>${escapeHtml(codes.join(', '))}</code>`,
      '',
      'Chọn khung thời gian cần xem:',
      '',
      '<i>Mã MKT chính: dùng /bc</i>',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      ...buildBcMenuKeyboard('other'),
    }
  );
}

async function sendBcReport(ctx: Context, period: BcReportPeriod, kind: BcReportKind): Promise<void> {
  const commandLabel = commandLabelForKind(kind);
  const waitMessage = await ctx.reply(
    kind === 'other'
      ? 'Đang tổng hợp dữ liệu sales và TikTok Ads cho mã MKT khác...'
      : 'Đang tổng hợp dữ liệu sales và TikTok Ads...'
  );

  try {
    const targetCodes = await getMktCodesForKind(kind);

    if (targetCodes.length === 0) {
      const chatId = ctx.chat?.id;
      const emptyMessage = [
        `<b>BÁO CÁO DOANH SỐ MKT KHÁC</b>`,
        '',
        'Chưa có mã MKT khác để báo cáo.',
        'Đặt <code>OTHER_MKT_CODE</code> hoặc gắn Mã MKT khác trên TKQC trong dashboard.',
      ].join('\n');

      if (chatId) {
        await ctx.telegram.editMessageText(
          chatId,
          waitMessage.message_id,
          undefined,
          emptyMessage,
          { parse_mode: 'HTML' }
        );
        return;
      }

      await ctx.reply(emptyMessage, { parse_mode: 'HTML' });
      return;
    }

    // Mỗi mã MKT là một báo cáo hoàn chỉnh (cùng format /bc), gửi riêng từng tin.
    const results = await Promise.all(targetCodes.map(async code => {
      try {
        return { code, report: await buildBcSalesReport({ ...period, targetMktCode: code }) };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[${kind === 'other' ? 'bckhac' : 'bc'}] report failed for ${code}:`, error);
        return {
          code,
          failedMessage: `❌ Không thể tạo báo cáo <b>${escapeHtml(code)}</b>:\n${escapeHtml(errorMessage)}`,
        };
      }
    }));

    const chatId = ctx.chat?.id;
    let usedWaitMessage = false;

    for (const result of results) {
      const message = result.failedMessage ?? result.report?.message ?? '';
      const issues = result.report?.issues ?? [];
      const keyboard = buildBcIssueKeyboard(issues);
      const chunks = splitMessage(message);

      if (chatId && chunks[0] && !usedWaitMessage) {
        usedWaitMessage = true;
        await ctx.telegram.editMessageText(
          chatId,
          waitMessage.message_id,
          undefined,
          chunks[0],
          {
            parse_mode: 'HTML',
            ...(keyboard && chunks.length === 1 ? keyboard : {}),
          }
        );

        for (const chunk of chunks.slice(1)) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
        if (keyboard && chunks.length > 1) {
          await ctx.reply('Có dòng dữ liệu sale cần kiểm tra:', keyboard);
        }
        continue;
      }

      for (const [index, chunk] of chunks.entries()) {
        await ctx.reply(chunk, {
          parse_mode: 'HTML',
          ...(keyboard && index === chunks.length - 1 ? keyboard : {}),
        });
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const chatId = ctx.chat?.id;

    if (chatId) {
      await ctx.telegram.editMessageText(
        chatId,
        waitMessage.message_id,
        undefined,
        `Không thể tạo báo cáo ${commandLabel}:\n${escapeHtml(errorMessage)}`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    await ctx.reply(`Không thể tạo báo cáo ${commandLabel}:\n${errorMessage}`);
  }
}

function clearExpiredPendingCustomReports(): void {
  const now = Date.now();

  for (const [key, pending] of pendingCustomReports.entries()) {
    if (now - pending.createdAt > CUSTOM_PENDING_TTL_MS) {
      pendingCustomReports.delete(key);
    }
  }
}

async function handleCustomText(ctx: Context, next: NextFunction): Promise<void> {
  clearExpiredPendingCustomReports();

  const pendingKey = getPendingKey(ctx);
  if (!pendingKey || !pendingCustomReports.has(pendingKey)) {
    await next();
    return;
  }

  const pending = pendingCustomReports.get(pendingKey)!;
  const messageText = getMessageText(ctx).trim();

  if (!messageText) {
    await next();
    return;
  }

  if (/^\/cancel/i.test(messageText)) {
    pendingCustomReports.delete(pendingKey);
    await ctx.reply('Đã hủy nhập thời gian custom.');
    return;
  }

  if (/^\//.test(messageText)) {
    pendingCustomReports.delete(pendingKey);
    await next();
    return;
  }

  try {
    const period = parseCustomBcReportPeriod(messageText);
    pendingCustomReports.delete(pendingKey);

    await sendBcReport(ctx, period, pending.kind);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await ctx.reply(
      [
        `Không đọc được thời gian: ${errorMessage}`,
        '',
        'Nhập lại ví dụ:',
        '<code>02</code>',
        '<code>02-27</code>',
        '<code>02/04/2026</code>',
        '<code>02/04/2026 - 26/04/2026</code>',
        '',
        'Gõ /cancel để hủy.',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  }
}

function parseDirectCommandPeriod(ctx: Context, command: 'bc' | 'bckhac'): BcReportPeriod | undefined {
  const messageText = getMessageText(ctx);
  const commandArgs = messageText.replace(new RegExp(`^\\/${command}(?:@\\w+)?`, 'i'), '').trim();

  return commandArgs ? parseCustomBcReportPeriod(commandArgs) : undefined;
}

function registerPeriodActions(bot: Telegraf, kind: BcReportKind): void {
  const prefix = callbackPrefixForKind(kind);
  const commandLabel = commandLabelForKind(kind);

  bot.action(`${prefix}:today`, async (ctx) => {
    await ctx.answerCbQuery();
    await sendBcReport(ctx, getTodayBcReportPeriod(), kind);
  });

  bot.action(`${prefix}:month`, async (ctx) => {
    await ctx.answerCbQuery();
    await sendBcReport(ctx, getMonthBcReportPeriod(), kind);
  });

  bot.action(`${prefix}:custom`, async (ctx) => {
    const pendingKey = getPendingKey(ctx);

    if (pendingKey) {
      pendingCustomReports.set(pendingKey, { createdAt: Date.now(), kind });
    }

    await ctx.answerCbQuery();
    await ctx.reply(
      [
        `Nhập thời gian custom cho báo cáo ${commandLabel}.`,
        '',
        'Có thể nhập một ngày hoặc một khoảng ngày:',
        '<code>02</code>',
        '<code>02-27</code>',
        '<code>02/04/2026</code>',
        '<code>02/04/2026 - 26/04/2026</code>',
        '<code>2026-04-02 đến 2026-04-26</code>',
        '',
        'Gõ /cancel để hủy.',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  });
}

export function setupBcSalesHandlers(bot: Telegraf): void {
  bot.command('bc', async (ctx) => {
    try {
      const directPeriod = parseDirectCommandPeriod(ctx, 'bc');

      if (directPeriod) {
        await sendBcReport(ctx, directPeriod, 'primary');
        return;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Sai cú pháp /bc: ${errorMessage}`);
      return;
    }

    await sendBcMenu(ctx);
  });

  bot.command('bckhac', async (ctx) => {
    try {
      const directPeriod = parseDirectCommandPeriod(ctx, 'bckhac');

      if (directPeriod) {
        await sendBcReport(ctx, directPeriod, 'other');
        return;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Sai cú pháp /bckhac: ${errorMessage}`);
      return;
    }

    await sendBcOtherMenu(ctx);
  });

  registerPeriodActions(bot, 'primary');
  registerPeriodActions(bot, 'other');

  bot.action(new RegExp(`^${BC_ISSUES_CALLBACK_PREFIX}:([^:]+):(\\d+)$`), async (ctx) => {
    clearExpiredBcIssueCallbacks();

    const token = ctx.match[1];
    const pageIndex = Math.max(0, Number(ctx.match[2]) || 0);
    const callbackContext = bcIssueCallbacks.get(token);

    if (!callbackContext) {
      await ctx.answerCbQuery('Nút đã hết hạn. Vui lòng chạy lại /bc hoặc /bckhac.');
      return;
    }

    const totalPages = Math.max(1, Math.ceil(callbackContext.issues.length / BC_ISSUES_PAGE_SIZE));
    const safePageIndex = Math.min(pageIndex, totalPages - 1);
    const keyboard = buildBcIssuePageKeyboard(token, safePageIndex, totalPages);

    await ctx.answerCbQuery();
    await ctx.reply(formatBcIssuePage(callbackContext.issues, safePageIndex), {
      parse_mode: 'HTML',
      ...(keyboard ? keyboard : {}),
    });
  });

  bot.on('text', (ctx, next) => {
    void handleCustomText(ctx, next);
  });
}
