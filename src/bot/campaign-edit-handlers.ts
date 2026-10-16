import { Markup, Telegraf, type Context } from 'telegraf';
import { enqueueXcampJob } from './handlers.js';
import { duplicateCampaign } from '../campaigns/manager.js';
import { countLoggedClones, recordCampaignClone } from '../campaigns/clone-tracking.js';
import { assertCopyQuantity } from '../campaigns/duplicate-safety.js';
import {
  cancelConfirmation,
  consumeConfirmation,
  createConfirmation,
  findConfirmation,
  peekConfirmation,
  type BidConfirmPayload,
  type BudgetConfirmPayload,
  type DeleteConfirmPayload,
  type DuplicateConfirmPayload,
  type ResumeConfirmPayload,
} from '../campaigns/confirmations.js';
import {
  deletePartialCampaign,
  previewDeletePartial,
  previewOfficialDuplicate,
} from '../campaigns/official-duplicate.js';
import { commitBidChange, commitBudgetChange, describeMoneyError, previewBidChange, previewBudgetChange } from '../campaigns/money-edit.js';
import { hashMoneyState, parseBudgetMode, parsePositiveMoney } from '../tiktok/smartplus/money.js';

function isAdmin(ctx: Context): boolean {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  return adminChatId ? ctx.chat?.id.toString() === adminChatId : false;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function actorOf(ctx: Context): string {
  return `telegram:${ctx.chat?.id ?? 'unknown'}:${ctx.from?.id ?? 'unknown'}`;
}

function argsOf(ctx: Context): string[] {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  return text.split(/\s+/).filter(Boolean);
}

function confirmKeyboard(ok: string, no: string, token: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback('Xác nhận', `${ok}:${token}`),
    Markup.button.callback('Hủy', `${no}:${token}`),
  ]);
}

async function replyPreview(ctx: Context, title: string, body: string, ok: string, no: string, token: string | undefined): Promise<void> {
  const text = `<b>${escapeHtml(title)}</b>\n<pre>${escapeHtml(body).slice(0, 3500)}</pre>`;
  if (!token) {
    await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }
  await ctx.reply(text, { parse_mode: 'HTML', ...confirmKeyboard(ok, no, token) });
}

async function handleDuplicateCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('Chỉ admin mới nhân bản được campaign.');
    return;
  }
  const args = argsOf(ctx);
  const campaignId = args[1];
  if (!campaignId || !/^\d+$/.test(campaignId)) {
    await ctx.reply('Dùng: /xcamp <campaign_id> [số lượng] [ngân sách] [giá thầu]\nVí dụ: /xcamp 12345 1 20 0.5');
    return;
  }
  let quantity: number;
  try {
    quantity = assertCopyQuantity(parseInt(args[2] || '1', 10), await countLoggedClones());
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
    return;
  }
  let budget: number | undefined;
  let bid: number | undefined;
  try {
    if (args[3] && args[3] !== '-') budget = parsePositiveMoney(args[3], 'Ngân sách');
    if (args[4] && args[4] !== '-') bid = parsePositiveMoney(args[4], 'Giá thầu');
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
    return;
  }

  await ctx.reply('Đang đọc campaign trên Marketing API (chưa tạo gì)...');
  try {
    const preview = await previewOfficialDuplicate(campaignId, { overrideBudget: budget, overrideBid: bid, actor: actorOf(ctx) });
    const lines = [
      preview.summary,
      '',
      `Số lượng: ${quantity}`,
      preview.warnings.length ? preview.warnings.slice(0, 4).join('\n') : '',
      preview.blockers.length && !preview.summary.includes('Không tạo được') ? preview.blockers.slice(0, 4).join('\n') : '',
    ].filter(Boolean).join('\n');
    if (!preview.canConfirm) {
      await replyPreview(ctx, 'Không nhân bản được', lines, 'xok', 'xno', undefined);
      return;
    }
    const token = createConfirmation({
      kind: 'duplicate',
      actor: actorOf(ctx),
      summary: lines,
      payload: { campaignId, quantity, budget, bid, campaignName: preview.campaignName },
    });
    await replyPreview(ctx, 'Xác nhận nhân bản', `${lines}\n\nBấm Xác nhận để tạo.`, 'xok', 'xno', token);
  } catch (error) {
    await ctx.reply(`Không đọc được campaign:\n${escapeHtml(describeMoneyError(error))}`, { parse_mode: 'HTML' });
  }
}

