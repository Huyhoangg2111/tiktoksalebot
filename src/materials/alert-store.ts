import { db } from '../db/index.js';

export type StoredAlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export async function saveAlertHistory(
  type: string,
  message: string,
  severity: StoredAlertSeverity = 'low'
): Promise<void> {
  // Level 1 chỉ giữ notification campaign khi đạt điều kiện.
  // Các trường hợp vượt giới hạn đã được material ruler tự động Pause/Active và có feedback riêng,
  // nên không lưu thêm một campaign_notify trùng ý nghĩa vào lịch sử /alerts.
  if (type === 'campaign_notify' && /^Campaign\s+vượt giới hạn\b/i.test(message.trim())) {
    return;
  }

  await db.run(
    `INSERT INTO alerts (type, message, severity, created_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    [type, message, severity]
  );
}
