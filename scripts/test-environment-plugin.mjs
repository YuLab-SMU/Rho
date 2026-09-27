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
import {recoveryFaultPackage} from './fixtures/r-recovery-fault.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const checkpointReferences=process.argv.includes('--checkpoint-references');
const rReferences=process.argv.includes('--r-references')||checkpointReferences;
assert.ok(process.argv.slice(2).every(arg=>['--r-references','--checkpoint-references'].includes(arg)));
if(checkpointReferences)assert.ok(process.env.RHO_CHECKPOINT_HELPER,'Checkpoint reference acceptance requires an existing verified helper.');
const checkpointGrants=['plugins.instance','operation.get','operation.list_recent','resources.read','operation.project_coverage'].map(id=>({id,version:1}));
if(rReferences)assert.ok(process.env.RHO_R_PLUGIN_PACKAGE&&process.env.RHO_ARK,'R reference acceptance requires an independent R package and installed Ark.');
const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-environment-plugin-')));
const project=path.join(temporary,'project'),materials=path.join(temporary,'materials');
fs.mkdirSync(project);fs.mkdirSync(materials);
const fixture=path.join(root,'crates/host/tests/fixtures/rhonextfixture');
fs.cpSync(fixture,path.join(project,'pkg'),{recursive:true});
const database=path.join(temporary,'host.sqlite');
const binary=process.env.RHO_TEST_BINARY??path.join(root,'target/debug/rho');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalHost=digest(fs.readFileSync(binary));
const rhome=fs.realpathSync(process.env.RHO_R_HOME??execFileSync('Rscript',['--vanilla','-e','cat(R.home())'],{encoding:'utf8'}).trim());
const rscript=fs.realpathSync(path.join(rhome,'bin/Rscript'));
execFileSync(rscript,['--vanilla','-e',"stopifnot(all(vapply(c('pak','renv','ps','jsonlite'),requireNamespace,logical(1),quietly=TRUE)))"],{stdio:'inherit',timeout:30000});
const source=process.env.RHO_ENVIRONMENT_PLUGIN_PACKAGE?fs.realpathSync(process.env.RHO_ENVIRONMENT_PLUGIN_PACKAGE):buildEnvironmentPlugin(path.join(temporary,'package'));
assert.ok(!source.startsWith(root+path.sep),'Use independently assembled source');
assert.equal(digest(fs.readFileSync(binary)),originalHost);
let server,socket,socketClosed;
let host, ready, exited, complete = false, counter = 0;
let rIdentity,rSession,observerIdentity,otherReader,faultController,captureProvider;
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
  const rRevision=rReferences?JSON.parse(execFileSync(binary,['--database',database,'--project',project,'plugins','snapshot',fs.realpathSync(process.env.RHO_R_PLUGIN_PACKAGE),'--target','aarch64-apple-darwin'],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024})).result:null;
  const faultRevision=checkpointReferences?JSON.parse(execFileSync(binary,['--database',database,'--project',project,'plugins','snapshot',recoveryFaultPackage(fs.realpathSync(process.env.RHO_R_PLUGIN_PACKAGE),path.join(temporary,'r-control-fault')),'--target','aarch64-apple-darwin'],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024})).result:null;
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
  const materialGrants=['operation.project_coverage','plugins.project_coverage','operation.list_recent','operation.events_checkpoint','plugins.instances','plugins.inspect'].map(id=>({id,version:1}));
  async function activate(id,configuration,optional_capabilities=[]) {
    return succeeded(await invoke(`activate-${id}`,'plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:'aarch64-apple-darwin',alias:id,configuration,optional_capabilities})).output.instance.identity;
  }
  const resolve=(instance,id,version=2) => query('plugins.resolve',{instance,capability:{id,version}});
  const rIdle=async(instance,session)=>{
    const binding=await resolve(instance,'r.inspection_state',1);
    await until(()=>query('r.inspection_state',{binding,arguments:{expected_session:session}}),value=>value.status==='ready','R settlement and native idle state');
  };

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
  await until(status,value=>value.activities.length===0,'Cancelled material settlement');
  const retainedBinding=await resolve(identity,'environment.retention');
  const noGrant=await query('environment.retention',{binding:retainedBinding,arguments:{operation_id:cancelled.operation.operation_id}},2);
  assert.equal(noGrant.can_quarantine,false);assert.match(noGrant.retained_reasons.join(' '),/grant|selected/i);
  assert.ok(fs.statSync(nativeRecovery.stage).isDirectory(),'Missing grants must retain original files');
  const after=(await observe()).observation;assert.deepEqual(after.packages,before.packages);assert.deepEqual(after.library_paths,before.library_paths);
  await until(status,value=>value.activities.length===0,'Original settlements');
  succeeded(await invoke('release-original','plugins.release',{instance:identity}));
  if(rReferences){
    rIdentity=succeeded(await invoke('activate-r','plugins.activate',{revision:rRevision.revision,artifact:rRevision.artifacts[0],target:'aarch64-apple-darwin',alias:'material-r',configuration:{ark:fs.realpathSync(process.env.RHO_ARK),r_home:rhome,execution_timeout_seconds:60,...(checkpointReferences?{checkpoint_helper_path:fs.realpathSync(process.env.RHO_CHECKPOINT_HELPER)}:{})},optional_capabilities:checkpointReferences?checkpointGrants:[]})).output.instance.identity;
    materialGrants.push({id:'r.session',version:1},{id:'r.snapshot',version:1});
    if(checkpointReferences)materialGrants.push({id:'r.checkpoint',version:1},{id:'r.checkpoint_control',version:1},{id:'r.capture_attempt',version:1});
    rSession=succeeded(await invoke('create-r','r.create_session',{binding:await resolve(rIdentity,'r.create_session',1),arguments:{}})).output.session_id;
    observerIdentity=succeeded(await invoke('activate-observer-r','plugins.activate',{revision:rRevision.revision,artifact:rRevision.artifacts[0],target:'aarch64-apple-darwin',alias:'observer-r',configuration:{ark:fs.realpathSync(process.env.RHO_ARK),r_home:rhome,execution_timeout_seconds:60,...(checkpointReferences?{checkpoint_helper_path:fs.realpathSync(process.env.RHO_CHECKPOINT_HELPER)}:{})},optional_capabilities:checkpointReferences?checkpointGrants:[]})).output.instance.identity;
    const observerSession=succeeded(await invoke('create-observer-r','r.create_session',{binding:await resolve(observerIdentity,'r.create_session',1),arguments:{}})).output.session_id;
    await rIdle(rIdentity,rSession);await rIdle(observerIdentity,observerSession);
    // Put the protected session last so the scan must visit every R provider.
    if(rIdentity.instance<observerIdentity.instance){[rIdentity,observerIdentity]=[observerIdentity,rIdentity];rSession=observerSession;}
  }
  let replacement=await activate('replacement',configuration,materialGrants);
  const replacementRealize=await resolve(replacement,'environment.realize');
  const fromOriginal=succeeded(await invoke('replacement-realize','environment.realize',{binding:replacementRealize,arguments:{plan_operation_id:planned.operation.operation_id}},2));
  const qualified=fromOriginal.operation.admission.owner_context.qualification.source;
  assert.equal(qualified.operation,planned.operation.operation_id);assert.deepEqual(qualified.binding.provider,identity);
  assert.notEqual(fromOriginal.output.report.owner.instance,identity.instance);assert.equal((await resource(fromOriginal.output.report)).verified,true);
  const reconcile=await resolve(replacement,'environment.reconcile');
  const reconciled=succeeded(await invoke('replacement-reconcile','environment.reconcile',{binding:reconcile,arguments:{operation_id:cancelled.operation.operation_id}},2));
  assert.equal((await resource(reconciled.output.report)).cleanup_confirmed,true);
  assert.deepEqual(await call('get_operation',{operation_id:cancelled.operation.operation_id}),cancelled);
  let replacementStatus=await resolve(replacement,'environment.status',1);
  await until(()=>query('environment.status',{binding:replacementStatus,arguments:{}}),value=>value.activities.length===0,'Replacement settlements');
  const materialBinding={};
  for(const id of ['retention','cleanup_status','cleanup','restore_cleanup','purge_cleanup'])materialBinding[id]=await resolve(replacement,`environment.${id}`);
  const materialQuery=(id,arguments_)=>query(`environment.${id}`,{binding:materialBinding[id],arguments:arguments_},2);
  const materialInvoke=async(id,action,arguments_)=>{
    const value=await invoke(id,`environment.${action}`,{binding:materialBinding[action],arguments:arguments_},2);
    await until(()=>query('environment.status',{binding:replacementStatus,arguments:{}}),state=>state.activities.length===0,'Material settlement');
    return value;
  };
  const successfulMaterial=await materialQuery('retention',{operation_id:realized.operation.operation_id});
  assert.equal(successfulMaterial.can_quarantine,false);assert.match(successfulMaterial.retained_reasons.join(' '),/Successful outputs/);
  let eligible=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});
  assert.equal(eligible.can_quarantine,true,JSON.stringify(eligible));assert.equal(eligible.material.stage.path,nativeRecovery.stage);
  if(rReferences){
    const candidate=path.join(nativeRecovery.stage,'reference-library');fs.mkdirSync(candidate);
    fs.cpSync(path.join(receipt.library_path,'rhonextfixture'),path.join(candidate,'rhonextfixture'),{recursive:true});
    const rBinding=await resolve(rIdentity,'r.execute',1);
    const run=async(id,code)=>{const result=succeeded(await invoke(id,'r.execute',{binding:rBinding,arguments:{expected_session:rSession,code}}));await rIdle(rIdentity,rSession);return result;};
    // Put the original successful plans beyond the first reference page.
    for(let page=0;page<12;page++)await run(`reference-history-${page}`,'invisible(NULL)');
    assert.ok(Number.isSafeInteger((await query('operation.list_recent',{limit:32})).next_cursor),'Exercise continuation to older original references');
    await run('reference-library',`original_paths <- .libPaths(); .libPaths(c(${JSON.stringify(candidate)}, original_paths)); stopifnot(${JSON.stringify(candidate)} %in% .libPaths()); TRUE`);
    const libraryUse=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});
    assert.equal(libraryUse.can_quarantine,false);assert.match(libraryUse.retained_reasons.join(' '),/still references/);
    await run('reference-namespace',`loadNamespace('rhonextfixture',lib.loc=${JSON.stringify(candidate)}); .libPaths(original_paths); stopifnot(!${JSON.stringify(candidate)} %in% .libPaths()); TRUE`);
    const namespaceUse=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});
    assert.equal(namespaceUse.can_quarantine,false);assert.match(namespaceUse.retained_reasons.join(' '),/still references/);
    await assert.rejects(()=>materialInvoke('namespace-quarantine','cleanup',{operation_id:cancelled.operation.operation_id,expected_fingerprint:namespaceUse.material.stage.fingerprint}),/still references/);
    let checkpoint;
    if(checkpointReferences){
      checkpoint=succeeded(await invoke('reference-checkpoint','r.capture_checkpoint',{binding:await resolve(rIdentity,'r.capture_checkpoint',1),arguments:{expected_session:rSession,include_names:['original_paths'],max_seconds:10}})).output;
      await rIdle(rIdentity,rSession);
      const manifest=await resource(checkpoint.manifest);assert.equal(manifest.libraries.complete,true);assert.ok(manifest.libraries.namespace_paths.includes(path.join(candidate,'rhonextfixture')));
    }
    await run('release-namespace',"unloadNamespace('rhonextfixture'); TRUE");
    const unused=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(unused.can_quarantine,!checkpointReferences,JSON.stringify(unused));
    if(checkpointReferences)assert.match(unused.retained_reasons.join(' '),/still references/);
    succeeded(await invoke('release-material-r','plugins.release',{instance:rIdentity}));rIdentity=null;
    succeeded(await invoke('release-observer-r','plugins.release',{instance:observerIdentity}));observerIdentity=null;
    if(checkpointReferences){
      const absent=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(absent.can_quarantine,false);assert.match(absent.retained_reasons.join(' '),/No active R checkpoint reader/);
      observerIdentity=succeeded(await invoke('activate-checkpoint-reader','plugins.activate',{revision:rRevision.revision,artifact:rRevision.artifacts[0],target:'aarch64-apple-darwin',alias:'checkpoint-reader',configuration:{},optional_capabilities:checkpointGrants})).output.instance.identity;
      const retained=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(retained.can_quarantine,false);assert.match(retained.retained_reasons.join(' '),/still references/);
      const readSession=()=>resolve(observerIdentity,'r.session',1).then(binding=>query('r.session',{binding,arguments:{}}));
      assert.equal((await readSession()).state,'unstarted');
      otherReader=succeeded(await invoke('activate-other-reader','plugins.activate',{revision:rRevision.revision,artifact:rRevision.artifacts[0],target:'aarch64-apple-darwin',alias:'other-reader',configuration:{},optional_capabilities:checkpointGrants})).output.instance.identity;
      const ambiguous=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(ambiguous.can_quarantine,false);assert.match(ambiguous.retained_reasons.join(' '),/Multiple R checkpoint readers/);
      succeeded(await invoke('release-unselected-environment','plugins.release',{instance:replacement}));
      replacement=await activate('selected-reader',{...configuration,checkpoint_reader:observerIdentity},materialGrants);
      replacementStatus=await resolve(replacement,'environment.status',1);
      for(const id of Object.keys(materialBinding))materialBinding[id]=await resolve(replacement,`environment.${id}`);
      const selected=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(selected.can_quarantine,false);assert.match(selected.retained_reasons.join(' '),/still references/);
      const reference=checkpoint.reference;
      const control=async(id,name,args,version=1,instance=observerIdentity)=>{
        const result=await invoke(id,name,{binding:await resolve(instance,name,version),arguments:args},version);
        const session=await query('r.session',{binding:await resolve(instance,'r.session',1),arguments:{}}),binding=await resolve(instance,'r.console',1);
        const settled=await until(()=>query('r.console',{binding,arguments:{expected_session:session.queue_target}}),state=>state.awaiting_commit.length===0,'Checkpoint control settlement');
        if(settled.console.pause)await call('control',{capability:{id:'r.resume_queue',version:1},arguments:{binding:{...await resolve(instance,'r.resume_queue',1),target:session.queue_target},arguments:{session_id:session.queue_target,pause_id:settled.console.pause.id,only_operation_ids:[result.operation.operation_id]}}});
        return result;
      };
      const pinned=succeeded(await control('protect-checkpoint','r.pin_checkpoint',{reference,expected_control:null,pinned:true}));
      assert.equal((await materialQuery('retention',{operation_id:cancelled.operation.operation_id})).can_quarantine,false);
      const unpinned=succeeded(await control('unpin-checkpoint','r.pin_checkpoint',{reference,expected_control:pinned.operation.operation_id,pinned:false}));
      faultController=succeeded(await invoke('activate-control-fault','plugins.activate',{revision:faultRevision.revision,artifact:faultRevision.artifacts[0],target:'aarch64-apple-darwin',alias:'control-fault',configuration:{},optional_capabilities:checkpointGrants})).output.instance.identity;
      captureProvider=succeeded(await invoke('activate-failed-capture','plugins.activate',{revision:faultRevision.revision,artifact:faultRevision.artifacts[0],target:'aarch64-apple-darwin',alias:'failed-capture',configuration:{ark:fs.realpathSync(process.env.RHO_ARK),r_home:rhome,checkpoint_helper_path:fs.realpathSync(process.env.RHO_CHECKPOINT_HELPER),execution_timeout_seconds:60},optional_capabilities:checkpointGrants})).output.instance.identity;
      const captureSession=succeeded(await control('create-failed-capture','r.create_session',{},1,captureProvider)).output.session_id;
      succeeded(await control('capture-dependent-namespace','r.execute',{expected_session:captureSession,code:`loadNamespace('rhonextfixture',lib.loc=${JSON.stringify(candidate)}); protected <- 42L; TRUE`},1,captureProvider));
      const unpublished=await control('unpublished-capture','r.capture_checkpoint',{expected_session:captureSession,include_names:['protected'],max_seconds:10},1,captureProvider);assert.ok(['failed','uncertain'].includes(unpublished.status));
      succeeded(await invoke('release-failed-capture','plugins.release',{instance:captureProvider}));captureProvider=null;
      const unconfirmed=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(unconfirmed.can_quarantine,false);assert.match(unconfirmed.retained_reasons.join(' '),/unknown recovery references/i);
      const inspectAttempt=()=>resolve(observerIdentity,'r.capture_attempt',1).then(binding=>query('r.capture_attempt',{binding,arguments:{source_operation_id:unpublished.operation.operation_id}}));
      let preview=await inspectAttempt();assert.equal(preview.owner_released,true);assert.equal(preview.can_discard,true);
      const lostDisposal=await control('lost-capture-disposal','r.discard_capture',{source_operation_id:unpublished.operation.operation_id,expected_fingerprint:preview.material.fingerprint},1,faultController);assert.equal(lostDisposal.status,'uncertain');
      const stillProtected=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(stillProtected.can_quarantine,false);assert.match(stillProtected.retained_reasons.join(' '),/unknown recovery references/i);
      preview=await inspectAttempt();assert.equal(preview.material.payload_bytes,null);assert.equal(preview.discarded_by,null);
      const confirmedDisposal=succeeded(await control('confirm-capture-disposal','r.discard_capture',{source_operation_id:unpublished.operation.operation_id,expected_fingerprint:preview.material.fingerprint}));
      assert.equal((await inspectAttempt()).discarded_by,confirmedDisposal.operation.operation_id);
      for(const original of [unpublished,lostDisposal])assert.deepEqual(await call('get_operation',{operation_id:original.operation.operation_id}),original);
      const uncertain=await control('uncertain-deletion','r.delete_checkpoint',{reference,expected_control:unpinned.operation.operation_id},1,faultController);assert.equal(uncertain.status,'uncertain');
      const resolveArgs={reference,source_operation_id:uncertain.operation.operation_id,expected_attempt:null,decision:'apply'};
      const retry=await control('uncertain-resolution','r.delete_checkpoint',resolveArgs,2,faultController);assert.equal(retry.status,'uncertain');
      const unresolved=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(unresolved.can_quarantine,false);assert.match(unresolved.retained_reasons.join(' '),/uncertain.*resolution|uncertain.*resolve/i);
      const deleted=succeeded(await control('resolve-deletion','r.delete_checkpoint',{...resolveArgs,expected_attempt:retry.operation.operation_id},2));
      for(const original of [uncertain,retry]){
        assert.deepEqual(await call('get_operation',{operation_id:original.operation.operation_id}),original,'Explicit resolution preserves the original uncertain outcome');
        const observed=await query('r.checkpoint_control',{binding:await resolve(observerIdentity,'r.checkpoint_control',1),arguments:{reference,operation_id:original.operation.operation_id}});
        assert.equal(observed.status,'uncertain');assert.equal(observed.resolution,deleted.operation.operation_id);
      }
      assert.equal((await query('r.session',{binding:await resolve(faultController,'r.session',1),arguments:{}})).state,'unstarted');
      succeeded(await invoke('release-control-fault','plugins.release',{instance:faultController}));faultController=null;
      succeeded(await control('purge-checkpoint','r.purge_checkpoint',{reference,deletion_operation_id:deleted.operation.operation_id}));
      assert.equal((await readSession()).state,'unstarted','Reference checks and controls must not start R');
      assert.deepEqual((await resource(checkpoint.manifest)).reference,reference,'Original public reports survive retirement');
    }
    eligible=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(eligible.can_quarantine,true,JSON.stringify(eligible));
  }
  await assert.rejects(()=>materialInvoke('stale-quarantine','cleanup',{operation_id:cancelled.operation.operation_id,expected_fingerprint:`sha256:${'0'.repeat(64)}`}),/changed since.*preview/i);
  const quarantineArgs={operation_id:cancelled.operation.operation_id,expected_fingerprint:eligible.material.stage.fingerprint};
  const quarantined=succeeded(await materialInvoke('quarantine','cleanup',quarantineArgs));
  assert.equal(quarantined.output.kind,'material');const moved=await resource(quarantined.output.report);assert.equal(moved.action,'quarantine');
  assert.equal(fs.existsSync(nativeRecovery.stage),false);assert.ok(fs.statSync(moved.trash_path).isDirectory());
  assert.deepEqual(await materialInvoke('quarantine','cleanup',quarantineArgs),quarantined,'Replay cannot move material again');
  let trash=await materialQuery('cleanup_status',{cleanup_operation_id:quarantined.operation.operation_id});
  assert.equal(trash.can_restore,true,JSON.stringify(trash));assert.equal(trash.can_purge,true);
  const restored=succeeded(await materialInvoke('restore','restore_cleanup',{cleanup_operation_id:quarantined.operation.operation_id,expected_fingerprint:trash.material.trash.fingerprint}));
  assert.equal((await resource(restored.output.report)).action,'restore');assert.ok(fs.statSync(nativeRecovery.stage).isDirectory());assert.equal(fs.existsSync(moved.trash_path),false);
  const again=await materialQuery('retention',{operation_id:cancelled.operation.operation_id});assert.equal(again.can_quarantine,true,JSON.stringify(again));
  const quarantinedAgain=succeeded(await materialInvoke('quarantine-again','cleanup',{operation_id:cancelled.operation.operation_id,expected_fingerprint:again.material.stage.fingerprint}));
  trash=await materialQuery('cleanup_status',{cleanup_operation_id:quarantinedAgain.operation.operation_id});assert.equal(trash.can_purge,true,JSON.stringify(trash));
  const purgeArgs={cleanup_operation_id:quarantinedAgain.operation.operation_id,expected_fingerprint:trash.material.trash.fingerprint};
  const purged=succeeded(await materialInvoke('purge','purge_cleanup',purgeArgs));assert.equal((await resource(purged.output.report)).action,'purge');
  assert.equal(fs.existsSync(trash.material.trash.path),false);assert.equal(fs.existsSync(nativeRecovery.stage),false);
  const gone=await materialQuery('cleanup_status',{cleanup_operation_id:quarantinedAgain.operation.operation_id});assert.equal(gone.can_purge,false);assert.equal(gone.material.stage,null);assert.equal(gone.material.trash,null);
  assert.deepEqual(await materialInvoke('purge','purge_cleanup',purgeArgs),purged);
  assert.deepEqual(await call('get_operation',{operation_id:cancelled.operation.operation_id}),cancelled,'Material changes do not rewrite the original scientific outcome');
  assert.deepEqual(await resource(quarantined.output.report),moved,'Material reports survive purge');
  if(otherReader){succeeded(await invoke('release-other-reader','plugins.release',{instance:otherReader}));otherReader=null;}
  if(observerIdentity){succeeded(await invoke('release-checkpoint-reader','plugins.release',{instance:observerIdentity}));observerIdentity=null;}
  succeeded(await invoke('release-replacement','plugins.release',{instance:replacement}));
  assert.deepEqual(await resource(planned.output.report),plan);assert.deepEqual(await resource(realized.output.report),receipt);
  assert.deepEqual(await invoke('plan','environment.plan',planArgs,2),planned);
  host.stdin.end();assert.equal((await deadline(exited,'Host shutdown',15000)).code,0);
  assert.equal(digest(fs.readFileSync(binary)),originalHost);complete=true;
  console.log(`Independent Environment package passed disconnected/query purity, material-owner exclusion, real pak/renv, resource reports, verified inventory, original idempotency, native cancellation, previous-instance resource reads, replacement recovery, explicit reference grants, stale preview refusal, quarantine/restore/purge and retained original results. Unchanged Host SHA256 ${originalHost}`);
  if(checkpointReferences)console.log('Native checkpoint references passed: original provider preference, namespace-only dependencies, retention after unload and release, unavailable-reader retention, unstarted replacement reader, ambiguous reader refusal and exact configured selection, pin/unpin, uncertain deletion and resolution retry, explicit completion, unpublished capture protection, uncertain disposal and explicit confirmation, unchanged original outcomes, purge, preserved reports and subsequent material quarantine/restore/purge.');
  if(rReferences)console.log('Native ordinary R reference checks passed: two exact idle sessions, live library paths, namespace retained after library-path removal, refused quarantine, explicit namespace unloading and released-instance observation.');
} finally {
  for(const instance of [rIdentity,observerIdentity,otherReader,faultController,captureProvider].filter(Boolean))if(host&&host.exitCode===null&&host.signalCode===null){
    try{succeeded(await invoke(`cleanup-${instance.instance}`,'plugins.release',{instance}));}
    catch(error){console.error(`Test-owned R release remains unconfirmed: ${error.message}`);}
  }
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
