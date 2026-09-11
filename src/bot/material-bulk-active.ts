import type { Context, Telegraf } from 'telegraf';
import { getTodaySpentCampaigns, type TikTokSpentCampaign } from '../tiktok/api.js';
import {
  getCampaignMaterialSnapshot,
  setMaterialOperationStatusBatch,
  type CampaignMaterialItem,
} from '../materials/service.js';

const MAX_LOOKBACK_DAYS = 90;
const SCAN_CONCURRENCY = 3;
const PROGRESS_EDIT_INTERVAL_MS = 1_500;

interface MaterialActiveArgs {
  days: number;
  minConversions: number;
  maxCpa: number;
}

interface QualifiedMaterial {
  campaign: TikTokSpentCampaign;
  material: CampaignMaterialItem;
  cpa: number;
}

interface ProductSummary {
  productName: string;
  marketCode: string;
  campaignKeys: Set<string>;
  qualifiedCount: number;
  needEnableCount: number;
  alreadyActiveCount: number;
}

let materialActiveRunning = false;

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

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('vi-VN')
    : value.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
}

function getVietnamDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDays(dateKey: string, offset: number): string {
  const value = new Date(`${dateKey}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function parseNumber(value: string | undefined): number {
  return Number(String(value || '').trim().replace(',', '.'));
}

function parseArgs(ctx: Context): MaterialActiveArgs | undefined {
  const message = ctx.message;
  const text = message && 'text' in message ? String(message.text || '') : '';
  const args = text.replace(/^\/(?:matactive|materialactive)(?:@\w+)?/i, '').trim().split(/\s+/).filter(Boolean);
  if (args.length !== 3) return undefined;

  const days = Number(args[0]);
  const minConversions = parseNumber(args[1]);
  const maxCpa = parseNumber(args[2]);

  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_LOOKBACK_DAYS ||
    !Number.isFinite(minConversions) ||
    minConversions < 0 ||
    !Number.isFinite(maxCpa) ||
    maxCpa <= 0
  ) {
    return undefined;
  }

  return { days, minConversions, maxCpa };
}

function uniqueCampaigns(rows: TikTokSpentCampaign[]): TikTokSpentCampaign[] {
  const byKey = new Map<string, TikTokSpentCampaign>();
  for (const row of rows) {
    const key = `${row.advertiser_id}:${row.campaign_id}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function extractProductMarket(campaignName: string): { productName: string; marketCode: string } {
  const parts = campaignName.split(/\s+-\s+/).map(item => item.trim()).filter(Boolean);
  return {
    productName: parts[0] || 'Unknown',
    marketCode: (parts[1] || 'UNKNOWN').toUpperCase(),
  };
}

function summarizeByProduct(items: QualifiedMaterial[]): ProductSummary[] {
  const summaries = new Map<string, ProductSummary>();

  for (const item of items) {
    const { productName, marketCode } = extractProductMarket(item.campaign.campaign_name);
    const key = `${productName.toLocaleLowerCase('vi-VN')}|${marketCode.toLowerCase()}`;
    const summary = summaries.get(key) || {
      productName,
      marketCode,
      campaignKeys: new Set<string>(),
      qualifiedCount: 0,
      needEnableCount: 0,
      alreadyActiveCount: 0,
    };

    summary.campaignKeys.add(`${item.campaign.advertiser_id}:${item.campaign.campaign_id}`);
    summary.qualifiedCount += 1;
    if (item.material.status === 'DISABLE') summary.needEnableCount += 1;
    if (item.material.status === 'ENABLE') summary.alreadyActiveCount += 1;
    summaries.set(key, summary);
  }

  return [...summaries.values()].sort((a, b) =>
    b.qualifiedCount - a.qualifiedCount ||
    a.productName.localeCompare(b.productName, 'vi') ||
    a.marketCode.localeCompare(b.marketCode, 'vi')
  );
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, () => runWorker())
  );
}

function splitMessage(message: string, maxLength = 3500): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of message.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
    } else {
      if (current) chunks.push(current);
      current = line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function safeEditProgress(
  ctx: Context,
  messageId: number,
  text: string
): Promise<void> {
  if (!ctx.chat?.id) return;
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text, {
      parse_mode: 'HTML',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/message is not modified/i.test(message)) {
      console.warn('[matactive] Cannot update progress message:', message);
    }
  }
}

