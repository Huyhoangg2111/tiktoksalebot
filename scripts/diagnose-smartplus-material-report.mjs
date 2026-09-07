import axios from 'axios';
import { connectDB } from '../dist/db/index.js';
import { getTikTokReadAccessToken } from '../dist/tiktok/config.js';
import { getTodaySpentCampaigns } from '../dist/tiktok/api.js';

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const PAGE_SIZE = 100;

function todayVietnam() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function n(value) {
  const parsed = Number(String(value ?? 0).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMessage(payload) {
  return String(payload?.message || payload?.msg || payload?.code || 'Unknown TikTok API error');
}

async function getJson(url, accessToken, params) {
  const response = await axios.get(url, {
    params,
    headers: { 'Access-Token': accessToken },
    timeout: 30_000,
  });
  if (Number(response.data?.code || 0) !== 0) {
    const error = new Error(getMessage(response.data));
    error.payload = response.data;
    throw error;
  }
  return response.data;
}

async function listSmartPlusAdsForCampaign(advertiserId, campaignId, accessToken) {
  const matched = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = await getJson(`${BASE}/smart_plus/ad/get/`, accessToken, {
      advertiser_id: advertiserId,
      page,
      page_size: PAGE_SIZE,
    });
    const list = Array.isArray(payload?.data?.list) ? payload.data.list : [];
    matched.push(...list.filter(item => String(item?.campaign_id || '') === campaignId));
    if (list.length < PAGE_SIZE) break;
  }
  return matched;
}

async function getSmartPlusAdDetail(advertiserId, smartPlusAdId, accessToken) {
  const payload = await getJson(`${BASE}/smart_plus/ad/get/`, accessToken, {
    advertiser_id: advertiserId,
    smart_plus_ad_ids: JSON.stringify([smartPlusAdId]),
    page: 1,
    page_size: PAGE_SIZE,
  });
  return (payload?.data?.list || []).find(
    item => String(item?.smart_plus_ad_id || '') === smartPlusAdId
  );
}

function parseRows(payload) {
  return (payload?.data?.list || []).map(row => {
    const d = row?.dimensions || {};
    const m = row?.metrics || {};
    return {
      main_material_id: String(d.main_material_id || row?.main_material_id || ''),
      spend: n(m.spend ?? row?.spend),
      impressions: n(m.impressions ?? row?.impressions),
      clicks: n(m.clicks ?? row?.clicks),
      ctr: n(m.ctr ?? row?.ctr),
      conversion: n(m.conversion ?? row?.conversion),
      cpa: n(m.cost_per_conversion ?? row?.cost_per_conversion),
      real_time_conversion: n(m.real_time_conversion ?? row?.real_time_conversion),
      real_time_cpa: n(m.real_time_cost_per_conversion ?? row?.real_time_cost_per_conversion),
    };
  });
}

function printRows(title, rows, creatives) {
  const byTikTokItem = new Map(creatives.map(c => [c.tiktok_item_id, c]));
  const byAdMaterial = new Map(creatives.map(c => [c.ad_material_id, c]));
  const byCreative = new Map(creatives.map(c => [c.smart_plus_creative_id, c]));

  console.log(`\n====================================`);
  console.log(title);
  console.log(`====================================`);
  console.table(rows.map(row => {
    const ref = byTikTokItem.get(row.main_material_id)
      || byAdMaterial.get(row.main_material_id)
      || byCreative.get(row.main_material_id);
    let idKind = '';
    if (byTikTokItem.has(row.main_material_id)) idKind = 'tiktok_item_id';
    else if (byAdMaterial.has(row.main_material_id)) idKind = 'ad_material_id';
    else if (byCreative.has(row.main_material_id)) idKind = 'smart_plus_creative_id';

    return {
      main_material_id: row.main_material_id,
      id_kind: idKind,
      material_index: ref?.index || '',
      spend: row.spend,
      clicks: row.clicks,
      ctr: row.ctr,
      conversion: row.conversion,
      cpa: row.cpa,
      real_time_conversion: row.real_time_conversion,
      real_time_cpa: row.real_time_cpa,
    };
  }));
}

async function fetchReport(endpoint, accessToken, commonParams, includeRealtime = true) {
  const standardMetrics = [
    'spend',
    'impressions',
    'clicks',
    'ctr',
    'conversion',
    'cost_per_conversion',
  ];
  const realtimeMetrics = [
    'real_time_conversion',
    'real_time_cost_per_conversion',
  ];

  const params = {
    ...commonParams,
    metrics: JSON.stringify(includeRealtime ? [...standardMetrics, ...realtimeMetrics] : standardMetrics),
  };

  try {
    return await getJson(`${BASE}${endpoint}`, accessToken, params);
  } catch (error) {
    if (includeRealtime) {
      console.warn(`[diagnostic] ${endpoint} không nhận real_time metrics: ${error.message}`);
      return fetchReport(endpoint, accessToken, commonParams, false);
    }
    throw error;
  }
}

async function diagnoseSmartPlusAd(advertiserId, campaignId, ad, dateKey, accessToken) {
  const smartPlusAdId = String(ad?.smart_plus_ad_id || '');
  if (!smartPlusAdId) return;

  let detailedAd = ad;
  if (!Array.isArray(detailedAd?.creative_list) || detailedAd.creative_list.length === 0) {
    detailedAd = await getSmartPlusAdDetail(advertiserId, smartPlusAdId, accessToken) || ad;
  }

  const creatives = (detailedAd?.creative_list || []).map((creative, idx) => ({
    index: idx + 1,
    ad_material_id: String(creative?.ad_material_id || ''),
    smart_plus_creative_id: String(creative?.smart_plus_creative_id || ''),
    tiktok_item_id: String(creative?.creative_info?.tiktok_item_id || ''),
    material_operation_status: String(
      creative?.material_operation_status
      ?? creative?.operation_status
      ?? creative?.status
      ?? creative?.creative_info?.material_operation_status
      ?? creative?.creative_info?.operation_status
      ?? creative?.creative_info?.status
      ?? ''
    ),
  }));

  console.log('\nREAD-ONLY diagnostic. Không có POST.');
  console.log(`Advertiser: ${advertiserId}`);
  console.log(`Campaign: ${campaignId}`);
  console.log(`Smart+ Ad: ${smartPlusAdId}`);
  console.log(`Date: ${dateKey}`);
  console.log(`Creative count: ${creatives.length}`);
  console.table(creatives);

  const filtering = JSON.stringify({ smart_plus_ad_ids: [smartPlusAdId] });
  const common = {
    advertiser_id: advertiserId,
    dimensions: JSON.stringify(['main_material_id']),
    filtering,
    start_date: dateKey,
    end_date: dateKey,
    page: 1,
    page_size: PAGE_SIZE,
  };

  const breakdown = await fetchReport(
    '/smart_plus/material_report/breakdown/',
    accessToken,
    common,
    true
  );
  printRows('A. BREAKDOWN - DATE', parseRows(breakdown), creatives);
  console.log(`request_id: ${String(breakdown?.request_id || '')}`);

  try {
    const overview = await fetchReport(
      '/smart_plus/material_report/overview/',
      accessToken,
      { ...common, query_lifetime: false },
      true
    );
    printRows('B. OVERVIEW - DATE', parseRows(overview), creatives);
    console.log(`request_id: ${String(overview?.request_id || '')}`);
  } catch (error) {
    console.warn(`[diagnostic] overview/date unavailable: ${error.message}`);
  }

  try {
    const lifetime = await fetchReport(
      '/smart_plus/material_report/overview/',
      accessToken,
      {
        advertiser_id: advertiserId,
        dimensions: JSON.stringify(['main_material_id']),
        filtering,
        query_lifetime: true,
        page: 1,
        page_size: PAGE_SIZE,
      },
      true
    );
    printRows('C. OVERVIEW - LIFETIME', parseRows(lifetime), creatives);
    console.log(`request_id: ${String(lifetime?.request_id || '')}`);
  } catch (error) {
    console.warn(`[diagnostic] overview/lifetime unavailable: ${error.message}`);
  }
}

async function main() {
  const campaignId = String(process.argv[2] || '').trim();
  const dateKey = String(process.argv[3] || todayVietnam()).trim();

  if (!campaignId) {
    console.error('Cách dùng: node scripts/diagnose-smartplus-material-report.mjs <campaign_id> [YYYY-MM-DD]');
    process.exit(2);
  }

  await connectDB();

  const campaigns = await getTodaySpentCampaigns(dateKey, dateKey);
  const campaign = campaigns.find(item => String(item.campaign_id) === campaignId);
  if (!campaign) throw new Error(`Không tìm thấy campaign ${campaignId} trong report ngày ${dateKey}.`);

  const advertiserId = String(campaign.advertiser_id || '').trim();
  if (!advertiserId) throw new Error(`Campaign ${campaignId} không có advertiser_id.`);

  const accessToken = await getTikTokReadAccessToken();
  const matchedAds = await listSmartPlusAdsForCampaign(advertiserId, campaignId, accessToken);
  if (matchedAds.length === 0) {
    throw new Error(`Không tìm thấy Smart+ Ad nào thuộc campaign ${campaignId} trong advertiser ${advertiserId}.`);
  }

  console.log(`Tìm thấy ${matchedAds.length} Smart+ Ad thuộc campaign ${campaignId}.`);
  for (const ad of matchedAds) {
    await diagnoseSmartPlusAd(advertiserId, campaignId, ad, dateKey, accessToken);
  }

  console.log('\n✅ Xong. READ-ONLY, không có POST và không in token.');
}

main().catch(error => {
  console.error('\n❌ Diagnostic failed:', error?.message || error);
  if (error?.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exit(1);
});