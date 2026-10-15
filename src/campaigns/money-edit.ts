import { assertAdvertiserAllowed, getAllowedAdvertiserIds, getTikTokWriteAccessToken } from '../tiktok/config.js';
import { TikTokClient } from '../tiktok/smartplus/client.js';
import { TikTokApiError } from '../tiktok/smartplus/errors.js';
import {
  planBidChange,
  planBudgetChange,
  type AdGroupMoney,
  type BudgetMode,
  type CampaignKind,
  type MoneyPlan,
  type MoneySnapshot,
} from '../tiktok/smartplus/money.js';
import { redact } from '../tiktok/smartplus/redact.js';
import { writeCampaignAudit } from './change-log.js';

type Row = Record<string, unknown>;

export async function createWriteClient(): Promise<TikTokClient> {
  const accessToken = await getTikTokWriteAccessToken();
  return new TikTokClient({
    accessToken,
    maxRetries: 2,
    rateLimitDelaysMs: [2_000, 8_000],
    logger: {
      warn(msg, meta) {
        console.warn(`[tiktok] ${msg}`, meta ? redact(meta) : '');
      },
    },
  });
}

function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  if (value == null) return undefined;
  const out = String(value).trim();
  return out || undefined;
}

function isDeleted(row: Row): boolean {
  const status = String(row.operation_status || row.effective_status || '').toUpperCase();
  return status === 'DELETE' || status === 'DELETED';
}

function listOf(data: unknown): Row[] {
  if (!data || typeof data !== 'object') return [];
  const list = (data as Row).list;
  return Array.isArray(list) ? list.filter((row): row is Row => !!row && typeof row === 'object') : [];
}

export function classifyCampaign(row: Row): CampaignKind {
  if (String(row.campaign_automation_type || '').toUpperCase() === 'UPGRADED_SMART_PLUS') return 'smart_plus';
  const spc = row.is_smart_performance_campaign;
  if (spc === true || spc === 1 || spc === 'true' || spc === '1') return 'spc';
  return 'manual';
}

export async function findCampaignRow(client: TikTokClient, campaignId: string): Promise<{ advertiserId: string; row: Row }> {
  const advertiserIds = await getAllowedAdvertiserIds(true);
  for (const advertiserId of advertiserIds) {
    const response = await client.get<{ list?: Row[] }>('/campaign/get/', {
      advertiser_id: advertiserId,
      filtering: { campaign_ids: [campaignId] },
      page: 1,
      page_size: 10,
    });
    const row = listOf(response.data).find(item => String(item.campaign_id) === campaignId);
    if (row) {
      await assertAdvertiserAllowed(advertiserId);
      return { advertiserId, row: { ...row, advertiser_id: advertiserId, campaign_id: campaignId } };
    }
  }
  throw new Error(`Không tìm thấy chiến dịch ${campaignId} trong các TKQC đang bật.`);
}

function mapAdGroup(row: Row): AdGroupMoney {
  return {
    adgroupId: String(row.adgroup_id || ''),
    adgroupName: text(row.adgroup_name),
    budget: num(row.budget),
    budgetMode: text(row.budget_mode),
    bidType: text(row.bid_type),
    optimizationGoal: text(row.optimization_goal),
    bidPrice: num(row.bid_price),
    conversionBidPrice: num(row.conversion_bid_price),
    roasBid: num(row.roas_bid),
  };
}

async function fetchRows(client: TikTokClient, path: string, advertiserId: string, filtering: Row): Promise<Row[]> {
  const response = await client.get(path, {
    advertiser_id: advertiserId,
    filtering,
    page: 1,
    page_size: 100,
  });
  return listOf(response.data).filter(row => !isDeleted(row));
}

