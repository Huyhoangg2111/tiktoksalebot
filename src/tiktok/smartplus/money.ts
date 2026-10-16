import { createHash } from 'node:crypto';

/**
 * Budget / bid write plans for the official Marketing API.
 *
 * Smart+ update bodies were checked against the official SDK (2026-02) and the
 * v1.3 reference, not copied from the regular campaign/ad group update endpoints:
 * - POST /smart_plus/campaign/update/ accepts advertiser_id, campaign_id, budget,
 *   campaign_name, po_number, budget_auto_adjust_strategy. It does NOT accept budget_mode.
 * - POST /smart_plus/adgroup/budget/update/ accepts advertiser_id plus budget[{adgroup_id, budget}].
 * - POST /smart_plus/adgroup/update/ accepts bid_price, conversion_bid_price, roas_bid, budget.
 *   bid_type is not in that update body, so a strategy switch may be rejected by TikTok.
 */

export type BudgetMode =
  | 'BUDGET_MODE_DAY'
  | 'BUDGET_MODE_TOTAL'
  | 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET'
  | 'BUDGET_MODE_INFINITE';

export type CampaignKind = 'smart_plus' | 'manual' | 'spc';

export interface AdGroupMoney {
  adgroupId: string;
  adgroupName?: string;
  budget?: number;
  budgetMode?: string;
  bidType?: string;
  optimizationGoal?: string;
  bidPrice?: number;
  conversionBidPrice?: number;
  roasBid?: number;
}

export interface MoneySnapshot {
  kind: CampaignKind;
  advertiserId: string;
  campaignId: string;
  campaignName?: string;
  budgetOptimizeOn: boolean;
  budgetMode?: string;
  budget?: number;
  budgetLevel: 'campaign' | 'adgroup';
  adgroups: AdGroupMoney[];
}

export interface PlannedWrite {
  endpoint: string;
  body: Record<string, unknown>;
  summary: string;
}

export interface MoneyPlan {
  before: string;
  after: string;
  writes: PlannedWrite[];
  limitations: string[];
}

const MODE_ALIASES: Record<string, BudgetMode> = {
  day: 'BUDGET_MODE_DAY',
  daily: 'BUDGET_MODE_DAY',
  ngay: 'BUDGET_MODE_DAY',
  'ngày': 'BUDGET_MODE_DAY',
  total: 'BUDGET_MODE_TOTAL',
  lifetime: 'BUDGET_MODE_TOTAL',
  tron: 'BUDGET_MODE_TOTAL',
  'trọn': 'BUDGET_MODE_TOTAL',
  dynamic: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
  cbo: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
  infinite: 'BUDGET_MODE_INFINITE',
  none: 'BUDGET_MODE_INFINITE',
  'không': 'BUDGET_MODE_INFINITE',
  BUDGET_MODE_DAY: 'BUDGET_MODE_DAY',
  BUDGET_MODE_TOTAL: 'BUDGET_MODE_TOTAL',
  BUDGET_MODE_DYNAMIC_DAILY_BUDGET: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
  BUDGET_MODE_INFINITE: 'BUDGET_MODE_INFINITE',
};

