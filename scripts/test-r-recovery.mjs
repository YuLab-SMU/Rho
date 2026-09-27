// Real native recovery through independent ordinary packages and an unchanged Host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(process.env.RHO_ARK&&process.env.RHO_R_HOME&&process.env.RHO_CHECKPOINT_HELPER,'Select existing verified Ark, R and recovery helper; no tools are installed.');
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-r-recovery-')));
const project=path.join(directory,'project');fs.mkdirSync(project);
const database=path.join(directory,'host.sqlite'),binary=process.env.RHO_TEST_BINARY??path.join(root,'target/debug/rho');
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex'),originalHost=digest(fs.readFileSync(binary));
const configuration={ark:fs.realpathSync(process.env.RHO_ARK),r_home:fs.realpathSync(process.env.RHO_R_HOME),checkpoint_helper_path:fs.realpathSync(process.env.RHO_CHECKPOINT_HELPER),execution_timeout_seconds:30};
const optional=['operation.get','operation.list_recent','resources.read','operation.project_coverage'].map(id=>({id,version:1}));
let host,exited,ready,complete=false,counter=0;
const pending=new Map(),instances=[];
const trace=(kind,value)=>fs.appendFileSync(path.join(directory,'session.jsonl'),JSON.stringify({kind,value})+'\n');
function deadline(promise,label,ms=180000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),ms);})]).finally(()=>clearTimeout(timer));}
async function call(method,params){const id=`request-${++counter}`,result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));host.stdin.write(JSON.stringify({id,request:{method,params}})+'\n');const reply=await deadline(result,`${method} ${id}`);assert.equal(reply.ok,true,JSON.stringify(reply.error));return reply.result;}
async function query(id,args){const result=await call('query_snapshot',{capability:{id,version:1},arguments:args});assert.equal(result.status,'ready',JSON.stringify(result));return result.data;}
const invoke=(request,id,args)=>call('invoke',{client_request_id:request,capability:{id,version:1},arguments:args,preconditions:[]});
const success=result=>{assert.equal(result.status,'succeeded',JSON.stringify({status:result.status,error:result.error,recovery:result.recovery}));return result;};
const resolve=(instance,id)=>query('plugins.resolve',{instance,capability:{id,version:1}});
const native=async(instance,id,args={})=>query(id,{binding:await resolve(instance,id),arguments:args});
const action=async(instance,id,args,request=`action-${++counter}`)=>{const record=await invoke(request,id,{binding:await resolve(instance,id),arguments:args});const state=await native(instance,'r.session');await settled(instance,state.queue_target);return record;};
async function activate(snapshot,alias,grants=optional,config=configuration){const record=success(await invoke(`activate-${alias}`,'plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:'aarch64-apple-darwin',alias,configuration:config,optional_capabilities:grants}));const instance=record.output.instance.identity;instances.push(instance);return instance;}
async function release(instance){success(await invoke(`release-${instance.instance}`,'plugins.release',{instance}));instances.splice(instances.findIndex(item=>item.instance===instance.instance),1);}
const create=async instance=>success(await action(instance,'r.create_session',{})).output.session_id;
const run=async(instance,session,code)=>success(await action(instance,'r.execute',{expected_session:session,code})).output;
async function retained(reference){const parts=[];let offset=0;while(offset<reference.bytes){const chunk=await query('resources.read',{reference,offset,limit:65536});assert.deepEqual(chunk.reference,reference);assert.equal(chunk.offset,offset);const bytes=Buffer.from(chunk.base64,'base64');assert.equal(bytes.length,Math.min(65536,reference.bytes-offset));parts.push(bytes);offset+=bytes.length;assert.equal(chunk.next,offset===reference.bytes?null:offset);}const bytes=Buffer.concat(parts);assert.equal(digest(bytes),reference.digest);return JSON.parse(bytes);}
async function settled(instance,session){
  const end=Date.now()+30000;
  for(;;){const state=await native(instance,'r.console',{expected_session:session});if(state.awaiting_commit.length===0)return state;if(Date.now()>end)throw new Error('Recovery settlement did not arrive within 30 seconds');await new Promise(done=>setTimeout(done,30));}
}
async function resume(instance,session,operations){const state=await settled(instance,session);assert.ok(state.console.pause);await call('control',{capability:{id:'r.resume_queue',version:1},arguments:{binding:{...await resolve(instance,'r.resume_queue'),target:session},arguments:{session_id:session,pause_id:state.console.pause.id,only_operation_ids:operations}}});}
function payload(record){
  const storage=record.operation.admission.owner_context.qualification.storage;
  assert.equal(storage.scope.project_root,project);assert.ok(storage.data_root.startsWith(directory+path.sep),'Only test-owned storage may be changed');
  const key=createHash('sha256').update(record.operation.operation_id).digest('hex');
  const file=path.join(storage.data_root,'r-recovery-v1',key,'payload.rds');assert.ok(fs.existsSync(file));return file;
}
try {
  const source=process.env.RHO_R_PLUGIN_PACKAGE?fs.realpathSync(process.env.RHO_R_PLUGIN_PACKAGE):path.join(directory,'r');
  if(!process.env.RHO_R_PLUGIN_PACKAGE)execFileSync(process.execPath,['scripts/build-r-plugin.mjs',source],{cwd:root,stdio:'inherit'});
  assert.ok(!source.startsWith(root+path.sep),'Use a source package outside the Host checkout');
  assert.equal(digest(fs.readFileSync(binary)),originalHost);
  const snapshot=source=>JSON.parse(execFileSync(binary,['--database',database,'--project',project,'plugins','snapshot',source,'--target','aarch64-apple-darwin'],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024})).result;
  const revision=snapshot(source);
  // Keep the registered contract unchanged and fault only the outgoing result.
  // The real owner has completed native capture and resource retention, while
  // the core must refuse the malformed plan and keep its own original outcome.
  const rejectedPackage=path.join(directory,'rejected-output-package');fs.cpSync(source,rejectedPackage,{recursive:true});
  const faultSource='#!'+process.execPath+'\n'+String.raw`
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const child=spawn(fileURLToPath(new URL('./rho-r-backend',import.meta.url)),[],{stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});
let buffered=Buffer.alloc(0);
child.stdout.on('data',chunk=>{
  buffered=Buffer.concat([buffered,chunk]);
  while(buffered.length>=4){const size=buffered.readUInt32BE(0);if(size===0||size>1048576)throw new Error('Invalid test backend frame');if(buffered.length<size+4)break;
    const frame=JSON.parse(buffered.subarray(4,size+4));buffered=buffered.subarray(size+4);
    if(frame.body.type==='commit_plan'&&frame.body.data.output?.reference&&frame.body.data.output?.manifest)frame.body.data.output={invalid_checkpoint_output:true};
    const encoded=Buffer.from(JSON.stringify(frame)),header=Buffer.alloc(4);header.writeUInt32BE(encoded.length);process.stdout.write(Buffer.concat([header,encoded]));
  }
});
child.on('error',error=>{console.error(error);process.exit(1);});
child.on('close',code=>{process.stdin.destroy();process.stdout.write(Buffer.alloc(0),()=>process.exit(code??1));});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
`;
  fs.writeFileSync(path.join(rejectedPackage,'recovery-fault.mjs'),faultSource);
  fs.writeFileSync(path.join(rejectedPackage,'dist/recovery-fault.mjs'),faultSource,{mode:0o755});
  fs.appendFileSync(path.join(rejectedPackage,'build.mjs'),'\nfs.copyFileSync(path.join(root,"recovery-fault.mjs"),path.join(root,"dist/recovery-fault.mjs"));\nfs.chmodSync(path.join(root,"dist/recovery-fault.mjs"),0o755);\n');
  const manifest=JSON.parse(fs.readFileSync(path.join(rejectedPackage,'plugin.json'),'utf8'));manifest.version='0.1.1';manifest.backend.executable='dist/recovery-fault.mjs';manifest.source.files.push('recovery-fault.mjs');
  fs.writeFileSync(path.join(rejectedPackage,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');const rejectedRevision=snapshot(rejectedPackage);
  host=spawn(binary,['--database',database,'--project',project,'session'],{stdio:['pipe','pipe','pipe']});
  exited=new Promise(resolve=>host.once('close',(code,signal)=>resolve({code,signal})));
  const handshake=new Promise((resolve,reject)=>{ready={resolve,reject};});
  host.stderr.on('data',bytes=>fs.appendFileSync(path.join(directory,'host.stderr'),bytes));
  host.on('error',error=>{ready.reject(error);for(const item of pending.values())item.reject(error);});
  host.on('exit',(code,signal)=>{const error=new Error(`Owned Host exited ${code}/${signal}`);ready.reject(error);for(const item of pending.values())item.reject(error);});
  readline.createInterface({input:host.stdout}).on('line',line=>{try{const packet=JSON.parse(line);trace('reply',packet);if(packet.type==='ready')ready.resolve(packet);else{assert.ok(pending.has(packet.id));pending.get(packet.id).resolve(packet);pending.delete(packet.id);}}catch(error){ready.reject(error);for(const item of pending.values())item.reject(error);}});
  assert.equal((await deadline(handshake,'Host ready')).protocol_version,1);
  const noGrant=await activate(revision,'without-read-grants',[]);
  await assert.rejects(()=>native(noGrant,'r.checkpoints',{limit:20}),/grant|scope|selected/i);
  assert.equal((await native(noGrant,'r.session')).state,'unstarted');await release(noGrant);
  const noHelper=await activate(revision,'without-helper',optional,{ark:configuration.ark,r_home:configuration.r_home});
  assert.equal((await native(noHelper,'r.session')).checkpoint_available,false);
  const noHelperSession=await create(noHelper);assert.equal((await native(noHelper,'r.session')).checkpoint_available,false);
  await assert.rejects(()=>action(noHelper,'r.capture_checkpoint',{expected_session:noHelperSession}),/component|recovery/i);await release(noHelper);

  const original=await activate(revision,'original');
  const empty=await native(original,'r.checkpoints',{limit:20});assert.deepEqual(empty.checkpoints,[]);
  assert.equal((await native(original,'r.session')).state,'unstarted');
  const session=await create(original);assert.equal((await native(original,'r.session')).checkpoint_available,true);
  await run(original,session,'e <- new.env(parent=emptyenv()); e$value <- 42L; 中文 <- e; alias <- e; makeActiveBinding("active",function() stop("active binding must not be forced"),.GlobalEnv); 42L');
  const captured=success(await action(original,'r.capture_checkpoint',{expected_session:session,include_names:['中文','alias','active'],max_seconds:10,automatic:true},'original-capture'));
  const copy=captured.output,reference=copy.reference,full=await retained(copy.manifest);
  assert.equal(reference.operation_id,captured.operation.operation_id);assert.deepEqual(reference.provider,original);
  assert.equal(full.reference.digest,reference.digest);assert.equal(full.native_session_id,session);
  assert.ok(full.report.saved_names.includes('中文'));assert.ok(full.report.saved_names.includes('alias'));
  assert.ok(full.report.skipped.some(item=>item.name==='active'));assert.equal(copy.coverage,'partial');
  assert.equal(full.libraries.complete,true);assert.deepEqual(full.libraries.library_paths,full.report.library_paths);
  assert.deepEqual(await action(original,'r.capture_checkpoint',{expected_session:session,include_names:['中文','alias','active'],max_seconds:10,automatic:true},'original-capture'),captured);
  assert.equal((await native(original,'r.checkpoint',{reference})).payload,'present');
  await call('control',{capability:{id:'r.pause_queue',version:1},arguments:{binding:{...await resolve(original,'r.pause_queue'),target:session},arguments:{session_id:session,pause_id:null}}});
  const queued=await call('invoke',{client_request_id:'cancel-pending-capture',capability:{id:'r.capture_checkpoint',version:1},arguments:{binding:await resolve(original,'r.capture_checkpoint'),arguments:{expected_session:session}},preconditions:[],return_after_acceptance:true});
  await call('request_cancellation',{operation_id:queued.operation.operation_id,only_if_pending:true});
  let cancelled;const cancelDeadline=Date.now()+30000;
  do {cancelled=await call('get_operation',{operation_id:queued.operation.operation_id});if(cancelled.status==='cancelled')break;if(Date.now()>cancelDeadline)throw new Error('Pending capture cancellation was not confirmed');await new Promise(done=>setTimeout(done,30));} while(true);
  assert.equal(cancelled.output.started,false);await resume(original,session,[queued.operation.operation_id]);
  await release(original);

  const narrow=await activate(revision,'without-coverage',optional.filter(item=>item.id!=='operation.project_coverage'));
  await assert.rejects(()=>native(narrow,'r.checkpoint',{reference}),/coverage|grant/i);
  assert.equal((await native(narrow,'r.session')).state,'unstarted');await release(narrow);
  const replacement=await activate(revision,'replacement');
  assert.equal((await native(replacement,'r.checkpoint',{reference})).deleted,false);
  const parts=[];let offset=0;
  do {const chunk=await native(replacement,'r.read_checkpoint',{reference,offset,limit:256});assert.deepEqual(chunk.reference,reference);assert.equal(chunk.offset,offset);const bytes=Buffer.from(chunk.base64,'base64');parts.push(bytes);offset+=bytes.length;assert.equal(chunk.next,offset===reference.bytes?null:offset);} while(offset<reference.bytes);
  assert.equal(digest(Buffer.concat(parts)),reference.digest);
  await assert.rejects(()=>native(replacement,'r.read_checkpoint',{reference:{...reference,bytes:reference.bytes+1},offset:0,limit:1}),/reference|original/i);
  await assert.rejects(()=>native(replacement,'r.read_checkpoint',{reference,offset:0,limit:65537}),/65536|limit|schema/i);
  assert.equal((await native(replacement,'r.session')).state,'unstarted','Old-copy observations never start R');
  const restoredSession=await create(replacement),before=await native(replacement,'r.inspection_state',{expected_session:restoredSession});
  const restored=success(await action(replacement,'r.restore_checkpoint',{expected_session:restoredSession,reference}));
  assert.equal(restored.output.restored_count,2);assert.deepEqual(restored.output.reference,reference);assert.ok((await retained(restored.output.report)).restored_names.includes('中文'));
  assert.notEqual((await native(replacement,'r.inspection_state',{expected_session:restoredSession})).cache_key,before.cache_key);
  assert.equal((await run(replacement,restoredSession,'stopifnot(identical(中文,alias),identical(中文$value,42L),!exists("active",inherits=FALSE)); 42L')).value,42);
  const nonempty=await action(replacement,'r.restore_checkpoint',{expected_session:restoredSession,reference});assert.notEqual(nonempty.status,'succeeded');
  await resume(replacement,restoredSession,[nonempty.operation.operation_id]);
  assert.equal((await run(replacement,restoredSession,'中文$value')).value,42);
  await release(replacement);

  const integrity=await activate(revision,'integrity');const integritySession=await create(integrity);
  const file=payload(captured),originalBytes=fs.readFileSync(file),changed=Buffer.from(originalBytes);changed[changed.length-1]^=1;fs.writeFileSync(file,changed);
  const tampered=await action(integrity,'r.restore_checkpoint',{expected_session:integritySession,reference});assert.equal(tampered.status,'failed');assert.match(tampered.error,/integrity|digest/i);fs.writeFileSync(file,originalBytes);
  await resume(integrity,integritySession,[tampered.operation.operation_id]);
  assert.equal((await run(integrity,integritySession,'exists("中文",inherits=FALSE)')).value,false);
  await release(integrity);

  const manager=await activate(revision,'manager');
  const pin=success(await action(manager,'r.pin_checkpoint',{reference,expected_control:null,pinned:true}));
  assert.equal((await native(manager,'r.checkpoint',{reference})).pinned,true);
  await assert.rejects(()=>action(manager,'r.delete_checkpoint',{reference,expected_control:pin.operation.operation_id}),/Unpin|pinned/i);
  await assert.rejects(()=>action(manager,'r.pin_checkpoint',{reference,expected_control:null,pinned:false}),/precondition/i);
  const unpin=success(await action(manager,'r.pin_checkpoint',{reference,expected_control:pin.operation.operation_id,pinned:false}));
  const deleted=success(await action(manager,'r.delete_checkpoint',{reference,expected_control:unpin.operation.operation_id}));
  assert.equal(deleted.output.deleted,true);assert.equal(deleted.output.payload_removed,undefined);
  const observed=await native(manager,'r.checkpoint',{reference});assert.equal(observed.deleted,true);assert.equal(observed.payload,'missing');
  success(await action(manager,'r.purge_checkpoint',{reference,deletion_operation_id:deleted.operation.operation_id}));
  await assert.rejects(()=>native(manager,'r.read_checkpoint',{reference,offset:0,limit:1}),/deleted/i);
  assert.equal((await retained(copy.manifest)).reference.digest,reference.digest);
  assert.equal((await native(manager,'r.session')).state,'unstarted','Pin, deletion and cleanup never start R');

  const rejected=await activate(rejectedRevision,'rejected-publication');const rejectedSession=await create(rejected);
  await run(rejected,rejectedSession,'recovered <- 17L; 17L');
  const uncertain=await action(rejected,'r.capture_checkpoint',{expected_session:rejectedSession,max_seconds:10});assert.ok(['failed','uncertain'].includes(uncertain.status));
  const nativeCopy=payload(uncertain);assert.ok(fs.existsSync(path.join(path.dirname(nativeCopy),'context.json')));
  await release(rejected);
  const adopted=success(await action(manager,'r.reconcile_checkpoint',{source_operation_id:uncertain.operation.operation_id}));
  const adoptedManifest=await retained(adopted.output.manifest);
  assert.equal(adoptedManifest.source.operation_id,uncertain.operation.operation_id);assert.deepEqual(adopted.output.reference.provider,manager);
  assert.equal(adoptedManifest.native_session_id,rejectedSession);assert.equal(adoptedManifest.libraries.complete,true);
  assert.equal((await call('get_operation',{operation_id:uncertain.operation.operation_id})).status,uncertain.status);
  assert.equal((await native(manager,'r.session')).state,'unstarted','Reconciliation copies native evidence without replaying R');
  fs.unlinkSync(path.join(path.dirname(nativeCopy),'context.json'));
  const fallback=success(await action(manager,'r.reconcile_checkpoint',{source_operation_id:uncertain.operation.operation_id}));
  const unknown=await retained(fallback.output.manifest);assert.equal(unknown.libraries.complete,false);assert.deepEqual(unknown.libraries.namespace_paths,[]);
  assert.equal(unknown.source.operation_id,uncertain.operation.operation_id);assert.ok(fs.existsSync(nativeCopy),'Adoption never removes the original evidence');
  await assert.rejects(()=>action(manager,'r.reconcile_checkpoint',{source_operation_id:adopted.operation.operation_id}),/terminal|outcome/i);
  const pages=[];let cursor=null;do{const page=await native(manager,'r.checkpoints',{before_cursor:cursor,limit:3});pages.push(...page.checkpoints);cursor=page.next_cursor;}while(cursor!==null);
  assert.ok(pages.some(item=>item.reference.operation_id===reference.operation_id));assert.ok(pages.some(item=>item.reference.operation_id===adopted.output.reference.operation_id));
  const final=await activate(revision,'recovered-session');const finalSession=await create(final);
  success(await action(final,'r.restore_checkpoint',{expected_session:finalSession,reference:adopted.output.reference}));
  assert.equal((await run(final,finalSession,'recovered')).value,17);
  for(const instance of [...instances].reverse())await release(instance);
  host.stdin.end();assert.equal((await deadline(exited,'Host shutdown',15000)).code,0);
  assert.equal(digest(fs.readFileSync(binary)),originalHost);complete=true;
  console.log(`Ordinary R recovery passed: grants, query purity, verified helper, partial Unicode graph, original replay, replacement reads, bounded bytes, full digest refusal, empty-candidate restore, exact pin/deletion chain, physical cleanup, retained history and explicit reconciliation after rejected publication. Unchanged Host ${originalHost}`);
} finally {
  if(!complete&&host&&host.exitCode===null&&host.signalCode===null)for(const instance of [...instances].reverse()){try{await release(instance);}catch(error){console.error(`Owned R instance cleanup unconfirmed (${instance.instance}): ${error.message}`);}}
  if(host&&host.exitCode===null&&host.signalCode===null){host.stdin.end();host.kill('SIGTERM');await deadline(exited,'Owned Host cleanup',15000);}
  if(complete)fs.rmSync(directory,{recursive:true,force:true});else console.error(`R recovery acceptance evidence retained at ${directory}`);
}
