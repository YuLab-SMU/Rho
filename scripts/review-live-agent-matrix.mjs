// Recheck retained model evidence through public ports. No model requests or R
// startup: only the exact Agent instance is explicitly resumed in its test Host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';

const [source,destination]=process.argv.slice(2);
assert.ok(source&&destination&&source!==destination,'Use source report and distinct review report');
const report=JSON.parse(fs.readFileSync(source));
const binary=process.env.RHO_TEST_BINARY;assert.ok(binary,'Select the original frozen Host');
assert.equal('sha256:'+createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),report.host_sha256);
const root=report.directory;
assert.ok(root&&fs.existsSync(path.join(root,'host.sqlite')),'Retained fixture is unavailable');
const child=spawn(binary,['--database',path.join(root,'host.sqlite'),'--project',path.join(root,'project'),'session'],{stdio:['pipe','pipe','pipe']});
const ended=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const pending=new Map();let readyResolve;
const ready=new Promise(resolve=>readyResolve=resolve);
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{const reply=JSON.parse(line);if(reply.type==='ready'){readyResolve();return;}const item=pending.get(reply.id);if(item){pending.delete(reply.id);reply.ok?item.resolve(reply.result):item.reject(Error(reply.error));}});
child.stderr.on('data',bytes=>fs.appendFileSync(destination+'.stderr.log',bytes));
child.on('exit',()=>{for(const item of pending.values())item.reject(Error('Review Host exited'));pending.clear();});
async function deadline(work,label,ms=60000){let timer;return Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} timed out`)),ms);})]).finally(()=>clearTimeout(timer));}
async function port(method,params){const id=randomUUID();const reply=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));child.stdin.write(JSON.stringify({id,request:{method,params}})+'\n');return deadline(reply,method);}
const key=id=>({id,version:1});
async function query(id,args){const value=await port('query_snapshot',{capability:key(id),arguments:args});assert.equal(value.status,'ready');assert.equal(value.completeness,'complete');return value.data;}
async function invoke(id,args){let value=await port('invoke',{capability:key(id),arguments:args,preconditions:[],client_request_id:randomUUID()});const end=Date.now()+60000;while(!['succeeded','failed','cancelled','uncertain'].includes(value.status)){assert.ok(Date.now()<end);value=await port('get_operation',{operation_id:value.operation.operation_id});}assert.equal(value.status,'succeeded',JSON.stringify(value.error));return value;}
const save=()=>fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
try{
  await deadline(ready,'Review Host startup');
  const attempts=report.live_provider.matrix.attempts;
  const first=await port('get_operation',{operation_id:attempts.find(item=>item.operation).operation});
  const agent=first.operation.normalized_arguments.binding.provider;
  const prior=await query('plugins.instance',{instance:agent});assert.equal(prior.instance.state,'suspended');
  const resumed=await invoke('plugins.resume',{instance:agent,suspension:prior.instance.suspension});assert.deepEqual(resumed.output.instance.identity,agent);
  const agentQuery=async(id,args)=>query(id,{binding:await query('plugins.resolve',{instance:agent,capability:key(id)}),arguments:args});
  report.retained_review={source,scope:'Recheck six completed Environment/Workspace runs; no new model/R call',completed:false,checked:[]};save();
  for(const attempt of attempts.filter(item=>['environment','workspace'].includes(item.id)&&item.run)){
    const record=await port('get_operation',{operation_id:attempt.operation});assert.equal(record.status,'succeeded');
    const run=await agentQuery('agent.model.run.get',{run_id:attempt.run});assert.deepEqual(run,record.output);assert.equal(run.state,'completed');
    assert.deepEqual(run.context?.sources??[],[]);assert.deepEqual(run.request.sources,[]);
    let after=0,answer='';for(let page=0;after<run.event_cursor&&page<10;page++){const events=await agentQuery('agent.model.run.events',{run_id:run.run_id,after,limit:100});assert.equal(events.history_gap,false);assert.ok(events.cursor>after);answer+=events.events.filter(event=>event.content.kind==='text').map(event=>event.content.text).join('');after=events.cursor;}
    assert.equal(after,run.event_cursor);
    const tools=await agentQuery('agent.model.run.tools',{run_id:run.run_id});
    const effects=tools.filter(item=>item.capability==='r.execute');assert.equal(effects.length,attempt.id==='workspace'?1:0);
    const binding=record.operation.normalized_arguments.arguments.r;
    assert.ok(answer.includes(attempt.id==='workspace'?'43':binding.target));
    for(const tool of effects){assert.equal(tool.phase,'resolved');const native=await port('get_operation',{operation_id:tool.operation_id});assert.equal(native.status,'succeeded');assert.equal(native.operation.causation_id,attempt.operation);assert.deepEqual(native.operation.normalized_arguments.binding,binding);assert.equal(native.output.session_id,binding.target);attempt.native_operation=native;}
    // Wire text is independently retained by the transparent forwarding fixture.
    const text=report.live_provider.wire.map(call=>call.text).join('');assert.ok(text.includes(answer));
    attempt.original_status=attempt.status;attempt.original_reason=attempt.reason;attempt.status='passed';attempt.reason=null;attempt.answer=answer;attempt.tools=tools;attempt.rechecked_without_model_or_r=true;
    report.retained_review.checked.push({id:attempt.id,repetition:attempt.repetition,operation:attempt.operation});save();
  }
  assert.equal(report.retained_review.checked.length,6,'All three Environment and Workspace repetitions must be retained');
  const matrix=report.live_provider.matrix;matrix.passed=attempts.filter(item=>item.status==='passed').length;matrix.failed=attempts.filter(item=>item.status==='failed').length;
  report.retained_review.completed=true;save();
}finally{child.stdin.end();assert.equal((await deadline(ended,'Review Host drain')).code,0);lines.close();}
console.log(JSON.stringify({review:destination,checked:report.retained_review?.checked.length}));
