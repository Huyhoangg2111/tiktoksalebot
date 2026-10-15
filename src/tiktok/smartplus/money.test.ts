import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBidOverride } from './clone-by-recreate.js';
import { redact } from './redact.js';
import { planBidChange, planBudgetChange, type MoneySnapshot } from './money.js';

const smartCampaign: MoneySnapshot = {
  kind: 'smart_plus',
  advertiserId: '100',
  campaignId: '200',
  campaignName: 'Lead DM',
  budgetOptimizeOn: true,
  budgetMode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
  budget: 20,
  budgetLevel: 'campaign',
  adgroups: [
    {
      adgroupId: '300',
      adgroupName: 'DM',
      optimizationGoal: 'CONVERSATION',
      bidType: 'BID_TYPE_CUSTOM',
      conversionBidPrice: 0.4,
    },
  ],
};

test('Smart+ campaign budget update sends budget only', () => {
  const plan = planBudgetChange(smartCampaign, 30);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0]?.endpoint, '/smart_plus/campaign/update/');
  assert.deepEqual(plan.writes[0]?.body, {
    advertiser_id: '100',
    campaign_id: '200',
    budget: 30,
  });
  assert.equal('budget_mode' in (plan.writes[0]?.body || {}), false);
});

test('Smart+ rejects a budget mode change', () => {
  assert.throws(
    () => planBudgetChange(smartCampaign, 30, 'BUDGET_MODE_DAY'),
    /không nhận budget_mode/
  );
});

test('Smart+ with CBO off updates each ad group budget', () => {
  const plan = planBudgetChange({ ...smartCampaign, budgetLevel: 'adgroup', budgetOptimizeOn: false }, 15);
  assert.equal(plan.writes[0]?.endpoint, '/smart_plus/adgroup/budget/update/');
  assert.deepEqual(plan.writes[0]?.body.budget, [{ adgroup_id: '300', budget: 15 }]);
});

test('bid update sends one price field and does not send bid_type', () => {
  const conversation = planBidChange(smartCampaign, 0.55);
  assert.deepEqual(conversation.writes[0]?.body, {
    advertiser_id: '100',
    adgroup_id: '300',
    conversion_bid_price: 0.55,
  });

  const click = planBidChange({
    ...smartCampaign,
    adgroups: [{ adgroupId: '301', optimizationGoal: 'CLICK', bidType: 'BID_TYPE_CUSTOM', bidPrice: 0.1 }],
  }, 0.2);
  assert.deepEqual(click.writes[0]?.body, {
    advertiser_id: '100',
    adgroup_id: '301',
    bid_price: 0.2,
  });
  assert.equal('conversion_bid_price' in (click.writes[0]?.body || {}), false);
  assert.equal('bid_type' in (click.writes[0]?.body || {}), false);
});

test('create-time bid override keeps a single price field', () => {
  const click: Record<string, unknown> = { optimization_goal: 'CLICK', conversion_bid_price: 1 };
  const warnings: string[] = [];
  applyBidOverride(click, 0.3, 'adgroup', warnings);
  assert.equal(click.bid_price, 0.3);
  assert.equal(click.conversion_bid_price, undefined);
  assert.equal(click.bid_type, 'BID_TYPE_CUSTOM');

  const conversation: Record<string, unknown> = { optimization_goal: 'CONVERSATION', bid_price: 1 };
  applyBidOverride(conversation, 0.4, 'adgroup', warnings);
  assert.equal(conversation.conversion_bid_price, 0.4);
  assert.equal(conversation.bid_price, undefined);
});

test('audit redaction strips access tokens', () => {
  const safe = redact({ access_token: 'secret-token', budget: 10, note: 'access_token=secret-token' });
  assert.equal(safe.access_token, '[REDACTED]');
  assert.equal(safe.budget, 10);
  assert.equal(String(safe.note).includes('secret-token'), false);
});
