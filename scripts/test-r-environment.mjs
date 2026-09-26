// Independent Environment and R providers, using an existing unchanged Host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildEnvironmentPlugin} from './build-environment-plugin.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(process.env.RHO_ARK&&process.env.RHO_R_HOME,'Select existing Ark and R; only disposable sessions are tested.');
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-r-environment-')));
const project=path.join(directory,'project'),materials=path.join(directory,'materials');fs.mkdirSync(project);fs.mkdirSync(materials);
const binary=process.env.RHO_TEST_BINARY??path.join(root,'target/debug/rho');
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex'),originalHost=digest(fs.readFileSync(binary));
const rhome=fs.realpathSync(process.env.RHO_R_HOME),rscript=fs.realpathSync(path.join(rhome,'bin/Rscript')),ark=fs.realpathSync(process.env.RHO_ARK);
fs.cpSync(path.join(root,'crates/host/tests/fixtures/rhonextfixture'),path.join(project,'pkg'),{recursive:true});
fs.writeFileSync(path.join(project,'pkg/R/load.R'),'.onLoad <- function(libname,pkgname) { if (file.exists("fail-load.flag")) stop("injected Environment namespace failure") }\n');
const database=path.join(directory,'host.sqlite');
let host,exited,ready,complete=false,counter=0;
const pending=new Map(),instances=[];
const trace=(kind,value)=>fs.appendFileSync(path.join(directory,'session.jsonl'),JSON.stringify({kind,value})+'\n');
function deadline(promise,label,ms=180000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),ms);})]).finally(()=>clearTimeout(timer));}
async function call(method,params){const id=`request-${++counter}`;const result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));host.stdin.write(JSON.stringify({id,request:{method,params}})+'\n');const reply=await deadline(result,`${method} ${id}`);assert.equal(reply.ok,true,JSON.stringify(reply.error));return reply.result;}
async function query(id,args,version=1){const value=await call('query_snapshot',{capability:{id,version},arguments:args});assert.equal(value.status,'ready',JSON.stringify(value));return value.data;}
const invoke=(id,cap,args,version=1)=>call('invoke',{client_request_id:id,capability:{id:cap,version},arguments:args,preconditions:[]});
const success=value=>{assert.equal(value.status,'succeeded',JSON.stringify({status:value.status,error:value.error,recovery:value.recovery}));return value;};
const resolve=(instance,id,version=1)=>query('plugins.resolve',{instance,capability:{id,version}});
async function native(instance,id,args={},version=1){return query(id,{binding:await resolve(instance,id,version),arguments:args},version);}
async function retained(reference){const parts=[];let offset=0;while(offset<reference.bytes){const chunk=await query('resources.read',{reference,offset,limit:65536});assert.deepEqual(chunk.reference,reference);assert.equal(chunk.offset,offset);const bytes=Buffer.from(chunk.base64,'base64');assert.equal(bytes.length,Math.min(65536,reference.bytes-offset));parts.push(bytes);offset+=bytes.length;assert.equal(chunk.next,offset===reference.bytes?null:offset);}const bytes=Buffer.concat(parts);assert.equal(digest(bytes),reference.digest);return JSON.parse(bytes);}
async function activate(snapshot,alias,configuration,optional_capabilities=[]){const value=success(await invoke(`activate-${alias}`,'plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:'aarch64-apple-darwin',alias,configuration,optional_capabilities}));instances.push(value.output.instance.identity);return value.output.instance.identity;}
async function release(instance){success(await invoke(`release-${instance.instance}`,'plugins.release',{instance}));instances.splice(instances.findIndex(value=>value.instance===instance.instance),1);}
async function run(instance,session,code){return success(await invoke(`run-${++counter}`,'r.execute',{binding:await resolve(instance,'r.execute'),arguments:{expected_session:session,code}})).output;}
try{
  const environmentSource=process.env.RHO_ENVIRONMENT_PLUGIN_PACKAGE?fs.realpathSync(process.env.RHO_ENVIRONMENT_PLUGIN_PACKAGE):buildEnvironmentPlugin(path.join(directory,'environment'));
  const rSource=process.env.RHO_R_PLUGIN_PACKAGE?fs.realpathSync(process.env.RHO_R_PLUGIN_PACKAGE):path.join(directory,'r');
  if(!process.env.RHO_R_PLUGIN_PACKAGE)execFileSync(process.execPath,['scripts/build-r-plugin.mjs',rSource],{cwd:root,stdio:'inherit'});
  for(const source of [environmentSource,rSource])assert.ok(!source.startsWith(root+path.sep),'Use independent source packages.');
  execFileSync('python3',[path.join(rSource,'tests/environment_protocol.py'),path.join(rSource,'dist/rho-r-backend')],{cwd:rSource,stdio:'inherit',timeout:180000});
  assert.equal(digest(fs.readFileSync(binary)),originalHost);
  const snapshot=source=>JSON.parse(execFileSync(binary,['--database',database,'--project',project,'plugins','snapshot',source,'--target','aarch64-apple-darwin'],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024})).result;
  const envRevision=snapshot(environmentSource),rRevision=snapshot(rSource);
  const fork=path.join(directory,'r-branch');fs.cpSync(rSource,fork,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(fork,'plugin.json'),'utf8'));manifest.version='0.1.1';fs.writeFileSync(path.join(fork,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
  const branch=snapshot(fork);assert.notEqual(branch.revision,rRevision.revision);
  host=spawn(binary,['--database',database,'--project',project,'session'],{stdio:['pipe','pipe','pipe']});
  exited=new Promise(resolve=>host.once('close',(code,signal)=>resolve({code,signal})));
  const handshake=new Promise((resolve,reject)=>{ready={resolve,reject};});
  host.stderr.on('data',bytes=>fs.appendFileSync(path.join(directory,'host.stderr'),bytes));
  host.on('error',error=>{ready.reject(error);for(const value of pending.values())value.reject(error);});
  host.on('exit',(code,signal)=>{const error=new Error(`Owned Host exited ${code}/${signal}`);ready.reject(error);for(const value of pending.values())value.reject(error);});
  readline.createInterface({input:host.stdout}).on('line',line=>{try{const packet=JSON.parse(line);trace('reply',packet);if(packet.type==='ready')ready.resolve(packet);else{assert.ok(pending.has(packet.id));pending.get(packet.id).resolve(packet);pending.delete(packet.id);}}catch(error){ready.reject(error);for(const value of pending.values())value.reject(error);}});
  assert.equal((await deadline(handshake,'Host ready')).protocol_version,1);
  const envConfig={rscript,storage_root:materials,timeout_seconds:90},rConfig={ark,r_home:rhome,execution_timeout_seconds:90};
  const env=await activate(envRevision,'environment',envConfig);
  const planned=success(await invoke('plan','environment.plan',{binding:await resolve(env,'environment.plan',2),arguments:{manager:'pak',packages:['local::pkg']}},2));
  const realized=success(await invoke('realize','environment.realize',{binding:await resolve(env,'environment.realize',2),arguments:{plan_operation_id:planned.operation.operation_id}},2));
  const receipt=await retained(realized.output.report);
  const selection={binding:await resolve(env,'environment.library',2),realization:realized.operation.operation_id};
  const original=await activate(rRevision,'original-r',rConfig);
  const createArgs=async(instance,selected=selection)=>({binding:await resolve(instance,'r.create_session',2),arguments:{environment:selected}});
  await assert.rejects(()=>createArgs(original).then(args=>invoke('no-grant','r.create_session',args,2)),/grant|scope|selected/i);
  assert.equal((await native(original,'r.session')).state,'unstarted');
  const oldSession=success(await invoke('default-create','r.create_session',{binding:await resolve(original,'r.create_session'),arguments:{}})).output.session_id;
  await run(original,oldSession,'old_sentinel <- 99L; stopifnot(!'+JSON.stringify(receipt.library_path)+' %in% .libPaths()); 99L');
  const optional=[{id:'environment.library',version:2},{id:'environment.verify',version:2},{id:'resources.read',version:1}];
  const current=await activate(branch,'bound-r',rConfig,optional);
  const args=await createArgs(current);
  const prepared=await native(current,'r.prepare_environment',{capability:{id:'r.create_session',version:2},arguments:args.arguments,target:null,preconditions:null},2);
  assert.equal(prepared.owner_context.environment.realization,realized.operation.operation_id);
  assert.equal((await native(current,'r.session')).state,'unstarted','Preflight must not create R or load namespaces');
  const description=path.join(receipt.library_path,'rhonextfixture/DESCRIPTION'),originalBytes=fs.readFileSync(description);
  fs.appendFileSync(description,'\nTampered: yes\n');
  await assert.rejects(()=>invoke('changed-library','r.create_session',args,2),/bytes changed|selection|digest/i);
  assert.equal((await native(current,'r.session')).state,'unstarted');fs.writeFileSync(description,originalBytes);
  const created=success(await invoke('bound-create','r.create_session',args,2));
  assert.deepEqual(await invoke('bound-create','r.create_session',args,2),created);
  const session=created.output.session_id,bound=created.output.environment;
  assert.equal(bound.selection.realization,realized.operation.operation_id);assert.deepEqual(bound.source.provider,env);
  const verification=await call('get_operation',{operation_id:bound.verification});
  assert.equal(verification.operation.causation_id,created.operation.operation_id);assert.equal(verification.status,'succeeded');
  assert.equal((await retained(bound.verification_report)).verified,true);
  assert.equal((await run(current,session,'stopifnot(!exists("old_sentinel",inherits=FALSE), '+JSON.stringify(receipt.library_path)+' %in% .libPaths(), identical(rhonextfixture::fixture_answer(),42L)); 42L')).value,42);
  assert.equal((await run(original,oldSession,'old_sentinel')).value,99);
  await release(env);
  assert.equal((await run(current,session,'rhonextfixture::fixture_answer()')).value,42,'Releasing Environment cannot end an existing R session');
  const replacement=await activate(envRevision,'replacement-environment',envConfig);
  const replacementSelection={binding:await resolve(replacement,'environment.library',2),realization:realized.operation.operation_id};
  const failedR=await activate(branch,'namespace-failure',rConfig,optional);
  fs.writeFileSync(path.join(project,'fail-load.flag'),'test-owned marker');
  const failedArgs=await createArgs(failedR,replacementSelection);
  const failed=await invoke('failed-native-verification','r.create_session',failedArgs,2);
  assert.equal(failed.status,'failed',JSON.stringify({status:failed.status,error:failed.error,recovery:failed.recovery}));
  const failedState=await native(failedR,'r.session');assert.equal(failedState.session_id,null);assert.equal(failedState.state,'environment_failed');
  assert.equal(failed.recovery.kind,'plugin_owner_recovery');
  const child=await call('get_operation',{operation_id:failed.recovery.data.verification_operation});
  assert.equal(child.status,'failed');assert.equal(child.operation.causation_id,failed.operation.operation_id);
  assert.deepEqual(await invoke('failed-native-verification','r.create_session',failedArgs,2),failed);
  fs.unlinkSync(path.join(project,'fail-load.flag'));await release(failedR);
  const next=await activate(branch,'replacement-bound-r',rConfig,optional);
  const nextCreated=success(await invoke('replacement-create','r.create_session',await createArgs(next,replacementSelection),2));
  assert.deepEqual(nextCreated.output.environment.source.provider,env);
  assert.deepEqual(nextCreated.output.environment.selection.binding.provider,replacement);
  assert.notEqual(nextCreated.output.session_id,session);
  assert.deepEqual((await native(current,'r.session')).environment,bound,'An existing session retains its original Environment binding');
  assert.equal((await run(next,nextCreated.output.session_id,'rhonextfixture::fixture_answer()')).value,42);
  assert.equal((await run(original,oldSession,'old_sentinel')).value,99);
  for(const instance of [...instances].reverse())await release(instance);
  assert.equal((await retained(bound.verification_report)).verified,true);
  host.stdin.end();assert.equal((await deadline(exited,'Host shutdown',15000)).code,0);
  assert.equal(digest(fs.readFileSync(binary)),originalHost);complete=true;
  console.log(`Independent R/Environment acceptance passed explicit optional grants, query purity, digest refusal, delegated native verification, immutable parent/child records, original idempotency, default/bound version coexistence, namespace failure without R startup, replacement providers and retained reports. Unchanged Host ${originalHost}`);
}finally{
  if(!complete&&host&&host.exitCode===null&&host.signalCode===null)for(const instance of [...instances].reverse()){
    try{await release(instance);}catch(error){console.error(`Owned instance cleanup remains unconfirmed (${instance.instance}): ${error.message}`);}
  }
  if(host&&host.exitCode===null&&host.signalCode===null){host.stdin.end();host.kill('SIGTERM');await deadline(exited,'Owned Host cleanup',15000);}
  const recovery=path.join(materials,'recovery');if(fs.existsSync(recovery))for(const name of fs.readdirSync(recovery)){if(!name.endsWith('.json'))continue;const marker=JSON.parse(fs.readFileSync(path.join(recovery,name),'utf8'));if(marker.project_root!==project)continue;const cleaned=spawnSync(rscript,['--vanilla','-e','ps::ps_kill_tree(commandArgs(TRUE)[[1L]])',marker.marker],{timeout:10000,stdio:'ignore'});assert.equal(cleaned.status,0,'Test-owned Environment process cleanup failed');}
  if(complete)fs.rmSync(directory,{recursive:true,force:true});else console.error(`R/Environment acceptance evidence retained at ${directory}`);
}
