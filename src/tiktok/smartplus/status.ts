import type { TikTokClient } from './client.js';
import { emitAudit, type AuditSink } from './audit.js';
import { chunk, SafetyError } from './util.js';

export type OperationStatus = 'ENABLE' | 'DISABLE' | 'DELETE';

export interface StatusOptions {
  /** Required to be true to send ENABLE. Keeps "starts spending money" an explicit decision. */
  allowEnable?: boolean;
  audit?: AuditSink;
  actor?: string;
}

/**
 * POST /smart_plus/campaign/status/update/ (campaign_ids 1-20; ENABLE|DISABLE|DELETE - verified in official SDK yml).
 * Chunks of 20.
 */
export async function setCampaignStatus(
  client: TikTokClient,
  advertiser_id: string,
  campaign_ids: string[],
  operation_status: OperationStatus,
  opts: StatusOptions = {},
): Promise<void> {
  guardEnable(operation_status, opts);
  for (const ids of chunk(campaign_ids, 20)) {
    const body = { advertiser_id, campaign_ids: ids, operation_status };
    try {
      await client.post('/smart_plus/campaign/status/update/', body);
      await emitAudit(opts.audit, { action: 'smartplus.campaign.status', advertiser_id, actor: opts.actor, request: body, ok: true });
    } catch (e) {
      await emitAudit(opts.audit, { action: 'smartplus.campaign.status', advertiser_id, actor: opts.actor, request: body, response: String(e), ok: false });
      throw e;
    }
  }
}

/** POST /smart_plus/adgroup/status/update/ {advertiser_id, adgroup_ids, operation_status}. */
export async function setAdGroupStatus(
  client: TikTokClient,
  advertiser_id: string,
  adgroup_ids: string[],
  operation_status: OperationStatus,
  opts: StatusOptions = {},
): Promise<void> {
  guardEnable(operation_status, opts);
  // TODO(UNVERIFIED): max ids per call for ad group / ad status update (campaign: 20). Using 20 to be safe.
  for (const ids of chunk(adgroup_ids, 20)) {
    const body = { advertiser_id, adgroup_ids: ids, operation_status };
    await client.post('/smart_plus/adgroup/status/update/', body);
    await emitAudit(opts.audit, { action: 'smartplus.adgroup.status', advertiser_id, actor: opts.actor, request: body, ok: true });
  }
}

/** POST /smart_plus/ad/status/update/ {advertiser_id, smart_plus_ad_ids, operation_status}. */
export async function setAdStatus(
  client: TikTokClient,
  advertiser_id: string,
  smart_plus_ad_ids: string[],
  operation_status: OperationStatus,
  opts: StatusOptions = {},
): Promise<void> {
  guardEnable(operation_status, opts);
  for (const ids of chunk(smart_plus_ad_ids, 20)) {
    const body = { advertiser_id, smart_plus_ad_ids: ids, operation_status };
    await client.post('/smart_plus/ad/status/update/', body);
    await emitAudit(opts.audit, { action: 'smartplus.ad.status', advertiser_id, actor: opts.actor, request: body, ok: true });
  }
}

/**
 * "Go live" helper: enables ad groups, ads, then the campaign LAST (the campaign is the master switch).
 * Call only after an explicit human confirmation, and with `allowEnable: true`.
 */
export async function enableCampaignTree(
  client: TikTokClient,
  advertiser_id: string,
  tree: { campaign_id: string; adgroup_ids?: string[]; smart_plus_ad_ids?: string[] },
  opts: StatusOptions,
): Promise<void> {
  guardEnable('ENABLE', opts);
  if (tree.adgroup_ids?.length) await setAdGroupStatus(client, advertiser_id, tree.adgroup_ids, 'ENABLE', opts);
  if (tree.smart_plus_ad_ids?.length) await setAdStatus(client, advertiser_id, tree.smart_plus_ad_ids, 'ENABLE', opts);
  await setCampaignStatus(client, advertiser_id, [tree.campaign_id], 'ENABLE', opts);
}

function guardEnable(status: OperationStatus, opts: StatusOptions): void {
  if (status === 'ENABLE' && !opts.allowEnable) {
    throw new SafetyError('Refusing to ENABLE without { allowEnable: true } (ENABLE starts spending money; confirm with a human first).');
  }
}
