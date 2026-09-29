/** Native code-tool acceptance through ordinary packages and an unchanged Host. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),binary=path.join(root,'target/debug/rho');
assert.ok(process.env.RHO_ARK&&process.env.RHO_R_HOME,'Select existing Ark and R paths; only disposable native sessions are tested.');
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex'),originalHost=digest(fs.readFileSync(binary));
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-r-format-'))),project=path.join(directory,'project');fs.mkdirSync(project);
let host,url,completed=false;
async function port(method,params){
  const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json'},
    body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})});
  const reply=await response.json();if(!reply.ok)throw new Error(reply.error);return reply.result;
}
const query=async(id,args)=>(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;
const request=(id,args,client_request_id=crypto.randomUUID())=>({capability:{id,version:1},arguments:args,preconditions:[],client_request_id});
async function invoke(id,args){const record=await port('invoke',request(id,args));assert.equal(record.status,'succeeded',JSON.stringify(record.error));return record.output;}
const binding=(instance,id)=>query('plugins.resolve',{instance,capability:{id,version:1}});
async function native(instance,id,args){return query(id,{binding:await binding(instance,id),arguments:args});}
async function control(instance,id,args){return port('control',{capability:{id,version:1},arguments:{binding:{...await binding(instance,id),target:args.session_id},arguments:args}});}
async function until(read,predicate){
  const deadline=Date.now()+30000;
  for(;;){const value=await read();if(predicate(value))return value;if(Date.now()>deadline)throw new Error('Native observation did not reach the expected phase within 30 seconds.');await new Promise(done=>setTimeout(done,40));}
}
async function retained(reference){
  const chunks=[];let offset=0;
  do{
    const part=await query('resources.read',{reference,offset,limit:65536}),bytes=Buffer.from(part.base64,'base64');
    assert.deepEqual(part.reference,reference);assert.equal(part.offset,offset);assert.equal(bytes.length,Math.min(65536,reference.bytes-offset));
    chunks.push(bytes);offset+=bytes.length;assert.equal(part.next,offset===reference.bytes?null:offset);
  }while(offset<reference.bytes);
  const bytes=Buffer.concat(chunks);assert.equal(digest(bytes),reference.digest);return JSON.parse(bytes.toString('utf8'));
}
try{
  const source=process.env.RHO_R_PLUGIN_PACKAGE??path.join(directory,'package');
  if(!process.env.RHO_R_PLUGIN_PACKAGE)execFileSync(process.execPath,[path.join(root,'scripts/build-r-plugin.mjs'),source,'--independent'],{cwd:root,stdio:'inherit'});
  assert.equal(digest(fs.readFileSync(binary)),originalHost,'Independent package build must leave the Host unchanged.');
  const database=path.join(directory,'state.sqlite');
  const snapshot=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',source,'--target','aarch64-apple-darwin'],{encoding:'utf8'})).result;
  host=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
  url=new URL(await new Promise((done,reject)=>{
    let output='',errors='';const timer=setTimeout(()=>reject(new Error(`Disposable formatting Host startup timed out: ${errors}`)),90000);
    host.stderr.on('data',chunk=>errors+=chunk);host.stdout.on('data',chunk=>{output+=chunk;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});
    host.once('exit',code=>{clearTimeout(timer);reject(new Error(`Disposable formatting Host exited ${code}: ${errors}`));});
  }));
  const instance=(await invoke('plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:'aarch64-apple-darwin',alias:'formatter',
    configuration:{ark:fs.realpathSync(process.env.RHO_ARK),r_home:fs.realpathSync(process.env.RHO_R_HOME),execution_timeout_seconds:30}})).instance.identity;
  const originalSession=await native(instance,'r.session',{});assert.equal(originalSession.state,'unstarted');
  await assert.rejects(port('invoke',request('r.format',{binding:await binding(instance,'r.format'),arguments:{expected_session:'absent',code:'a=1'}})),/session/i);
  assert.equal((await native(instance,'r.session',{})).state,'unstarted','Reading and preflight cannot create R.');
  const session=(await invoke('r.create_session',{binding:await binding(instance,'r.create_session'),arguments:{}})).session_id;
  const run=async code=>invoke('r.execute',{binding:await binding(instance,'r.execute'),arguments:{expected_session:session,code}});
  const before=await run('list(objects=ls(.GlobalEnv, all.names=TRUE), cache=getOption("styler.cache_name"), quiet=getOption("styler.quiet"))');
  const sourceLabel={view_id:'editor-document',label:'分析.R',kind:'format'},formatBinding=await binding(instance,'r.format');
  const args={binding:formatBinding,arguments:{expected_session:session,code:'format_should_not_exist=42',source:sourceLabel}},original=request('r.format',args);
  const record=await port('invoke',original);assert.equal(record.status,'succeeded',JSON.stringify(record.error));
  const output=record.output;assert.equal(output.operation_id,record.operation.operation_id);assert.equal(output.session_id,session);
  assert.deepEqual(output.source,sourceLabel);assert.equal(output.output_mode,null);assert.equal(output.value.code,'format_should_not_exist <- 42');
  assert.equal(output.value.changed,true);assert.ok(output.value.tool_version);assert.equal(output.value_in_report,false);
  assert.deepEqual(output.report.owner,instance);
  assert.equal((await retained(output.report)).value.code,output.value.code);
  const repeated=await port('invoke',original);assert.equal(repeated.operation.operation_id,record.operation.operation_id);
  const empty=await invoke('r.format',{binding:formatBinding,arguments:{expected_session:session,code:''}});
  assert.equal(empty.value.code,'');assert.equal(empty.value.changed,false);
  const after=await run('list(objects=ls(.GlobalEnv, all.names=TRUE), cache=getOption("styler.cache_name"), quiet=getOption("styler.quiet"))');
  assert.deepEqual(after.value,before.value,'Formatting must not evaluate the input or retain its temporary options.');
  const execution={id:'r.execute',version:2},executionSource={...sourceLabel,kind:'selection'};
  const versioned=await port('invoke',{...request('r.execute',{binding:await query('plugins.resolve',{instance,capability:execution}),
    arguments:{expected_session:session,run:{code:'1 + 1',output_mode:'console',source:executionSource}}}),capability:execution});
  assert.equal(versioned.status,'succeeded');assert.equal(versioned.output.value,null);assert.match(versioned.output.stdout,/\[1\] 2/);
  assert.deepEqual(versioned.output.source,executionSource);assert.equal(versioned.output.output_mode,'console');
  const sentinel=path.join(project,'format-must-not-write.txt');fs.writeFileSync(sentinel,'original bytes\n');
  await invoke('r.format',{binding:formatBinding,arguments:{expected_session:session,code:'writeLines("changed", "format-must-not-write.txt")'}});
  assert.equal(fs.readFileSync(sentinel,'utf8'),'original bytes\n','Formatting must not execute file-writing code.');
  await assert.rejects(port('invoke',request('r.format',{binding:formatBinding,arguments:{expected_session:'another-session',code:'x=1'}})),/session/i);
  await assert.rejects(port('invoke',request('r.format',{binding:formatBinding,arguments:{expected_session:session,code:'中'.repeat(21846)}})),/65536|64 KiB/);
  const large=('# '+ 'comment 中文 '.repeat(30).trimEnd()+'\n').repeat(90);
  assert.ok(Buffer.byteLength(large)>32768&&Buffer.byteLength(large)<65536);
  const longOutput=await invoke('r.format',{binding:formatBinding,arguments:{expected_session:session,code:large,source:sourceLabel}});
  assert.equal(longOutput.value_in_report,true);assert.equal(longOutput.value,null);
  const full=await retained(longOutput.report);assert.ok(Buffer.byteLength(full.value.code)>32768);assert.equal(full.value.code,large.trimEnd());
  const failed=await port('invoke',request('r.format',{binding:formatBinding,arguments:{expected_session:session,code:'x <- ('}}));
  assert.equal(failed.status,'failed');assert.ok(failed.output.report);assert.ok((await retained(failed.output.report)).error);
  const settled=await until(()=>native(instance,'r.console',{expected_session:session}),value=>value.awaiting_commit.length===0);
  await control(instance,'r.pause_queue',{session_id:session,pause_id:settled.console.pause?.id??null});
  const pending=await port('invoke',{...request('r.format',{binding:formatBinding,arguments:{expected_session:session,code:'never_evaluate=99'}}),return_after_acceptance:true});
  await until(()=>native(instance,'r.console',{expected_session:session}),value=>value.console.pending.some(item=>item.operation_id===pending.operation.operation_id));
  await port('request_cancellation',{operation_id:pending.operation.operation_id,only_if_pending:true});
  const cancelled=await until(()=>port('get_operation',{operation_id:pending.operation.operation_id}),value=>value.status==='cancelled');
  assert.equal(cancelled.output.started,false);
  const paused=await until(()=>native(instance,'r.console',{expected_session:session}),value=>value.awaiting_commit.length===0);
  await control(instance,'r.resume_queue',{session_id:session,pause_id:paused.console.pause.id,only_operation_ids:[failed.operation.operation_id,pending.operation.operation_id]});
  assert.equal((await run('exists("never_evaluate", envir=.GlobalEnv, inherits=FALSE)')).value,false);
  await invoke('plugins.release',{instance});
  assert.equal((await port('get_operation',{operation_id:record.operation.operation_id})).output.value.code,output.value.code);
  assert.equal((await retained(output.report)).value.code,output.value.code);
  assert.equal(digest(fs.readFileSync(binary)),originalHost);
  console.log(`Native formatting passed: explicit existing session, no input evaluation/file writes, original replay, exact retained large result, syntax failure and pending cancellation. Unchanged Host: ${originalHost}`);
  completed=true;
}finally{
  if(host?.exitCode===null){host.kill('SIGINT');await new Promise(done=>host.once('exit',done));}
  if(completed)fs.rmSync(directory,{recursive:true,force:true});else console.error(`Incomplete native formatting evidence retained at ${directory}`);
}
