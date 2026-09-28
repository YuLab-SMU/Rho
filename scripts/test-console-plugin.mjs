import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildConsolePlugin} from './build-console-plugin.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-console-unit-'));
try {
  const plugin=buildConsolePlugin(path.join(directory,'console'));
  const {ConsoleModel,runFrom,mergeEvents,addHistory,validateCode,visibleRun}=await import(pathToFileURL(path.join(plugin,'compiled/src/model.js')));
  const {observedText}=await import(pathToFileURL(path.join(plugin,'compiled/src/terminal.js')));
  const {operationRequestId}=await import(pathToFileURL(path.join(plugin,'compiled/public/plugin-ui/index.js')));
  const owner={instance:'r-instance',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
  const reference={owner,resource:'events-resource',digest:'sha256:'+'c'.repeat(64),bytes:20,media_type:'application/json'};
  const source={view_id:'console-view',label:'Console',kind:'console'};
  const record={operation:{operation_id:'original-run',capability:{id:'r.execute',version:2},normalized_arguments:{binding:{provider:owner},arguments:{expected_session:'session',run:{code:'11;22',output_mode:'console',source}}},accepted_at_ms:42},status:'succeeded',cancellation_requested:false,output:{operation_id:'original-run',session_id:'session',events:reference,source}};
  const run=runFrom(record,owner);assert.equal(run.id,'original-run');assert.equal(run.code,'11;22');
  assert.equal(runFrom(record,{...owner,revision:'sha256:'+'d'.repeat(64)}),null);
  const unknown=structuredClone(record);unknown.operation.capability.version=3;assert.equal(runFrom(unknown,owner),null);
  for(const field of ['operation_id','session_id']) {const wrong=structuredClone(record);wrong.output[field]='other';assert.throws(()=>runFrom(wrong,owner));}
  const forged=structuredClone(record);forged.output.events.owner={...owner,instance:'other'};assert.throws(()=>runFrom(forged,owner));
  const wrongSource=structuredClone(record);wrongSource.output.source={...wrongSource.output.source,label:'file.R'};assert.throws(()=>runFrom(wrongSource,owner),/source/);
  const cancelled=structuredClone(record);cancelled.status='cancelled';cancelled.output={operation_id:'original-run',started:false};assert.equal(runFrom(cancelled,owner).retained,null);
  const event=(sequence,text)=>({operation_id:'original-run',sequence,kind:'stdout',text,media:null,observed_at_ms:sequence});
  const page=events=>({operation_id:'original-run',events,next_sequence:events.at(-1)?.sequence??0,has_more:false,gap:false,truncated:false,notices:[]});
  mergeEvents(run,page([event(1,'中文\n')]));mergeEvents(run,page([event(1,'中文\n'),event(2,'[1] 22\n')]));
  assert.equal(run.events.map(event=>event.text).join(''),'中文\n[1] 22\n','retained completion does not duplicate live text');
  const retainedEvents=run.events;mergeEvents(run,page([event(1,'中文\n'),event(2,'[1] 22\n')]));assert.equal(run.events,retainedEvents);
  assert.equal(observedText('rolling',[event(1,'old'),event(2,' text')]).text,'old text');
  assert.equal(observedText('rolling',[event(2,' text'),event(3,' window')]).text,' text window','bounded stream retention resets its terminal cache');
  assert.throws(()=>mergeEvents(run,page([event(1,'changed')])));
  assert.throws(()=>mergeEvents(run,page([event(3,'a'),event(2,'b')])));
  assert.throws(()=>mergeEvents(run,{...page([event(3,'a')]),operation_id:'foreign'}));
  assert.throws(()=>validateCode('中'.repeat(100000)));assert.throws(()=>validateCode('1\0'));validateCode('中文 <- 42');
  assert.deepEqual(addHistory(['1','2'],'2'),['1','2']);assert.ok(addHistory(['中'.repeat(40000)],'文'.repeat(40000)).length===1);
  const calls=[],saved=[];
  let release;
  const client={view:{view:'console-view',project:'project',state:{input:'11;22'}},setState:async state=>{saved.push(structuredClone(state));return state;},
    invoke:async(cap,args,options)=>{calls.push({cap,args,options});await new Promise(done=>release=done);return {...record,status:'accepted',output:null};},
    control:async(cap,args)=>{calls.push({cap,args});return {accepted:true};},dispose:()=>{}};
  const model=new ConsoleModel(client,owner);model.session={state:'idle',session_id:'session',queue_target:'session'};
  await assert.rejects(()=>model.submit(),/Observe this R instance/);assert.equal(model.state.submission,null);
  model.liveAvailable=true;
  const sending=model.submit();await new Promise(done=>setImmediate(done));
  assert.ok(saved[0].submission.request);assert.equal(saved[0].submission.code,'11;22');
  model.state.input='new draft 中文';release();await sending;
  assert.equal(model.state.input,'new draft 中文','acceptance never overwrites newer edits');
  assert.equal(model.state.submission,null);assert.deepEqual(model.state.history,['11;22']);
  assert.equal(calls[0].args.binding.provider.revision,owner.revision);assert.equal(calls[0].args.binding.target,'session');
  assert.equal(calls[0].options.requestId,saved[0].submission.request);
  const another=new ConsoleModel({...client,view:{...client.view,view:'another-view',state:{...saved[0]}}},owner);
  await assert.rejects(()=>another.submit(true),/another view/);
  assert.equal(calls.filter(call=>call.cap.id==='r.execute').length,1,'copying state cannot replay an unconfirmed original through another caller');
  const captured=structuredClone(saved[0].submission),lookup=await operationRequestId(captured.view,captured.request);
  const recoveredRecord={...record,status:'accepted',output:null,operation:{...record.operation,
    caller:{kind:'plugin',id:captured.view},client_request_id:lookup,preconditions:[],
    normalized_arguments:{...structuredClone(calls[0].args),preconditions:null}}};
  const observations=[],recoverySaves=[];
  let observed=recoveredRecord,listed=[{operation_id:'original-run'}],completeness='complete',failRecoverySave=false;
  const recoveryClient={...client,view:{...client.view,view:'replacement-view',state:{...saved[0],input:'new draft after reopening'}},
    invoke:async()=>{throw new Error('Recovery must never invoke');},control:async()=>{throw new Error('Recovery must never control');},
    query:async(cap,args)=>{
      observations.push({cap,args});
      if(cap.id==='operation.list_recent'){
        assert.deepEqual(args,{client_request_id:lookup,limit:2});
        return {status:'ready',completeness,data:{operations:listed,next_cursor:null}};
      }
      assert.equal(cap.id,'operation.get');assert.deepEqual(args,{operation_id:'original-run'});
      return {status:'ready',completeness:'complete',data:{record:observed}};
    },setState:async state=>{if(failRecoverySave)throw new Error('Recovery state not saved');recoverySaves.push(structuredClone(state));return state;}};
  const recovery=new ConsoleModel(recoveryClient,owner);
  assert.equal(recovery.liveAvailable,false,'original admission inspection does not need a live R session');
  const found=await recovery.recoverSubmission();assert.equal(found.id,'original-run');
  assert.equal(recovery.state.submission,null);assert.equal(recovery.state.input,'new draft after reopening');
  assert.deepEqual(recovery.state.history,['11;22']);assert.equal(recoverySaves.at(-1).submission,null);
  assert.deepEqual(observations.map(item=>item.cap.id),['operation.list_recent','operation.get']);
  for(const mutate of [
    value=>value.operation.caller.id='foreign-view',
    value=>value.operation.client_request_id='another-request',
    value=>value.operation.operation_id='another-operation',
    value=>value.operation.capability.version=1,
    value=>value.operation.normalized_arguments.binding.project='another-project',
    value=>value.operation.normalized_arguments.binding.target='another-session',
    value=>value.operation.normalized_arguments.arguments.run.code='different code',
    value=>value.operation.normalized_arguments.arguments.run.output_mode='script',
    value=>value.operation.normalized_arguments.arguments.run.source.view_id='another-view',
    value=>value.operation.preconditions=[{forged:true}],
    value=>value.status='unknown',
  ]) {
    observed=structuredClone(recoveredRecord);mutate(observed);
    const refused=new ConsoleModel(recoveryClient,owner),before=structuredClone(refused.state);
    await assert.rejects(()=>refused.recoverSubmission(),/original Console submission/);
    assert.deepEqual(refused.state,before,'a foreign or malformed observation retains the original request and draft');
  }
  observed=recoveredRecord;
  for(const result of [[],[{operation_id:'original-run'},{operation_id:'duplicate'}]]) {
    listed=result;const missing=new ConsoleModel(recoveryClient,owner);
    await assert.rejects(()=>missing.recoverSubmission(),/No unique original run/);
    assert.deepEqual(missing.state.submission,captured);
  }
  listed=[{operation_id:'original-run'}];completeness='partial';
  const partial=new ConsoleModel(recoveryClient,owner);await assert.rejects(()=>partial.recoverSubmission(),/No unique original run/);
  assert.deepEqual(partial.state.submission,captured);completeness='complete';
  failRecoverySave=true;const unsaved=new ConsoleModel(recoveryClient,owner);
  await assert.rejects(()=>unsaved.recoverSubmission(),/Recovery state not saved/);
  assert.deepEqual(unsaved.state.submission,captured);assert.equal(unsaved.state.input,'new draft after reopening');
  failRecoverySave=false;await unsaved.recoverSubmission();assert.equal(unsaved.state.submission,null);
  let releaseObservation,observationStarted;
  let reachedObservation=new Promise(done=>observationStarted=done);
  const delayedClient={...recoveryClient,query:async(cap,args)=>{
    const value=await recoveryClient.query(cap,args);
    if(cap.id==='operation.get')await new Promise(done=>{releaseObservation=done;observationStarted();});
    return value;
  }};
  const editedDuringRead=new ConsoleModel(delayedClient,owner),reading=editedDuringRead.recoverSubmission();
  await reachedObservation;editedDuringRead.state.input='typed while observing 原始结果';releaseObservation();await reading;
  assert.equal(editedDuringRead.state.input,'typed while observing 原始结果');
  assert.equal(recoverySaves.at(-1).input,'typed while observing 原始结果');
  reachedObservation=new Promise(done=>observationStarted=done);
  const replacedDuringRead=new ConsoleModel(delayedClient,owner),staleRead=replacedDuringRead.recoverSubmission();
  await reachedObservation;replacedDuringRead.state.submission={...captured,request:crypto.randomUUID()};
  releaseObservation();await assert.rejects(()=>staleRead,/saved submission changed/);
  assert.notEqual(replacedDuringRead.state.submission.request,captured.request,'an old observation cannot clear a replacement request');
  const retryCalls=[];let failSave=true;
  const retryModel=new ConsoleModel({...client,setState:async state=>{retryCalls.push('save');if(failSave)throw new Error('storage unavailable');return state;},
    invoke:async()=>{retryCalls.push('invoke');return {...record,status:'accepted',output:null};}},owner);
  retryModel.session=model.session;retryModel.liveAvailable=true;
  await assert.rejects(()=>retryModel.submit(),/storage unavailable/);assert.deepEqual(retryCalls,['save']);
  const originalRequest=retryModel.state.submission.request;
  await assert.rejects(()=>retryModel.submit(true),/storage unavailable/);assert.deepEqual(retryCalls,['save','save']);
  assert.equal(retryModel.state.submission.request,originalRequest);failSave=false;
  await retryModel.submit(true);assert.deepEqual(retryCalls,['save','save','save','invoke','save']);
  await model.cancel('original-run',true);assert.equal(calls.at(-1).cap.id,'operation.request_cancellation');assert.equal(calls.at(-1).args.only_if_pending,true);
  const request={session_id:'session',operation_id:'original-run',request_id:'native-input',prompt:'Password',password:true,submitted:false};
  model.queue={console:{session_id:'session',current:null,pending:[],pause:null,input:request},awaiting_commit:[],accepting:true,capacity:33};
  await model.respond(request,'secret-中文');assert.ok(!JSON.stringify(saved).includes('secret-中文'));assert.ok(!JSON.stringify(model.state).includes('secret-中文'));
  assert.equal(calls.at(-1).args.arguments.request_id,'native-input');
  const live={...run,status:'running'};model.runs.set(live.id,live);model.clearView();
  assert.equal(visibleRun(live,model.state),null,'Clear View hides already observed output');
  mergeEvents(live,page([event(3,'new after clear\n')]));
  assert.deepEqual(visibleRun(live,model.state),{events:[event(3,'new after clear\n')],showCode:false},'new output from the same run still appears without cleared code');
  const reopened=new ConsoleModel({...client,view:{...client.view,state:structuredClone(model.state)}},owner);
  assert.deepEqual(visibleRun(live,reopened.state),visibleRun(live,model.state));
  model.showHistory();assert.equal(visibleRun(live,model.state).events.length,3);assert.equal(visibleRun(live,model.state).showCode,true);
  const records=Array.from({length:126},(_,i)=>({...record,status:i===0?'running':'succeeded',output:null,
    operation:{...record.operation,operation_id:`history-${i}`,accepted_at_ms:i}}));
  let listCalls=0;
  const historyClient={...client,query:async(cap,args)=> {
    if(cap.id==='operation.get')return {data:{record:records.find(record=>record.operation.operation_id===args.operation_id)}};
    listCalls++;
    const before=args.before_cursor??records.length;
    const page=records.slice(Math.max(0,before-25),before).reverse();
    return {data:{operations:page.map(record=>record.operation),next_cursor:before>25?before-25:null}};
  }};
  const historyModel=new ConsoleModel(historyClient,owner);
  await historyModel.inspect('history-0');await historyModel.history();
  for(let i=0;i<3;i++)await historyModel.history(true);
  assert.equal(historyModel.runs.size,101);assert.ok(historyModel.runs.has('history-125'));assert.ok(historyModel.runs.has('history-0'));
  assert.equal(historyModel.historyLimited,true);const fullCalls=listCalls;
  await historyModel.history(true);assert.equal(listCalls,fullCalls,'a full transcript does not drop recent work to load an undisplayable page');
  await historyModel.history();assert.equal(historyModel.runs.size,101);assert.ok(historyModel.runs.has('history-125'));
  const exhausted=new ConsoleModel(historyClient,owner);exhausted.historyLoaded=true;exhausted.cursor=null;
  const exhaustedCalls=listCalls;await exhausted.history(true);assert.equal(listCalls,exhaustedCalls,'the end of history never restarts the first page');
  const sparse=[{...record,output:null},...Array.from({length:60},()=>({operation:{operation_id:'view-state',capability:{id:'views.update',version:1}}}))];
  let sparsePages=0;
  const sparseModel=new ConsoleModel({...client,query:async(cap,args)=>{
    if(cap.id==='operation.get')return {data:{record:sparse[0]}};
    sparsePages++;const before=args.before_cursor??sparse.length;
    return {data:{operations:sparse.slice(Math.max(0,before-25),before).reverse().map(record=>record.operation),next_cursor:before>25?before-25:null}};
  }},owner);
  await sparseModel.history();assert.equal(sparsePages,3);assert.ok(sparseModel.runs.has('original-run'),'view-state records do not hide retained R history on reopen');
  assert.equal(fs.existsSync(path.join(plugin,'node_modules')),false,'borrowed tools never become package paths');
  assert.match(fs.readFileSync(path.join(plugin,'dist/THIRD-PARTY-NOTICES.txt'),'utf8'),/@codemirror\/view/);
  console.log('Independent Console build and original run, source, event, draft, cancellation and transient-input checks passed.');
} finally {fs.rmSync(directory,{recursive:true,force:true});}
