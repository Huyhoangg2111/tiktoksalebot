import { Markup, type Context, type Telegraf } from 'telegraf';
import { db } from '../db/index.js';
import {
  runScheduledMaterialActivation,
  type MaterialActiveArgs,
} from './material-bulk-active.js';

const DAILY_RULE_CALLBACK_PREFIX = 'rday';
const MAX_LOOKBACK_DAYS = 90;

interface DailyMaterialRule extends MaterialActiveArgs {
  id: number;
  enabled: boolean;
  lastStartedAt?: string | null;
  lastFinishedAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
}

let dailySchedulerHandle: NodeJS.Timeout | undefined;
let dailyRunInProgress = false;

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

function parseNumber(value: string | undefined): number {
  return Number(String(value || '').trim().replace(',', '.'));
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

async function ensureDailyRuleTable(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_material_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      days INTEGER NOT NULL,
      min_conversions REAL NOT NULL,
      max_cpa REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_started_at TEXT,
      last_finished_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getRules(enabledOnly = false): Promise<DailyMaterialRule[]> {
  await ensureDailyRuleTable();
  const rows = await db.all<any>(
    `SELECT id, days, min_conversions, max_cpa, enabled,
            last_started_at, last_finished_at, last_status, last_error
     FROM daily_material_rules
     ${enabledOnly ? 'WHERE enabled = 1' : ''}
     ORDER BY id ASC`
  );

  return rows.map(row => ({
    id: Number(row.id),
    days: Number(row.days),
    minConversions: Number(row.min_conversions),
    maxCpa: Number(row.max_cpa),
    enabled: Boolean(row.enabled),
    lastStartedAt: row.last_started_at,
    lastFinishedAt: row.last_finished_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
  }));
}

function buildRuleMessage(rules: DailyMaterialRule[]): string {
  const lines = [
    '<b>📏 RULER MATERIAL HẰNG NGÀY</b>',
    'Lịch chạy: <b>01:00 sáng · Asia/Ho_Chi_Minh</b>',
    'Nguồn cấu hình: <b>SQLite</b>',
    '',
  ];

  if (rules.length === 0) {
    lines.push('Chưa có rule nào.');
  } else {
    for (const rule of rules) {
      const status = rule.enabled ? '🟢' : '⚪';
      lines.push(
        `${status} <b>#${rule.id}</b> · ${rule.days} ngày · Conversion &gt; ${formatNumber(rule.minConversions)} · CPA &lt; $${formatNumber(rule.maxCpa)}`
      );
      if (rule.lastStatus) {
        const lastIcon = rule.lastStatus === 'success' ? '✅' : rule.lastStatus === 'running' ? '⏳' : '❌';
        lines.push(
          `   ${lastIcon} Lần cuối: ${escapeHtml(rule.lastFinishedAt || rule.lastStartedAt || 'không rõ')}`
        );
      }
    }
  }

  lines.push(
    '',
    '<b>Lệnh quản lý</b>',
    '<code>/rulerday add 7 5 0.6</code>',
    '<code>/rulerday edit ID 7 5 0.6</code>',
    '<code>/rulerday on ID</code> · <code>/rulerday off ID</code>',
    '<code>/rulerday del ID</code>',
    '<code>/rulerday run</code> hoặc <code>/rulerday run ID</code>'
  );
  return lines.join('\n');
}

function buildRuleKeyboard(rules: DailyMaterialRule[]) {
  const rows = rules.map(rule => [
    Markup.button.callback(
      rule.enabled ? `⏸ Tắt #${rule.id}` : `▶️ Bật #${rule.id}`,
      `${DAILY_RULE_CALLBACK_PREFIX}:${rule.enabled ? 'off' : 'on'}:${rule.id}`
    ),
    Markup.button.callback(`🧪 Chạy #${rule.id}`, `${DAILY_RULE_CALLBACK_PREFIX}:run:${rule.id}`),
    Markup.button.callback(`🗑 Xóa #${rule.id}`, `${DAILY_RULE_CALLBACK_PREFIX}:del:${rule.id}`),
  ]);
  return rows.length ? Markup.inlineKeyboard(rows) : undefined;
}

async function sendRuleMenu(ctx: Context, edit = false): Promise<void> {
  const rules = await getRules();
  const message = buildRuleMessage(rules);
  const keyboard = buildRuleKeyboard(rules);
  const options = {
    parse_mode: 'HTML' as const,
    ...(keyboard ? keyboard : {}),
  };

  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(message, options);
      return;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/message is not modified/i.test(text)) return;
    }
  }
  await ctx.reply(message, options);
}

