import { Markup, type Context, type Telegraf } from 'telegraf';
import { initializeAlertRules } from '../alerts/index.js';
import { getSchedulerHealthSnapshot, restartScheduler } from '../scheduler/index.js';
import {
  getRuntimeSettingsSnapshot,
  setRuntimeSettingNumber,
  setRuntimeSettingText,
  type RuntimeSettingKey,
  type RuntimeTextSettingKey,
} from '../settings/runtime.js';

type AnySettingKey = RuntimeSettingKey | RuntimeTextSettingKey;
const pendingSettingsByChat = new Map<number, AnySettingKey>();

const SETTING_LABELS: Record<AnySettingKey, string> = {
  material_ruler_run_time: 'Giờ chạy Material Ruler',
  material_ruler_period: 'Khoảng kiểm tra Material Ruler',
  level1_interval_minutes: 'Lịch cảnh báo cấp 1',
  level2_interval_minutes: 'Lịch cảnh báo cấp 2',
  level3_interval_minutes: 'Lịch cảnh báo cấp 3 (tháng)',
  exchange_rate: 'Tỉ giá USD/VND',
  balance_threshold_usd: 'Ngưỡng số dư',
  level2_cp_ads_threshold: 'Ngưỡng %CP cấp 2 (hôm nay)',
  level3_cp_ads_threshold: 'Ngưỡng %CP cấp 3 (tháng)',
  sheets_concurrency: 'Số luồng Google Sheets (/bc)',
  tiktok_concurrency: 'Số luồng TikTok API (/bc)',
};

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

function formatSettingNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('vi-VN')
    : value.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return '-';

  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return '-';
  if (durationMs < 1_000) return `${durationMs} mili giây`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} giây`;
  return `${(durationMs / 60_000).toFixed(1)} phút`;
}

function formatSchedulerLevel(level: string): string {
  const match = level.match(/level\s*(\d+)/i);
  return match?.[1] ? `Cấp ${match[1]}` : level.toUpperCase();
}

function formatSchedulerStatus(state: {
  running: boolean;
  consecutiveFailures: number;
  lastSuccessAt?: number;
}): string {
  if (state.running) return '🟡 ĐANG CHẠY';
  if (state.consecutiveFailures > 0) return `🔴 LỖI x${state.consecutiveFailures}`;
  if (state.lastSuccessAt) return '🟢 ỔN ĐỊNH';
  return '⚪ ĐANG CHỜ';
}

async function buildSettingsMessage(): Promise<string> {
  const settings = await getRuntimeSettingsSnapshot();

  return [
    '<b>⚙️ CÀI ĐẶT BOT</b>',
    '',
    '<b>📋 Cảnh báo</b>',
    `• Cấp 1: mỗi <b>${formatSettingNumber(settings.level1IntervalMinutes)}</b> phút`,
    `• Cấp 2 (hôm nay): mỗi <b>${formatSettingNumber(settings.level2IntervalMinutes)}</b> phút · %CP &gt; <b>${formatSettingNumber(settings.level2CpAdsThreshold)}%</b>`,
    `• Cấp 3 (tháng): mỗi <b>${formatSettingNumber(settings.level3IntervalMinutes)}</b> phút · %CP &gt; <b>${formatSettingNumber(settings.level3CpAdsThreshold)}%</b>`,
    `• Số dư: dưới <b>$${formatSettingNumber(settings.balanceThresholdUsd)}</b>`,
    '',
    '<b>🎬 Material Ruler</b>',
    `• Giờ chạy: <b>${escapeHtml(settings.materialRulerRunTime)}</b> · múi giờ Việt Nam`,
    `• Khoảng kiểm tra: <b>${escapeHtml(settings.materialRulerPeriod)}</b>`,
    '• Chạy ngay: <code>/materialruler</code>',
    '',
    '<b>💱 Tỉ giá</b>',
    `• USD/VND: <b>${formatSettingNumber(settings.exchangeRate)}</b>`,
    '',
    '<b>⚡ Hiệu năng /bc</b>',
    `• Luồng Google Sheets: <b>${formatSettingNumber(settings.sheetsConcurrency)}</b> (1–8)`,
    `• Luồng TikTok API: <b>${formatSettingNumber(settings.tiktokConcurrency)}</b> (1–8)`,
    '',
    '<i>Chọn mục bên dưới → nhập số mới.</i>',
  ].join('\n');
}

function buildSettingsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⏱ Cấp 1', 'settings:set:level1_interval_minutes'),
      Markup.button.callback('⏱ Cấp 2', 'settings:set:level2_interval_minutes'),
    ],
    [
      Markup.button.callback('⏱ Cấp 3', 'settings:set:level3_interval_minutes'),
      Markup.button.callback('💰 Số dư', 'settings:set:balance_threshold_usd'),
    ],
    [
      Markup.button.callback('📈 %CP C2', 'settings:set:level2_cp_ads_threshold'),
      Markup.button.callback('📉 %CP C3', 'settings:set:level3_cp_ads_threshold'),
    ],
    [
      Markup.button.callback('🎬 Giờ Material Ruler', 'settings:set:material_ruler_run_time'),
      Markup.button.callback('📅 Khoảng kiểm tra', 'settings:set:material_ruler_period'),
    ],
    [Markup.button.callback('💱 Tỉ giá', 'settings:set:exchange_rate')],
    [
      Markup.button.callback('📄 Luồng Sheets', 'settings:set:sheets_concurrency'),
      Markup.button.callback('📡 Luồng TikTok', 'settings:set:tiktok_concurrency'),
    ],
    [Markup.button.callback('🩺 Tình trạng bot', 'settings:health')],
  ]);
}

function buildHealthKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Làm mới', 'settings:health')],
    [Markup.button.callback('♻️ Khởi động lại Docker bot', 'settings:docker_restart')],
    [Markup.button.callback('⬅️ Quay lại cài đặt', 'settings:menu')],
  ]);
}

function buildDockerRestartConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Xác nhận khởi động lại', 'settings:docker_restart_confirm')],
    [Markup.button.callback('❌ Hủy', 'settings:docker_restart_cancel')],
  ]);
}

function buildHealthMessage(): string {
  const snapshot = getSchedulerHealthSnapshot();
  const uptimeSeconds = Math.round(process.uptime());
  const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const lines = [
    '<b>🩺 TÌNH TRẠNG BOT</b>',
    '',
    `⏱ Thời gian hoạt động: <b>${uptimeHours} giờ ${uptimeMinutes} phút</b>`,
    `🧠 Bộ nhớ đang dùng (RSS): <b>${memoryMb} MB</b>`,
    `🔁 Phiên lịch chạy: <b>${snapshot.generation}</b>`,
    `♻️ Đang yêu cầu khởi động lại: <b>${snapshot.restartRequested ? 'CÓ' : 'KHÔNG'}</b>`,
  ];

  for (const [level, state] of Object.entries(snapshot.levels)) {
    lines.push(
      '',
      `<b>${formatSchedulerLevel(level)}: ${formatSchedulerStatus(state)}</b>`,
      `Chu kỳ: ${state.intervalMinutes} phút · Giới hạn thời gian: ${Math.round(state.timeoutMs / 60_000)} phút`,
      `Lần bắt đầu gần nhất: ${formatTimestamp(state.lastStartedAt)}`,
      `Lần thành công gần nhất: ${formatTimestamp(state.lastSuccessAt)}`,
      `Thời gian chạy gần nhất: ${formatDuration(state.lastDurationMs)}`,
      state.lastError
        ? `Lỗi gần nhất: ${escapeHtml(state.lastError.slice(0, 300))}`
        : 'Lỗi gần nhất: Không có'
    );
  }

  return lines.join('\n');
}

async function showSettings(ctx: Context, edit = false): Promise<void> {
  const text = await buildSettingsMessage();
  const options = {
    parse_mode: 'HTML' as const,
    ...buildSettingsKeyboard(),
  };

  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (error) {
      if (!String(error).toLowerCase().includes('message is not modified')) {
        console.error('Cannot edit settings menu:', error);
      }
    }
  }

  await ctx.reply(text, options);
}

async function showHealth(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageText(buildHealthMessage(), {
      parse_mode: 'HTML',
      ...buildHealthKeyboard(),
    });
  } catch (error) {
    if (!String(error).toLowerCase().includes('message is not modified')) {
      throw error;
    }
  }
}

async function applyRuntimeSetting(key: RuntimeSettingKey, value: number): Promise<void> {
  await setRuntimeSettingNumber(key, value);

  if (
    key === 'level1_interval_minutes' ||
    key === 'level2_interval_minutes' ||
    key === 'level3_interval_minutes'
  ) {
    await restartScheduler();
  }

  if (key === 'balance_threshold_usd') {
    await initializeAlertRules();
  }
}

async function handlePendingSettingText(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const pendingKey = pendingSettingsByChat.get(chatId);
  if (!pendingKey) return false;

  const message = ctx.message;
  const text = message && 'text' in message ? String(message.text || '') : '';
  if (text.trim().startsWith('/')) {
    pendingSettingsByChat.delete(chatId);
    return false;
  }
  if (pendingKey === 'material_ruler_run_time' || pendingKey === 'material_ruler_period') {
    try {
      await setRuntimeSettingText(pendingKey, text);
      pendingSettingsByChat.delete(chatId);
      const suffix = pendingKey === 'material_ruler_run_time' ? ' (giờ Việt Nam)' : '';
      await ctx.reply(`✅ Đã cập nhật ${SETTING_LABELS[pendingKey]}: <b>${escapeHtml(text.trim())}</b>${suffix}`, { parse_mode: 'HTML' });
      await showSettings(ctx);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Không lưu được cài đặt: ${escapeHtml(messageText)}`, { parse_mode: 'HTML' });
    }
    return true;
  }

  const value = Number(text.replace(/,/g, '').trim());

  if (!Number.isFinite(value) || value <= 0) {
    const hint =
      pendingKey === 'sheets_concurrency' || pendingKey === 'tiktok_concurrency'
        ? 'Nhập số nguyên từ 1 đến 8.'
        : 'Nhập một số lớn hơn 0.';
    await ctx.reply(`Giá trị không hợp lệ. ${hint}`);
    return true;
  }

  try {
    await applyRuntimeSetting(pendingKey, value);
    pendingSettingsByChat.delete(chatId);
    const displayValue =
      pendingKey === 'sheets_concurrency' || pendingKey === 'tiktok_concurrency'
        ? String(Math.trunc(value))
        : formatSettingNumber(value);

    await ctx.reply(
      `✅ Đã cập nhật ${SETTING_LABELS[pendingKey]}: <b>${escapeHtml(displayValue)}</b>`,
      { parse_mode: 'HTML' }
    );
    await showSettings(ctx);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Không lưu được cài đặt: ${escapeHtml(messageText)}`, {
      parse_mode: 'HTML',
    });
  }

  return true;
}

export function setupSettingsMenuHandlers(bot: Telegraf): void {
  // Đăng ký trước handler cũ để menu cài đặt mới xử lý toàn bộ callback liên quan.
  bot.command('settings', async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.reply('❌ Chỉ admin mới có thể mở cài đặt.');
      return;
    }

    await showSettings(ctx);
  });

  bot.action(/^settings:set:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const key = ctx.match[1] as AnySettingKey;
    if (!SETTING_LABELS[key]) {
      await ctx.answerCbQuery('Cài đặt không hợp lệ.');
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCbQuery('Không xác định được chat.');
      return;
    }

    pendingSettingsByChat.set(chatId, key);
    await ctx.answerCbQuery();
    const rangeHint = key === 'material_ruler_run_time'
      ? '\n<i>Nhập HH:mm theo giờ Việt Nam, ví dụ 00:05 hoặc 06:30.</i>'
      : key === 'sheets_concurrency' || key === 'tiktok_concurrency'
        ? '\n<i>Nhập số nguyên từ 1 đến 8.</i>\nThấp = nhẹ quota · Cao = /bc nhanh hơn.'
        : '';
    await ctx.reply(
      `Nhập giá trị mới cho <b>${escapeHtml(SETTING_LABELS[key])}</b>.${rangeHint}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^settings:health$/, async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    await ctx.answerCbQuery('Đã cập nhật tình trạng bot.');
    await showHealth(ctx);
  });

  bot.action(/^settings:menu$/, async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    await ctx.answerCbQuery();
    await showSettings(ctx, true);
  });

  bot.action(/^settings:docker_restart$/, async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      [
        '<b>♻️ KHỞI ĐỘNG LẠI DOCKER BOT</b>',
        '',
        'Bot sẽ tự thoát tiến trình để Docker khởi động lại container <code>tiktok-sales-bot</code>.',
        'Không tác động đến container hoặc dịch vụ khác trên VPS.',
        '',
        'Bạn có chắc muốn tiếp tục?',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        ...buildDockerRestartConfirmKeyboard(),
      }
    );
  });

  bot.action(/^settings:docker_restart_cancel$/, async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    await ctx.answerCbQuery('Đã hủy khởi động lại.');
    await showHealth(ctx);
  });

  bot.action(/^settings:docker_restart_confirm$/, async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    await ctx.answerCbQuery('Đang khởi động lại Docker bot...');

    try {
      await ctx.editMessageText(
        [
          '<b>♻️ ĐANG KHỞI ĐỘNG LẠI BOT</b>',
          '',
          'Tiến trình bot sẽ thoát sau khoảng 1 giây.',
          'Docker sẽ tự khởi động lại container <code>tiktok-sales-bot</code>.',
          'Sau vài giây hãy mở lại /settings để kiểm tra tình trạng.',
        ].join('\n'),
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Cannot show Docker restart confirmation:', error);
    }

    // docker-compose.yml dùng restart: unless-stopped. Thoát tiến trình chỉ làm
    // Docker khởi động lại container của bot, không cần mount docker.sock và
    // không tác động đến các container khác trên VPS.
    setTimeout(() => process.exit(1), 1_200);
  });

  // Nút cũ từ tin nhắn Telegram trước đây chỉ dùng để chạy install-vps.sh.
  // Giữ chặn để không bao giờ thực thi lại script cũ.
  bot.action(/^settings:restart$/, async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    await ctx.answerCbQuery('Nút cũ đã ngừng hoạt động. Hãy dùng Tình trạng bot → Khởi động lại Docker bot.', {
      show_alert: true,
    });
    await showSettings(ctx, true);
  });

  bot.on('text', async (ctx, next) => {
    if (await handlePendingSettingText(ctx)) {
      return;
    }

    await next();
  });
}
