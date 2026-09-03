import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import * as googleSheets from '@googleapis/sheets';
import { connectDB } from './db/index.js';
import { getTodaySpentCampaigns } from './tiktok/api.js';
import { parseSalesDate } from './google-sheets/api.js';

function formatDate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function testSalesLogic() {
  console.log("=== BẮT ĐẦU TEST SALES DỮ LIỆU THẬT ===");
  
  await connectDB();
  
  const auth = new googleSheets.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = googleSheets.sheets({ version: 'v4', auth });
  const configSheetId = process.env.CONFIG_GOOGLE_SHEET_ID || '1f7bH43w8kv_iiqoy9X5TzSugDuWtsKrB3-Iq8IrxvAI';

  console.log(`1. Đang đọc cấu hình từ file gốc...`);
  
  let sources: string[] = [];
  let spMap: Array<{variant: string, short: string}> = [];
  let pageMap: Array<{handle: string, marketCode: string, name: string, url: string}> = [];
  let permissions: Array<{mktCode: string, advertiserId: string}> = [];

  try {
    const configRes = await sheets.spreadsheets.values.get({ spreadsheetId: configSheetId, range: 'Sources!A:E' });
    const rawSources = configRes.data.values || [];
    const idRegex = /^[a-zA-Z0-9-_]{30,}$/;
    for (let i = 1; i < rawSources.length; i++) {
      const sheetId = rawSources[i].find(cell => idRegex.test(String(cell).trim()));
      if (sheetId) sources.push(String(sheetId).trim());
    }

    const spMapRes = await sheets.spreadsheets.values.get({ spreadsheetId: configSheetId, range: 'SpMap!C:E' });
    const rawSpMap = spMapRes.data.values || [];
    spMap = rawSpMap.slice(1).map(r => ({ variant: r[0] || '', short: r[2] || '' }));

    const pageMapRes = await sheets.spreadsheets.values.get({ spreadsheetId: configSheetId, range: 'PageMap!A:D' });
    pageMap = (pageMapRes.data.values || []).slice(1).map(r => ({ 
      handle: r[0] || '', 
      marketCode: r[1] || '',
      name: r[2] || '',
      url: r[3] || ''
    }));

    const permRes = await sheets.spreadsheets.values.get({ spreadsheetId: configSheetId, range: 'Permissions!A:B' });
    permissions = (permRes.data.values || []).slice(1).map(r => ({
      mktCode: r[0] || '',
      advertiserId: r[1] || ''
    }));
  } catch(e: any) {
    console.error('Lỗi khi đọc file Config:', e.message);
    return;
  }

  const targetProduct = 'Mặt nạ mắt Lanbena';
  const targetMkt = 'MKT80.HOÀNG-TH';
  const salesMonth: Record<string, { gross: number, delivered: number, orders: number }> = {};
  const salesToday: Record<string, { gross: number, delivered: number, orders: number }> = {};
  let blankAmountRows = 0;
  let invalidAmountRows = 0;
  let invalidDateRows = 0;

  let targetDanhMucs: string[] = [];
  let targetKeyMaps: string[] = [];
  
  spMap.forEach(s => {
    if (s.variant.toLowerCase().includes('mặt nạ mắt') || s.variant.toLowerCase().includes('lanbena')) {
      targetDanhMucs.push(s.variant);
      if (s.short) {
        const keys = s.short.split(',').map(k => k.trim().toUpperCase());
        targetKeyMaps.push(...keys);
      }
    }
  });

  targetKeyMaps = [...new Set(targetKeyMaps)];
  console.log(`=> Tìm thấy DANH MỤC tương ứng:`, [...new Set(targetDanhMucs)]);
  console.log(`=> KEY MAP Của ${targetProduct} là:`, targetKeyMaps);

  const now = new Date();
  const todayDateStr = formatDate(now);
  const startOfMonthStr = formatDate(new Date(now.getFullYear(), now.getMonth(), 1));

  console.log(`\n2. Bắt đầu quét qua ${sources.length} bảng doanh số tìm tab "ĐÀI LOAN"...`);

  for (const sheetId of sources) {
    try {
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
      const relevantSheets = spreadsheet.data.sheets?.filter(s => {
        const title = s.properties?.title?.toLowerCase() || '';
        return title.includes('đài loan') || title.includes('dai loan') || title.includes('taiwan');
      }) || [];

      for (const sheet of relevantSheets) {
        const sheetName = sheet.properties?.title;
        if (!sheetName) continue;
        
        try {
          const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${sheetName}'!A:Z` });
          const rows = response.data.values || [];
          
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row.length < 15) continue;
            
            const rawDate = row[0]; // A
        const mktCode = String(row[4] || '').trim(); // E
        const productName = String(row[5] || '').trim(); // F
        const channelLink = String(row[6] || '').trim(); // G
        const rawAmount = String(row[14] || '').trim(); // O
        const status = String(row[16] || '').trim(); // Q

        if (mktCode.toUpperCase() !== targetMkt.toUpperCase()) continue;

        const isTargetProduct = targetDanhMucs.some(d => productName.toUpperCase() === d.toUpperCase()) || 
                                productName.toLowerCase().includes('mặt nạ mắt') || 
                                productName.toLowerCase().includes('lanbena');

        if (!isTargetProduct) continue;

        const parsedDate = parseSalesDate(rawDate);
        if (!parsedDate) {
          invalidDateRows++;
          console.log(`Skipping invalid date: ${rawDate}`);
          continue;
        }
        const isThisMonth = parsedDate.getFullYear() === now.getFullYear() && parsedDate.getMonth() === now.getMonth();
        const isToday = formatDate(parsedDate) === todayDateStr;

        let amountVnd = 0;
        if (!rawAmount) {
          blankAmountRows++;
        } else {
          amountVnd = parseFloat(rawAmount.replace(/\s|\.|,/g, ''));
          if (isNaN(amountVnd)) {
            invalidAmountRows++;
            console.log(`Skipping invalid amount: ${rawAmount} for ${productName}`);
            continue;
          }
        }

        let marketCode = 'UNKNOWN';
        const pageNameStr = String(row[3] || '').trim(); // D
        const page = pageMap.find(p => 
          (p.handle && channelLink.includes(p.handle)) || 
          (p.url && channelLink.includes(p.url)) ||
          (p.name && pageNameStr && p.name.toUpperCase() === pageNameStr.toUpperCase()) ||
          (p.name && pageNameStr && pageNameStr.toUpperCase().includes(p.name.toUpperCase()))
        );
        if (page) marketCode = page.marketCode.toUpperCase();

        if (isThisMonth) {
          if (!salesMonth[marketCode]) salesMonth[marketCode] = { gross: 0, delivered: 0, orders: 0 };
          salesMonth[marketCode].gross += amountVnd;
          salesMonth[marketCode].orders++;
          if (status.match(/thành công|đã nhận|hoàn thành|done|success/i)) salesMonth[marketCode].delivered += amountVnd;
        }

        if (isToday) {
          if (!salesToday[marketCode]) salesToday[marketCode] = { gross: 0, delivered: 0, orders: 0 };
          salesToday[marketCode].gross += amountVnd;
          salesToday[marketCode].orders++;
          if (status.match(/thành công|đã nhận|hoàn thành|done|success/i)) salesToday[marketCode].delivered += amountVnd;
        }
      }
    } catch (e: any) {
      // ignore sheet errors
    }
    } // close for loop
    } catch (e: any) {
    }
  }

  console.log(`=> Đã tính ${blankAmountRows} dòng đúng sản phẩm/MKT nhưng trống tiền với doanh số 0; bỏ qua ${invalidAmountRows} dòng tiền lỗi, ${invalidDateRows} dòng ngày lỗi.`);

  console.log(`\n3. Đang tải chi tiêu chiến dịch từ TikTok API (${startOfMonthStr} -> ${todayDateStr})...`);
  let monthCampaigns: any[] = [];
  try {
    monthCampaigns = await getTodaySpentCampaigns(startOfMonthStr, todayDateStr);
  } catch(e: any) {
    console.error('Lỗi khi lấy dữ liệu TikTok:', e.message);
  }
  
  const exchangeRate = 28119;

  const todayCampaigns = monthCampaigns.filter(c => c.date && c.date.startsWith(todayDateStr));

  const buildReportForTimeframe = (timeframe: string, campaigns: any[], salesData: Record<string, { gross: number, delivered: number, orders: number }>) => {
    console.log(`\n=== BÁO CÁO: ${timeframe} ===`);
    
    // Tìm tất cả các ngôn ngữ có phát sinh sale HOẶC có chiến dịch
    const allLangs = new Set(Object.keys(salesData));
    campaigns.forEach(c => {
      const nameParts = c.campaign_name.split('-').map((s: string) => s.trim().toUpperCase());
      const hasProduct = targetKeyMaps.some(k => nameParts[0] === k) || targetKeyMaps.some(k => c.campaign_name.toUpperCase().includes(k)) || nameParts[0].includes('MẶT NẠ MẮT') || nameParts[0].includes('LANBENA') || c.campaign_name.toUpperCase().includes('MẶT NẠ MẮT') || c.campaign_name.toUpperCase().includes('LANBENA');
      
      if (hasProduct) {
        // Simple language extract for debug
        const knownLangs = [...new Set(pageMap.map(p => p.marketCode.toUpperCase()))];
        let matchedLang = 'UNKNOWN';
        if (nameParts.length > 1 && knownLangs.includes(nameParts[1])) matchedLang = nameParts[1];
        else {
          const langInParts = knownLangs.find(l => nameParts.includes(l));
          if (langInParts) matchedLang = langInParts;
          else {
            const langInName = knownLangs.find(l => c.campaign_name.toUpperCase().includes(`-${l}-`) || c.campaign_name.toUpperCase().includes(` ${l} `));
            if (langInName) matchedLang = langInName;
            else if (nameParts.length > 1) matchedLang = nameParts[1];
          }
        }
        allLangs.add(matchedLang);
      }
    });

    for (const lang of allLangs) {
      const sales = salesData[lang] || { gross: 0, delivered: 0, orders: 0 };
      
      const targetCampaigns = campaigns.filter(c => {
        const isMktOwner = permissions.some(p => String(p.advertiserId).trim() === String(c.advertiser_id).trim() && p.mktCode.toUpperCase() === targetMkt.toUpperCase());
        if (!isMktOwner) return false;

        const nameParts = c.campaign_name.split('-').map((s: string) => s.trim().toUpperCase());
        const hasProduct = targetKeyMaps.some(k => nameParts[0] === k) || targetKeyMaps.some(k => c.campaign_name.toUpperCase().includes(k)) || nameParts[0].includes('MẶT NẠ MẮT') || nameParts[0].includes('LANBENA') || c.campaign_name.toUpperCase().includes('MẶT NẠ MẮT') || c.campaign_name.toUpperCase().includes('LANBENA');
        const hasLang = nameParts[1] === lang.toUpperCase() || nameParts.includes(lang.toUpperCase()) || c.campaign_name.toUpperCase().includes(`-${lang.toUpperCase()}-`) || c.campaign_name.toUpperCase().includes(` ${lang.toUpperCase()} `);
        
        return hasProduct && hasLang;
      });

      const totalSpendUsd = targetCampaigns.reduce((sum, c) => sum + c.spend, 0);
      const totalSpendVnd = totalSpendUsd * exchangeRate;
      const totalConversionsAds = targetCampaigns.reduce((sum, c) => sum + c.conversions, 0);

      if (sales.orders === 0 && totalSpendUsd === 0) continue;

      console.log(`[Ngôn ngữ: ${lang}]`);
      console.log(`- Số đơn hàng (Sheet): ${sales.orders}`);
      console.log(`- Chi tiêu Ads: ${totalSpendVnd.toLocaleString('vi-VN')} đ ($${totalSpendUsd.toFixed(2)})`);
      console.log(`- Số chuyển đổi Ads: ${totalConversionsAds} (CPA: $${totalConversionsAds > 0 ? (totalSpendUsd / totalConversionsAds).toFixed(2) : 0})`);
      console.log(`- Doanh số Chốt: ${sales.gross.toLocaleString('vi-VN')} đ`);
      console.log(`- Doanh số Thành công: ${sales.delivered.toLocaleString('vi-VN')} đ`);
      console.log(`- % CP Ads (Chốt): ${sales.gross > 0 ? ((totalSpendVnd / sales.gross) * 100).toFixed(2) : 0}%`);
      console.log(`-----------------------------------`);
    }
  };

  buildReportForTimeframe("HÔM NAY", todayCampaigns, salesToday);
  buildReportForTimeframe("THÁNG NÀY", monthCampaigns, salesMonth);
}

testSalesLogic().catch(console.error);