async function handleBudgetCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('Chỉ admin mới đổi ngân sách.');
    return;
  }
  const args = argsOf(ctx);
  const campaignId = args[1];
  if (!campaignId || !args[2]) {
    await ctx.reply('Dùng: /budget <campaign_id> <số tiền> [ngày|trọn|dynamic]\nVí dụ: /budget 12345 30 ngày');
    return;
  }
  try {
    const budget = parsePositiveMoney(args[2], 'Ngân sách');
    const mode = parseBudgetMode(args[3]);
    const { snapshot, plan } = await previewBudgetChange(campaignId, budget, mode);
    const body = [plan.before, '', 'Sau khi xác nhận:', plan.after, '', ...plan.writes.map(write => `${write.endpoint}\n${write.summary}`), ...plan.limitations].join('\n');
    const token = createConfirmation({
      kind: 'budget',
      actor: actorOf(ctx),
      summary: body,
      payload: { campaignId, budget, mode, stateHash: hashMoneyState(snapshot, plan) },
    });
    await replyPreview(ctx, 'Xác nhận đổi ngân sách', body, 'bok', 'bno', token);
  } catch (error) {
    await ctx.reply(describeMoneyError(error));
  }
}

async function handleBidCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('Chỉ admin mới đổi giá thầu.');
    return;
  }
  const args = argsOf(ctx);
  const campaignId = args[1];
  if (!campaignId || !args[2]) {
    await ctx.reply('Dùng: /bid <campaign_id> <giá thầu>\nVí dụ: /bid 12345 0.45');
    return;
  }
  try {
    const bid = parsePositiveMoney(args[2], 'Giá thầu');
    const { snapshot, plan } = await previewBidChange(campaignId, bid);
    const body = [plan.before, '', 'Sau khi xác nhận:', plan.after, '', ...plan.limitations].join('\n');
    const token = createConfirmation({
      kind: 'bid',
      actor: actorOf(ctx),
      summary: body,
      payload: { campaignId, bid, stateHash: hashMoneyState(snapshot, plan) },
    });
    await replyPreview(ctx, 'Xác nhận đổi giá thầu', body, 'iok', 'ino', token);
  } catch (error) {
    await ctx.reply(describeMoneyError(error));
  }
}

async function handleResumeCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('Chỉ admin mới tiếp tục bản sao dở.');
    return;
  }
  const args = argsOf(ctx);
  const sourceCampaignId = args[1];
  const newCampaignId = args[2];
  const adgroupId = args[3];
  if (!sourceCampaignId || !newCampaignId) {
    await ctx.reply('Dùng: /xcamp_resume <campaign_gốc> <campaign_mới> [adgroup_id]');
    return;
  }
  await ctx.reply('Đang đối chiếu phần đã tạo (chưa ghi thêm)...');
  try {
    const preview = await previewOfficialDuplicate(sourceCampaignId, {
      resume: { campaignId: newCampaignId, adgroupId },
      actor: actorOf(ctx),
    });
    if (!preview.canConfirm) {
      await replyPreview(ctx, 'Không tiếp tục được', preview.summary, 'rok', 'rno', undefined);
      return;
    }
    const token = createConfirmation({
      kind: 'resume',
      actor: actorOf(ctx),
      summary: preview.summary,
      payload: { sourceCampaignId, newCampaignId, adgroupId },
    });
    await replyPreview(ctx, 'Xác nhận tiếp tục bản dở', `${preview.summary}\n\nCampaign gốc không bị tạo lại.`, 'rok', 'rno', token);
  } catch (error) {
    await ctx.reply(describeMoneyError(error));
  }
}

async function handleDeleteCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('Chỉ admin mới xóa bản sao dở.');
    return;
  }
  const campaignId = argsOf(ctx)[1];
  if (!campaignId) {
    await ctx.reply('Dùng: /xcamp_xoa <campaign_id>');
    return;
  }
  try {
    const preview = await previewDeletePartial(campaignId);
    if (!preview.canConfirm) {
      await replyPreview(ctx, 'Không xóa', preview.summary, 'dok', 'dno', undefined);
      return;
    }
    createConfirmation({
      kind: 'delete-partial',
      actor: actorOf(ctx),
      summary: preview.summary,
      payload: { campaignId },
    });
    await ctx.reply(
      `<b>Xác nhận xóa</b>\n<pre>${escapeHtml(preview.summary).slice(0, 3500)}</pre>\nGõ lại đúng campaign id <code>${escapeHtml(campaignId)}</code> để xóa. Gõ nội dung khác (không phải lệnh) để hủy.`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    await ctx.reply(describeMoneyError(error));
  }
}

