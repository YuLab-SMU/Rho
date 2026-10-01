// Frozen Host + retained ordinary archives; no build, user catalog or real model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {installPluginSet} from './plugin-set.mjs';
const root = path.resolve(import.meta.dirname, '..');
assert.ok(process.env.RHO_PLUGIN_SET_PACKAGE, 'Select a retained full plugin set; this check never builds missing inputs');
const set = fs.realpathSync(process.env.RHO_PLUGIN_SET_PACKAGE);
const binary = fs.realpathSync(process.env.RHO_TEST_BINARY ?? path.join(root, 'target/debug/rho'));
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-environment-')));
const project = path.join(directory, 'project'), database = path.join(directory, 'host.sqlite');
const nativeBin = path.join(directory, 'native-bin'), nativeHome = path.join(directory, 'native-home');
for (const dir of [project, nativeBin, nativeHome]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(nativeBin, 'rho-science-fixture'), 'disposable');
fs.copyFileSync(path.join(root, 'crates/host/tests/fixtures/agent-science.cjs'), path.join(nativeBin, 'kimi'));
fs.copyFileSync(path.join(root, 'scripts/fixtures/agent-environment-tools.cjs'), path.join(nativeBin, 'agent-environment-tools.cjs'));
fs.chmodSync(path.join(nativeBin, 'kimi'), 0o700);
const evidence = path.resolve(process.env.RHO_AGENT_ENVIRONMENT_EVIDENCE ?? path.join(directory, 'result.json'));
const report = {directory, set, host_sha256:hash(fs.readFileSync(binary)), set_index_sha256:hash(fs.readFileSync(path.join(set, 'plugin-set.json'))),
  completed:false, stages:[], sends:[], native_builds:0, peer:'deterministic local ACP peer; no real model or credentials'};
