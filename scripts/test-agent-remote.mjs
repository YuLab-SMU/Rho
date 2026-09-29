// Frozen Host + retained ordinary archives; no build, user catalog or real model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {installPluginSet} from './plugin-set.mjs';
import {startLoopbackSsh} from './fixtures/loopback-ssh.mjs';
const root = path.resolve(import.meta.dirname, '..');
assert.ok(process.env.RHO_PLUGIN_SET_PACKAGE, 'Select a retained full plugin set; this check never builds missing inputs');
const set = fs.realpathSync(process.env.RHO_PLUGIN_SET_PACKAGE);
const binary = fs.realpathSync(process.env.RHO_TEST_BINARY ?? path.join(root, 'target/debug/rho'));
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-remote-')));
const project = path.join(directory, 'project'), database = path.join(directory, 'host.sqlite');
const nativeBin = path.join(directory, 'native-bin'), nativeHome = path.join(directory, 'native-home');
for (const dir of [project, nativeBin, nativeHome]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(nativeBin, 'rho-science-fixture'), 'disposable');
fs.copyFileSync(path.join(root, 'crates/host/tests/fixtures/agent-science.cjs'), path.join(nativeBin, 'kimi'));
fs.copyFileSync(path.join(root, 'scripts/fixtures/agent-remote-tools.cjs'), path.join(nativeBin, 'agent-remote-tools.cjs'));
fs.chmodSync(path.join(nativeBin, 'kimi'), 0o700);
const evidence = path.resolve(process.env.RHO_AGENT_REMOTE_EVIDENCE ?? path.join(directory, 'result.json'));
const report = {directory, set, host_sha256:hash(fs.readFileSync(binary)), set_index_sha256:hash(fs.readFileSync(path.join(set, 'plugin-set.json'))),
  completed:false, stages:[], sends:[], native_builds:0, peer:'deterministic local ACP peer; no real model or credentials'};
