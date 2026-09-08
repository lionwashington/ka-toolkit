import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syncDetails,readDetails,sanitize,buildJobs,labelledFields} from '../kb/skills/coros-health/scripts/coros-details.mjs';
const tool=name=>({name,inputSchema:{properties:{startDate:{},endDate:{},days:{}}}});
test('lossless fields retain unknown values and wake-day headings while removing nested secrets',()=>{
  const value=sanitize({content:[{text:JSON.stringify({access_token:'SENSITIVE',unknown:[3,'4 bpm'],text:'20310403\nMain Sleep Window: 2031-04-02 23:00 - 2031-04-03 06:00\nNovel Field: 8 foos'})}]});
  assert.ok(!JSON.stringify(value).includes('SENSITIVE'));
  const fields=labelledFields(value);assert.ok(fields.some(f=>f.text==='Novel Field: 8 foos'&&f.date==='2031-04-03'));
  assert.ok(fields.some(f=>f.value==='4 bpm'));
});
test('job coverage excludes interpretation and duplicate FIT, partitions checks daily',()=>{
 const jobs=buildJobs(['queryHealthCheckTimeSeries','queryDevices','getActivityDetail','analyzeActivityDetail','downloadActivityFitFiles'].map(tool),[{labelId:'synthetic',sportType:100,date:20310401}],'2031-04-01','2031-04-03');
 assert.equal(jobs.length,5);assert.equal(jobs.filter(j=>j.tool==='queryHealthCheckTimeSeries').length,3);
 assert.equal(jobs.at(-1).args.labelId,'synthetic');
});
test('persistent jobs resume, preserve changed revisions, query full schema and handle failures without losing cache',async()=>{
 const root=mkdtempSync(join(tmpdir(),'coros-detail-'));const paths={root,activities:join(root,'activities.json')};writeFileSync(paths.activities,'[]');
 let calls=0,value=1,fail=false;const provider={listTools:()=>[tool('queryDevices'),tool('querySleepData')],callTool:()=>{calls++;if(fail)throw Error('secret-token');return {content:[{text:`Novel metric: ${value} units`} ]};}};
 const opts={provider,startDate:'2031-04-03',endDate:'2031-04-03',delayMs:0};
 let result=await syncDetails(paths,{...opts,maxCalls:1});assert.equal(result.remaining,1);
 await syncDetails(paths,opts);assert.equal(calls,2);await syncDetails(paths,opts);assert.equal(calls,2);
 const prior=readDetails(paths);value=2;await syncDetails(paths,{...opts,refresh:true});
 const fresh=readDetails(paths);assert.notEqual(prior.records[0].file,fresh.records[0].file);
 assert.ok(readDetails(paths,{schema:true}).datasets.querySleepData.inputSchema);
 fail=true;result=await syncDetails(paths,{...opts,refresh:true});assert.equal(result.complete,false);
 assert.equal(readDetails(paths).records[0].file,fresh.records[0].file);
 assert.ok(readDetails(paths,{key:fresh.records[0].key}).payload);
 assert.throws(()=>readDetails(paths,{key:'../escape'}));
});