export function setupCampaignEditHandlers(bot: Telegraf): void {
  bot.command('xcamp', ctx => void handleDuplicateCommand(ctx));
  bot.command('duplicate', ctx => void handleDuplicateCommand(ctx));
  bot.command('budget', ctx => void handleBudgetCommand(ctx));
  bot.command('bid', ctx => void handleBidCommand(ctx));
  bot.command('xcamp_resume', ctx => void handleResumeCommand(ctx));
  bot.command('xcamp_xoa', ctx => void handleDeleteCommand(ctx));
  bot.command('xcamp_delete', ctx => void handleDeleteCommand(ctx));

  bot.action(/^(xok|xno|bok|bno|iok|ino|rok|rno|dok|dno):([0-9a-f]{32})$/, async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền.');
      return;
    }
    const action = ctx.match[1] || '';
    const token = ctx.match[2] || '';
    const actor = actorOf(ctx);
    if (action === 'dok') {
      await ctx.answerCbQuery('Gõ lại campaign id');
      await ctx.reply('Xóa chỉ thực hiện khi gõ lại đúng campaign id trong chat.');
      return;
    }
    const peeked = peekConfirmation(token);
    if (!peeked) {
      await ctx.answerCbQuery('Phiên xác nhận đã hết hạn hoặc đã dùng.');
      return;
    }
    if (peeked.actor !== actor) {
      await ctx.answerCbQuery('Phiên này thuộc người khác.');
      return;
    }
    const cancel = action.endsWith('no');
    if (cancel) {
      cancelConfirmation(token);
      await ctx.answerCbQuery('Đã hủy');
      await ctx.editMessageText('Đã hủy. Không có gì được ghi lên TikTok.');
      return;
    }
    const pending = consumeConfirmation(token);
    if (!pending) {
      await ctx.answerCbQuery('Phiên xác nhận đã hết hạn hoặc đã dùng.');
      return;
    }
    await ctx.answerCbQuery('Đang thực hiện...');
    try {
      if (pending.kind === 'duplicate' && action === 'xok') {
        const payload = pending.payload as DuplicateConfirmPayload;
        const wait = await ctx.reply(`Đã xác nhận. Đang xếp hàng nhân bản ${payload.quantity} bản từ ${payload.campaignId}.`);
        enqueueXcampJob({
          ctx,
          waitMessageId: wait.message_id,
          chatId: ctx.chat?.id,
          campaignId: payload.campaignId,
          quantity: payload.quantity,
          budget: payload.budget,
          bid: payload.bid,
          actor: pending.actor,
        });
        return;
      }
      if (pending.kind === 'budget' && action === 'bok') {
        const payload = pending.payload as BudgetConfirmPayload;
        const plan = await commitBudgetChange(
          payload.campaignId,
          payload.budget,
          payload.mode ? parseBudgetMode(payload.mode) : undefined,
          pending.actor,
          payload.stateHash
        );
        await ctx.reply(`Đã cập nhật ngân sách ${payload.campaignId}.\n${plan.after}`);
        return;
      }
      if (pending.kind === 'bid' && action === 'iok') {
        const payload = pending.payload as BidConfirmPayload;
        const plan = await commitBidChange(payload.campaignId, payload.bid, pending.actor, payload.stateHash);
        await ctx.reply(`Đã cập nhật giá thầu ${payload.campaignId}.\n${plan.after}`);
        return;
      }
      if (pending.kind === 'resume' && action === 'rok') {
        const payload = pending.payload as ResumeConfirmPayload;
        const result = await duplicateCampaign(payload.sourceCampaignId, {
          resume: { campaignId: payload.newCampaignId, adgroupId: payload.adgroupId },
          actor: pending.actor,
        });
        try {
          await recordCampaignClone(payload.sourceCampaignId, result);
        } catch (recordError) {
          console.error('Không ghi được bộ đếm nhân bản campaign:', recordError);
        }
        await ctx.reply(`Đã tiếp tục campaign ${result.campaignId}. Campaign, nhóm và quảng cáo được bật khi tạo xong.`);
        return;
      }
      await ctx.reply('Nút xác nhận không khớp thao tác. Không có gì được ghi.');
    } catch (error) {
      await ctx.reply(`Không thực hiện được:\n${describeMoneyError(error)}`);
    }
  });

  bot.on('text', async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
    if (!text || text.startsWith('/')) return next();
    const actor = actorOf(ctx);
    const found = findConfirmation(item => item.kind === 'delete-partial' && item.actor === actor);
    if (!found) return next();
    const payload = found.item.payload as DeleteConfirmPayload;
    if (text === payload.campaignId) {
      consumeConfirmation(found.token);
      try {
        await deletePartialCampaign(payload.campaignId, actor);
        await ctx.reply(`Đã xóa campaign Smart+ ${payload.campaignId}.`);
      } catch (error) {
        await ctx.reply(`Không xóa được:\n${describeMoneyError(error)}`);
      }
      return;
    }
    cancelConfirmation(found.token);
    await ctx.reply(`Id không khớp ${payload.campaignId}. Không xóa.`);
  });
}
