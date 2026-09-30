// A real stateful Python interpreter, installed outside the checkout into an
// unchanged Host. No Cargo, native plugin build, current catalog or user session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const binary = fs.realpathSync(process.env.RHO_TEST_BINARY ?? path.join(root, 'target/debug/rho'));
const hash = file => 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-external-runtime-')));
const project = path.join(directory, 'project'), pkg = path.join(directory, 'python'), database = path.join(directory, 'host.sqlite');
fs.mkdirSync(project); fs.mkdirSync(path.join(pkg, 'dist'), {recursive:true});
const evidence = path.resolve(process.env.RHO_EXTERNAL_RUNTIME_EVIDENCE ?? path.join(directory, 'result.json'));
const report = {directory, completed:false, host_sha256:hash(binary), native_builds:0, core_builds:0, stages:[]};
const started = performance.now(), window = 'external-runtime-acceptance';
const key = id => ({id, version:1});
const safe = text => String(text).replace(/token=[a-z0-9]+/g, 'token=[redacted]');
const save = () => fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
const object = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const empty = object({}), text = {type:'string',minLength:1}, owner = {type:'object'};
const capabilities = [
  ['inspect','query',empty,object({owner,pid:{type:'integer'},session:{type:['string','null']},starts:{type:'integer'},executions:{type:'integer'},python:text})],
  ['start','operation',empty,object({owner,session:text,pid:{type:'integer'}})],
  ['execute','operation',object({session:text,source:{...text,maxLength:16384}}),object({owner,session:text,executions:{type:'integer'},operation:text,value:true,stdout:{type:'string'},stderr:{type:'string'}})],
].map(([name,kind,input_schema,output_schema]) => ({capability:key(`example.python.${name}`),kind,title:`Python ${name}`,
  description:'External stateful Python acceptance runtime',input_schema,output_schema,recovery_schema:true,
  examples:[name === 'execute' ? {session:'explicit-native-session',source:'result = 1 + 1'} : {}],
  required_scopes:[kind === 'query' ? 'plugins.read' : 'plugins.run'],effects:kind === 'query' ? [] : ['example.python.session'],
  cancellation:'unsupported',preflight:null}));
