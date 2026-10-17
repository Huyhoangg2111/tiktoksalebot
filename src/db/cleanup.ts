import { db } from './index.js';

/**
 * Tự động xoá dữ liệu lịch sử cũ để giảm dung lượng lưu trữ trên VPS.
 *
 * - Mặc định giữ 45 ngày (env `DATA_RETENTION_DAYS` để đổi).
 * - Chạy 1 lần/ngày vào ~00:35 giờ Việt Nam.
 * - Chỉ xoá dữ liệu LỊCH SỬ (alert, log, cache); cấu hình (bot_settings,
 *   admin_config_rows, alert_action_rules...) và trạng thái hiện hành không bao giờ bị xoá.
 * - VACUUM chạy hàng tuần (Chủ nhật) sau khi dọn để trả lại dung lượng file.
 */

const TZ = 'Asia/Ho_Chi_Minh';
const CLEANUP_HOUR = 0;
const CLEANUP_MINUTE = 35;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export const DEFAULT_RETENTION_DAYS = 45;

function getRetentionDays(): number {
  const parsed = Number(process.env.DATA_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 365
    ? Math.trunc(parsed)
    : DEFAULT_RETENTION_DAYS;
}

function vnTimeKeys(): { dateKey: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts();
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const weekday = (get('weekday') || '').trim();
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    // Intl "short" weekday ở vi locale có thể là "CN"/"Th 2"...; map gần đúng qua chuỗi EN mặc định
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].find(day => weekday.includes(day)) === 'Sun' ? 0 : 1,
  };
}

async function cutoffDays(days: number): Promise<{ textCutoff: string; msCutoff: number; dateCutoff: string }> {
  const now = Date.now();
  const msCutoff = now - days * 24 * 60 * 60 * 1000;
  const dateCutoff = new Date(msCutoff).toISOString().slice(0, 10);
  // datetime('now','-N days') của SQLite dùng UTC — khớp với date key dạng ISO.
  const textCutoff = new Date(msCutoff)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  return { textCutoff, msCutoff, dateCutoff };
}

