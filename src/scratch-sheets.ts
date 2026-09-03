import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import * as googleSheets from '@googleapis/sheets';

async function run() {
  const auth = new googleSheets.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = googleSheets.sheets({ version: 'v4', auth });
  const configSheetId = process.env.CONFIG_GOOGLE_SHEET_ID || '1f7bH43w8kv_iiqoy9X5TzSugDuWtsKrB3-Iq8IrxvAI';

  const configRes = await sheets.spreadsheets.values.get({ spreadsheetId: configSheetId, range: 'Sources!A:E' });
  const rawSources = configRes.data.values || [];
  const sources: string[] = [];
  const idRegex = /^[a-zA-Z0-9-_]{30,}$/;
  for (let i = 1; i < rawSources.length; i++) {
    const sheetId = rawSources[i].find(cell => idRegex.test(String(cell).trim()));
    if (sheetId) sources.push(String(sheetId).trim());
  }

  for (const sheetId of sources) {
    try {
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
      console.log(`Sheet ID ${sheetId} tabs:`, spreadsheet.data.sheets?.map(s => s.properties?.title));
    } catch(e) {}
  }
}

run();
