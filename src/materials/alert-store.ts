import { db } from '../db/index.js';

export type StoredAlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export async function saveAlertHistory(
  type: string,
  message: string,
  severity: StoredAlertSeverity = 'low'
): Promise<void> {
  await db.run(
    `INSERT INTO alerts (type, message, severity, created_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    [type, message, severity]
  );
}