export async function loadMoneySnapshot(campaignId: string, client?: TikTokClient): Promise<MoneySnapshot> {
  const api = client ?? (await createWriteClient());
  const found = await findCampaignRow(api, campaignId);
  const kind = classifyCampaign(found.row);
  let campaign = found.row;
  let groups: Row[] = [];

  if (kind === 'smart_plus') {
    const smartCampaigns = await fetchRows(api, '/smart_plus/campaign/get/', found.advertiserId, { campaign_ids: [campaignId] });
    campaign = smartCampaigns.find(row => String(row.campaign_id) === campaignId) ?? found.row;
    groups = await fetchRows(api, '/smart_plus/adgroup/get/', found.advertiserId, { campaign_ids: [campaignId] });
  } else {
    groups = await fetchRows(api, '/adgroup/get/', found.advertiserId, { campaign_ids: [campaignId] });
  }

  const budgetMode = text(campaign.budget_mode) || text(found.row.budget_mode);
  const optimizeOff = campaign.budget_optimize_on === false || campaign.budget_optimize_on === 0 || campaign.budget_optimize_on === 'false';
  let budgetLevel: MoneySnapshot['budgetLevel'] = 'campaign';
  if (kind === 'smart_plus') {
    budgetLevel = !optimizeOff && budgetMode !== 'BUDGET_MODE_INFINITE' ? 'campaign' : 'adgroup';
  } else if (kind === 'spc') {
    budgetLevel = 'campaign';
  } else if (optimizeOff || budgetMode === 'BUDGET_MODE_INFINITE') {
    budgetLevel = 'adgroup';
  }

  const adgroups = groups.map(mapAdGroup).filter(group => group.adgroupId);
  const groupBudget = adgroups.find(group => group.budget != null)?.budget;

  return {
    kind,
    advertiserId: found.advertiserId,
    campaignId,
    campaignName: text(campaign.campaign_name) || text(found.row.campaign_name),
    budgetOptimizeOn: !optimizeOff,
    budgetMode,
    budget: budgetLevel === 'campaign' ? num(campaign.budget) ?? num(found.row.budget) : groupBudget,
    budgetLevel,
    adgroups,
  };
}

export function describeMoneyError(error: unknown): string {
  if (error instanceof TikTokApiError) {
    return `TikTok ${error.code}: ${error.apiMessage}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function applyMoneyPlan(plan: MoneyPlan, actor: string, client?: TikTokClient, campaignId?: string): Promise<void> {
  const api = client ?? (await createWriteClient());
  const errors: string[] = [];
  for (const write of plan.writes) {
    try {
      await api.post(write.endpoint, write.body, { idempotent: false });
    } catch (error) {
      errors.push(`${write.endpoint}: ${describeMoneyError(error)}`);
      break;
    }
  }
  const advertiserId = String(plan.writes[0]?.body.advertiser_id || '');
  const loggedCampaignId = campaignId || String(plan.writes[0]?.body.campaign_id || '');
  await writeCampaignAudit({
    actor,
    action: 'money.update',
    advertiserId,
    campaignId: loggedCampaignId || undefined,
    before: plan.before,
    after: errors.length ? { planned: plan.after, errors } : plan.after,
    ok: errors.length === 0,
    detail: plan.limitations.join('\n'),
  });
  if (errors.length) {
    throw new Error(errors[0]);
  }
}

export async function previewBudgetChange(campaignId: string, budget: number, mode?: BudgetMode): Promise<{ snapshot: MoneySnapshot; plan: MoneyPlan }> {
  const client = await createWriteClient();
  const snapshot = await loadMoneySnapshot(campaignId, client);
  return { snapshot, plan: planBudgetChange(snapshot, budget, mode) };
}

export async function previewBidChange(campaignId: string, bid: number): Promise<{ snapshot: MoneySnapshot; plan: MoneyPlan }> {
  const client = await createWriteClient();
  const snapshot = await loadMoneySnapshot(campaignId, client);
  return { snapshot, plan: planBidChange(snapshot, bid) };
}

export async function commitBudgetChange(campaignId: string, budget: number, mode: BudgetMode | undefined, actor: string): Promise<MoneyPlan> {
  const client = await createWriteClient();
  const snapshot = await loadMoneySnapshot(campaignId, client);
  const plan = planBudgetChange(snapshot, budget, mode);
  await applyMoneyPlan(plan, actor, client, snapshot.campaignId);
  return plan;
}

export async function commitBidChange(campaignId: string, bid: number, actor: string): Promise<MoneyPlan> {
  const client = await createWriteClient();
  const snapshot = await loadMoneySnapshot(campaignId, client);
  const plan = planBidChange(snapshot, bid);
  await applyMoneyPlan(plan, actor, client, snapshot.campaignId);
  return plan;
}
