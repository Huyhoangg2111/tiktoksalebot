import type { Telegraf } from 'telegraf';
import { db } from '../db/index.js';
import { getRuntimeSettingText, RUNTIME_SETTING_DEFAULTS } from '../settings/runtime.js';
import { getCampaigns, type TikTokCampaign } from '../tiktok/api.js';
import { getCampaignMaterialSnapshot, setMaterialOperationStatusBatch, type CampaignMaterialItem } from './service.js';

const TZ='Asia/Ho_Chi_Minh';
const HEADERS=[['campaign_match','spend_operator','spend_threshold','cpa_operator','cpa_threshold','conversions_operator','conversions_threshold','enabled','note']];
type Operator='>'|'>='|'<'|'<='|'=';
interface Condition { operator:Operator; threshold:number; }
interface Rule { id:string; campaignMatch?:string; spend?:Condition; cpa?:Condition; conversions?:Condition; }
interface MaterialRulerCampaignSummary {
 campaignId:string; campaignName:string; matchedMaterials:number; enabledMaterials:number; failedGroups:number;
}
export interface MaterialRulerRunSummary {
 manual:boolean; ruleCount:number; matchedCampaigns:number; matchedMaterials:number;
 enabledMaterials:number; failedGroups:number; periodLabels:string[]; campaigns:MaterialRulerCampaignSummary[];
}
function t(v:unknown){return String(v??'').trim();}
function isEnabled(v:unknown){return ['true','1','yes','on','enabled','bat','bật'].includes(t(v).toLocaleLowerCase('vi-VN'));}
function operator(v:unknown):Operator|undefined{const x=t(v);return ['>','>=','<','<=','='].includes(x)?x as Operator:undefined;}
function condition(opValue:unknown,thresholdValue:unknown):Condition|undefined {
 const op=operator(opValue),raw=t(thresholdValue);if(!op&&!raw)return undefined;
 const threshold=Number(raw.replace(',','.'));return op&&Number.isFinite(threshold)?{operator:op,threshold}:undefined;
}
function parseRules(rows:any[][]):Rule[]{const out:Rule[]=[];
 rows.slice(1).forEach((r,i)=>{const id=`row-${i+2}`,spend=condition(r[1],r[2]),cpa=condition(r[3],r[4]),conversions=condition(r[5],r[6]);
  if(!isEnabled(r[7]))return;
  const hasMalformedPair=[[r[1],r[2]],[r[3],r[4]],[r[5],r[6]]].some(([op,x])=>Boolean(t(op)||t(x))&&!condition(op,x));
  if(hasMalformedPair||(!spend&&!cpa&&!conversions)){console.warn(`[MaterialRuler] invalid conditions row ${i+2}`);return;}
  out.push({id,campaignMatch:t(r[0])||undefined,spend,cpa,conversions});});
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
function matches(m:CampaignMaterialItem,r:Rule){
 return (!r.spend||compare(m.spend,r.spend.operator,r.spend.threshold))&&
  (!r.cpa||compare(m.cpa,r.cpa.operator,r.cpa.threshold))&&
  (!r.conversions||compare(m.conversions,r.conversions.operator,r.conversions.threshold));
}
function campaignMatch(c:TikTokCampaign,q?:string){return !q||String(c.name||'').toLocaleUpperCase('vi-VN').includes(q.toLocaleUpperCase('vi-VN'));}
async function ensureTable(){await db.exec(`CREATE TABLE IF NOT EXISTS material_daily_ruler_runs(
 rule_id TEXT NOT NULL,date_key TEXT NOT NULL,timezone TEXT NOT NULL,run_time TEXT NOT NULL,
 matched_campaigns INTEGER DEFAULT 0,changed_materials INTEGER DEFAULT 0,completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(rule_id,date_key))`);}
async function completed(d:string,time:string){return !!(await db.get('SELECT 1 FROM material_daily_ruler_runs WHERE rule_id=? AND date_key=? AND run_time=?',['__day__',d,time]));}
async function mark(d:string,time:string,s:MaterialRulerRunSummary){await db.run(`INSERT INTO material_daily_ruler_runs
 (rule_id,date_key,timezone,run_time,matched_campaigns,changed_materials) VALUES(?,?,?,?,?,?)
 ON CONFLICT(rule_id,date_key) DO UPDATE SET matched_campaigns=excluded.matched_campaigns,changed_materials=excluded.changed_materials,completed_at=CURRENT_TIMESTAMP`,
 ['__day__',d,TZ,time,s.matchedCampaigns,s.enabledMaterials]);}
async function rules(){
 const local=await db.all<{data_json:string}>('SELECT data_json FROM admin_config_rows WHERE section=? ORDER BY position,id',['material_ruler']).catch(()=>[]);
 const rows=local.map(x=>{const r=JSON.parse(x.data_json);return [r.campaign_match,r.spend_operator,r.spend_threshold,r.cpa_operator,r.cpa_threshold,r.conversions_operator,r.conversions_threshold,r.enabled,r.note];});
 return parseRules([HEADERS[0],...rows]);}
async function enable(items:CampaignMaterialItem[]){const groups=new Map<string,CampaignMaterialItem[]>();
 items.filter(x=>x.status==='DISABLE').forEach(x=>groups.set(x.smartPlusAdId,[...(groups.get(x.smartPlusAdId)||[]),x]));
 let enabled=0,failed=0;for(const g of groups.values()){const x=g[0];try{const r=await setMaterialOperationStatusBatch(x.advertiserId,x.smartPlusAdId,g.map(y=>y.adMaterialId),'ENABLE');
 enabled+=r.verified.length;if(r.failed.length)failed++;}catch(e){failed++;console.error('[MaterialRuler] enable failed',e);}}return {enabled,failed};}
async function execute(rs:Rule[],manual:boolean):Promise<MaterialRulerRunSummary>{const today=vnNow().dateKey,camps=await getCampaigns();
 const configuredPeriod=await getRuntimeSettingText('material_ruler_period',RUNTIME_SETTING_DEFAULTS.materialRulerPeriod);
 const p=period(configuredPeriod,today);if(!p)throw new Error(`Khoảng kiểm tra Material Ruler không hợp lệ: ${configuredPeriod}`);
 const s:MaterialRulerRunSummary={manual,ruleCount:rs.length,matchedCampaigns:0,matchedMaterials:0,enabledMaterials:0,failedGroups:0,periodLabels:[],campaigns:[]};
 const campaignSummaries=new Map<string,MaterialRulerCampaignSummary>();s.periodLabels.push(p.label);
 for(const r of rs){
  for(const c of camps.filter(x=>campaignMatch(x,r.campaignMatch))){s.matchedCampaigns++;
   const campaignSummary=campaignSummaries.get(c.id)||{campaignId:c.id,campaignName:c.name,matchedMaterials:0,enabledMaterials:0,failedGroups:0};
   campaignSummaries.set(c.id,campaignSummary);
   try{const snap=await getCampaignMaterialSnapshot(c.advertiser_id,c.id,c.name,p.start,p.end);
    const hit=snap.materials.filter(x=>matches(x,r));s.matchedMaterials+=hit.length;campaignSummary.matchedMaterials+=hit.length;
    const z=await enable(hit);s.enabledMaterials+=z.enabled;s.failedGroups+=z.failed;campaignSummary.enabledMaterials+=z.enabled;campaignSummary.failedGroups+=z.failed;
   }catch(e){s.failedGroups++;campaignSummary.failedGroups++;console.error('[MaterialRuler] campaign failed',c.id,e);}}}
 s.campaigns=[...campaignSummaries.values()].filter(x=>x.matchedMaterials>0||x.failedGroups>0);return s;}
function esc(v:unknown){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function shortCampaignName(name:string){const parts=t(name).split(' - ').map(x=>x.trim()).filter(Boolean);return parts.length>=2?`${parts[0]} - ${parts[1]}`:t(name);}
export function formatMaterialRulerSummary(s:MaterialRulerRunSummary){
 const visible=s.campaigns.slice(0,20);
 const campaignLines=visible.flatMap((c,i)=>[
  `${i+1}. <b>${esc(shortCampaignName(c.campaignName))}</b> - <code>${esc(c.campaignId)}</code>`,
  `Đạt: <b>${c.matchedMaterials}</b> · Đã bật: <b>${c.enabledMaterials}</b>${c.failedGroups?` · Lỗi: <b>${c.failedGroups}</b>`:''}`
 ]);
 if(s.campaigns.length>visible.length)campaignLines.push(`… +${s.campaigns.length-visible.length} campaign khác`);
 return [
  `<b>${s.manual?'Chạy thủ công':'Lịch tự động'} Material Ruler</b>`,`Rule hợp lệ: <b>${s.ruleCount}</b>`,
  `Campaign đã xét: <b>${s.matchedCampaigns}</b>`,`Material đạt điều kiện: <b>${s.matchedMaterials}</b>`,
  `Material đã bật: <b>${s.enabledMaterials}</b>`,`Lỗi/thiếu xác nhận: <b>${s.failedGroups}</b>`,
  s.periodLabels.length?`Khoảng dữ liệu: <code>${esc([...new Set(s.periodLabels)].join(', '))}</code>`:'',
  campaignLines.length?'<b>Thống kê theo campaign</b>':'',...campaignLines
 ].filter(Boolean).join('\n');
}
export async function runMaterialRulerNow(bot:Telegraf){const s=await execute(await rules(),true);const id=t(process.env.ADMIN_CHAT_ID);
 if(id)await bot.telegram.sendMessage(id,formatMaterialRulerSummary(s),{parse_mode:'HTML'});return s;}
export async function checkAndRunDailyMaterialRuler(bot:Telegraf){await ensureTable();const now=vnNow();
 const runTime=await getRuntimeSettingText('material_ruler_run_time',RUNTIME_SETTING_DEFAULTS.materialRulerRunTime);
 if(now.timeKey<runTime||await completed(now.dateKey,runTime))return;const s=await execute(await rules(),false);const id=t(process.env.ADMIN_CHAT_ID);
 if(id)await bot.telegram.sendMessage(id,formatMaterialRulerSummary(s),{parse_mode:'HTML'});if(!s.failedGroups)await mark(now.dateKey,runTime,s);}
