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

interface CampaignDetailPeriod {
  startDate: string;
  endDate: string;
}

function buildDateKey(year: string, month: string, day: string): string | undefined {
  const dateKey = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isValidDateKey(dateKey) ? dateKey : undefined;
}

function parseCampaignDetailPeriod(value: string | undefined, today: string): CampaignDetailPeriod | undefined {
  if (!value) {
    return { startDate: today, endDate: today };
  }

  const currentYear = today.slice(0, 4);
  const currentMonth = today.slice(5, 7);
  const input = value.trim();

  const dayRange = input.match(/^(\d{1,2})-(\d{1,2})$/);
  if (dayRange) {
    const startDate = buildDateKey(currentYear, currentMonth, dayRange[1]);
    const endDate = buildDateKey(currentYear, currentMonth, dayRange[2]);
    if (!startDate || !endDate) return undefined;
    return startDate <= endDate
      ? { startDate, endDate }
      : { startDate: endDate, endDate: startDate };
  }

  const dayMonthRange = input.match(/^(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{1,2})$/);
  if (dayMonthRange) {
    const startDate = buildDateKey(currentYear, dayMonthRange[2], dayMonthRange[1]);
    const endDate = buildDateKey(currentYear, dayMonthRange[4], dayMonthRange[3]);
    if (!startDate || !endDate) return undefined;
    return startDate <= endDate
      ? { startDate, endDate }
      : { startDate: endDate, endDate: startDate };
  }

  if (isValidDateKey(input)) {
    return { startDate: input, endDate: input };
  }

  return undefined;
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

function formatCampaignDisplayName(value: string | undefined): string {
  const fullName = String(value || '').replace(/\s+/g, ' ').trim();
  if (!fullName) return 'Không rõ tên';
  const parts = fullName.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} - ${parts[1]}` : fullName;
}

async function handleCampaignDetail(ctx: Context): Promise<void> {
  const args = getCommandArgs(ctx);
  const campaignId = String(args[0] || '').trim();

  if (!/^\d{10,}$/.test(campaignId)) {
    await ctx.reply([
      '<b>Chi tiết một chiến dịch</b>',
      '',
      'Cú pháp:',
      '<code>/campid CAMPAIGN_ID</code> — hôm nay',
      '<code>/campid CAMPAIGN_ID 01-06</code> — ngày 1 đến 6 tháng này',
      '<code>/campid CAMPAIGN_ID 10/05-30/07</code> — 10/05 đến 30/07 năm nay',
    ].join('\n'), { parse_mode: 'HTML' });
    return;
  }

  const today = getVietnamDateKey();
  const period = args.length <= 2
    ? parseCampaignDetailPeriod(args[1], today)
    : undefined;

  if (!period) {
    await ctx.reply([
      'Khoảng ngày không hợp lệ.',
      'Dùng <code>01-06</code> cho ngày trong tháng này,',
      'hoặc <code>10/05-30/07</code> cho ngày/tháng trong năm nay.',
    ].join('\n'), { parse_mode: 'HTML' });
    return;
  }

  const normalizedStart = period.startDate;
  const normalizedEnd = period.endDate;
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
    const dateLabel = normalizedStart === normalizedEnd
      ? normalizedStart
      : `${normalizedStart} → ${normalizedEnd}`;
    const budgetAndBid = [
      defaults.budget != null ? `💳 Ngân sách <b>$${defaults.budget.toFixed(2)}</b>` : '',
      defaults.bid != null ? `🏷 Giá thầu <b>$${defaults.bid.toFixed(2)}</b>` : '',
    ].filter(Boolean).join(' · ');

    const lines = [
      '<b>📊 Chi tiết chiến dịch</b>',
      `<b>${escapeHtml(formatCampaignDisplayName(defaults.campaignName || campaign?.campaign_name))}</b>`,
      `<code>${escapeHtml(campaignId)}</code>`,
      `<b>${formatStatus(campaign?.status)}</b>`,
      budgetAndBid,
      '',
      `📅 <b>${escapeHtml(dateLabel)}</b>`,
      `💸 <b>$${totals.spend.toFixed(2)}</b> · 👆 <b>${formatNumber(totals.clicks)}/${ctr.toFixed(2)}%</b> · 🎯 <b>${formatNumber(totals.conversions)}</b> · 💰 <b>$${cpa.toFixed(2)}</b>`,
      `👁 Hiển thị <b>${formatNumber(totals.impressions)}</b> · CPC <b>$${cpc.toFixed(2)}</b>`,
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
            `🎬 <b>${snapshot.materials.length}</b> material · 🟢 <b>${active}</b> đang chạy · 🟡 <b>${paused}</b> tạm dừng`
          );

          for (const material of snapshot.materials.slice(0, 10)) {
            const icon = material.status === 'ENABLE' ? '🟢' : material.status === 'DISABLE' ? '🟡' : '⚪';
            lines.push(
              `${material.materialNumber}. ${icon} 💸 ${material.spend.toFixed(2)} · 👆 ${formatNumber(material.clicks)}/${material.ctr.toFixed(2)}% · 🎯 ${formatNumber(material.conversions)} · 💰 ${material.cpa.toFixed(2)}`
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
