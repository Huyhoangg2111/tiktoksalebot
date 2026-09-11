import * as googleSheets from '@googleapis/sheets';
import type { Telegraf } from 'telegraf';
import { db } from '../db/index.js';
import { getRuntimeSettingText, RUNTIME_SETTING_DEFAULTS } from '../settings/runtime.js';
import { getCampaigns, type TikTokCampaign } from '../tiktok/api.js';
import { getCampaignMaterialSnapshot, setMaterialOperationStatusBatch, type CampaignMaterialItem } from './service.js';

const SHEET='MaterialRuler', TZ='Asia/Ho_Chi_Minh';
const DEFAULT_SHEET='1f7bH43w8kv_iiqoy9X5TzSugDuWtsKrB3-Iq8IrxvAI';
const HEADERS=[['rule_id','campaign_match','metric','operator','threshold','period','enabled','note']];
const DEMO=[
 ['enable-good-cpa','Mặt nạ mắt - ID','cpa','<=','0.7','today','false','Bật material CPA tốt'],
 ['enable-converting','Mặt nạ mắt - VN','conversions','>=','3','last_3_days','false','Bật material có chuyển đổi'],
];
type Metric='spend'|'cpa'|'conversions';
type Operator='>'|'>='|'<'|'<='|'=';
interface Rule { id:string; campaignMatch?:string; metric:Metric; operator:Operator; threshold:number; period:string; }
export interface MaterialRulerRunSummary {
 manual:boolean; ruleCount:number; matchedCampaigns:number; matchedMaterials:number;
 enabledMaterials:number; failedGroups:number; periodLabels:string[];
}
function sheetId(){return process.env.CONFIG_GOOGLE_SHEET_ID||process.env.GOOGLE_SHEET_ID||DEFAULT_SHEET;}
function client(scopes:string[]){const auth=new googleSheets.auth.GoogleAuth({credentials:{
 client_email:process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
 private_key:process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g,'\n')},scopes});
 return googleSheets.sheets({version:'v4',auth});}
function t(v:unknown){return String(v??'').trim();}
function isEnabled(v:unknown){return ['true','1','yes','on','enabled','bat','bật'].includes(t(v).toLocaleLowerCase('vi-VN'));}
function metric(v:unknown):Metric|undefined{const k=t(v).toLocaleLowerCase('vi-VN').normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[\s-]+/g,'_');
 if(['spend','chi_tieu','chitieu'].includes(k))return 'spend';
 if(['cpa','cost_per_conversion'].includes(k))return 'cpa';
 if(['conversion','conversions','chuyen_doi','chuyendoi'].includes(k))return 'conversions';}
function operator(v:unknown):Operator|undefined{const x=t(v);return ['>','>=','<','<=','='].includes(x)?x as Operator:undefined;}
function parseRules(rows:any[][]):Rule[]{const out:Rule[]=[];const ids=new Set<string>();
 rows.slice(1).forEach((r,i)=>{const id=t(r[0]),m=metric(r[2]),op=operator(r[3]),tValue=Number(t(r[4]).replace(',','.'));
  if(!id||ids.has(id)||!isEnabled(r[6]))return;
  if(!m||!op||!Number.isFinite(tValue)){console.warn(`[MaterialRuler] invalid row ${i+2}`);return;}
  ids.add(id);out.push({id,campaignMatch:t(r[1])||undefined,metric:m,operator:op,threshold:tValue,period:t(r[5])||'today'});});
 return out;}
function vnNow(){const p=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts();
 const g=(x:Intl.DateTimeFormatPartTypes)=>p.find(y=>y.type===x)?.value||'';
 return {dateKey:`${g('year')}-${g('month')}-${g('day')}`,timeKey:`${g('hour')}:${g('minute')}`};}
function shift(d:string,n:number){const x=new Date(`${d}T12:00:00Z`);x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);}
function period(value:string,today:string){const v=value.toLowerCase();
 if(['today','hom_nay','hôm_nay'].includes(v))return {start:today,end:today,label:today};
 if(['yesterday','hom_qua','hôm_qua'].includes(v)){const d=shift(today,-1);return {start:d,end:d,label:d};}
 if(['month_to_date','mtd','thang_nay'].includes(v))return {start:`${today.slice(0,8)}01`,end:today,label:`${today.slice(0,8)}01..${today}`};
 const last=v.match(/^last_(\d{1,3})_days$/);if(last){const n=Math.max(1,Math.min(90,+last[1])),s=shift(today,-(n-1));return {start:s,end:today,label:`${s}..${today}`};}
 const fixed=v.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);if(fixed&&fixed[1]<=fixed[2])return {start:fixed[1],end:fixed[2],label:v};}
function compare(v:number,op:Operator,x:number){return op==='>'?v>x:op==='>='?v>=x:op==='<'?v<x:op==='<='?v<=x:v===x;}
function value(m:CampaignMaterialItem,k:Metric){return k==='spend'?m.spend:k==='cpa'?m.cpa:m.conversions;}
function campaignMatch(c:TikTokCampaign,q?:string){return !q||String(c.name||'').toLocaleUpperCase('vi-VN').includes(q.toLocaleUpperCase('vi-VN'));}
async function ensureTable(){await db.exec(`CREATE TABLE IF NOT EXISTS material_daily_ruler_runs(
 rule_id TEXT NOT NULL,date_key TEXT NOT NULL,timezone TEXT NOT NULL,run_time TEXT NOT NULL,
 matched_campaigns INTEGER DEFAULT 0,changed_materials INTEGER DEFAULT 0,completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(rule_id,date_key))`);}
