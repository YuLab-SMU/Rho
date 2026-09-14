// Exact-session continuation across an owned disposable Host crash. By default
// uses a local ACP fixture. --real-* opts into native models; --model selects an exact native model ID.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
const root=path.resolve(import.meta.dirname,'..');
const provider=process.argv.includes('--real-codex')?'codex':process.argv.includes('--real-deepseek')?'deepseek':'kimi';
const real=process.argv.some(a=>['--real-kimi','--real-codex','--real-deepseek'].includes(a));
const modelIndex=process.argv.indexOf('--model');
if(modelIndex>=0)assert.ok(real&&process.argv[modelIndex+1]&&!process.argv[modelIndex+1].startsWith('--'),'--model requires a native test and an exact native model ID');
const model=modelIndex>=0?process.argv[modelIndex+1]:real?(provider==='codex'?'gpt-6-astra':provider==='deepseek'?'[\"115-newapi\",\"deepseek-v4-flash\"]':'b-ai/glm-5.3-flash'):'fixture-fast';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rho-agent-recovery-'));
fs.mkdirSync(path.join(dir,'study'));const project=fs.realpathSync(path.join(dir,'study')),urlfile=path.join(dir,'launch'),log=path.join(dir,'native.jsonl');
const watched=['config.toml','mcp.json'].map(n=>path.join(process.env.KIMI_CODE_HOME||path.join(os.homedir(),'.kimi-code'),n));
watched.push(path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'config.toml'),...['settings.yaml','.credentials.yaml'].map(n=>path.join(process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),n)));
const hashes=()=>watched.map(p=>fs.existsSync(p)?createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null);const before=hashes();
const env={...process.env};if(!real){const bin=path.join(dir,'bin');fs.mkdirSync(bin);fs.copyFileSync(path.join(root,'ui/e2e/fixtures/agents/kimi.cjs'),path.join(bin,'kimi'));fs.chmodSync(path.join(bin,'kimi'),0o700);env.PATH=`${bin}${path.delimiter}${env.PATH}`;env.KIMI_CODE_HOME=path.join(dir,'kimi-home');fs.mkdirSync(env.KIMI_CODE_HOME);env.RHO_AGENT_FIXTURE_LOG=log;}
let host,origin,token='',registered,heartbeat,taskId,seq=0,stderr='';const windowId=randomUUID();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const safe=v=>String(v).replaceAll(token||'\0','<private-token>').replace(/([#?&]token=)[^&\s"']+/gi,'$1<private-token>');
async function api(route,body){const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const data=await r.json();assert.ok(r.ok,safe(JSON.stringify(data)));return data;}
const bridge=params=>api('/api/application/bridge',{project_root:project,frame:{id:String(++seq),request:{method:'application_bridge',params}}});
const query=query=>api('/api/agents/tasks/query',{project_root:project,query});
const command=(command,request_id=randomUUID())=>api('/api/agents/tasks/command',{project_root:project,window:registered.window,request_id,command});
const ctl=d=>({task_id:d.summary.task.task_id,generation:d.summary.attachment.generation});
const get=async id=>(await query({kind:'get',task_id:id})).detail;
async function waitFor(read,predicate,ms=120000){const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(predicate(value))return value;await pause(100);}throw new Error('Timed out; no native input was replayed');}
async function settled(id){return waitFor(async()=>{const {receipt}=await query({kind:'receipt',request_id:id});if(receipt&&['failed','uncertain','interrupted'].includes(receipt.status))throw new Error(safe(receipt.error||receipt.status));return receipt;},r=>r?.status==='succeeded');}
async function launch(){fs.rmSync(urlfile,{force:true});host=spawn(path.join(root,'target/debug/rho'),['--database',path.join(dir,'state.sqlite'),'--project',project,'workbench','--url-file',urlfile],{env,stdio:['ignore','ignore','pipe']});stderr='';host.stderr.on('data',d=>stderr=(stderr+d).slice(-3000));await waitFor(async()=>{if(host.exitCode!==null)throw new Error(safe(stderr));return fs.existsSync(urlfile);},Boolean,30000);const u=new URL(fs.readFileSync(urlfile,'utf8').trim());origin=u.origin;token=new URLSearchParams(u.hash.slice(1)).get('token');registered=(await bridge({kind:'register',window_id:windowId,incarnation:randomUUID(),label:'Recovery acceptance',previous_session:null})).result.data.session;heartbeat=setInterval(()=>void bridge({kind:'renew',session:registered}).catch(()=>{}),5000);}
async function stop(signal){clearInterval(heartbeat);if(host&&host.exitCode===null&&host.signalCode===null){const done=new Promise(r=>host.once('exit',r));host.kill(signal);const force=setTimeout(()=>host.kill('SIGKILL'),10000);await done;clearTimeout(force);}}
async function draft(d,text){return(await command({kind:'save_draft',control:ctl(d),version:d.draft.version,content:{...d.draft.content,text}})).detail;}
const calls=()=>real?[]:fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[];
function redPng(){const crc=b=>{let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;};const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),a=Buffer.alloc(4),b=Buffer.alloc(4);a.writeUInt32BE(data.length);b.writeUInt32BE(crc(body));return Buffer.concat([a,body,b]);};const h=Buffer.alloc(13);h.writeUInt32BE(32);h.writeUInt32BE(32,4);h[8]=8;h[9]=2;const pixels=Buffer.alloc(32*(1+32*3));for(let y=0;y<32;y++)for(let x=0;x<32;x++)pixels[y*97+1+x*3]=255;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
async function reportUsage(){
 const {page:usagePage}=await query({kind:'events',task_id:taskId,after:null,before:null,limit:100});
 const usage=usagePage.events.flatMap(event=>event.usage?[event.usage]:[]);
 for(const observation of usage){assert.equal(typeof observation.source,'string');assert.ok(['turn_total','session_total','context_window'].includes(observation.scope));for(const key of ['input_tokens','output_tokens','cached_input_tokens','cache_write_tokens','reasoning_tokens','total_tokens','context_used','context_capacity'])assert.ok(observation[key]===null||(Number.isSafeInteger(observation[key])&&observation[key]>=0),`Invalid native usage ${key}`);}
 console.log(JSON.stringify({phase:'native-usage',provider:real?provider:'ACP fixture',available:usage.length>0,observations:usage,missingCounters:'unknown',historyGap:usagePage.history_gap}));
}

try{
 await launch();let d=(await command({kind:'create',provider,model,effort:null})).detail;const id=d.summary.task.task_id;taskId=id;
 d=await draft(d,real?'Give a detailed explanation of linear regression assumptions, without tools.':'slow old request');
 const sent=await command({kind:'send',control:ctl(d),draft_version:d.draft.version});
 d=await waitFor(()=>get(id),v=>v.summary.task.native_session_id&&v.summary.attachment.state==='running');const native=d.summary.task.native_session_id;
 d=await draft(d,'retained next draft');const oldGeneration=d.summary.attachment.generation,oldOrigin=origin;await stop('SIGKILL');
 await launch();d=await get(id);assert.equal(d.summary.attachment.state,'disconnected');assert.equal(d.summary.task.native_session_id,native);assert.equal(d.draft.content.text,'retained next draft');
 const original=(await query({kind:'receipt',request_id:sent.receipt.request_id})).receipt;assert.equal(original.status,'uncertain');
 const prompts=calls().filter(c=>c.method==='session/prompt').length;const resumed=await command({kind:'resume',control:ctl(d)});await settled(resumed.receipt.request_id);d=await get(id);
 assert.equal(d.summary.task.native_session_id,native);assert.ok(d.summary.attachment.generation>oldGeneration);assert.equal((await query({kind:'receipt',request_id:sent.receipt.request_id})).receipt.status,'uncertain');assert.notEqual(origin,oldOrigin);
 if(!real){assert.equal(calls().filter(c=>c.method==='session/prompt').length,prompts);const opens=calls().filter(c=>c.method==='session/new'||c.method==='session/load');assert.notEqual(opens[0].mcp[0].fingerprint,opens.at(-1).mcp[0].fingerprint);assert.equal(opens.at(-1).mcp[0].url,origin+'/mcp');}
 console.log(JSON.stringify({phase:'host-crash-resume',runtime:real?provider:'ACP fixture',sameNativeId:true,oldReceipt:'uncertain',draftPreserved:true,newHost:true}));
 if(provider!=='deepseek'){
 const asset=await command({kind:'add_asset',control:ctl(d),name:'red-square.png',mime_type:'image/png',data:redPng().toString('base64')});await settled(asset.receipt.request_id);d=await get(id);d.draft.content.assets=d.assets.map(a=>a.asset_id);d=await draft(d,real?'What is the dominant color of the attached image? Reply with one lowercase English color word. Do not use tools.':'image input');
 }else{d=await draft(d,'Reply with exactly fresh. Do not use tools.');}
 const image=await command({kind:'send',control:ctl(d),draft_version:d.draft.version});await settled(image.receipt.request_id);
 const answerOf=async requestId=>{const {page}=await query({kind:'events',task_id:id,after:null,before:null,limit:100});return page.events.filter(e=>e.request_id===requestId&&e.role==='assistant'&&e.text.trim()).at(-1)?.text.trim()||'';};
 const observedAnswer=async requestId=>{try{return await waitFor(()=>answerOf(requestId),value=>!!value,5000);}catch(error){const {page}=await query({kind:'events',task_id:id,after:null,before:null,limit:100});console.log(JSON.stringify({phase:'native-response-observation',provider,matched:page.events.filter(e=>e.request_id===requestId).map(e=>({kind:e.kind,role:e.role,source:e.source,textChars:e.text.length,status:e.status})),historyGap:page.history_gap,hasMore:page.has_more}));throw error;}};
 const answer=await observedAnswer(image.receipt.request_id);assert.equal(answer,provider==='deepseek'?'fresh':real?'red':'Image received');
 console.log(JSON.stringify({phase:provider==='deepseek'?'resumed-new-input':'resumed-multimodal-input',model,reply:answer,passed:true}));
 if(real){
  const previous=(await api('/api/agent-connection')).sessions;const served=new Map(previous.map(s=>[s.connection_id,s.overview_served_at_ms]));
  d=await get(id);d=await draft(d,'Use the configured rho MCP tools to read host.overview. Return only the final directory name of its project_root. Do not use shell, edit files, configure anything, or run R.');
  const read=await command({kind:'send',control:ctl(d),draft_version:d.draft.version});const handled=new Set();
  await waitFor(async()=>{
    const detail=await get(id);
    for(const decision of detail.summary.attachment.decisions){
      const title=provider==='deepseek'?`mcp__rho__rho_host_overview_v1_${createHash('sha256').update('rho\0rho.host.overview.v1').digest('hex').slice(0,12)}`:'mcp__rho__rho_host_overview_v1';
      const option=provider==='deepseek'?'allow-once':'approve_once';assert.equal(decision.title,title,'Unexpected tool request; no permission sent');assert.ok(decision.options.some(o=>o.id===option));
      if(!handled.has(decision.id)){handled.add(decision.id);await command({kind:'decision',control:ctl(detail),decision_id:decision.id,option_id:option});}
    }
    const {receipt}=await query({kind:'receipt',request_id:read.receipt.request_id});if(['failed','uncertain','interrupted'].includes(receipt?.status))throw new Error(safe(receipt.error||receipt.status));return receipt;
  },r=>r?.status==='succeeded');
  const observed=(await api('/api/agent-connection')).sessions.filter(s=>s.overview_served_at_ms&&s.overview_served_at_ms!==served.get(s.connection_id));assert.ok(observed.length>0,'No MCP overview was actually read after Host restart');assert.equal(await observedAnswer(read.receipt.request_id),'study');
  assert.equal((await query({kind:'receipt',request_id:sent.receipt.request_id})).receipt.status,'uncertain');
  console.log(JSON.stringify({phase:'fresh-host-native-mcp',provider,sameNativeId:(await get(id)).summary.task.native_session_id===native,actualReads:observed.length,projectMatches:true,passed:true}));
 }
 await reportUsage();
 assert.deepEqual(hashes(),before);
 console.log(JSON.stringify({phase:'user-configuration',provider:real?provider:'ACP fixture',unchanged:true}));
}catch(e){if(taskId)await reportUsage().catch(()=>console.log(JSON.stringify({phase:'native-usage',provider,available:false,observationUnavailable:true,missingCounters:'unknown'})));console.error(safe(e.stack||e));process.exitCode=1;}finally{await stop('SIGINT');assert.deepEqual(hashes(),before);fs.rmSync(dir,{recursive:true,force:true});}