function parseRuleValues(args: string[]): MaterialActiveArgs | undefined {
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

async function runRules(bot: Telegraf, rules: DailyMaterialRule[], trigger: 'schedule' | 'manual'): Promise<void> {
  if (dailyRunInProgress) {
    if (trigger === 'manual') {
      const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
      if (adminChatId) await bot.telegram.sendMessage(adminChatId, '⏳ Ruler ngày đang chạy.');
    }
    return;
  }

  dailyRunInProgress = true;
  try {
    for (const rule of rules) {
      const startedAt = new Date().toISOString();
      await db.run(
        `UPDATE daily_material_rules
         SET last_started_at = ?, last_status = 'running', last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [startedAt, rule.id]
      );

      const adminChatId = String(process.env.ADMIN_CHAT_ID || '').trim();
      if (adminChatId) {
        await bot.telegram.sendMessage(
          adminChatId,
          [
            `<b>⏰ Ruler ngày #${rule.id} bắt đầu</b>`,
            `Nguồn chạy: <b>${trigger === 'schedule' ? 'Lịch 01:00' : 'Chạy thủ công'}</b>`,
            `${rule.days} ngày · Conversion &gt; ${formatNumber(rule.minConversions)} · CPA &lt; $${formatNumber(rule.maxCpa)}`,
          ].join('\n'),
          { parse_mode: 'HTML' }
        );
      }

      try {
        await runScheduledMaterialActivation(bot, rule);
        await db.run(
          `UPDATE daily_material_rules
           SET last_finished_at = ?, last_status = 'success', last_error = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [new Date().toISOString(), rule.id]
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.run(
          `UPDATE daily_material_rules
           SET last_finished_at = ?, last_status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [new Date().toISOString(), message, rule.id]
        );
        if (adminChatId) {
          await bot.telegram.sendMessage(
            adminChatId,
            `❌ Ruler ngày #${rule.id} thất bại: ${message}`
          );
        }
      }
    }
  } finally {
    dailyRunInProgress = false;
  }
}

function millisecondsUntilNextVietnamOneAm(now = new Date()): number {
  const vietnamOffsetMs = 7 * 60 * 60 * 1000;
  const localNow = new Date(now.getTime() + vietnamOffsetMs);
  let targetUtcMs = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    1, 0, 0, 0
  ) - vietnamOffsetMs;

  if (targetUtcMs <= now.getTime()) {
    targetUtcMs += 24 * 60 * 60 * 1000;
  }
  return targetUtcMs - now.getTime();
}

function armNextDailyRun(bot: Telegraf): void {
  if (dailySchedulerHandle) clearTimeout(dailySchedulerHandle);
  const delayMs = millisecondsUntilNextVietnamOneAm();
  console.log(`Daily material ruler armed for 01:00 Asia/Ho_Chi_Minh in ${Math.round(delayMs / 1000)}s`);

  dailySchedulerHandle = setTimeout(() => {
    void (async () => {
      try {
        const rules = await getRules(true);
        if (rules.length > 0) await runRules(bot, rules, 'schedule');
      } catch (error) {
        console.error('[DailyMaterialRuler] scheduled run failed:', error);
      } finally {
        armNextDailyRun(bot);
      }
    })();
  }, delayMs);
  dailySchedulerHandle.unref();
}

export function startDailyMaterialRulerScheduler(bot: Telegraf): void {
  void ensureDailyRuleTable()
    .then(() => armNextDailyRun(bot))
    .catch(error => console.error('[DailyMaterialRuler] initialization failed:', error));
}