async function handleMaterialActive(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('❌ Chỉ admin mới có thể thực hiện hành động này.');
    return;
  }

  const args = parseArgs(ctx);
  if (!args) {
    await ctx.reply([
      '<b>Tự động bật material đạt điều kiện</b>',
      '',
      'Cú pháp: <code>/matactive DAYS MIN_COV MAX_CPA</code>',
      'Ví dụ: <code>/matactive 7 5 0.6</code>',
      'Điều kiện ví dụ: conversion &gt; 5 và CPA &lt; $0.60 trong 7 ngày.',
      `DAYS từ 1 đến ${MAX_LOOKBACK_DAYS}.`,
    ].join('\n'), { parse_mode: 'HTML' });
    return;
  }

  if (materialActiveRunning) {
    await ctx.reply('⏳ Đang có một tiến trình /matactive khác chạy. Vui lòng chờ hoàn tất.');
    return;
  }

  materialActiveRunning = true;
  const endDate = getVietnamDateKey();
  const startDate = addDays(endDate, -(args.days - 1));
  const progress = await ctx.reply([
    '<b>🔎 Đang quét material</b>',
    `Thời gian: <b>${startDate} → ${endDate}</b>`,
    `Điều kiện: <b>Conversion &gt; ${formatNumber(args.minConversions)} · CPA &lt; $${formatNumber(args.maxCpa)}</b>`,
    'Đang lấy danh sách campaign...',
  ].join('\n'), { parse_mode: 'HTML' });

  try {
    const campaignRows = await getTodaySpentCampaigns(startDate, endDate);
    const campaigns = uniqueCampaigns(campaignRows);
    const byAdvertiser = new Map<string, TikTokSpentCampaign[]>();
    for (const campaign of campaigns) {
      const values = byAdvertiser.get(campaign.advertiser_id) || [];
      values.push(campaign);
      byAdvertiser.set(campaign.advertiser_id, values);
    }

    const qualified: QualifiedMaterial[] = [];
    const scanErrors: string[] = [];
    let scanned = 0;
    let lastProgressEdit = 0;

    await mapWithConcurrency([...byAdvertiser.values()], SCAN_CONCURRENCY, async advertiserCampaigns => {
      for (const campaign of advertiserCampaigns) {
        try {
          const snapshot = await getCampaignMaterialSnapshot(
            campaign.advertiser_id,
            campaign.campaign_id,
            campaign.campaign_name,
            startDate,
            endDate
          );
          for (const material of snapshot.materials) {
            const cpa = material.conversions > 0 ? material.spend / material.conversions : material.cpa;
            if (material.conversions > args.minConversions && cpa < args.maxCpa) {
              qualified.push({ campaign, material, cpa });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          scanErrors.push(`${campaign.campaign_id}: ${message}`);
          console.error(`[matactive] Scan failed campaign=${campaign.campaign_id}:`, error);
        } finally {
          scanned += 1;
          if (Date.now() - lastProgressEdit >= PROGRESS_EDIT_INTERVAL_MS || scanned === campaigns.length) {
            lastProgressEdit = Date.now();
            await safeEditProgress(ctx, progress.message_id, [
              '<b>🔎 Đang quét material</b>',
              `Thời gian: <b>${startDate} → ${endDate}</b>`,
              `Tiến trình: <b>${scanned}/${campaigns.length}</b> campaign`,
              `Đã tìm thấy: <b>${qualified.length}</b> material đạt điều kiện`,
              scanErrors.length ? `Lỗi quét: <b>${scanErrors.length}</b> campaign` : '',
            ].filter(Boolean).join('\n'));
          }
        }
      }
    });

    const qualifiedCampaigns = new Set(
      qualified.map(item => `${item.campaign.advertiser_id}:${item.campaign.campaign_id}`)
    );
    const needEnable = qualified.filter(item => item.material.status === 'DISABLE');
    const alreadyActive = qualified.filter(item => item.material.status === 'ENABLE').length;
    const unknown = qualified.length - needEnable.length - alreadyActive;
    const summaries = summarizeByProduct(qualified);

    const groups = new Map<string, QualifiedMaterial[]>();
    for (const item of needEnable) {
      const key = `${item.material.advertiserId}:${item.material.smartPlusAdId}`;
      const values = groups.get(key) || [];
      values.push(item);
      groups.set(key, values);
    }

    await safeEditProgress(ctx, progress.message_id, [
      '<b>⚙️ Đã quét xong, đang bật material</b>',
      `Đạt điều kiện: <b>${qualified.length}</b> material / <b>${qualifiedCampaigns.size}</b> campaign`,
      `Cần bật: <b>${needEnable.length}</b> · Đã active: <b>${alreadyActive}</b>`,
      unknown ? `Không rõ trạng thái: <b>${unknown}</b>` : '',
      `Tiến trình bật: <b>0/${needEnable.length}</b>`,
    ].filter(Boolean).join('\n'));

    let enabled = 0;
    let failed = 0;
    let processed = 0;
    let lastEnableEdit = 0;

    await mapWithConcurrency([...groups.values()], SCAN_CONCURRENCY, async group => {
      const first = group[0];
      try {
        const result = await setMaterialOperationStatusBatch(
          first.material.advertiserId,
          first.material.smartPlusAdId,
          group.map(item => item.material.adMaterialId),
          'ENABLE'
        );
        enabled += result.verified.length;
        failed += result.failed.length;
      } catch (error) {
        failed += group.length;
        console.error(
          `[matactive] Enable failed advertiser=${first.material.advertiserId} ad=${first.material.smartPlusAdId}:`,
          error
        );
      } finally {
        processed += group.length;
        if (Date.now() - lastEnableEdit >= PROGRESS_EDIT_INTERVAL_MS || processed === needEnable.length) {
          lastEnableEdit = Date.now();
          await safeEditProgress(ctx, progress.message_id, [
            '<b>⚙️ Đang bật material</b>',
            `Đạt điều kiện: <b>${qualified.length}</b> material / <b>${qualifiedCampaigns.size}</b> campaign`,
            `Tiến trình bật: <b>${processed}/${needEnable.length}</b>`,
            `Thành công: <b>${enabled}</b> · Lỗi: <b>${failed}</b>`,
          ].join('\n'));
        }
      }
    });

    await safeEditProgress(ctx, progress.message_id, [
      '<b>✅ Hoàn tất /matactive</b>',
      `Thời gian: <b>${startDate} → ${endDate}</b>`,
      `Điều kiện: <b>Conversion &gt; ${formatNumber(args.minConversions)} · CPA &lt; $${formatNumber(args.maxCpa)}</b>`,
      `Đạt điều kiện: <b>${qualified.length}</b> material / <b>${qualifiedCampaigns.size}</b> campaign`,
      `Cần bật: <b>${needEnable.length}</b>`,
      `Bật thành công: <b>${enabled}</b> · Lỗi: <b>${failed}</b>`,
      `Đã active sẵn: <b>${alreadyActive}</b>`,
      unknown ? `Không rõ trạng thái: <b>${unknown}</b>` : '',
      scanErrors.length ? `Campaign quét lỗi: <b>${scanErrors.length}</b>` : '',
    ].filter(Boolean).join('\n'));

    if (summaries.length > 0) {
      const lines = [
        '<b>Thống kê material đạt điều kiện theo sản phẩm</b>',
        '',
        ...summaries.map(summary =>
          `${escapeHtml(summary.productName)} (${escapeHtml(summary.marketCode)}) - ` +
          `<b>${summary.qualifiedCount}</b> material / <b>${summary.campaignKeys.size}</b> camp` +
          ` · cần bật <b>${summary.needEnableCount}</b> · active sẵn <b>${summary.alreadyActiveCount}</b>`
        ),
      ];
      for (const chunk of splitMessage(lines.join('\n'))) {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      }
    }
  } catch (error) {
    console.error('[matactive] Fatal error:', error);
    const message = error instanceof Error ? error.message : String(error);
    await safeEditProgress(ctx, progress.message_id, [
      '<b>❌ /matactive thất bại</b>',
      escapeHtml(message),
    ].join('\n'));
  } finally {
    materialActiveRunning = false;
  }
}

export function setupMaterialBulkActiveHandlers(bot: Telegraf): void {
  bot.command('matactive', ctx => void handleMaterialActive(ctx));
  bot.command('materialactive', ctx => void handleMaterialActive(ctx));
}