export function parsePositiveMoney(value: unknown, label = 'Giá trị'): number {
  const parsed = Number(String(value ?? '').replace(/[$,\s]/g, '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} phải là số lớn hơn 0.`);
  }
  if (parsed > 1_000_000) {
    throw new Error(`${label} quá lớn (tối đa 1.000.000).`);
  }
  return Math.round(parsed * 100) / 100;
}

export function parseBudgetMode(value: string | undefined): BudgetMode | undefined {
  const raw = String(value || '').trim();
  if (!raw || raw === '-') return undefined;
  const mode = MODE_ALIASES[raw] || MODE_ALIASES[raw.toUpperCase()] || MODE_ALIASES[raw.toLowerCase()];
  if (!mode) {
    throw new Error(
      'Chế độ ngân sách không hợp lệ. Dùng: ngày (BUDGET_MODE_DAY), trọn (BUDGET_MODE_TOTAL), dynamic (BUDGET_MODE_DYNAMIC_DAILY_BUDGET), không giới hạn (BUDGET_MODE_INFINITE).'
    );
  }
  return mode;
}

export function currentBid(group: AdGroupMoney): { field: string; value?: number } {
  if (group.roasBid != null && group.roasBid > 0 && /ROAS|VALUE/i.test(`${group.bidType || ''} ${group.optimizationGoal || ''}`)) {
    return { field: 'roas_bid', value: group.roasBid };
  }
  if (group.optimizationGoal === 'CLICK') {
    return { field: 'bid_price', value: group.bidPrice };
  }
  if (group.conversionBidPrice != null && group.conversionBidPrice > 0) {
    return { field: 'conversion_bid_price', value: group.conversionBidPrice };
  }
  if (group.bidPrice != null && group.bidPrice > 0) {
    return { field: 'bid_price', value: group.bidPrice };
  }
  return { field: group.optimizationGoal === 'CLICK' ? 'bid_price' : 'conversion_bid_price' };
}

function formatAmount(value: number | undefined): string {
  return value == null ? 'chưa đặt' : String(value);
}

export function describeSnapshot(snapshot: MoneySnapshot): string {
  const level = snapshot.budgetLevel === 'campaign' ? 'cấp campaign' : 'cấp ad group';
  const groups = snapshot.adgroups.map(group => {
    const bid = currentBid(group);
    return `${group.adgroupName || group.adgroupId}: bid ${bid.field}=${formatAmount(bid.value)} (${group.bidType || 'không rõ chiến lược'})`;
  });
  return [
    `${snapshot.campaignName || snapshot.campaignId} [${snapshot.kind}]`,
    `Ngân sách ${level}: ${formatAmount(snapshot.budget)} ${snapshot.budgetMode || ''}`.trim(),
    ...groups,
  ].join('\n');
}

export function planBudgetChange(snapshot: MoneySnapshot, budget: number, requestedMode?: BudgetMode): MoneyPlan {
  const limitations: string[] = [];
  const before = describeSnapshot(snapshot);
  const writes: PlannedWrite[] = [];

  if (snapshot.kind === 'smart_plus') {
    if (requestedMode && requestedMode !== snapshot.budgetMode) {
      throw new Error(
        'API Smart+ /smart_plus/campaign/update/ và /smart_plus/adgroup/budget/update/ không nhận budget_mode. Chỉ đổi được số ngân sách, không đổi chế độ.'
      );
    }
    if (snapshot.budgetLevel === 'campaign') {
      writes.push({
        endpoint: '/smart_plus/campaign/update/',
        body: {
          advertiser_id: snapshot.advertiserId,
          campaign_id: snapshot.campaignId,
          budget,
        },
        summary: `Ngân sách campaign ${formatAmount(snapshot.budget)} → ${budget} (giữ ${snapshot.budgetMode || 'chế độ hiện tại'})`,
      });
    } else {
      if (snapshot.adgroups.length === 0) {
        throw new Error('Campaign không có ad group để cập nhật ngân sách.');
      }
      writes.push({
        endpoint: '/smart_plus/adgroup/budget/update/',
        body: {
          advertiser_id: snapshot.advertiserId,
          budget: snapshot.adgroups.map(group => ({ adgroup_id: group.adgroupId, budget })),
        },
        summary: `Ngân sách ${snapshot.adgroups.length} ad group → ${budget}`,
      });
      limitations.push('CBO đang tắt nên ngân sách nằm ở ad group. Endpoint chính thức không nhận budget_mode.');
    }
  } else if (snapshot.kind === 'spc') {
    if (requestedMode && requestedMode !== snapshot.budgetMode) {
      limitations.push('Đổi budget_mode của Smart Performance Campaign không nằm trong body update đã kiểm chứng; chỉ gửi budget.');
    }
    writes.push({
      endpoint: '/campaign/spc/update/',
      body: {
        advertiser_id: snapshot.advertiserId,
        campaign_id: snapshot.campaignId,
        budget,
      },
      summary: `Ngân sách SPC ${formatAmount(snapshot.budget)} → ${budget}`,
    });
  } else if (snapshot.budgetLevel === 'adgroup') {
    if (snapshot.adgroups.length === 0) {
      throw new Error('Campaign không có ad group để cập nhật ngân sách.');
    }
    writes.push({
      endpoint: '/adgroup/budget/update/',
      body: {
        advertiser_id: snapshot.advertiserId,
        budget: snapshot.adgroups.map(group => ({ adgroup_id: group.adgroupId, budget })),
      },
      summary: `Ngân sách ${snapshot.adgroups.length} ad group → ${budget}`,
    });
    if (requestedMode && requestedMode !== snapshot.budgetMode) {
      limitations.push('Ngân sách đang ở ad group. Lần cập nhật này chỉ gửi số tiền, không gửi budget_mode.');
    }
  } else {
    const body: Record<string, unknown> = {
      advertiser_id: snapshot.advertiserId,
      campaign_id: snapshot.campaignId,
      budget,
    };
    if (requestedMode && requestedMode !== snapshot.budgetMode) {
      body.budget_mode = requestedMode;
      limitations.push('budget_mode của campaign thường không đổi được sau khi tạo. Nếu TikTok từ chối, ngân sách giữ nguyên.');
    }
    writes.push({
      endpoint: '/campaign/update/',
      body,
      summary: `Ngân sách campaign ${formatAmount(snapshot.budget)} ${snapshot.budgetMode || ''} → ${budget}${requestedMode ? ` ${requestedMode}` : ''}`.trim(),
    });
  }

  const modeApplied = snapshot.kind === 'manual' && snapshot.budgetLevel === 'campaign' && requestedMode;
  const afterMode = modeApplied ? requestedMode : snapshot.budgetMode;
  return {
    before,
    after: `Ngân sách ${budget}${afterMode ? ` · ${afterMode}` : ''} · ${snapshot.budgetLevel === 'campaign' ? 'cấp campaign' : 'cấp ad group'}`,
    writes,
    limitations,
  };
}

export function bidFieldForGroup(group: AdGroupMoney): 'bid_price' | 'conversion_bid_price' | 'roas_bid' {
  const goal = String(group.optimizationGoal || '');
  if (goal === 'VALUE') return 'roas_bid';
  if (goal === 'CLICK') return 'bid_price';
  return 'conversion_bid_price';
}

export function hashMoneyState(snapshot: MoneySnapshot, plan: MoneyPlan): string {
  return createHash('sha256').update(JSON.stringify({
    campaignId: snapshot.campaignId,
    kind: snapshot.kind,
    budget: snapshot.budget,
    budgetMode: snapshot.budgetMode,
    budgetLevel: snapshot.budgetLevel,
    adgroups: snapshot.adgroups.map(group => ({
      id: group.adgroupId,
      bidType: group.bidType,
      goal: group.optimizationGoal,
      budget: group.budget,
      bidPrice: group.bidPrice,
      conversionBidPrice: group.conversionBidPrice,
      roasBid: group.roasBid,
    })),
    bodies: plan.writes.map(write => write.body),
  })).digest('hex');
}

export function planBidChange(snapshot: MoneySnapshot, bid: number): MoneyPlan {
  const limitations: string[] = [];
  const writes: PlannedWrite[] = [];
  const before = describeSnapshot(snapshot);

  if (snapshot.adgroups.length === 0 && snapshot.kind !== 'spc') {
    throw new Error('Không tìm thấy ad group để cập nhật giá thầu.');
  }

  if (snapshot.kind === 'smart_plus') {
    const blocked = snapshot.adgroups.filter(group => group.bidType !== 'BID_TYPE_CUSTOM');
    if (blocked.length) {
      throw new Error(
        `Không đổi giá thầu Smart+: ${blocked.map(group => `${group.adgroupId} đang ${group.bidType || 'không rõ bid_type'}`).join(', ')}. Body /smart_plus/adgroup/update/ không có bid_type.`
      );
    }
    const group = snapshot.adgroups[0];
    if (!group) throw new Error('Không tìm thấy ad group để cập nhật giá thầu.');
    const field = bidFieldForGroup(group);
    const budgets = [snapshot.budget, ...snapshot.adgroups.map(item => item.budget)].filter((value): value is number => value != null && value > 0);
    if (field !== 'roas_bid') {
      if (budgets.length === 0) {
        limitations.push('Không có ngân sách dương để kiểm tra giá thầu nhỏ hơn ngân sách.');
      } else if (bid >= Math.min(...budgets)) {
        throw new Error(`Giá thầu ${bid} phải nhỏ hơn ngân sách ${Math.min(...budgets)}.`);
      }
    }
    if (group.optimizationGoal === 'CONVERSATION' || group.optimizationGoal === 'CLICK') {
      limitations.push('Cập nhật giá thầu mục tiêu tin nhắn (DM) trên /smart_plus/adgroup/update/ chưa được kiểm chứng. Hãy thử trên campaign thử nghiệm trước.');
    }
    if (field === 'roas_bid') {
      limitations.push('Field roas_bid cho mục tiêu VALUE trên endpoint update chưa được kiểm chứng.');
    }
    limitations.push(
      snapshot.adgroups.length > 1
        ? `Chỉ gửi một lần cho ad group ${group.adgroupId}. Các ad group còn lại không được gọi riêng; khi CBO bật giá phải giống nhau.`
        : 'Gửi một lần cho ad group này.'
    );
    writes.push({
      endpoint: '/smart_plus/adgroup/update/',
      body: {
        advertiser_id: snapshot.advertiserId,
        adgroup_id: group.adgroupId,
        [field]: bid,
      },
      summary: `${group.adgroupName || group.adgroupId}: ${field} ${formatAmount(currentBid(group).value)} → ${bid}`,
    });
  } else if (snapshot.kind === 'spc' && snapshot.adgroups.length === 0) {
    throw new Error('Chưa kiểm chứng được cách đổi giá thầu SPC qua /campaign/spc/update/. Bot không gửi field này.');
  } else {
    const endpoint = snapshot.kind === 'spc' ? '/adgroup/update/' : '/adgroup/update/';
    for (const group of snapshot.adgroups) {
      const field = bidFieldForGroup(group);
      writes.push({
        endpoint,
        body: {
          advertiser_id: snapshot.advertiserId,
          adgroup_id: group.adgroupId,
          [field]: bid,
        },
        summary: `${group.adgroupName || group.adgroupId}: ${field} ${formatAmount(currentBid(group).value)} → ${bid}`,
      });
    }
  }

  if (writes.length > 1) {
    limitations.push('Nhiều lệnh ghi không nằm trong một transaction. Nếu lệnh sau lỗi, lệnh trước không được hoàn tác.');
  }

  return {
    before,
    after: writes.map(write => write.summary).join('\n'),
    writes,
    limitations,
  };
}
