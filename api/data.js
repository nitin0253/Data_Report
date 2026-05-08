// pages/api/data.js
let cache = null;
let lastFetch = 0;
const CACHE_TIME = 30 * 60 * 1000;
const METABASE_URL = "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv";
const filteredCache = new Map();

function parseCSVRow(row){const out=[];let cur='',q=false;for(let i=0;i<row.length;i++){const ch=row[i];if(ch==='"'){if(q&&row[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(ch===','&&!q){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out;}
function parseCSV(text){const lines=text.trim().split(/\r?\n/);if(!lines.length)return[];const headers=parseCSVRow(lines[0]).map(h=>h.trim());return lines.slice(1).filter(Boolean).map(line=>{const vals=parseCSVRow(line);const o={};headers.forEach((h,i)=>o[h]=(vals[i]??'').trim());return o;});}
function safeDate(str){if(!str)return null;const d=new Date(String(str).trim().replace(' ','T'));return isNaN(d)?null:d;}
function pickField(r,names){for(const n of names){if(r[n]!=null&&String(r[n]).trim()!=='') return r[n];}return '';}
function parseTat(s){if(s==null)return null;s=String(s).trim();if(!s||s==='null')return null;if(s.includes(':')){const p=s.split(':').map(Number);if(p.some(isNaN))return null;if(p.length===3)return p[0]*60+p[1]+p[2]/60;if(p.length===2)return p[0]+p[1]/60;}const n=parseFloat(s);return isNaN(n)?null:n;}
function parseSla(s){if(s==null)return null;s=String(s).trim().toLowerCase();if(['1','true','yes','within','within_sla'].includes(s))return 1;if(['0','false','no','out','out_of_sla','breached'].includes(s))return 0;return null;}
function isDelivered(r){return r._crm==='qc_done'&&r._verified==='verified';}
function isRejected(r){return r._crm==='qc_done'&&(['rejected','none',''].includes(r._verified||''));}
function isPending(r){return r._crm!=='qc_done';}
function isoWeekStart(d){const x=new Date(d);const day=x.getDay();const diff=day===0?-6:1-day;x.setDate(x.getDate()+diff);x.setHours(0,0,0,0);return x;}
function monthKey(d){return d.toISOString().slice(0,7);} 
function dayKey(d){return d.toISOString().slice(0,10);} 

async function loadCache(){
 if(cache && Date.now()-lastFetch<CACHE_TIME) return cache;
 const resp = await fetch(METABASE_URL,{headers:{'User-Agent':'Mozilla/5.0'}});
 if(!resp.ok) throw new Error('Metabase fetch failed');
 const rows = parseCSV(await resp.text());
 cache = rows.map(r=>{
   const o={...r};
   o._crm=(pickField(r,['CRM_Status','crm_status'])||'').toLowerCase().trim();
   o._verified=(pickField(r,['verified_status','verified'])||'').toLowerCase().trim();
   o._team=pickField(r,['Team_Name','team_name','team']).trim();
   o._created=safeDate(r.Created_ON);
   o._updated=safeDate(r.Updated_ON);
   o._tat=parseTat(pickField(r,['TAT','tat','tat_hours','TAT_hours']));
   o._sla=parseSla(pickField(r,['SLA_Flag','sla_flag','SLA']));
   if(o._tat==null && o._created && o._updated && o._crm==='qc_done') o._tat=(o._updated-o._created)/60000;
   return o;
 });
 lastFetch=Date.now(); filteredCache.clear();
 return cache;
}

function buildTrend(rows, mode){
 const map={};
 rows.forEach(r=>{
   if(!r._created) return;
   let key;
   if(mode==='this_week') key=dayKey(r._created);
   else if(mode==='weeks') key=dayKey(isoWeekStart(r._created));
   else key=monthKey(r._created);
   if(!map[key]) map[key]={received:0,delivered:0,rejected:0};
   map[key].received++;
   if(isDelivered(r)) map[key].delivered++;
   else if(isRejected(r)) map[key].rejected++;
 });
 const keys=Object.keys(map).sort();
 return {labels:keys,received:keys.map(k=>map[k].received),delivered:keys.map(k=>map[k].delivered),rejected:keys.map(k=>map[k].rejected)};
}

function aggregate(rows, trendMode){
 let totalReceived=0,totalDelivered=0,totalRejected=0,totalPending=0,withinSla=0,outOfSla=0,tatSum=0,tatCount=0;
 const ent={},team={},qc={};
 rows.forEach(r=>{
   totalReceived++;
   if(isDelivered(r)) totalDelivered++; else if(isRejected(r)) totalRejected++; else if(isPending(r)) totalPending++;
   if(r._crm==='qc_done'){
     if(r._sla===1) withinSla++; else if(r._sla===0) outOfSla++;
     if(Number.isFinite(r._tat)){tatSum+=r._tat;tatCount++;}
   }
   if(r.Ent_Name) ent[r.Ent_Name]=(ent[r.Ent_Name]||0)+1;
   if(r._team) team[r._team]=(team[r._team]||0)+1;
   if(r.qc_email_id) qc[r.qc_email_id]=(qc[r.qc_email_id]||0)+1;
 });
 const deliveryPct=totalReceived?+((totalDelivered/totalReceived)*100).toFixed(2):0;
 return {
   kpis:{totalReceived,totalDelivered,totalRejected,totalPending,withinSla,outOfSla,slaPercent:totalDelivered?+((withinSla/totalDelivered)*100).toFixed(2):0,deliveryPct,avgTat:tatCount?+((tatSum/60)/tatCount).toFixed(2):0,totalEnterpriseCount:Object.keys(ent).length,totalTeamCount:Object.keys(team).length},
   charts:{enterprise:Object.fromEntries(Object.entries(ent).sort((a,b)=>b[1]-a[1]).slice(0,12)),team:Object.fromEntries(Object.entries(team).sort((a,b)=>b[1]-a[1]).slice(0,12)),qc:Object.fromEntries(Object.entries(qc).sort((a,b)=>b[1]-a[1]).slice(0,15)),trend:buildTrend(rows,trendMode)}
 };
}

export default async function handler(req,res){
 try{
  const all=await loadCache();
  const {start,end,enterprise='all',team='all',user='all',verified='all',sla='all',trend='months'}=req.query;
  const key=JSON.stringify(req.query);
  if(filteredCache.has(key)) return res.status(200).json(filteredCache.get(key));
  let filtered=all;
  if(enterprise!=='all') filtered=filtered.filter(d=>d.Ent_Name===enterprise);
  if(team!=='all') filtered=filtered.filter(d=>d._team===team);
  if(user!=='all') filtered=filtered.filter(d=>d.qc_email_id===user);
  if(verified!=='all') filtered=filtered.filter(d=>d._verified===verified);
  if(sla==='1') filtered=filtered.filter(d=>d._sla===1);
  if(sla==='0') filtered=filtered.filter(d=>d._sla===0);
  if(start){const s=new Date(start+'T00:00:00'); filtered=filtered.filter(d=>d._created && d._created>=s);}
  if(end){const e=new Date(end+'T23:59:59'); filtered=filtered.filter(d=>d._created && d._created<=e);}
  const response={
   ...aggregate(filtered, trend),
   filters:{
    enterpriseList:[...new Set(all.map(d=>d.Ent_Name).filter(Boolean))].sort(),
    teamList:[...new Set(all.map(d=>d._team).filter(Boolean))].sort(),
    userList:[...new Set(all.map(d=>d.qc_email_id).filter(Boolean))].sort()
   },
   raw: filtered.slice().sort((a,b)=>(b._created?.getTime()||0)-(a._created?.getTime()||0)).slice(0,500).map(d=>({Ent_Name:d.Ent_Name,team:d._team,qc_email_id:d.qc_email_id,crm_status:d._crm,verified_status:d._verified,tat:d._tat,Created_ON:d.Created_ON,Updated_ON:d.Updated_ON})),
   lastSynced:new Date(lastFetch).toISOString()
  };
  filteredCache.set(key,response);
  res.status(200).json(response);
 }catch(err){res.status(500).json({error:err.message});}
}
