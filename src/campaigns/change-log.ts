import { db } from '../db/index.js';
import { redact } from '../tiktok/smartplus/redact.js';

export async function ensureCampaignChangeLog(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      action TEXT NOT NULL,
      advertiser_id TEXT,
      campaign_id TEXT,
      before_json TEXT,
      after_json TEXT,
      ok INTEGER NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function writeCampaignAudit(event: {
  actor?: string;
  action: string;
  advertiserId?: string;
  campaignId?: string;
  before?: unknown;
  after?: unknown;
  ok: boolean;
  detail?: string;
}): Promise<void> {
  try {
    await ensureCampaignChangeLog();
    const safeBefore = JSON.stringify(redact(event.before ?? null));
    const safeAfter = JSON.stringify(redact(event.after ?? null));
    const detail = event.detail ? String(redact(event.detail)) : null;
    await db.run(
      `INSERT INTO campaign_change_log(actor, action, advertiser_id, campaign_id, before_json, after_json, ok, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.actor || null,
        event.action,
        event.advertiserId || null,
        event.campaignId || null,
        safeBefore,
        safeAfter,
        event.ok ? 1 : 0,
        detail,
      ]
    );
  } catch (error) {
    console.error('[audit] Không ghi được campaign_change_log:', error instanceof Error ? error.message : error);
  }
}
