import type { Context, Telegraf } from 'telegraf';
import { getCampaignCloneDefaults, getTodaySpentCampaigns } from '../tiktok/api.js';
import { getCampaignMaterialSnapshot } from '../materials/service.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getVietnamDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function getCommandArgs(ctx: Context): string[] {
  const message = ctx.message;
  const text = message && 'text' in message ? String(message.text || '') : '';
  return text.replace(/^\/campid(?:@\w+)?/i, '').trim().split(/\s+/).filter(Boolean);
}

function formatStatus(status: string | undefined): string {
  if (status === 'active') return '🟢 Đang chạy';
  if (status === 'paused') return '🟡 Tạm dừng';
  if (status === 'deleted') return '⚪ Đã xóa';
  return escapeHtml(status || 'Không xác định');
}

function formatNumber(value: number): string {
  return value.toLocaleString('vi-VN');
}

async function handleCampaignDetail(ctx: Context): Promise<void> {
  const args = getCommandArgs(ctx);
  const campaignId = String(args[0] || '').trim();

  if (!/^\d{10,}$/.test(campaignId)) {
    await ctx.reply([
      '<b>Chi tiết một chiến dịch</b>',
      '',
      'Cú pháp:',
      '<code>/campid CAMPAIGN_ID</code>',
      '<code>/campid CAMPAIGN_ID YYYY-MM-DD</code>',
      '<code>/campid CAMPAIGN_ID YYYY-MM-DD YYYY-MM-DD</code>',
    ].join('\n'), { parse_mode: 'HTML' });
    return;
  }

  const today = getVietnamDateKey();
  const startDate = args[1] || today;
  const endDate = args[2] || startDate;

  if (!isValidDateKey(startDate) || !isValidDateKey(endDate)) {
    await ctx.reply('Ngày không hợp lệ. Hãy dùng định dạng YYYY-MM-DD.');
    return;
  }

  const normalizedStart = startDate <= endDate ? startDate : endDate;
  const normalizedEnd = startDate <= endDate ? endDate : startDate;
  const waitMessage = await ctx.reply(`Đang lấy chi tiết campaign ${campaignId}...`);

  try {
    const defaults = await getCampaignCloneDefaults(campaignId);
    const campaigns = await getTodaySpentCampaigns(normalizedStart, normalizedEnd);
    const rows = campaigns.filter(item => String(item.campaign_id) === campaignId);
    const campaign = rows[0];
    const advertiserId = defaults.advertiserId || campaign?.advertiser_id;

    const totals = rows.reduce((sum, row) => ({
      spend: sum.spend + row.spend,
      impressions: sum.impressions + row.impressions,
      clicks: sum.clicks + row.clicks,
      conversions: sum.conversions + row.conversions,
    }), { spend: 0, impressions: 0, clicks: 0, conversions: 0 });

    const ctr = totals.impressions > 0 ? totals.clicks / totals.impressions * 100 : 0;
    const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
    const cpa = totals.conversions > 0 ? totals.spend / totals.conversions : 0;

    const lines = [
      '<b>📊 CHI TIẾT CHIẾN DỊCH</b>',
      '',
      `Tên: <b>${escapeHtml(defaults.campaignName || campaign?.campaign_name || 'Không rõ')}</b>`,
      `Campaign ID: <code>${escapeHtml(campaignId)}</code>`,
      `Advertiser ID: <code>${escapeHtml(advertiserId || 'Không rõ')}</code>`,
      `Trạng thái: <b>${formatStatus(campaign?.status)}</b>`,
      defaults.budget != null ? `Ngân sách: <b>$${defaults.budget.toFixed(2)}</b>` : '',
      defaults.bid != null ? `Giá thầu: <b>$${defaults.bid.toFixed(2)}</b>` : '',
      '',
      `<b>Hiệu suất ${escapeHtml(normalizedStart === normalizedEnd ? normalizedStart : `${normalizedStart} → ${normalizedEnd}`)}</b>`,
      `Chi tiêu: <b>$${totals.spend.toFixed(2)}</b>`,
      `Hiển thị: <b>${formatNumber(totals.impressions)}</b>`,
      `Clicks: <b>${formatNumber(totals.clicks)}</b>`,
      `CTR: <b>${ctr.toFixed(2)}%</b>`,
      `CPC: <b>$${cpc.toFixed(2)}</b>`,
      `Chuyển đổi: <b>${formatNumber(totals.conversions)}</b>`,
      `CPA: <b>$${cpa.toFixed(2)}</b>`,
    ].filter(Boolean);

    if (advertiserId) {
      try {
        const materialDate = normalizedEnd;
        const snapshot = await getCampaignMaterialSnapshot(
          advertiserId,
          campaignId,
          defaults.campaignName || campaign?.campaign_name,
          materialDate
        );
        if (snapshot.materials.length > 0) {
          const active = snapshot.materials.filter(item => item.status === 'ENABLE').length;
          const paused = snapshot.materials.filter(item => item.status === 'DISABLE').length;
          lines.push(
            '',
            `<b>Material Smart+ ngày ${escapeHtml(materialDate)}</b>`,
            `Tổng: <b>${snapshot.materials.length}</b> · Active: <b>${active}</b> · Pause: <b>${paused}</b>`
          );

          for (const material of snapshot.materials.slice(0, 10)) {
            const icon = material.status === 'ENABLE' ? '🟢' : material.status === 'DISABLE' ? '🟡' : '⚪';
            lines.push(
              `${icon} #${material.materialNumber} · $${material.spend.toFixed(2)} · 🎯 ${formatNumber(material.conversions)} · CPA $${material.cpa.toFixed(2)}`
            );
          }
          if (snapshot.materials.length > 10) {
            lines.push(`… còn ${snapshot.materials.length - 10} material khác.`);
          }
        }
      } catch (error) {
        console.warn(`[campid] Cannot load Smart+ materials for ${campaignId}:`, error);
      }
    }

    if (rows.length === 0) {
      lines.push('', '<i>Campaign không có dữ liệu chi tiêu trong khoảng thời gian đã chọn.</i>');
    }

    const chatId = ctx.chat?.id;
    if (chatId) {
      await ctx.telegram.editMessageText(chatId, waitMessage.message_id, undefined, lines.join('\n'), {
        parse_mode: 'HTML',
      });
    } else {
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const chatId = ctx.chat?.id;
    const text = `❌ Không lấy được campaign <code>${escapeHtml(campaignId)}</code>: ${escapeHtml(message)}`;

    if (chatId) {
      await ctx.telegram.editMessageText(chatId, waitMessage.message_id, undefined, text, {
        parse_mode: 'HTML',
      });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  }
}

export function setupCampaignDetailHandlers(bot: Telegraf): void {
  bot.command('campid', ctx => void handleCampaignDetail(ctx));
}