function deadline(promise, label, ms = 30000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(() => reject(Error(`${label} timed out`)),ms);})]).finally(() => clearTimeout(timer));
}
let host, exited, url;
async function startHost() {
  host = spawn(binary, ['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
  exited = new Promise(resolve => host.once('exit',(code,signal) => resolve({code,signal})));
  url = new URL(await deadline(new Promise((resolve,reject) => {
    let output='',errors=''; host.once('error',reject);
    host.stderr.on('data',b => {errors+=safe(b);fs.appendFileSync(path.join(directory,'host-stderr.log'),safe(b));});
    host.stdout.on('data',b => {output+=b;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found)resolve(found[0]);});
    exited.then(status => reject(Error(`Owned Host exited ${JSON.stringify(status)}: ${errors}`)));
  }),'Owned Host startup',60000));
}
async function stopHost() {
  if(!host || host.exitCode!==null || host.signalCode!==null)return;
  host.kill('SIGINT');assert.equal((await deadline(exited,'Owned Host drain')).code,0);
}
async function port(method,params) {
  const reply = await fetch(new URL('/api/host',url),{method:'POST',signal:AbortSignal.timeout(30000),
    headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':window},
    body:JSON.stringify({project_root:project,frame:{id:randomUUID(),request:{method,params}}})}).then(r=>r.json());
  assert.equal(reply.ok,true,safe(JSON.stringify(reply)));return reply.result;
}
async function query(id,args) {
  const result=await port('query_snapshot',{capability:key(id),arguments:args});
  assert.equal(result.status,'ready',JSON.stringify(result));return result.data;
}
async function invoke(id,args,request=randomUUID(),expected='succeeded') {
  const admitted=await port('invoke',{capability:key(id),arguments:args,preconditions:[],client_request_id:request,return_after_acceptance:true});
  const operation=admitted.operation.operation_id, end=Date.now()+30000;
  for(;;){const record=await port('get_operation',{operation_id:operation});
    if(['succeeded','failed','cancelled','uncertain'].includes(record.status)){
      assert.equal(record.status,expected,JSON.stringify(record.error));return record;
    }
    assert.ok(Date.now()<end,`${id} settlement timed out`);await new Promise(resolve=>setTimeout(resolve,20));
  }
}
const binding = (instance,id) => query('plugins.resolve',{instance,capability:key(id)});
const inspect = async instance => query('example.python.inspect',{binding:await binding(instance,'example.python.inspect'),arguments:{}});
try {
  assert.ok(!pkg.startsWith(root+path.sep),'Runtime package must be outside the checkout');
  const python = execFileSync('python3',['-c','import sys; print(sys.version)'],{encoding:'utf8',timeout:10000}).trim();
  fs.copyFileSync(path.join(root,'scripts/fixtures/python-runtime.py'),path.join(pkg,'backend.py'));
  fs.copyFileSync(path.join(root,'LICENSE'),path.join(pkg,'LICENSE'));
  fs.copyFileSync(path.join(pkg,'backend.py'),path.join(pkg,'dist/backend'));fs.chmodSync(path.join(pkg,'dist/backend'),0o755);
  fs.writeFileSync(path.join(pkg,'BUILD.md'),'Copy backend.py to dist/backend and make it executable. Requires existing Python 3; standard library only. No Rho checkout, package downloads or compilation.\n');
  fs.writeFileSync(path.join(pkg,'dependencies.lock'),`Python runtime used for this acceptance: ${python}\nPublic Rho wire protocol: 1\nNo third-party dependencies.\n`);
  fs.writeFileSync(path.join(pkg,'plugin.json'),JSON.stringify({protocol_version:1,id:'example.external-python',name:'External Python runtime',
    version:'1.0.0',description:'Stateful Python via the public language-independent protocol',license:'AGPL-3.0-only',
    source:{files:['backend.py','LICENSE'],lockfiles:['dependencies.lock'],build_instructions:'BUILD.md',build:null},dependencies:{},requires:[],views:[],contexts:[],
    backend:{executable:'dist/backend',arguments:[]},configuration_schema:empty,default_configuration:{},capabilities},null,2));
  const installed=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',pkg,'--target','aarch64-apple-darwin'],
    {encoding:'utf8',timeout:60000,killSignal:'SIGKILL'})).result;
  report.package={path:pkg,python,revision:installed.revision,artifact:installed.artifacts[0],backend_sha256:hash(path.join(pkg,'backend.py'))};
  await startHost();assert.equal((await query('plugins.instances',{after:null,limit:100})).total,0);
  const instances=[];
  for(const alias of ['left','right']){
    const instance=(await invoke('plugins.activate',{revision:installed.revision,artifact:installed.artifacts[0],target:'aarch64-apple-darwin',alias,configuration:{}})).output.instance.identity;
    instances.push(instance);const before=await inspect(instance);
    assert.equal(before.session,null);assert.equal(before.starts,0);assert.equal(before.executions,0);
    assert.equal(before.python,python,'Record the interpreter actually selected by the plugin process');
    assert.deepEqual(await inspect(instance),before,'A query cannot create a session');
  }
  const [left,right]=instances;report.instances=instances;
  assert.notEqual((await inspect(left)).pid,(await inspect(right)).pid);
  const start=async instance=>(await invoke('example.python.start',{binding:await binding(instance,'example.python.start'),arguments:{}})).output;
  const a=await start(left),b=await start(right);assert.notEqual(a.session,b.session);
  const execute=await binding(left,'example.python.execute');
  const input={binding:execute,arguments:{session:a.session,source:'import statistics\nvalues = [2, 4, 6, 8]\nresult = {"mean": statistics.mean(values), "spread": statistics.pstdev(values)}\nprint("Python result 中文", result["mean"])'}};
  const request=randomUUID(), first=await invoke('example.python.execute',input,request);
  assert.deepEqual(first.output.value,{mean:5,spread:Math.sqrt(5)});
  assert.equal(first.output.stdout,'Python result 中文 5\n');assert.equal(first.output.stderr,'');
  assert.deepEqual(first.output.owner,left);assert.equal(first.output.session,a.session);assert.equal(first.output.operation,first.operation.operation_id);
  assert.deepEqual(first.operation.normalized_arguments.binding.provider,left);
  const retry=await invoke('example.python.execute',input,request);
  assert.equal(retry.operation.operation_id,first.operation.operation_id);assert.deepEqual(retry.output,first.output);
  assert.equal((await inspect(left)).executions,1);
  const second=await invoke('example.python.execute',{binding:execute,arguments:{session:a.session,source:'values.append(10)\nresult = sum(values)'}});
  assert.equal(second.output.value,30);assert.equal(second.output.executions,2);
  const rightBinding=await binding(right,'example.python.execute');
  await invoke('example.python.execute',{binding:rightBinding,arguments:{session:a.session,source:'result = "must not execute"'}},randomUUID(),'failed');
  assert.equal((await inspect(right)).executions,0);
  const isolated=await invoke('example.python.execute',{binding:rightBinding,arguments:{session:b.session,source:'result = {"has_left_values": "values" in globals(), "value": 99}'}});
  assert.deepEqual(isolated.output.value,{has_left_values:false,value:99});assert.deepEqual(isolated.output.owner,right);
  const records=await query('operation.list_recent',{limit:100});
  assert.equal(records.operations.filter(r=>r.capability.id==='example.python.execute').length,4);
  report.operations={first,second,isolated};report.stages.push('External package activated without core rebuild; observations start no session; two real Python processes and sessions');
  report.stages.push('Real statistics and persistent namespace; exact session refusal; instance isolation; original request executes once');save();
  for(const instance of instances)await invoke('plugins.release',{instance});
  assert.deepEqual((await port('get_operation',{operation_id:first.operation.operation_id})).output,first.output);
  await stopHost();await startHost();
  assert.deepEqual((await port('get_operation',{operation_id:first.operation.operation_id})).output,first.output);
  for(const instance of instances)assert.equal((await query('plugins.instance',{instance})).instance.state,'released');
  report.stages.push('Both runtimes released; original execution survives actual Host restart without reactivation or replay');
  report.completed=true;
}catch(error){report.error=safe(error.stack??error);throw error;}
finally{
  try{await stopHost();}catch(error){report.completed=false;report.cleanup_error=safe(error.message);
    if(host?.exitCode===null&&host?.signalCode===null){host.kill('SIGKILL');await deadline(exited,'Owned forced cleanup',5000).catch(()=>{});}}
  report.host_unchanged=hash(binary)===report.host_sha256;if(!report.host_unchanged)report.completed=false;
  report.elapsed_seconds=(performance.now()-started)/1000;save();
  console.log(JSON.stringify({completed:report.completed,evidence,seconds:report.elapsed_seconds,stages:report.stages}));
  if(!report.completed)process.exitCode=1;
}
