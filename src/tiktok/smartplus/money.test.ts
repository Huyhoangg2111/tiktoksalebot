import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeScope, applyBidOverride, bidOverrideDecision, budgetModeAllowsAmount } from './clone-by-recreate.js';
import { redact } from './redact.js';
import { hashMoneyState, parsePositiveMoney, planBidChange, planBudgetChange, type MoneySnapshot } from './money.js';

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
  assert.equal(conversation.writes.length, 1);
  assert.deepEqual(conversation.writes[0]?.body, {
    advertiser_id: '100',
    adgroup_id: '300',
    conversion_bid_price: 0.55,
  });
  assert.match(conversation.limitations.join('\n'), /chưa được kiểm chứng/);

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

test('Smart+ bid update writes the first ad group once and blocks a non-custom bid', () => {
  const two = planBidChange({
    ...smartCampaign,
    adgroups: [
      { adgroupId: '300', optimizationGoal: 'CONVERSATION', bidType: 'BID_TYPE_CUSTOM', conversionBidPrice: 0.4 },
      { adgroupId: '301', optimizationGoal: 'CONVERSATION', bidType: 'BID_TYPE_CUSTOM', conversionBidPrice: 0.4 },
    ],
  }, 0.5);
  assert.equal(two.writes.length, 1);
  assert.equal(two.writes[0]?.body.adgroup_id, '300');
  assert.match(two.limitations.join('\n'), /Chỉ gửi một lần/);

  assert.throws(
    () => planBidChange({
      ...smartCampaign,
      adgroups: [{ adgroupId: '300', optimizationGoal: 'CONVERSATION', bidType: 'BID_TYPE_NO_BID' }],
    }, 0.5),
    /Không đổi giá thầu Smart\+/
  );
  assert.throws(() => planBidChange(smartCampaign, 20), /phải nhỏ hơn ngân sách/);
});

test('create-time bid override keeps a single price field', () => {
  const warnings: string[] = [];
  const click: Record<string, unknown> = { optimization_goal: 'CLICK', bid_type: 'BID_TYPE_CUSTOM', conversion_bid_price: 1 };
  applyBidOverride(click, 0.3, 'adgroup', warnings);
  assert.equal(click.bid_price, 0.3);
  assert.equal(click.conversion_bid_price, undefined);
  assert.equal(click.bid_type, 'BID_TYPE_CUSTOM');

  const value: Record<string, unknown> = { optimization_goal: 'VALUE', bid_type: 'BID_TYPE_CUSTOM', conversion_bid_price: 1, bid_price: 2 };
  applyBidOverride(value, 1.5, 'adgroup', warnings);
  assert.equal(value.roas_bid, 1.5);
  assert.equal(value.conversion_bid_price, undefined);
  assert.equal(value.bid_price, undefined);

  const conversation: Record<string, unknown> = {
    optimization_goal: 'CONVERSATION',
    bid_type: 'BID_TYPE_NO_BID',
    budget_mode: 'BUDGET_MODE_DAY',
    min_budget: 10,
  };
  applyBidOverride(conversation, 0.4, 'adgroup', warnings);
  assert.equal(conversation.bid_type, 'BID_TYPE_CUSTOM');
  assert.equal(conversation.conversion_bid_price, 0.4);
  assert.equal(conversation.min_budget, undefined);

  assert.throws(
    () => applyBidOverride({ optimization_goal: 'CLICK', bid_type: 'BID_TYPE_NO_BID' }, 0.3, 'adgroup', warnings),
    /không ghi đè giá thầu/
  );
});

test('catalog_id 0 from a DM ad group is unset and does not block the clone', () => {
  const empty = analyzeScope(
    { objective_type: 'LEAD_GENERATION' },
    [{ adgroup_id: '1879234983564930', promotion_type: 'LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE', catalog_id: '0' }],
    []
  );
  assert.equal(empty.blockers.some(item => item.includes('catalog')), false);

  const catalog = analyzeScope(
    { objective_type: 'LEAD_GENERATION' },
    [{ adgroup_id: '1879234983564930', promotion_type: 'LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE', catalog_id: '12345' }],
    []
  );
  assert.equal(catalog.blockers.some(item => item.includes('catalog_id=12345')), true);
});

test('an infinite budget mode does not take an amount override', () => {
  assert.equal(budgetModeAllowsAmount('BUDGET_MODE_INFINITE'), false);
  assert.equal(budgetModeAllowsAmount('BUDGET_MODE_DAY'), true);
  assert.equal(budgetModeAllowsAmount('BUDGET_MODE_TOTAL'), true);
  const value = bidOverrideDecision({ optimization_goal: 'VALUE', bid_type: 'BID_TYPE_CUSTOM' });
  assert.equal(value.ok && value.field, 'roas_bid');
});

test('money confirm hash changes when the snapshot changes', () => {
  const plan = planBudgetChange(smartCampaign, 30);
  const first = hashMoneyState(smartCampaign, plan);
  assert.equal(hashMoneyState(smartCampaign, plan), first);
  assert.notEqual(hashMoneyState({ ...smartCampaign, budget: 40 }, plan), first);
});

test('money values above one million are rejected', () => {
  assert.throws(() => parsePositiveMoney('1000001', 'Ngân sách'), /1\.000\.000/);
});

test('audit redaction strips access tokens', () => {
  const safe = redact({ access_token: 'secret-token', write_token: 'write-secret', budget: 10, note: 'access_token=secret-token' });
  assert.equal(safe.access_token, '[REDACTED]');
  assert.equal(safe.write_token, '[REDACTED]');
  assert.equal(safe.budget, 10);
  assert.equal(String(safe.note).includes('secret-token'), false);
});
