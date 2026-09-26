// Disposable LOCAL-ONLY SSH/Slurm acceptance through an unchanged public Host.
// No Host compilation, live remote connection or real scheduler submission.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildRemotePlugin} from './build-remote-plugin.mjs';
import {createRemoteFixture} from './fixtures/ssh-slurm.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-remote-plugin-')));
const fixture = createRemoteFixture(temporary, {dropSubmit:true}), project = fs.realpathSync(fixture.project);
const database = path.join(temporary, 'host.sqlite');
const target = {host_alias:'fixture', project_root:fs.realpathSync(fixture.remote), slurm_cluster:'fixture_cluster'};
const env = {...fixture.env, RHO_TEST_DROP_SUBMIT:'1'};
const binary = process.env.RHO_TEST_BINARY ?? path.join(root, 'target/debug/rho');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHost = digest(fs.readFileSync(binary));
const source = process.env.RHO_REMOTE_PLUGIN_PACKAGE ? fs.realpathSync(process.env.RHO_REMOTE_PLUGIN_PACKAGE) : buildRemotePlugin(path.join(temporary, 'package'));
assert.ok(!source.startsWith(root + path.sep), 'Use an independently assembled package');
assert.equal(digest(fs.readFileSync(binary)), originalHost);
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
const invoke=(id,cap,args,version=1) => call('invoke',{client_request_id:id,capability:{id:cap,version},arguments:args,preconditions:[],return_after_acceptance:false});
const succeeded=record => {assert.equal(record.status,'succeeded',JSON.stringify({status:record.status,error:record.error,recovery:record.recovery})); return record;};
const ownerRecovery=record => {assert.equal(record.recovery?.kind,'plugin_owner_recovery',JSON.stringify(record.recovery));return record.recovery.data;};
const native=() => JSON.parse(fs.readFileSync(fixture.state,'utf8'));
const saveNative=value => fs.writeFileSync(fixture.state,JSON.stringify(value));
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
  execFileSync(process.execPath,[path.join(source,'tests/protocol.mjs'),path.join(source,'dist/rho-remote-backend')],{cwd:source,stdio:'inherit',timeout:180000});
  const snapshot=JSON.parse(execFileSync(binary,['--database',database,'--project',project,'plugins','snapshot',source,'--target','aarch64-apple-darwin'],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024})).result;
  assert.ok(snapshot.revision&&snapshot.artifacts[0],JSON.stringify(snapshot)); trace('snapshot',snapshot);
  host=spawn(binary,['--database',database,'--project',project,'session'],{env,stdio:['pipe','pipe','pipe']});
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
  const disconnectedStatus=await resolve(disconnected,'remote.status',1);
  assert.equal((await query('remote.status',{binding:disconnectedStatus,arguments:{}})).target,null);
  const disconnectedRun=await resolve(disconnected,'process.run_remote');
  await assert.rejects(() => invoke('unconfigured-run','process.run_remote',{binding:disconnectedRun,arguments:{program:'printf',args:['no']}},2),/configure|target/i);
  succeeded(await invoke('release-disconnected','plugins.release',{instance:disconnected}));
  const identity=await activate('remote',{target});
  const bindings={}; for(const cap of ['process.run_remote','slurm.submit','slurm.reconcile','slurm.request_cancel','slurm.snapshot'])bindings[cap]=await resolve(identity,cap);
  const statusBinding=await resolve(identity,'remote.status',1);
  const status=() => query('remote.status',{binding:statusBinding,arguments:{}});
  assert.deepEqual((await status()).target,target); assert.deepEqual((await status()).activities,[]);
  assert.equal(fs.existsSync(fixture.log),false,'Activation or local status connected to SSH');
  const payload='\0中文🧪\n'.repeat(2000);
  const runArgs={binding:bindings['process.run_remote'],arguments:{program:process.execPath,args:['-e',"require('fs').appendFileSync('once.txt','once\\n');process.stdin.pipe(process.stdout);process.stderr.write('stderr 中文');"],stdin:payload,timeout_ms:15000,output_limit_bytes:131072}};
  const first=succeeded(await invoke('remote-once','process.run_remote',runArgs,2));
  const report=await resource(first.output.report);
  assert.deepEqual(first.output.report.owner,identity); assert.equal(first.output.operation,first.operation.operation_id);
  assert.equal(first.output.native_outcome,'succeeded'); assert.equal(first.output.remote_exit_code,0);
  assert.deepEqual(Buffer.from(report.transport.stdout.bytes),Buffer.from(payload));
  assert.equal(report.transport.stdout.total_bytes,Buffer.byteLength(payload));
  assert.equal(Buffer.from(report.transport.stderr.bytes).toString(),'stderr 中文');
  assert.equal(report.transport.stdout.eof,true); assert.equal(report.transport.stdout.truncated,false);
  const replay=succeeded(await invoke('remote-once','process.run_remote',runArgs,2));
  assert.equal(replay.operation.operation_id,first.operation.operation_id);assert.deepEqual(replay.output,first.output);
  const once=path.join(fixture.remote,'once.txt');assert.equal(fs.readFileSync(once,'utf8'),'once\n');
  await assert.rejects(() => invoke('wrong-target','process.run_remote',{...runArgs,binding:{...bindings['process.run_remote'],target:'ssh:foreign'}},2),/target/i);
  assert.equal(fs.readFileSync(once,'utf8'),'once\n');
  for(const [exit,outcome] of [[9,'failed'],[255,'uncertain']]) {
    const result=await invoke(`exit-${exit}`,'process.run_remote',{binding:bindings['process.run_remote'],arguments:{program:'/bin/sh',args:['-c',`exit ${exit}`]}},2);
    assert.equal(result.status,outcome); assert.equal(result.output.native_outcome,outcome);
    assert.equal((await resource(result.output.report)).transport.exit_code,exit);
    if(exit===255){assert.equal(ownerRecovery(result).automatic_reexecution,false);assert.equal(ownerRecovery(result).report_transfer_confirmed,true);}
  }
  const submitArgs={binding:bindings['slurm.submit'],arguments:{body:'#SBATCH --array=1-100\nprintf hello',cpus:2,time_minutes:2,memory_mb:2048}};
  const lost=await invoke('lost-submit','slurm.submit',submitArgs,2);
  assert.equal(lost.status,'uncertain',JSON.stringify(lost));assert.equal(native().submissions,1);
  const original=lost.operation.operation_id;
  assert.equal(ownerRecovery(lost).source_operation_id,original);
  const sourceArgs={submission_operation_id:original};
  const lostReplay=await invoke('lost-submit','slurm.submit',submitArgs,2);
  assert.equal(lostReplay.operation.operation_id,original);assert.equal(lostReplay.status,'uncertain');assert.equal(native().submissions,1);
  await until(status,value => value.activities.length===0,'Original settlement');
  const before=fs.readFileSync(database);
  const observed=await query('slurm.snapshot',{binding:bindings['slurm.snapshot'],arguments:sourceArgs},2);
  assert.equal(observed.status,'ready');assert.equal(observed.lookup.jobs[0].state,'RUNNING');
  assert.deepEqual(fs.readFileSync(database),before,'Read-only snapshot changed the journal');
  const recovered=succeeded(await invoke('recover','slurm.reconcile',{binding:bindings['slurm.reconcile'],arguments:sourceArgs},2));
  assert.equal(recovered.output.jobs[0].job.job_id,'4201');assert.equal(native().submissions,1);
  const cancel=succeeded(await invoke('request-cancel','slurm.request_cancel',{binding:bindings['slurm.request_cancel'],arguments:sourceArgs},2));
  assert.equal(cancel.output.request_sent,true);assert.equal(cancel.output.after.state,'RUNNING');
  await until(status,value => value.activities.length===0,'Cancellation settlement');
  let scheduler=native();scheduler.jobs[0].state='CANCELLED';saveNative(scheduler);
  const terminal=await query('slurm.snapshot',{binding:bindings['slurm.snapshot'],arguments:sourceArgs},2);
  assert.equal(terminal.lookup.jobs[0].source,'sacct');assert.equal(terminal.lookup.jobs[0].state,'CANCELLED');
  const cancelled=succeeded(await invoke('already-terminal','slurm.request_cancel',{binding:bindings['slurm.request_cancel'],arguments:sourceArgs},2));
  assert.equal(cancelled.output.request_sent,false);assert.equal(native().cancel_requests,1);
  scheduler=native();scheduler.jobs.push({...scheduler.jobs[0],id:'4202'});saveNative(scheduler);
  const ambiguous=await invoke('ambiguous','slurm.request_cancel',{binding:bindings['slurm.request_cancel'],arguments:sourceArgs},2);
  assert.equal(ambiguous.status,'uncertain');assert.equal(ownerRecovery(ambiguous).lookup.jobs.length,2);assert.equal(native().cancel_requests,1);
  scheduler=native();scheduler.jobs.pop();saveNative(scheduler);
  await assert.rejects(() => invoke('wrong-source','slurm.reconcile',{binding:bindings['slurm.reconcile'],arguments:{submission_operation_id:first.operation.operation_id}},2),/source|submission|binding/i);
  await until(status,value => value.activities.length===0,'Remote settlement');
  succeeded(await invoke('release-original','plugins.release',{instance:identity}));
  const replacement=await activate('replacement',{target});
  const replacementBinding=await resolve(replacement,'slurm.reconcile');
  const replacementArgs={binding:replacementBinding,arguments:sourceArgs};
  const replacementResult=succeeded(await invoke('replacement-recovery','slurm.reconcile',replacementArgs,2));
  assert.equal(replacementResult.output.jobs[0].job.job_id,'4201');
  const qualification=replacementResult.operation.admission.owner_context.qualification;
  assert.equal(qualification.source.operation,original);
  assert.deepEqual(qualification.source.binding,lost.operation.normalized_arguments.binding);
  assert.notEqual(qualification.source.binding.provider.instance,replacement.instance);
  const unchanged=await call('get_operation',{operation_id:original});
  assert.equal(unchanged.status,'uncertain');assert.deepEqual(unchanged.output,lost.output);assert.deepEqual(unchanged.recovery,lost.recovery);
  const replacementReplay=succeeded(await invoke('replacement-recovery','slurm.reconcile',replacementArgs,2));
  assert.equal(replacementReplay.operation.operation_id,replacementResult.operation.operation_id);
  const replacementStatus=await resolve(replacement,'remote.status',1);
  await until(() => query('remote.status',{binding:replacementStatus,arguments:{}}),value => value.activities.length===0,'Replacement settlement');
  succeeded(await invoke('release-replacement','plugins.release',{instance:replacement}));
  assert.deepEqual(await resource(first.output.report),report,'Original report survives both provider releases');
  assert.equal((await invoke('lost-submit','slurm.submit',submitArgs,2)).operation.operation_id,original);
  assert.equal((await invoke('remote-once','process.run_remote',runArgs,2)).operation.operation_id,first.operation.operation_id);
  assert.equal(native().submissions,1);assert.equal(native().cancel_requests,1);assert.equal(fs.readFileSync(once,'utf8'),'once\n');
  host.stdin.end();assert.equal((await deadline(exited,'Host shutdown',15000)).code,0);
  assert.equal(digest(fs.readFileSync(binary)),originalHost);complete=true;
  console.log(`Independent Remote package passed configured activation, native bytes/resources, exact target, lost receipt without resubmission, scoped source reads, cancellation observations, ambiguous refusal, immutable replacement recovery, settlement and retained results. LOCAL ONLY. Unchanged Host SHA256 ${originalHost}`);
} finally {
  if(host&&host.exitCode===null&&host.signalCode===null){host.stdin.end();host.kill('SIGTERM');await deadline(exited,'Owned Host cleanup',15000);}
  if(complete)fs.rmSync(temporary,{recursive:true,force:true});else console.error(`Remote Host acceptance evidence retained at ${temporary}`);
}
