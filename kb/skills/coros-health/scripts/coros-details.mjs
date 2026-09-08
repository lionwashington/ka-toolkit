import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createOfficialProvider } from './coros-wellness.mjs';

const VERSION = 1;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read(file, fallback) { return existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : fallback; }
function lines(file) { return existsSync(file) ? readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function write(file, value) {
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.tmp-${process.pid}`;
  writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,file);
}
const secret = /(?:access|refresh)[_-]?token|authorization|password|secret|verifier|login.?ticket|poll.?token/i;
export function sanitize(value) {
  if (typeof value==='string') {
    try { return sanitize(JSON.parse(value)); } catch {}
    return value.replace(/Bearer\s+[\w.~+/=-]+/gi,'Bearer [REDACTED]')
      .replace(/([?&](?:token|access_token|refresh_token|code|signature|sig)=)[^&\s]+/gi,'$1[REDACTED]');
  }
  if(Array.isArray(value))return value.map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!secret.test(k)).map(([k,v])=>[k,sanitize(v)]));
  return value;
}
export const DATASETS = {
  querySleepHrv: {kind:'sleep_hrv',semantics:'wake-up date; official assessment plus raw samples; never average samples to replace assessment'},
  querySleepData: {kind:'sleep',semantics:'wake-up date; Main Sleep excludes awake; windows and naps retained'},
  queryDailyHealthData: {kind:'daily',semantics:'COROS local date; Total sleep includes awake; recent-window query'},
  queryRestingHeartRate: {kind:'resting_hr',semantics:'COROS local date; bpm; recent-window query'},
  queryStressLevel: {kind:'stress_daily',semantics:'COROS local date; vendor score, not a clinical measure'},
  queryRecoveryStatus: {kind:'recovery',semantics:'current snapshot only; percentage, level and duration'},
  queryTrainingLoadAssessment: {kind:'training_load',semantics:'daily assessment; vendor load units and dimensionless ratio'},
  queryAvgHeartRate: {kind:'average_hr',semantics:'daily average bpm, distinct from resting HR'},
  queryStressTimeSeries: {kind:'stress_samples',semantics:'raw timestamped samples; preserve timezone code, stress, display score, HRV and HR'},
  queryHealthCheckTimeSeries: {kind:'wellness_checks',semantics:'latest complete check in range, NOT all checks; daily requests improve coverage but cannot guarantee multiple checks/day'},
  queryFitnessAssessmentOverview: {kind:'fitness',semantics:'current device estimate; VO2max, running level, threshold pace, race predictions'},
  queryDevices: {kind:'devices',semantics:'current bound-device snapshot; identifiers private'},
  queryUserInfo: {kind:'profile',semantics:'current self-reported body profile; not verified OAuth identity'},
  queryTrainingSchedule: {kind:'schedule',semantics:'planned sessions, not performed workouts; internal IDs private'},
  queryMenstruationCycles: {kind:'cycles',semantics:'reported cycle ranges/phases/notes; absent response is not a physiological conclusion'},
  querySportRecords: {kind:'activities',semantics:'official activity catalogue; daily partitions with explicit high limit; possible truncation flagged'},
  getActivityDetail: {kind:'activity_detail',semantics:'one activity; sport-dependent fields, units as returned'},
  queryActivityLapData: {kind:'activity_laps',semantics:'official app-visible laps/segments, not arbitrary custom windows'},
};
export function detailsPaths(paths) {const root=join(paths.root,'details');return {root,index:join(root,'index.json'),schema:join(root,'schema.json'),state:join(root,'state.json')};}
function day(value) {const v=String(value);return /^\d{8}$/.test(v)?`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`:v.slice(0,10);}
function daysBetween(start,end) {const out=[];for(let d=new Date(start+'T12:00:00Z');d<=new Date(end+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1))out.push(d.toISOString().slice(0,10));return out;}
function validateDay(value) {if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)throw Error('invalid calendar date');return value;}
const compact = d => d.replaceAll('-','');

// Lossless evidence plus query-friendly labelled lines. Never invent units or
// a fixed schema for vendor text. Original decoded payload remains authoritative.
export function labelledFields(payload) {
  const fields=[];
  function visit(value,path='$') {
    if(Array.isArray(value)){value.forEach((v,i)=>visit(v,`${path}[${i}]`));return;}
    if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value))visit(v,`${path}.${k}`);return;}
    if(typeof value!=='string'||!value.includes('\n')) { fields.push({path,value,encoding:'scalar'});return; }
    let date=null;
    value.split(/\r?\n/).forEach((line,i)=>{
      const heading=line.trim().match(/^(?:---\s*)?(\d{4}-\d{2}-\d{2}|\d{8})(?:\s*---|:)?$/);
      if(heading)date=day(heading[1]);
      if(line.trim())fields.push({path,line:i+1,date,text:line,encoding:'source_line'});
    });
  }
  visit(payload);return fields;
}
export function buildJobs(tools,activities,start,end,index={},refresh=false) {
  validateDay(start);validateDay(end);if(start>end)throw Error('start date is after end date');
  const days=daysBetween(start,end),recent=days.slice(-3),jobs=[];
  const add=(tool,args,scope,mutable=true)=>{
    const key=hash([tool,args]);const prior=index[key];
    if(!refresh&&prior?.status==='ok'&&(!mutable||prior.checked_day===end))return;
    jobs.push({key,tool,args,scope});
  };
  for(const tool of tools){const name=tool.name;if(!DATASETS[name])continue;
    if(['getActivityDetail','queryActivityLapData'].includes(name)) {
      for(const a of activities)if(a.labelId!=null&&a.sportType!=null)add(name,{labelId:String(a.labelId),sportType:Number(a.sportType)},{activity_id:String(a.labelId)},recent.includes(day(a.date)));
    } else if(['queryDevices','queryUserInfo','queryFitnessAssessmentOverview','queryRecoveryStatus'].includes(name))add(name,{}, {snapshot_day:end});
    else if(['queryDailyHealthData','queryRestingHeartRate','queryStressLevel','queryTrainingLoadAssessment'].includes(name))add(name,{days:Math.min(days.length,7)},{recent_to:end,requested_days:Math.min(days.length,7)});
    else for(const d of days){let args={startDate:compact(d),endDate:compact(d)};
      if(name==='queryMenstruationCycles')args={startDay:Number(compact(d)),endDay:Number(compact(d))};
      if(name==='querySportRecords')args={...args,sportTypeCodes:[65535],minDistanceKm:null,maxDistanceKm:null,minDurationMinutes:null,maxDurationMinutes:null,maxAveragePace:null,locationKeyword:null,limit:1000};
      else if(Object.hasOwn(tool.inputSchema?.properties||{},'days'))args.days=1;
      add(name,args,{date:d},recent.includes(d));
    }
  }
  return jobs.sort((a,b)=>Number(Boolean(a.scope.activity_id))-Number(Boolean(b.scope.activity_id)));
}
export function readDetails(paths, options={}) {
  const p=detailsPaths(paths);const index=read(p.index,{});
  if(options.schema)return read(p.schema,{error:'details not initialized'});
  if(options.key){if(!/^[a-f0-9]{64}$/.test(options.key)||!index[options.key])throw Error('unknown detail key');return index[options.key].file?read(join(p.root,index[options.key].file),null):index[options.key];}
  const selected=Object.entries(index).filter(([,r])=>(!options.tool||r.tool===options.tool)&&(!options.date||r.scope?.date===options.date||r.scope?.snapshot_day===options.date));
  const offset=Math.max(0,Number(options.offset)||0),limit=Math.min(100,Math.max(1,Number(options.limit)||20));
  return {schema_version:VERSION,total:selected.length,offset,records:selected.slice(offset,offset+limit).map(([key,r])=>({key,...r})),state:read(p.state,{})};
}
export async function syncDetails(paths,options={}) {
  const p=detailsPaths(paths);mkdirSync(p.root,{recursive:true,mode:0o700});
  const lock=join(p.root,'.sync-lock');
  try { mkdirSync(lock,{mode:0o700}); } catch { throw Error('details sync already locked; verify no worker is running before recovering an abandoned lock'); }
  try {return await syncDetailsUnlocked(paths,options);}finally{rmdirSync(lock);}
}
async function syncDetailsUnlocked(paths,options={}) {
  const p=detailsPaths(paths);const provider=options.provider||createOfficialProvider(options);
  const end=validateDay(options.endDate||new Intl.DateTimeFormat('en-CA',{timeZone:options.timeZone||'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
  const wellness=lines(join(paths.root,'wellness','derived','daily.jsonl'));
  const start=validateDay(options.startDate||wellness[0]?.date||end);
  const tools=await provider.listTools(Boolean(options.refreshTools));const index=read(p.index,{});
  write(p.schema,{schema_version:VERSION,storage:'content-addressed immutable response revisions; index contains current pointers',
    envelope:{schema_version:'integer',tool:'official tool name',args:'official inputSchema',scope:'date OR snapshot_day OR activity_id; requested scope not proof of returned coverage',payload:'complete decoded response; unknown fields preserved; credential fields removed',fields:'lossless scalar/path or dated source_line index; text units remain explicit in source',fetched_at:'UTC acquisition timestamp'},
    datasets:Object.fromEntries(tools.filter(t=>DATASETS[t.name]).map(t=>[t.name,{...DATASETS[t.name],description:t.description,inputSchema:t.inputSchema}])),
    not_fetched:{analyzeActivityDetail:'generated interpretation, not additional raw data',queryCustomActivityLapData:'infinite user-selected windows; original FIT and full official laps retained',downloadActivityFitFiles:'existing validated FIT cache reused; no redundant binary requests',queryActivityFitFileDownloadUrls:'temporary signed URLs are not durable data'},
    limitations:['Tool success does not prove records exist or cover every requested date.','Recent-only tools cannot reconstruct unavailable old snapshots.','Wellness-check endpoint returns only latest complete check per request.','Unknown units and timezone codes are preserved, never guessed.']});
  function retain(job,payload,fetched_at,status='ok') {
    const decoded=sanitize(payload);const record={schema_version:VERSION,tool:job.tool,args:job.args,scope:job.scope,payload:decoded,fields:labelledFields(decoded)};
    const digest=hash(record),file=`raw/${digest}.json`;
    if(!existsSync(join(p.root,file)))write(join(p.root,file),{...record,fetched_at});
    index[job.key]={tool:job.tool,scope:job.scope,file,status,checked_day:end,fetched_at};
    write(p.index,index);
  }
  // Import all already-fetched wellness evidence without another network call.
  for(const row of lines(join(paths.root,'wellness','raw','observations.jsonl'))){const key=hash(['wellness',row.key]);if(index[key]?.fetched_at===row.fetched_at)continue;
    retain({key,tool:row.tool,args:null,scope:{range:row.range,imported:true}},row.payload,row.fetched_at);
  }
  const jobs=buildJobs(tools,read(paths.activities,[]),start,end,index,options.refresh);
  const max=options.maxCalls===undefined?jobs.length:Math.max(0,Number(options.maxCalls));
  const state={schema_version:VERSION,start_date:start,end_date:end,planned:jobs.length,completed:0,failed:0,remaining:jobs.length,complete:false};
  for(const job of jobs.slice(0,max)){
    try{const result=await provider.callTool(job.tool,job.args);if(result?.isError)throw Error('tool returned error');retain(job,result,new Date().toISOString());state.completed++;}
    catch {state.failed++;index[job.key]={...index[job.key],tool:job.tool,scope:job.scope,status:'failed',checked_day:end};write(p.index,index);}
    state.remaining--;write(p.state,state);options.onProgress?.({...state});
    if(options.delayMs!==0)await new Promise(r=>setTimeout(r,options.delayMs??150));
    if(state.failed>=5)break; // bounded failure circuit; resume safely later
  }
  state.complete=state.remaining===0&&state.failed===0;write(p.state,state);return state;
}
