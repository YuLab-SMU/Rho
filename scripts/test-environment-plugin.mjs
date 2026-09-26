// Real R in disposable libraries through an independently built ordinary plugin.
// This script never builds or replaces the Host binary and never stops a user Host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import net from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildEnvironmentPlugin} from './build-environment-plugin.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-environment-plugin-')));
const project=path.join(temporary,'project'),materials=path.join(temporary,'materials');
fs.mkdirSync(project);fs.mkdirSync(materials);
const fixture=path.join(root,'crates/host/tests/fixtures/rhonextfixture');
fs.cpSync(fixture,path.join(project,'pkg'),{recursive:true});
const database=path.join(temporary,'host.sqlite');
const binary=process.env.RHO_TEST_BINARY??path.join(root,'target/debug/rho');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalHost=digest(fs.readFileSync(binary));
const rhome=process.env.RHO_R_HOME??execFileSync('Rscript',['--vanilla','-e','cat(R.home())'],{encoding:'utf8'}).trim();
const rscript=fs.realpathSync(path.join(rhome,'bin/Rscript'));
execFileSync(rscript,['--vanilla','-e',"stopifnot(all(vapply(c('pak','renv','ps','jsonlite'),requireNamespace,logical(1),quietly=TRUE)))"],{stdio:'inherit',timeout:30000});
const source=process.env.RHO_ENVIRONMENT_PLUGIN_PACKAGE?fs.realpathSync(process.env.RHO_ENVIRONMENT_PLUGIN_PACKAGE):buildEnvironmentPlugin(path.join(temporary,'package'));
assert.ok(!source.startsWith(root+path.sep),'Use independently assembled source');
assert.equal(digest(fs.readFileSync(binary)),originalHost);
let server,socket,socketClosed;
let host, ready, exited, complete = false, counter = 0;
const pending = new Map();
const trace = (kind, value) => fs.appendFileSync(path.join(temporary, 'session.jsonl'), JSON.stringify({kind,value}) + '\n');
function deadline(promise, label, ms = 180000) {
  let timer;
  return Promise.race([promise, new Promise((_,reject) => {timer=setTimeout(() => reject(new Error(`${label} timed out`)),ms);})]).finally(() => clearTimeout(timer));
}
async function call(method, params) {
  const id = `request-${++counter}`;
  const reply = new Promise((resolve,reject) => pending.set(id,{resolve,reject}));
  host.stdin.write(JSON.stringify({id,request:{method,params}})+'\n');
  const packet = await deadline(reply, `${method} ${id}`);
  assert.equal(packet.ok,true,JSON.stringify(packet));
  return packet.result;
}
async function query(id,args,version=1) {
  const result=await call('query_snapshot',{capability:{id,version},arguments:args});
  assert.equal(result.status,'ready',JSON.stringify(result)); return result.data;
}
const invoke=(id,cap,args,version=1,accepted=false) => call('invoke',{client_request_id:id,capability:{id:cap,version},arguments:args,preconditions:[],return_after_acceptance:accepted});
const succeeded=record => {assert.equal(record.status,'succeeded',JSON.stringify({status:record.status,error:record.error,recovery:record.recovery})); return record;};
const ownerRecovery=record => {assert.equal(record.recovery?.kind,'plugin_owner_recovery',JSON.stringify(record.recovery));return record.recovery.data;};
async function until(read,predicate,label) {
  const start=Date.now();
  for (;;) {const result=await read(); if(predicate(result))return result; assert.ok(Date.now()-start<15000,`${label}: ${JSON.stringify(result)}`); await new Promise(resolve => setTimeout(resolve,25));}
}
async function resource(reference) {
  const chunks=[]; let offset=0;
  for (;;) {
    const chunk=await query('resources.read',{reference,offset,limit:65536});
    assert.deepEqual(chunk.reference,reference); assert.equal(chunk.offset,offset);
    chunks.push(Buffer.from(chunk.base64,'base64'));
    if(chunk.next==null)break; assert.ok(chunk.next>offset); offset=chunk.next;
  }
  const bytes=Buffer.concat(chunks);
  assert.equal(bytes.length,reference.bytes); assert.equal(`sha256:${digest(bytes)}`,reference.digest);
  return JSON.parse(bytes);
}
try {
  execFileSync('python3',[path.join(source,'tests/protocol.py'),path.join(source,'dist/rho-environment-backend')],{cwd:source,stdio:'inherit',timeout:180000});
  const snapshot=JSON.parse(execFileSync(binary,['--database',database,'--project',project,'plugins','snapshot',source,'--target','aarch64-apple-darwin'],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024})).result;
  assert.ok(snapshot.revision&&snapshot.artifacts[0],JSON.stringify(snapshot)); trace('snapshot',snapshot);
  host=spawn(binary,['--database',database,'--project',project,'session'],{stdio:['pipe','pipe','pipe']});
  const handshake=new Promise((resolve,reject) => {ready={resolve,reject};});
  exited=new Promise(resolve => host.once('close',(code,signal) => resolve({code,signal})));
  host.on('error',error => {ready.reject(error); for(const request of pending.values())request.reject(error);});
  host.on('exit',(code,signal) => {const error=new Error(`Owned Host exited ${code}/${signal}`);ready.reject(error);for(const request of pending.values())request.reject(error);});
  host.stderr.on('data',bytes => fs.appendFileSync(path.join(temporary,'host.stderr'),bytes));
  readline.createInterface({input:host.stdout}).on('line',line => {
    try {const packet=JSON.parse(line);trace('reply',packet); if(packet.type==='ready')ready.resolve(packet);
      else {assert.ok(pending.has(packet.id),'Uncorrelated Host reply');pending.get(packet.id).resolve(packet);pending.delete(packet.id);}}
    catch(error){ready.reject(error);for(const request of pending.values())request.reject(error);}
  });
  assert.equal((await deadline(handshake,'Host ready')).protocol_version,1);
  async function activate(id,configuration) {
    return succeeded(await invoke(`activate-${id}`,'plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:'aarch64-apple-darwin',alias:id,configuration})).output.instance.identity;
  }
  const resolve=(instance,id,version=2) => query('plugins.resolve',{instance,capability:{id,version}});

  const disconnected=await activate('disconnected',{});
  const disconnectedStatus=await resolve(disconnected,'environment.status',1);
  assert.equal((await query('environment.status',{binding:disconnectedStatus,arguments:{}})).rscript,null);
  const disabled=await resolve(disconnected,'environment.refresh');
  await assert.rejects(()=>invoke('unconfigured','environment.refresh',{binding:disabled,arguments:{}},2),/configured|configure/i);
  succeeded(await invoke('release-disconnected','plugins.release',{instance:disconnected}));
  const configuration={rscript,storage_root:materials,timeout_seconds:90};
  const identity=await activate('environment',configuration);
  const bindings={};
  for(const id of ['environment.refresh','environment.plan','environment.realize','environment.verify','environment.reconcile','environment.observe'])bindings[id]=await resolve(identity,id);
  const statusBinding=await resolve(identity,'environment.status',1);
  const status=()=>query('environment.status',{binding:statusBinding,arguments:{}});
  assert.equal((await status()).storage_root,materials);
  assert.equal(fs.existsSync(path.join(materials,'recovery')),false,'Activation started native R');
  const observe=()=>query('environment.observe',{binding:bindings['environment.observe'],arguments:{limit:500}},2);
  assert.equal((await observe()).status,'unavailable');
  assert.equal(fs.existsSync(path.join(materials,'recovery')),false,'Query started native R');
  const collision=await invoke('shared-live-storage','plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:'aarch64-apple-darwin',alias:'collision',configuration});
  // The original lifecycle operation stays uncertain after initialization was
  // attempted; inspect the distinct instance state and native ownership refusal.
  assert.equal(collision.status,'uncertain',JSON.stringify({status:collision.status,error:collision.error}));
  assert.equal(collision.recovery.automatic_reexecution,false);
  const rejectedIdentity={...identity,instance:collision.operation.target.identity};
  const rejected=await query('plugins.instance',{instance:rejectedIdentity});
  assert.equal(rejected.instance.state,'failed',JSON.stringify(rejected));
  assert.equal(rejected.process_id,null);
  assert.match(rejected.stderr,/material storage is already owned or unavailable/);
  await assert.rejects(()=>resolve(rejectedIdentity,'environment.plan'),/unavailable|active|failed/i);
  assert.equal((await status()).storage_root,materials);
  const refresh=succeeded(await invoke('refresh','environment.refresh',{binding:bindings['environment.refresh'],arguments:{}},2));
  const before=await resource(refresh.output.report);assert.equal(refresh.output.kind,'configuration');
  assert.equal((await observe()).status,'ready');
  const planArgs={binding:bindings['environment.plan'],arguments:{manager:'pak',packages:['local::pkg']}};
  const planned=succeeded(await invoke('plan','environment.plan',planArgs,2));
  const plan=await resource(planned.output.report);assert.equal(plan.packages[0].name,'rhonextfixture');
  const realizedArgs={binding:bindings['environment.realize'],arguments:{plan_operation_id:planned.operation.operation_id}};
  const realized=succeeded(await invoke('realize','environment.realize',realizedArgs,2));
  const receipt=await resource(realized.output.report);assert.equal(receipt.verified,true);assert.equal(realized.output.verified,true);
  assert.ok(receipt.library_path.startsWith(materials+path.sep));assert.equal(receipt.activation,'available_not_active');
  const replay=succeeded(await invoke('realize','environment.realize',realizedArgs,2));assert.deepEqual(replay,realized);
  const verification=succeeded(await invoke('verify','environment.verify',{binding:bindings['environment.verify'],arguments:{realization_operation_id:realized.operation.operation_id}},2));
  assert.equal((await resource(verification.output.report)).verified,true);
  const inventory=await query('environment.observe',{binding:bindings['environment.observe'],arguments:{realization_operation_id:realized.operation.operation_id}},2);
  assert.equal(inventory.status,'ready');assert.equal(inventory.observation.packages[0].name,'rhonextfixture');
  const renvLock=path.join(project,'renv.lock');fs.copyFileSync(receipt.renv_lockfile,renvLock);const lockBytes=fs.readFileSync(renvLock);
  const renv=succeeded(await invoke('renv-plan','environment.plan',{binding:bindings['environment.plan'],arguments:{manager:'renv',lockfile:'renv.lock'}},2));
  succeeded(await invoke('renv-realize','environment.realize',{binding:bindings['environment.realize'],arguments:{plan_operation_id:renv.operation.operation_id}},2));
  assert.deepEqual(fs.readFileSync(renvLock),lockBytes);
  await assert.rejects(()=>invoke('wrong-source','environment.realize',{binding:bindings['environment.realize'],arguments:{plan_operation_id:realized.operation.operation_id}},2),/source|operation|report/i);
  const description=path.join(receipt.library_path,'rhonextfixture/DESCRIPTION');const originalDescription=fs.readFileSync(description);
  fs.writeFileSync(description,Buffer.concat([originalDescription,Buffer.from('\nTampered: yes\n')]));
  const tampered=await invoke('tampered','environment.verify',{binding:bindings['environment.verify'],arguments:{realization_operation_id:realized.operation.operation_id}},2);
  assert.equal(tampered.status,'failed');assert.equal(tampered.output.verified,false);assert.equal((await resource(tampered.output.report)).library_digest_matches,false);
  fs.writeFileSync(description,originalDescription);
  // Signal from an actual descendant namespace loader before requesting cancel.
  server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const started=new Promise(resolve=>server.once('connection',connection=>{
    socket=connection;socket.on('error',()=>{});socketClosed=new Promise(done=>socket.once('close',done));
    let text='';socket.on('data',bytes=>{text+=bytes.toString();if(text.includes('\n'))resolve(text.split('\n')[0]);});
  }));
  fs.cpSync(fixture,path.join(project,'slowpkg'),{recursive:true});
  fs.writeFileSync(path.join(project,'slowpkg/R/load.R'),`.onLoad <- function(libname,pkgname) {
    con <- socketConnection('127.0.0.1',port=${server.address().port},open='w',blocking=TRUE)
    writeLines(Sys.getenv('RHO_OPERATION_ID'),con); flush(con); Sys.sleep(90); close(con)
  }\n`);
  const slowPlan=succeeded(await invoke('slow-plan','environment.plan',{binding:bindings['environment.plan'],arguments:{manager:'pak',packages:['local::slowpkg']}},2));
  const slowArgs={binding:bindings['environment.realize'],arguments:{plan_operation_id:slowPlan.operation.operation_id}};
  const accepted=await invoke('slow-realize','environment.realize',slowArgs,2,true);
  assert.equal(await deadline(started,'Native installer readiness',45000),accepted.operation.operation_id);
  const requested=await call('request_cancellation',{operation_id:accepted.operation.operation_id});assert.equal(requested.accepted,true);
  const cancelled=await until(()=>call('get_operation',{operation_id:accepted.operation.operation_id}),value=>['succeeded','failed','cancelled','uncertain'].includes(value.status),'Native installer cancellation');
  assert.equal(cancelled.status,'cancelled',JSON.stringify(cancelled));assert.equal(cancelled.cancellation_requested,true);
  const recovery=ownerRecovery(cancelled);assert.equal(recovery.automatic_reexecution,false);
  const nativeRecovery=await resource(recovery.native_recovery);assert.equal(nativeRecovery.runtime.tree_cleanup_confirmed,true);assert.ok(fs.statSync(nativeRecovery.stage).isDirectory());
  await deadline(socketClosed,'Cancelled installer exit',5000);socket.destroy();server.close();server=null;
  assert.deepEqual(await invoke('slow-realize','environment.realize',slowArgs,2),cancelled);
  const after=(await observe()).observation;assert.deepEqual(after.packages,before.packages);assert.deepEqual(after.library_paths,before.library_paths);
  await until(status,value=>value.activities.length===0,'Original settlements');
  succeeded(await invoke('release-original','plugins.release',{instance:identity}));
  const replacement=await activate('replacement',configuration);
  const replacementRealize=await resolve(replacement,'environment.realize');
  const fromOriginal=succeeded(await invoke('replacement-realize','environment.realize',{binding:replacementRealize,arguments:{plan_operation_id:planned.operation.operation_id}},2));
  const qualified=fromOriginal.operation.admission.owner_context.qualification.source;
  assert.equal(qualified.operation,planned.operation.operation_id);assert.deepEqual(qualified.binding.provider,identity);
  assert.notEqual(fromOriginal.output.report.owner.instance,identity.instance);assert.equal((await resource(fromOriginal.output.report)).verified,true);
  const reconcile=await resolve(replacement,'environment.reconcile');
  const reconciled=succeeded(await invoke('replacement-reconcile','environment.reconcile',{binding:reconcile,arguments:{operation_id:cancelled.operation.operation_id}},2));
  assert.equal((await resource(reconciled.output.report)).cleanup_confirmed,true);
  assert.deepEqual(await call('get_operation',{operation_id:cancelled.operation.operation_id}),cancelled);
  const replacementStatus=await resolve(replacement,'environment.status',1);
  await until(()=>query('environment.status',{binding:replacementStatus,arguments:{}}),value=>value.activities.length===0,'Replacement settlements');
  succeeded(await invoke('release-replacement','plugins.release',{instance:replacement}));
  assert.deepEqual(await resource(planned.output.report),plan);assert.deepEqual(await resource(realized.output.report),receipt);
  assert.deepEqual(await invoke('plan','environment.plan',planArgs,2),planned);
  host.stdin.end();assert.equal((await deadline(exited,'Host shutdown',15000)).code,0);
  assert.equal(digest(fs.readFileSync(binary)),originalHost);complete=true;
  console.log(`Independent Environment package passed disconnected/query purity, material-owner exclusion, real pak/renv, resource reports, verified inventory, original idempotency, native cancellation, previous-instance resource reads, replacement recovery and retained results. Unchanged Host SHA256 ${originalHost}`);
} finally {
  if(host&&host.exitCode===null&&host.signalCode===null){host.stdin.end();host.kill('SIGTERM');await deadline(exited,'Owned Host cleanup',15000);}
  const recoveryRoot=path.join(materials,'recovery');
  if(fs.existsSync(recoveryRoot))for(const file of fs.readdirSync(recoveryRoot)) {
    if(!file.endsWith('.json'))continue;
    const material=JSON.parse(fs.readFileSync(path.join(recoveryRoot,file),'utf8'));
    if(material.project_root!==project)continue;
    const cleanup=spawnSync(rscript,['--vanilla','-e','ps::ps_kill_tree(commandArgs(TRUE)[[1L]])',material.marker],{timeout:10000,stdio:'ignore'});
    assert.equal(cleanup.status,0,'Test-owned native cleanup failed');
  }
  socket?.destroy();server?.close();
  if(complete)fs.rmSync(temporary,{recursive:true,force:true});else console.error(`Environment Host acceptance evidence retained at ${temporary}`);
}
