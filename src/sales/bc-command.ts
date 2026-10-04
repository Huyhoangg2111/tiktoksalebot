import { Markup, Telegraf, type Context } from 'telegraf';
import { getAdvertiserPermissions } from '../google-sheets/api.js';
import {
  buildBcSalesReport,
  getMonthBcReportPeriod,
  getTodayBcReportPeriod,
  parseCustomBcReportPeriod,
  type BcReportPeriod,
  type BcSalesDataIssue,
} from './bc-report.js';

type ReplyOptions = Parameters<Context['reply']>[1];
type NextFunction = () => Promise<void>;

const BC_CALLBACK_PREFIX = 'bc_report';
const BC_ISSUES_CALLBACK_PREFIX = 'bc_issues';
const CUSTOM_PENDING_TTL_MS = 10 * 60 * 1000;
const BC_ISSUES_TTL_MS = 30 * 60 * 1000;
const BC_ISSUES_PAGE_SIZE = 8;

const pendingCustomReports = new Map<string, { createdAt: number }>();
const bcIssueCallbacks = new Map<string, { createdAt: number; issues: BcSalesDataIssue[] }>();

function getTargetMktCode(): string {
  return process.env.TARGET_MKT_CODE?.trim() || 'MKT80.HOÀNG-TH';
}

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

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function replyLongMessage(ctx: Context, message: string, options?: ReplyOptions): Promise<void> {
  const chunks = splitMessage(message);

  for (let index = 0; index < chunks.length; index++) {
    const prefix = chunks.length > 1 ? `<b>Phần ${index + 1}/${chunks.length}</b>\n` : '';
    await ctx.reply(`${prefix}${chunks[index]}`, options);
  }
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
function buildBcMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Hôm nay', `${BC_CALLBACK_PREFIX}:today`),
      Markup.button.callback('Tháng này', `${BC_CALLBACK_PREFIX}:month`),
    ],
    [
      Markup.button.callback('Custom', `${BC_CALLBACK_PREFIX}:custom`),
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

export async function sendBcMenu(ctx: Context): Promise<void> {
  const targetMktCode = getTargetMktCode();

  await ctx.reply(
    [
      '<b>BÁO CÁO DOANH SỐ MKT</b>',
      `MKT: <code>${escapeHtml(targetMktCode)}</code>`,
      '',
      'Chọn khung thời gian cần xem:',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      ...buildBcMenuKeyboard(),
    }
  );
}
/**
 * Danh sách mã MKT mà /bc sẽ báo cáo: mọi mã MKT của TKQC đang bật trong dashboard
 * (mã MKT env/target đứng đầu nếu có), fallback về TARGET_MKT_CODE khi dashboard trống.
 */
async function getBcTargetMktCodes(): Promise<string[]> {
  const permissions = await getAdvertiserPermissions({ includeAllMkt: true }).catch(error => {
    // Không nuốt lỗi im lặng: nếu đọc danh sách TKQC lỗi (DB bận…), log để biết
    // /bc đang fallback về một mã MKT thay vì báo đủ các mã đã cấu hình.
    console.error('[bc] không đọc được danh sách TKQC, /bc chỉ báo theo TARGET_MKT_CODE:', error);
    return [];
  });
  const codes = [...new Set(
    permissions
      .filter(permission => permission.enabled && permission.mktCode.trim())
      .map(permission => permission.mktCode.trim())
  )];

  if (codes.length === 0) {
    console.warn('[bc] không có TKQC nào có Mã MKT trong dashboard — /bc chỉ báo', getTargetMktCode());
    return [getTargetMktCode()];
  }

  const target = getTargetMktCode();
  const rest = codes
    .filter(code => code.toLocaleUpperCase('vi-VN') !== target.toLocaleUpperCase('vi-VN'))
    .sort((a, b) => a.localeCompare(b, 'vi'));
  return codes.some(code => code.toLocaleUpperCase('vi-VN') === target.toLocaleUpperCase('vi-VN'))
    ? [target, ...rest]
    : rest.length > 0 ? rest : [target];
}

async function sendBcReport(ctx: Context, period: BcReportPeriod): Promise<void> {
  const waitMessage = await ctx.reply('Đang tổng hợp dữ liệu sales và TikTok Ads cho tất cả mã MKT...');

  try {
    const targetCodes = await getBcTargetMktCodes();
    // Các mã MKT chạy song song; mỗi mã vẫn là một báo cáo hoàn chỉnh theo format /bc.
    const results = await Promise.all(targetCodes.map(async code => {
      try {
        return { code, report: await buildBcSalesReport({ ...period, targetMktCode: code }) };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[bc] report failed for ${code}:`, error);
        return { code, failedMessage: `❌ Không thể tạo báo cáo <b>${escapeHtml(code)}</b>:\n${escapeHtml(errorMessage)}` };
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
        `Không thể tạo báo cáo /bc:\n${escapeHtml(errorMessage)}`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    await ctx.reply(`Không thể tạo báo cáo /bc:\n${errorMessage}`);
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

    await sendBcReport(ctx, period);
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

function parseDirectBcCommandPeriod(ctx: Context): BcReportPeriod | undefined {
  const messageText = getMessageText(ctx);
  const commandArgs = messageText.replace(/^\/bc(?:@\w+)?/i, '').trim();

  return commandArgs ? parseCustomBcReportPeriod(commandArgs) : undefined;
}
export function setupBcSalesHandlers(bot: Telegraf): void {
  bot.command('bc', async (ctx) => {
    try {
      const directPeriod = parseDirectBcCommandPeriod(ctx);

      if (directPeriod) {
        await sendBcReport(ctx, directPeriod);
        return;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Sai cú pháp /bc: ${errorMessage}`);
      return;
    }

    await sendBcMenu(ctx);
  });

  bot.action(`${BC_CALLBACK_PREFIX}:today`, async (ctx) => {
    await ctx.answerCbQuery();
    await sendBcReport(ctx, getTodayBcReportPeriod());
  });

  bot.action(`${BC_CALLBACK_PREFIX}:month`, async (ctx) => {
    await ctx.answerCbQuery();
    await sendBcReport(ctx, getMonthBcReportPeriod());
  });

  bot.action(`${BC_CALLBACK_PREFIX}:custom`, async (ctx) => {
    const pendingKey = getPendingKey(ctx);

    if (pendingKey) {
      pendingCustomReports.set(pendingKey, { createdAt: Date.now() });
    }

    await ctx.answerCbQuery();
    await ctx.reply(
      [
        'Nhập thời gian custom cho báo cáo /bc.',
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

  bot.action(new RegExp(`^${BC_ISSUES_CALLBACK_PREFIX}:([^:]+):(\\d+)$`), async (ctx) => {
    clearExpiredBcIssueCallbacks();

    const token = ctx.match[1];
    const pageIndex = Math.max(0, Number(ctx.match[2]) || 0);
    const callbackContext = bcIssueCallbacks.get(token);

    if (!callbackContext) {
      await ctx.answerCbQuery('Nút đã hết hạn. Vui lòng chạy lại /bc.');
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