export async function runCleanup(): Promise<void> {
  const days = getRetentionDays();
  const { textCutoff, msCutoff, dateCutoff } = await cutoffDays(days);
  const summary: string[] = [];

  const count = async (sql: string, params: unknown[] = []): Promise<{ done: number }> => {
    const result = await db.run(sql, params).catch(error => {
      console.warn('[DataRetention] cleanup statement failed:', String(error));
      return { changes: 0 } as { changes: number };
    });
    return { done: (result as { changes: number }).changes ?? 0 };
  };

  // Lịch sử alert / log — mỗi dòng có created_at TEXT (UTC).
  summary.push(`alerts: ${await count('DELETE FROM alerts WHERE created_at < ?', [textCutoff]).then(r => r.done)}`);
  summary.push(`campaign_change_log: ${await count('DELETE FROM campaign_change_log WHERE created_at < ?', [textCutoff]).then(r => r.done)}`);
  summary.push(`campaign_clone_log: ${await count('DELETE FROM campaign_clone_log WHERE created_at < ?', [textCutoff]).then(r => r.done)}`);
  summary.push(`smart_plus_appeal_attempts: ${await count('DELETE FROM smart_plus_appeal_attempts WHERE attempted_at < ?', [textCutoff]).then(r => r.done)}`);
  summary.push(`admin_audit_log: ${await count('DELETE FROM admin_audit_log WHERE created_at < ?', [textCutoff]).then(r => r.done)}`);

  // Cache campaign theo ngày — date_key dạng YYYY-MM-DD.
  summary.push(`spent_campaign_cache: ${await count('DELETE FROM spent_campaign_cache WHERE date_key < ?', [dateCutoff]).then(r => r.done)}`);
  summary.push(`material_daily_ruler_runs: ${await count('DELETE FROM material_daily_ruler_runs WHERE date_key < ?', [dateCutoff]).then(r => r.done)}`);

  // Callback token sản phẩm (TTL 6h) — giữ tối đa 2 ngày.
  summary.push(`product_pause_callbacks: ${await count('DELETE FROM product_pause_callbacks WHERE created_at_ms < ?', [Date.now() - 2 * 24 * 60 * 60 * 1000]).then(r => r.done)}`);

  // Cooldown notification: xoá key cũ (>45 ngày) để bảng không phình vô hạn.
  // Xoá cooldown cũ nghĩa là nếu key này cần thiết lại sẽ gửi thông báo 1 lần đầu tiên — an toàn.
  summary.push(`campaign_material_rule_notifications: ${await count('DELETE FROM campaign_material_rule_notifications WHERE last_sent_ms < ?', [msCutoff]).then(r => r.done)}`);
  summary.push(`alert_action_state: ${await count('DELETE FROM alert_action_state WHERE updated_at < ?', [textCutoff]).then(r => r.done)}`);

  // Lịch sử đăng nhập admin: mã OTP hết hạn & session hết hạn.
  summary.push(`admin_login_codes: ${await count('DELETE FROM admin_login_codes WHERE expires_at < ?', [Date.now()]).then(r => r.done)}`);
  summary.push(`admin_sessions: ${await count('DELETE FROM admin_sessions WHERE expires_at < ?', [Date.now()]).then(r => r.done)}`);

  // History snapshot cấu hình: giữ 50 bản mới nhất cho mỗi section.
  try {
    const sections = await db.all<{ section: string }>('SELECT DISTINCT section FROM admin_config_history');
    let deleted = 0;
    for (const { section } of sections) {
      const result = await count(
        'DELETE FROM admin_config_history WHERE section = ? AND id NOT IN (SELECT id FROM admin_config_history WHERE section = ? ORDER BY id DESC LIMIT 50)',
        [section, section]
      );
      deleted += result.done;
    }
    summary.push(`admin_config_history (giữ 50/section): ${deleted}`);
  } catch (error) {
    console.warn('[DataRetention] admin_config_history cleanup failed:', error);
  }

  console.log(`[DataRetention] dọn xong (giữ ${days} ngày): ${summary.join(' · ')}`);
}

async function runVacuum(): Promise<void> {
  try {
    await db.exec('VACUUM');
    console.log('[DataRetention] VACUUM hoàn tất — đã thu hồi dung lượng file DB.');
  } catch (error) {
    console.warn('[DataRetention] VACUUM failed:', error);
  }
}

async function cleanupOncePerDay(): Promise<void> {
  const { dateKey, hour, minute, weekday } = vnTimeKeys();
  // Cửa sổ 00:30–00:59 (dọn 1 lần/ngày, marker chống lặp — tick cách 30 phút nên dùng cửa sổ thay vì bấm đúng phút).
  if (hour !== CLEANUP_HOUR || minute < CLEANUP_MINUTE) return;

  const markerKey = 'db_cleanup_last_date';
  const last = await db.get<{ value: string }>('SELECT value FROM bot_settings WHERE key = ?', [markerKey]);
  if (String(last?.value || '') === dateKey) return;

  await db.run('INSERT INTO bot_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP', [markerKey, dateKey]);
  await runCleanup();
  if (weekday === 0) await runVacuum();
}

let started = false;

/** Gọi từ src/index.ts một lần sau connectDB(). */
export function startDataRetention(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => {
    cleanupOncePerDay().catch(error => console.warn('[DataRetention] cleanup tick failed:', error));
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  // Chạy thử ngay lúc khởi động: nếu hôm qua/bữa trước lỡ bỏ lịch (container restart),
  // khoảng giờ 00:35 vừa qua thì dọn bù; không phải giờ thì no-op.
  cleanupOncePerDay().catch(error => console.warn('[DataRetention] startup cleanup check failed:', error));
  console.log(`[DataRetention] tự xoá dữ liệu lịch sử sau ${getRetentionDays()} ngày đã kích hoạt.`);
}
