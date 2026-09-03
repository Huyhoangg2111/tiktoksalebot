import {
  duplicateCampaign as tiktokDuplicateCampaign,
  setCampaignStatusById as tiktokSetCampaignStatusById,
  toggleCampaignStatus as tiktokToggleCampaignStatus,
  type TikTokDuplicateCampaignResult,
  type TikTokCampaignOperationStatus,
} from '../tiktok/api.js';

/**
 * Duplicate an existing campaign with new settings
 */
export async function duplicateCampaign(
  originalCampaignId: string,
  options?: {
    newName?: string;
    overrideBudget?: number;
    overrideBid?: number;
  }
): Promise<TikTokDuplicateCampaignResult> {
  const duplicateResult = await tiktokDuplicateCampaign(originalCampaignId, options);

  if (!duplicateResult) {
    throw new Error(`Could not duplicate campaign: ${originalCampaignId}`);
  }

  // Pending Smart+ clones have no campaignId yet but are valid accepted results.
  if (duplicateResult.status !== 'pending' && !duplicateResult.campaignId) {
    throw new Error(`Could not duplicate campaign: ${originalCampaignId}`);
  }

  return duplicateResult;
}

/**
 * Toggle the status of a campaign (enable/disable)
 */
export async function toggleCampaignStatus(campaignId: string): Promise<string> {
  const newStatus = await tiktokToggleCampaignStatus(campaignId);

  if (!newStatus) {
    throw new Error(`Không thể đổi trạng thái chiến dịch ${campaignId}`);
  }

  return newStatus;
}

export async function setCampaignStatusById(
  campaignId: string,
  operationStatus: TikTokCampaignOperationStatus
): Promise<string> {
  return tiktokSetCampaignStatusById(campaignId, operationStatus);
}