export function setupDailyMaterialRulerHandlers(bot: Telegraf): void {
  bot.command('rulerday', async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.reply('❌ Chỉ admin mới có thể quản lý ruler ngày.');
      return;
    }

    const text = ctx.message?.text || '';
    const args = text.replace(/^\/rulerday(?:@\w+)?/i, '').trim().split(/\s+/).filter(Boolean);
    const action = String(args[0] || '').toLowerCase();

    try {
      if (!action) {
        await sendRuleMenu(ctx);
        return;
      }

      if (action === 'add') {
        const values = parseRuleValues(args.slice(1));
        if (!values) throw new Error('Dùng: /rulerday add DAYS MIN_COV MAX_CPA');
        await ensureDailyRuleTable();
        await db.run(
          `INSERT INTO daily_material_rules(days, min_conversions, max_cpa, enabled)
           VALUES (?, ?, ?, 1)`,
          [values.days, values.minConversions, values.maxCpa]
        );
        await sendRuleMenu(ctx);
        return;
      }

      if (action === 'edit') {
        const id = Number(args[1]);
        const values = parseRuleValues(args.slice(2));
        if (!Number.isInteger(id) || id < 1 || !values) {
          throw new Error('Dùng: /rulerday edit ID DAYS MIN_COV MAX_CPA');
        }
        await ensureDailyRuleTable();
        await db.run(
          `UPDATE daily_material_rules
           SET days = ?, min_conversions = ?, max_cpa = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [values.days, values.minConversions, values.maxCpa, id]
        );
        await sendRuleMenu(ctx);
        return;
      }

      if (action === 'on' || action === 'off') {
        const id = Number(args[1]);
        if (!Number.isInteger(id) || id < 1) throw new Error(`Dùng: /rulerday ${action} ID`);
        await ensureDailyRuleTable();
        await db.run(
          'UPDATE daily_material_rules SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [action === 'on' ? 1 : 0, id]
        );
        await sendRuleMenu(ctx);
        return;
      }

      if (action === 'del') {
        const id = Number(args[1]);
        if (!Number.isInteger(id) || id < 1) throw new Error('Dùng: /rulerday del ID');
        await ensureDailyRuleTable();
        await db.run('DELETE FROM daily_material_rules WHERE id = ?', [id]);
        await sendRuleMenu(ctx);
        return;
      }

      if (action === 'run') {
        const rules = await getRules();
        const id = args[1] ? Number(args[1]) : undefined;
        const selected = id
          ? rules.filter(rule => rule.id === id)
          : rules.filter(rule => rule.enabled);
        if (selected.length === 0) throw new Error(id ? `Không tìm thấy rule #${id}.` : 'Không có rule đang bật.');
        await ctx.reply(`▶️ Bắt đầu chạy ${selected.length} ruler ngày.`);
        void runRules(bot, selected, 'manual');
        return;
      }

      throw new Error('Thao tác không hợp lệ. Gõ /rulerday để xem hướng dẫn.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ ${message}`);
    }
  });

  bot.action(new RegExp(`^${DAILY_RULE_CALLBACK_PREFIX}:(on|off|run|del):(\\d+)$`), async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('Không có quyền thực hiện.');
      return;
    }

    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const rules = await getRules();
    const rule = rules.find(item => item.id === id);
    if (!rule) {
      await ctx.answerCbQuery('Rule không còn tồn tại.');
      await sendRuleMenu(ctx, true);
      return;
    }

    if (action === 'run') {
      await ctx.answerCbQuery(`Đang chạy rule #${id}`);
      void runRules(bot, [rule], 'manual');
      return;
    }

    if (action === 'del') {
      await db.run('DELETE FROM daily_material_rules WHERE id = ?', [id]);
      await ctx.answerCbQuery(`Đã xóa rule #${id}`);
    } else {
      await db.run(
        'UPDATE daily_material_rules SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [action === 'on' ? 1 : 0, id]
      );
      await ctx.answerCbQuery(`Đã ${action === 'on' ? 'bật' : 'tắt'} rule #${id}`);
    }
    await sendRuleMenu(ctx, true);
  });
}
