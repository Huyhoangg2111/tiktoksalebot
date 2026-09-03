import { db } from '../db/index.js';

export interface CampaignCloneResult {
  campaignId: string;
  advertiserId?: string;
  campaignName?: string;
}

export async function recordCampaignClone(
  originalCampaignId: string,
  clone: CampaignCloneResult
): Promise<void> {
  const originalId = String(originalCampaignId || '').trim();
  const clonedId = String(clone.campaignId || '').trim();

  if (!originalId || !clonedId) {
    return;
  }

  await db.run(
    `INSERT INTO campaign_clone_log (
      original_campaign_id,
      cloned_campaign_id,
      cloned_advertiser_id,
      cloned_campaign_name
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(cloned_campaign_id)
    DO UPDATE SET
      original_campaign_id = excluded.original_campaign_id,
      cloned_advertiser_id = excluded.cloned_advertiser_id,
      cloned_campaign_name = excluded.cloned_campaign_name`,
    [
      originalId,
      clonedId,
      clone.advertiserId || null,
      clone.campaignName || null,
    ]
  );
}

export async function getCampaignCloneCountMap(
  campaignIds: string[]
): Promise<Map<string, number>> {
  const uniqueCampaignIds = [...new Set(
    campaignIds
      .map(campaignId => String(campaignId || '').trim())
      .filter(Boolean)
  )];

  if (uniqueCampaignIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueCampaignIds.map(() => '?').join(', ');
  const rows = await db.all<{ original_campaign_id: string; clone_count: number }>(
    `SELECT original_campaign_id, COUNT(*) AS clone_count
     FROM campaign_clone_log
     WHERE original_campaign_id IN (${placeholders})
     GROUP BY original_campaign_id`,
    uniqueCampaignIds
  );

  return new Map(
    rows.map(row => [
      row.original_campaign_id,
      Number(row.clone_count || 0),
    ])
  );
}