const started = performance.now(), window = 'agent-environment-acceptance';
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
let host, exited, url, agent, environmentOwner;
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
const pluginQuery = async (instance, id, args, version = 1) => query(id, {binding:await binding(instance,id,version), arguments:args}, version);
const control = detail => ({task_id:detail.summary.task.task_id, generation:detail.summary.attachment.generation});
const peerEvidence = () => JSON.parse(fs.readFileSync(path.join(project, 'native-science-evidence.json'), 'utf8'));
const materials = path.join(directory, 'materials');
fs.mkdirSync(materials);
const rhome = fs.realpathSync(process.env.RHO_R_HOME ?? '/Library/Frameworks/R.framework/Resources');
const rscript = fs.realpathSync(path.join(rhome, 'bin/Rscript'));
execFileSync(rscript, ['--vanilla','-e', "stopifnot(all(vapply(c('pak','renv','ps','jsonlite'),requireNamespace,logical(1),quietly=TRUE)))"], {stdio:'inherit',timeout:30000});
fs.cpSync(path.join(root,'crates/host/tests/fixtures/rhonextfixture'),path.join(project,'pkg'),{recursive:true});
// An actual namespace load supplies evidence that retry/restart never runs it again.
const loads = path.join(project,'namespace-loads.txt');
fs.writeFileSync(path.join(project,'pkg/R/load.R'), `.onLoad <- function(libname,pkgname) { cat("loaded\\n",file=${JSON.stringify(loads)},append=TRUE) }\n`);
let originalDescription, description;
const actions = ['refresh','plan','realize','verify'];
const queries = ['prepare_plan','observe','library'];
try {
  const installed = installPluginSet({rho:binary, directory:set, database});
  assert.equal(installed.imported.length,16);
  const packages = JSON.parse(fs.readFileSync(path.join(set,'plugin-set.json'))).packages;
  await start();
  for (const name of ['environment','agent']) {
    const entry = packages.find(entry => entry.plugin === `org.rho.${name}`);
    const optional = name === 'agent' ? [key('plugins.inspect'), key('host.core_contract'), key('resources.read'),
      key('operation.get'), key('plugins.delegated_operation'), ...[...actions,...queries].map(id=>key(`environment.${id}`,2))] : [];
    const active = (await invoke('plugins.activate',{revision:entry.revision,
      artifact:entry.artifacts.find(a=>a.target==='aarch64-apple-darwin').id,target:'aarch64-apple-darwin',alias:name,
      configuration:name==='agent'?{kimi_home:nativeHome}:{rscript,storage_root:materials,timeout_seconds:90},
      optional_capabilities:optional})).output.instance.identity;
    if(name==='agent')agent=active;else environmentOwner=active;
  }
  report.instances={agent,environment:environmentOwner};
  assert.equal(fs.existsSync(path.join(materials,'recovery')),false,'Activation cannot start native work');
  const commandBinding=await binding(agent,'agent.native.command');
  const command=async command=>(await invoke('agent.native.command',{binding:commandBinding,arguments:{request_id:randomUUID(),command}})).output;
  let task=await command({kind:'create',provider:'kimi',model:'fixture',effort:null});
  task=await command({kind:'connect',control:control(task.detail)});
  let realization;
  for(const mode of ['readonly','normal','tampered']) {
    if(mode==='tampered')fs.appendFileSync(description,'\nTampered: yes\n');
    const names=mode==='readonly'?['prepare_plan','observe']:mode==='normal'?[...actions,...queries]:['verify'];
    task=await command({kind:'save_draft',control:control(task.detail),version:task.detail.draft.version,
      content:{text:mode==='readonly'?'Inspect the local package plan without running R.':
        mode==='normal'?'Plan, realize and verify the local fixture in the isolated Environment library.':'Verify the same library and retain its actual outcome.',assets:[],context:[]}});
    fs.writeFileSync(path.join(project,'native-environment-input.json'),JSON.stringify({mode,provider:environmentOwner,names,
      realization,project,materials}));
    const tools=[];
    for(const name of names)tools.push({name,target:{type:'provider',binding:await binding(environmentOwner,`environment.${name}`,2)}});
    if(mode!=='readonly')tools.push({name:'read',target:{type:'host',project:commandBinding.project,capability:key('resources.read'),fixed_arguments:{}}});
    const input={binding:commandBinding,arguments:{request_id:randomUUID(),command:{kind:'send',control:control(task.detail),draft_version:task.detail.draft.version},tools}};
    const parent=await invoke('agent.native.command',input);
    const proof=peerEvidence();assert.equal(proof.error,undefined,JSON.stringify(proof));
    assert.equal(proof.send_request,input.arguments.request_id);assert.equal(proof.prompts,report.sends.length+1);
    const retained={mode,input,parent:parent.operation.operation_id,proof,children:[]};
    if(mode==='readonly') {
      assert.equal(proof.unselected_plan_refused,true);
      assert.equal(fs.existsSync(path.join(materials,'recovery')),false,'Read-only Send cannot launch native R');
      assert.equal(fs.existsSync(loads),false);
    } else {
      for(const entry of proof.operations) {
        const lookup={send_request:input.arguments.request_id,tool_request:entry.invocation.tool_request};
        const tool=await pluginQuery(agent,'agent.native.tool',lookup);
        const child=await original(tool.operation);
        assert.equal(tool.phase,'resolved');assert.equal(child.status,mode==='tampered'?'failed':'succeeded');
        assert.equal(tool.result.status,child.status);
        assert.equal(child.operation.causation_id,parent.operation.operation_id);
        assert.deepEqual(child.operation.caller,{kind:'plugin',id:agent.instance});
        assert.equal(child.operation.capability.id,`environment.${entry.name}`);
        assert.deepEqual(child.operation.normalized_arguments.binding.provider,environmentOwner);
        assert.deepEqual(child.output.report.owner,environmentOwner);
        assert.equal((await pluginQuery(agent,'agent.native.tool.operation',lookup)).operation.operation_id,tool.operation);
        retained.children.push({lookup,tool,child});
      }
      if(mode==='normal') {
        realization=proof.operations.find(o=>o.name==='realize').result.operation_id;
        description=path.join(proof.library.library_path,'rhonextfixture/DESCRIPTION');
        originalDescription=fs.readFileSync(description);
        assert.ok(fs.readFileSync(loads,'utf8').split('\n').filter(Boolean).length>=1,'Real native namespace was loaded');
      } else {
        assert.equal(proof.verification.verified,false);assert.equal(proof.verification.library_digest_matches,false);
      }
    }
    const before=fs.existsSync(loads)?fs.readFileSync(loads,'utf8'):null;
    const replay=await invoke('agent.native.command',input);
    assert.equal(replay.output.receipt.status,'succeeded');
    assert.equal(peerEvidence().prompts,report.sends.length+1);
    assert.equal(fs.existsSync(loads)?fs.readFileSync(loads,'utf8'):null,before,'Send replay cannot load the native namespace');
    task=replay.output;report.sends.push(retained);report.stages.push(`${mode}: original tool/Send receipts, reports and no replay`);save();
    if(mode==='tampered')fs.writeFileSync(description,originalDescription);
  }
  await until(()=>pluginQuery(environmentOwner,'environment.status',{}),s=>s.activities.length===0,'Environment settlement');
  const runs=(await query('operation.list_recent',{limit:100})).operations.filter(r=>actions.some(id=>r.capability.id===`environment.${id}`));
  assert.equal(runs.length,5,'Four selected successful operations and one actual failed verification');
  report.native_loads_before_restart=fs.readFileSync(loads,'utf8');
  await stop();await start();
  for(const instance of [agent,environmentOwner])assert.equal((await query('plugins.instance',{instance})).instance.state,'suspended');
  const suspended=await query('plugins.instance',{instance:agent});
  assert.deepEqual((await invoke('plugins.resume',{instance:agent,suspension:suspended.instance.suspension})).output.instance.identity,agent);
  for(const sent of report.sends) {
    assert.equal((await invoke('agent.native.command',sent.input)).output.receipt.status,'succeeded');
    for(const {lookup,tool,child} of sent.children) {
      assert.deepEqual(await pluginQuery(agent,'agent.native.tool',lookup),tool);
      const record=await original(tool.operation);assert.deepEqual(record.output,child.output);assert.equal(record.status,child.status);
    }
  }
  assert.equal(fs.readFileSync(loads,'utf8'),report.native_loads_before_restart);
  assert.deepEqual(fs.readFileSync(description),originalDescription);
  assert.equal(peerEvidence().prompts,3);
  assert.equal((await query('plugins.instance',{instance:environmentOwner})).instance.state,'suspended');
  report.stages.push('actual Host restart; same Agent and original success/failure records; Environment remains suspended without native replay');
  report.completed=true;
}catch(error){report.error=safe(error.stack??error);throw error;}
finally {
  if(originalDescription&&description)fs.writeFileSync(description,originalDescription);
  try {await stop();}catch(error){
    report.completed=false;report.cleanup_error=safe(error.message);
    if(host?.exitCode===null&&host?.signalCode===null){host.kill('SIGKILL');await deadline(exited,'Owned forced cleanup',5000).catch(()=>{});}
  }
  assert.equal(hash(fs.readFileSync(binary)),report.host_sha256);
  report.elapsed_seconds=(performance.now()-started)/1000;save();
  console.log(JSON.stringify({completed:report.completed,evidence,seconds:report.elapsed_seconds,stages:report.stages}));
  if(!report.completed)process.exitCode=1;
}
