import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import { getTodaySpentCampaigns } from './tiktok/api.js';

async function run() {
  console.log("Fetching campaigns...");
  const campaigns = await getTodaySpentCampaigns('2026-04-01', '2026-04-26');
  
  let todayIdSpend = 0;
  let todayVnSpend = 0;
  let monthIdSpend = 0;
  let monthVnSpend = 0;

  for (const c of campaigns) {
    const isProduct = c.campaign_name.toUpperCase().includes('MẶT NẠ MẮT') || c.campaign_name.toUpperCase().includes('LANBENA');
    if (!isProduct) continue;
    
    const isID = c.campaign_name.toUpperCase().includes('-ID') || c.campaign_name.toUpperCase().includes(' ID ');
    const isVN = c.campaign_name.toUpperCase().includes('-VN') || c.campaign_name.toUpperCase().includes(' VN ');
    
    const isToday = c.date && c.date.startsWith('2026-04-26');
    
    if (isID) {
      monthIdSpend += c.spend;
      if (isToday) todayIdSpend += c.spend;
    }
    if (isVN) {
      monthVnSpend += c.spend;
      if (isToday) todayVnSpend += c.spend;
    }
  }

  console.log(`Month ID: $${monthIdSpend.toFixed(2)}`);
  console.log(`Month VN: $${monthVnSpend.toFixed(2)}`);
  console.log(`Today ID: $${todayIdSpend.toFixed(2)}`);
  console.log(`Today VN: $${todayVnSpend.toFixed(2)}`);
}

run().catch(console.error);