const started = performance.now(), window = 'agent-remote-acceptance';
const key = (id, version = 1) => ({id, version});
const terminal = status => ['succeeded','failed','cancelled','uncertain'].includes(status);
const safe = value => String(value).replace(/token=[a-z0-9]+/g, 'token=[redacted]');
const save = () => fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
function deadline(promise, label, ms = 30000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);})]).finally(() => clearTimeout(timer));
}
async function until(read, accept, label, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {const value = await read(); if (accept(value)) return value;
    assert.ok(Date.now() < end, `${label}: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 50));}
}
let host, exited, url, agent, remoteOwner;
async function start() {
  host = spawn(binary, ['--database', database, '--project', project, '--plugins-only', 'workbench'],
    {stdio:['ignore','pipe','pipe'], env:{...process.env, PATH:nativeBin + path.delimiter + process.env.PATH}});
  exited = new Promise(resolve => host.once('exit', (code, signal) => resolve({code, signal})));
  let output = '', errors = '';
  url = new URL(await deadline(new Promise((resolve, reject) => {
    host.once('error', reject);
    host.stderr.on('data', bytes => {const text = safe(bytes); errors += text; fs.appendFileSync(path.join(directory, 'host-stderr.log'), text);});
    host.stdout.on('data', bytes => {output += bytes; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/); if (found) resolve(found[0]);});
    exited.then(status => reject(Error(`Owned Host exited ${JSON.stringify(status)}: ${errors}`)));
  }), 'Owned Host startup', 60000));
}
async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  host.kill('SIGINT'); assert.equal((await deadline(exited, 'Owned Host drain')).code, 0);
}
async function port(method, params) {
  const reply = await fetch(new URL('/api/host', url), {method:'POST', signal:AbortSignal.timeout(45000),
    headers:{Authorization:`Bearer ${url.hash.slice(7)}`, 'Content-Type':'application/json', 'X-Rho-Studio-Window':window},
    body:JSON.stringify({project_root:project, frame:{id:randomUUID(), request:{method, params}}})}).then(response => response.json());
  assert.equal(reply.ok, true, safe(JSON.stringify(reply))); return reply.result;
}
async function query(id, arguments_, version = 1) {
  const result = await port('query_snapshot', {capability:key(id, version), arguments:arguments_});
  assert.equal(result.status, 'ready', JSON.stringify(result)); return result.data;
}
const original = operation => port('get_operation', {operation_id:operation});
async function invoke(id, args, expected = 'succeeded') {
  const admitted = await port('invoke', {capability:key(id), arguments:args, preconditions:[], client_request_id:randomUUID(), return_after_acceptance:true});
  const record = await until(() => original(admitted.operation.operation_id), record => terminal(record.status), `${id} settlement`, 45000);
  assert.equal(record.status, expected, JSON.stringify({id, status:record.status, error:record.error})); return record;
}
const binding = (instance, id, version = 1) => query('plugins.resolve', {instance, capability:key(id, version)});
const pluginQuery = async (instance, id, args) => query(id, {binding:await binding(instance,id), arguments:args});
const control = detail => ({task_id:detail.summary.task.task_id, generation:detail.summary.attachment.generation});
const peerEvidence = () => JSON.parse(fs.readFileSync(path.join(project, 'native-science-evidence.json'), 'utf8'));
const remoteRoot=path.join(directory,'remote');fs.mkdirSync(remoteRoot);
const effect = mode => path.join(remoteRoot, `${mode}-once.txt`);
const release = path.join(remoteRoot, 'release-process');
let ssh;
try {
  ssh=await startLoopbackSsh(directory,nativeBin);
  report.ssh={port:ssh.port,log:ssh.log,transport:'real OpenSSH on 127.0.0.1; ephemeral pinned host key'};
  const target={host_alias:ssh.host_alias,project_root:remoteRoot,slurm_cluster:null};
  assert.equal(installPluginSet({rho:binary,directory:set,database}).imported.length,16);
  const packages=JSON.parse(fs.readFileSync(path.join(set,'plugin-set.json'))).packages;
  await start();
  for(const name of ['remote','agent']){
    const entry=packages.find(p=>p.plugin===`org.rho.${name}`);
    const grants=name==='agent'?[key('plugins.inspect'),key('host.core_contract'),key('process.prepare_remote',2),key('process.run_remote',2),key('resources.read'),key('operation.get'),key('plugins.delegated_operation')]:[];
    const active=(await invoke('plugins.activate',{revision:entry.revision,artifact:entry.artifacts.find(a=>a.target==='aarch64-apple-darwin').id,
      target:'aarch64-apple-darwin',alias:name,configuration:name==='agent'?{kimi_home:nativeHome}:{target},optional_capabilities:grants})).output.instance.identity;
    if(name==='agent')agent=active;else remoteOwner=active;
  }
  report.instances={agent,remote:remoteOwner};
  assert.equal(ssh.connections(),0,'Activation must not connect');
  const commandBinding=await binding(agent,'agent.native.command');
  const command=async command=>(await invoke('agent.native.command',{binding:commandBinding,arguments:{request_id:randomUUID(),command}})).output;
  let task=await command({kind:'create',provider:'kimi',model:'fixture',effort:null});
  task=await command({kind:'connect',control:control(task.detail)});
  const taskId=task.detail.summary.task.task_id;
  for(const mode of ['readonly','normal','failed','stop','uncertain']){
    task=await command({kind:'save_draft',control:control(task.detail),version:task.detail.draft.version,
      content:{text:mode==='readonly'?'Inspect without running a command.':`Run the disposable loopback SSH ${mode} command and preserve its outcome.`,assets:[],context:[]}});
    const script=`const fs=require('fs');fs.appendFileSync(${JSON.stringify(effect(mode))},'once\\n');${mode==='stop'
      ?`const start=Date.now();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('SSH settled after Agent Stop');}else if(Date.now()-start>30000){clearInterval(timer);process.exitCode=9;}},25);`
      :`process.stdin.pipe(process.stdout);process.stderr.write('SSH stderr 中文');process.exitCode=${mode==='failed'?9:mode==='uncertain'?255:0};`}`;
    const args={program:fs.realpathSync(process.execPath),args:['-e',script],stdin:'SSH original 中文 🧬\n',timeout_ms:40000,output_limit_bytes:65536};
    fs.writeFileSync(path.join(project,'native-remote-input.json'),JSON.stringify({mode,provider:remoteOwner,target,arguments:args,effect:effect(mode)}));
    const tools=[{name:'prepare',target:{type:'provider',binding:await binding(remoteOwner,'process.prepare_remote',2)}}];
    if(mode!=='readonly')tools.push({name:'run',target:{type:'provider',binding:await binding(remoteOwner,'process.run_remote',2)}},
      {name:'read',target:{type:'host',project:commandBinding.project,capability:key('resources.read'),fixed_arguments:{}}});
    const input={binding:commandBinding,arguments:{request_id:randomUUID(),command:{kind:'send',control:control(task.detail),draft_version:task.detail.draft.version},tools}};
    const admitted=await port('invoke',{capability:key('agent.native.command'),arguments:input,preconditions:[],client_request_id:randomUUID(),return_after_acceptance:true});
    let proof;
    if(mode==='stop'){
      await until(()=>fs.existsSync(effect(mode)),Boolean,'Actual SSH command entry');proof=peerEvidence();assert.equal(proof.error,undefined,JSON.stringify(proof));
      assert.equal((await original(admitted.operation.operation_id)).status,'running');
      const detail=await pluginQuery(agent,'agent.native.task',{task_id:taskId});
      assert.equal((await command({kind:'stop',control:control(detail)})).receipt.status,'succeeded');
      assert.equal((await original(admitted.operation.operation_id)).status,'running','Stopping Agent cannot claim SSH command termination');
      fs.writeFileSync(release,'release\n');
    }
    const parent=await until(()=>original(admitted.operation.operation_id),r=>terminal(r.status),'SSH Send settlement',45000);
    const parentStatus=mode==='stop'?'failed':mode==='uncertain'?'uncertain':'succeeded';
    assert.equal(parent.status,parentStatus,JSON.stringify(parent.error));
    if(mode!=='stop')proof=peerEvidence();
    assert.equal(proof.error,undefined,JSON.stringify(proof));assert.equal(proof.send_request,input.arguments.request_id);
    assert.equal(proof.prompts,report.sends.length+1);
    const retained={mode,input,parent:parent.operation.operation_id,parent_status:parentStatus,parent_record:parent,proof};
    if(mode==='readonly'){
      assert.equal(proof.unselected_run_refused,true);assert.equal(fs.existsSync(effect(mode)),false);assert.equal(ssh.connections(),0);
    }else{
      const lookup={send_request:input.arguments.request_id,tool_request:proof.invocation.tool_request};
      const tool=await pluginQuery(agent,'agent.native.tool',lookup);
      const observation=await pluginQuery(agent,'agent.native.tool.operation',lookup);
      const child=await original(observation.operation.operation_id);
      const childStatus=mode==='failed'?'failed':mode==='uncertain'?'uncertain':'succeeded';
      assert.equal(child.status,childStatus);assert.equal(child.output.native_outcome,childStatus);
      assert.equal(child.operation.causation_id,parent.operation.operation_id);
      assert.deepEqual(child.operation.caller,{kind:'plugin',id:agent.instance});
      assert.equal(child.operation.capability.id,'process.run_remote');
      assert.deepEqual(child.operation.normalized_arguments.binding.provider,remoteOwner);
      assert.deepEqual(child.output.report.owner,remoteOwner);assert.deepEqual(child.output.target,target);
      assert.equal(tool.phase,mode==='uncertain'?'uncertain':'resolved');
      if(mode!=='uncertain'){assert.equal(tool.result.status,childStatus);assert.equal(tool.operation,child.operation.operation_id);}
      else {assert.equal(child.recovery.data.automatic_reexecution,false);assert.equal(proof.unconfirmed,true);}
      assert.equal(fs.readFileSync(effect(mode),'utf8'),'once\n');
      if(['normal','failed'].includes(mode))assert.equal(proof.resource_verified,true);
      Object.assign(retained,{lookup,tool,child});
    }
    const connections=ssh.connections();
    // A fresh envelope may successfully read the original native ACP receipt.
    // That is distinct from the original Send/SSH scientific settlement.
    retained.native_receipt=await pluginQuery(agent,'agent.native.receipt',{request_id:input.arguments.request_id});
    const replay=await invoke('agent.native.command',input);
    assert.deepEqual(replay.output.receipt,retained.native_receipt);
    assert.equal(replay.output.receipt.status,mode==='stop'?'interrupted':'succeeded');task=replay.output;
    assert.deepEqual(await original(retained.parent),parent,'Receipt replay cannot promote the original uncertain Send');
    assert.equal(ssh.connections(),connections);assert.equal(peerEvidence().prompts,report.sends.length+1);
    if(mode!=='readonly')assert.equal(fs.readFileSync(effect(mode),'utf8'),'once\n');
    report.sends.push(retained);report.stages.push(`${mode}: original native Send/tool/SSH records; no repeated connection or effect`);save();
  }
  await until(()=>pluginQuery(remoteOwner,'remote.status',{}),s=>s.activities.length===0,'SSH settlement');
  const runs=(await query('operation.list_recent',{limit:100})).operations.filter(r=>r.capability.id==='process.run_remote');
  assert.equal(runs.length,4);assert.equal(ssh.connections(),4);
  report.ssh.connections_before_restart=ssh.connections();
  await stop();await start();
  for(const instance of [agent,remoteOwner])assert.equal((await query('plugins.instance',{instance})).instance.state,'suspended');
  const suspended=await query('plugins.instance',{instance:agent});
  assert.deepEqual((await invoke('plugins.resume',{instance:agent,suspension:suspended.instance.suspension})).output.instance.identity,agent);
  for(const sent of report.sends){
    const replay=await invoke('agent.native.command',sent.input);
    assert.deepEqual(replay.output.receipt,sent.native_receipt);
    assert.deepEqual(await original(sent.parent),sent.parent_record);
    if(sent.tool){
      assert.deepEqual(await pluginQuery(agent,'agent.native.tool',sent.lookup),sent.tool);
      const child=await original(sent.child.operation.operation_id);
      assert.deepEqual(child.output,sent.child.output);assert.equal(child.status,sent.child.status);assert.deepEqual(child.recovery,sent.child.recovery);
      assert.equal(fs.readFileSync(effect(sent.mode),'utf8'),'once\n');
    }
  }
  assert.equal(ssh.connections(),report.ssh.connections_before_restart);assert.equal(peerEvidence().prompts,5);
  assert.equal((await query('plugins.instance',{instance:remoteOwner})).instance.state,'suspended');
  report.stages.push('actual Host restart; same Agent and original success/failure/uncertain records; Remote remains suspended without SSH replay');
  report.completed=true;
}catch(error){report.error=safe(error.stack??error);throw error;}
finally{
  fs.writeFileSync(release,'release\n');
  try{await stop();}catch(error){report.completed=false;report.cleanup_error=safe(error.message);
    if(host?.exitCode===null&&host?.signalCode===null){host.kill('SIGKILL');await deadline(exited,'Owned forced cleanup',5000).catch(()=>{});}}
  try{await ssh?.stop();}catch(error){report.completed=false;report.ssh_cleanup_error=safe(error.message);}
  assert.equal(hash(fs.readFileSync(binary)),report.host_sha256);
  report.elapsed_seconds=(performance.now()-started)/1000;save();
  console.log(JSON.stringify({completed:report.completed,evidence,seconds:report.elapsed_seconds,stages:report.stages}));
  if(!report.completed)process.exitCode=1;
}