async function completed(d:string){return !!(await db.get('SELECT 1 FROM material_daily_ruler_runs WHERE rule_id=? AND date_key=?',['__day__',d]));}
async function mark(d:string,time:string,s:MaterialRulerRunSummary){await db.run(`INSERT INTO material_daily_ruler_runs
 (rule_id,date_key,timezone,run_time,matched_campaigns,changed_materials) VALUES(?,?,?,?,?,?)
 ON CONFLICT(rule_id,date_key) DO UPDATE SET matched_campaigns=excluded.matched_campaigns,changed_materials=excluded.changed_materials,completed_at=CURRENT_TIMESTAMP`,
 ['__day__',d,TZ,time,s.matchedCampaigns,s.enabledMaterials]);}
export async function ensureMaterialRulerSheetTemplate(){const c=client(['https://www.googleapis.com/auth/spreadsheets']),id=sheetId();
 const book=await c.spreadsheets.get({spreadsheetId:id});const exists=book.data.sheets?.some(s=>s.properties?.title===SHEET);
 let legacy=false;if(exists){const old=await c.spreadsheets.values.get({spreadsheetId:id,range:`${SHEET}!A1:H1`});legacy=String(old.data.values?.[0]?.[2]||'')==='timezone';}
 if(!exists)await c.spreadsheets.batchUpdate({spreadsheetId:id,requestBody:{requests:[{addSheet:{properties:{title:SHEET}}}]}});
 await c.spreadsheets.values.update({spreadsheetId:id,range:`${SHEET}!A1:H1`,valueInputOption:'RAW',requestBody:{values:HEADERS}});
 if(!exists||legacy){await c.spreadsheets.values.clear({spreadsheetId:id,range:`${SHEET}!A2:H`});await c.spreadsheets.values.update({spreadsheetId:id,range:`${SHEET}!A2:H3`,valueInputOption:'RAW',requestBody:{values:DEMO}});}
 return {created:!exists};}
async function rules(){await ensureMaterialRulerSheetTemplate();const c=client(['https://www.googleapis.com/auth/spreadsheets.readonly']);
 const r=await c.spreadsheets.values.get({spreadsheetId:sheetId(),range:`${SHEET}!A:H`});return parseRules(r.data.values||[]);}
async function enable(items:CampaignMaterialItem[]){const groups=new Map<string,CampaignMaterialItem[]>();
 items.filter(x=>x.status==='DISABLE').forEach(x=>groups.set(x.smartPlusAdId,[...(groups.get(x.smartPlusAdId)||[]),x]));
 let enabled=0,failed=0;for(const g of groups.values()){const x=g[0];try{const r=await setMaterialOperationStatusBatch(x.advertiserId,x.smartPlusAdId,g.map(y=>y.adMaterialId),'ENABLE');
 enabled+=r.verified.length;if(r.failed.length)failed++;}catch(e){failed++;console.error('[MaterialRuler] enable failed',e);}}return {enabled,failed};}
async function execute(rs:Rule[],manual:boolean):Promise<MaterialRulerRunSummary>{const today=vnNow().dateKey,camps=await getCampaigns();
 const s:MaterialRulerRunSummary={manual,ruleCount:rs.length,matchedCampaigns:0,matchedMaterials:0,enabledMaterials:0,failedGroups:0,periodLabels:[]};
 for(const r of rs){const p=period(r.period,today);if(!p){console.warn('[MaterialRuler] invalid period',r.id,r.period);continue;}s.periodLabels.push(p.label);
  for(const c of camps.filter(x=>campaignMatch(x,r.campaignMatch))){s.matchedCampaigns++;try{const snap=await getCampaignMaterialSnapshot(c.advertiser_id,c.id,c.name,p.start,p.end);
   const hit=snap.materials.filter(x=>compare(value(x,r.metric),r.operator,r.threshold));s.matchedMaterials+=hit.length;const z=await enable(hit);s.enabledMaterials+=z.enabled;s.failedGroups+=z.failed;
  }catch(e){s.failedGroups++;console.error('[MaterialRuler] campaign failed',c.id,e);}}}return s;}
function esc(v:unknown){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
export function formatMaterialRulerSummary(s:MaterialRulerRunSummary){return [
 `<b>${s.manual?'Chạy thủ công':'Lịch tự động'} Material Ruler</b>`,`Rule hợp lệ: <b>${s.ruleCount}</b>`,
 `Campaign đã xét: <b>${s.matchedCampaigns}</b>`,`Material đạt điều kiện: <b>${s.matchedMaterials}</b>`,
 `Material đã bật: <b>${s.enabledMaterials}</b>`,`Lỗi/thiếu xác nhận: <b>${s.failedGroups}</b>`,
 s.periodLabels.length?`Khoảng dữ liệu: <code>${esc([...new Set(s.periodLabels)].join(', '))}</code>`:''].filter(Boolean).join('\n');}
export async function runMaterialRulerNow(bot:Telegraf){const s=await execute(await rules(),true);const id=t(process.env.ADMIN_CHAT_ID);
 if(id)await bot.telegram.sendMessage(id,formatMaterialRulerSummary(s),{parse_mode:'HTML'});return s;}
export async function checkAndRunDailyMaterialRuler(bot:Telegraf){await ensureTable();const now=vnNow();
 const runTime=await getRuntimeSettingText('material_ruler_run_time',RUNTIME_SETTING_DEFAULTS.materialRulerRunTime);
 if(now.timeKey<runTime||await completed(now.dateKey))return;const s=await execute(await rules(),false);const id=t(process.env.ADMIN_CHAT_ID);
 if(id)await bot.telegram.sendMessage(id,formatMaterialRulerSummary(s),{parse_mode:'HTML'});if(!s.failedGroups)await mark(now.dateKey,runTime,s);}
