import type { Telegraf } from 'telegraf';
import {
  buildMaterialDetailCallbackData,
  buildMaterialToggleCallbackData,
  parseMaterialDetailCallbackData,
  parseMaterialToggleCallbackData,
} from '../materials/callbacks.js';
import {
  getCampaignMaterialSnapshot,
  setMaterialOperationStatusBatch,
  type CampaignMaterialSnapshot,
} from '../materials/service.js';

const MATERIALS_PER_PAGE = 7;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isAdmin(ctx: any): boolean {
  const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return true;
  return String(ctx?.chat?.id ?? ctx?.callbackQuery?.message?.chat?.id ?? '') === adminChatId;
}

function formatUsd(value: number): string {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${Number(value || 0).toFixed(2)}%`;
}

function shortMaterialName(name: string | undefined, tiktokItemId: string): string {
  const normalized = String(name || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return `Video ${tiktokItemId}`;
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function renderMaterialPage(snapshot: CampaignMaterialSnapshot, requestedPage: number) {
  const totalPages = Math.max(1, Math.ceil(snapshot.materials.length / MATERIALS_PER_PAGE));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const start = page * MATERIALS_PER_PAGE;
  const items = snapshot.materials.slice(start, start + MATERIALS_PER_PAGE);
  const campaignLabel = snapshot.campaignName || snapshot.campaignId;

  const lines = [
    `<b>🎬 Chi tiết material</b>`,
    `<b>${escapeHtml(campaignLabel)}</b>`,
    `<code>${escapeHtml(snapshot.campaignId)}</code>`,
    `📅 ${escapeHtml(snapshot.dateKey)} · Trang ${page + 1}/${totalPages}`,
    '',
  ];

  if (snapshot.materials.length === 0) {
    lines.push('Không tìm thấy material Smart+ cho campaign này.');
  }

  for (const item of items) {
    const enabled = item.status === 'ENABLE';
    const icon = enabled ? '🟢' : item.status === 'DISABLE' ? '🔴' : '⚪';
    lines.push(
      `${item.materialNumber}. ${icon} <b>${escapeHtml(shortMaterialName(item.name, item.tiktokItemId))}</b>`,
      `💵 ${formatUsd(item.spend)} · 👆 ${item.clicks.toLocaleString()}/${formatPercent(item.ctr)} · 🎯 ${item.conversions.toLocaleString()} · 💰 ${formatUsd(item.cpa)}`,
      `<code>${escapeHtml(item.tiktokItemId)}</code>`
    );
  }

  const inlineKeyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const item of items) {
    const nextStatus = item.status === 'ENABLE' ? 'DISABLE' : 'ENABLE';
    inlineKeyboard.push([{
      text: item.status === 'ENABLE'
        ? `⏸ ${item.materialNumber} Tắt`
        : `▶️ ${item.materialNumber} Bật`,
      callback_data: buildMaterialToggleCallbackData({
        advertiserId: item.advertiserId,
        smartPlusAdId: item.smartPlusAdId,
        adMaterialId: item.adMaterialId,
        campaignId: item.campaignId,
        operationStatus: nextStatus,
        page,
      }),
    }]);
  }

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) {
    navigation.push({
      text: '◀️',
      callback_data: buildMaterialDetailCallbackData(snapshot.advertiserId, snapshot.campaignId, page - 1),
    });
  }
  navigation.push({
    text: '🔄 Làm mới',
    callback_data: buildMaterialDetailCallbackData(snapshot.advertiserId, snapshot.campaignId, page),
  });
  if (page + 1 < totalPages) {
    navigation.push({
      text: '▶️',
      callback_data: buildMaterialDetailCallbackData(snapshot.advertiserId, snapshot.campaignId, page + 1),
    });
  }
  inlineKeyboard.push(navigation);

  return {
    text: lines.join('\n'),
    replyMarkup: { inline_keyboard: inlineKeyboard },
  };
}

async function editMaterialMessage(ctx: any, snapshot: CampaignMaterialSnapshot, page: number): Promise<void> {
  const rendered = renderMaterialPage(snapshot, page);
  try {
    await ctx.editMessageText(rendered.text, {
      parse_mode: 'HTML',
      reply_markup: rendered.replyMarkup,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (!message.includes('message is not modified')) throw error;
  }
}

export function setupMaterialHandlers(bot: Telegraf): void {
  bot.action(/^md:/, async (ctx: any) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const data = parseMaterialDetailCallbackData(String(ctx.callbackQuery?.data || ''));
    if (!data) {
      await ctx.answerCbQuery('Dữ liệu chi tiết không hợp lệ.');
      return;
    }

    await ctx.answerCbQuery('Đang tải material...');
    try {
      const snapshot = await getCampaignMaterialSnapshot(data.advertiserId, data.campaignId);
      const rendered = renderMaterialPage(snapshot, data.page);
      await ctx.reply(rendered.text, {
        parse_mode: 'HTML',
        reply_markup: rendered.replyMarkup,
      });
    } catch (error) {
      console.error('Material detail callback failed:', error);
      await ctx.reply(`⛔ Không tải được material: ${escapeHtml(error instanceof Error ? error.message : String(error))}`, {
        parse_mode: 'HTML',
      });
    }
  });

  bot.action(/^mt:/, async (ctx: any) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const data = parseMaterialToggleCallbackData(String(ctx.callbackQuery?.data || ''));
    if (!data) {
      await ctx.answerCbQuery('Dữ liệu bật/tắt không hợp lệ.');
      return;
    }

    await ctx.answerCbQuery(data.operationStatus === 'ENABLE' ? 'Đang bật material...' : 'Đang tắt material...');

    try {
      const result = await setMaterialOperationStatusBatch(
        data.advertiserId,
        data.smartPlusAdId,
        [data.adMaterialId],
        data.operationStatus
      );

      if (result.failed.length > 0) {
        await ctx.reply('⚠️ TikTok đã nhận yêu cầu nhưng trạng thái xác minh chưa đúng. Bot không tự giả định thành công.');
      }

      const snapshot = await getCampaignMaterialSnapshot(data.advertiserId, data.campaignId);
      await editMaterialMessage(ctx, snapshot, data.page);
    } catch (error) {
      console.error('Material toggle callback failed:', error);
      await ctx.reply(`⛔ Không thể cập nhật material: ${escapeHtml(error instanceof Error ? error.message : String(error))}`, {
        parse_mode: 'HTML',
      });
    }
  });
}
