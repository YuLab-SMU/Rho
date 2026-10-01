import assert from 'node:assert/strict';
export async function checkEditorSessions({readSessions,observeSession,EditorController,make,wait}) {
  const provider={plugin:'another.r.provider',instance:'alternate-r',revision:'sha256:'+'e'.repeat(64),artifact:'sha256:'+'f'.repeat(64)};
  const captured=await make('captured=1',true,true);captured.r.providers.set(provider.instance,{provider,session:'alternate-session'});
  const old=captured.controller.runtime.source;await captured.controller.startCode('document');
  const original=structuredClone(captured.controller.code.intent);await captured.controller.selectSession(provider);
  assert.deepEqual(captured.controller.code.intent,original);assert.equal(captured.r.attempts.length,1);
  assert.deepEqual(captured.stored().runtime,provider);captured.finish();await captured.controller.inspectCode();
  await captured.controller.startCode('document');assert.deepEqual(captured.r.attempts[1].args.binding.provider,provider);
  assert.equal(captured.r.attempts[1].args.arguments.expected_session,'alternate-session');
  await captured.controller.pause();captured.controller.stop();captured.client.view={...captured.client.view,view:'reopened-selected-session'};
  const reopened=new EditorController(captured.client,captured.configuration);await reopened.open();assert.deepEqual(reopened.runtime.source,provider);
  captured.finish();await reopened.inspectCode();await reopened.selectSession(old);assert.equal(captured.r.attempts.length,2,'choosing never evaluates');

  const file=await make('file_capture=1',true,true);file.r.providers.set(provider.instance,{provider,session:'alternate-session'});
  await file.controller.saveAndRun('bound.R');await file.controller.selectSession(provider);await file.finishFile();await file.controller.inspectSave();await file.controller.advanceSavedRun();
  assert.deepEqual(file.r.attempts[0].args.binding.provider,old);assert.equal(file.r.attempts[0].args.binding.target,'session');
  assert.deepEqual(file.controller.runtime.source,provider,'the next target and accepted capture have separate identities');

  const notStarted=await make('x=1',true,true);notStarted.r.providers.set(provider.instance,{provider,session:null});
  await notStarted.controller.selectSession(provider);assert.equal(notStarted.r.attempts.length,0);await assert.rejects(notStarted.controller.startCode('document'),/Start the selected/);
  const fixed=await make();await assert.rejects(fixed.controller.selectSession(provider),/not enabled/);assert.equal(fixed.r.queries.length,0);
  const closing=await make('x=1',true,true);closing.r.providers.set(provider.instance,{provider,session:'alternate-session'});
  let release;closing.r.sessionGate=new Promise(resolve=>release=resolve);const choosing=closing.controller.selectSession(provider);
  await wait(()=>closing.r.queries.length>0);const close=closing.controller.pause();release();await assert.rejects(choosing,/preparing to close/);await close;
  assert.deepEqual(closing.stored().runtime,old);
  const invalid=await make('x=1',true,true);await assert.rejects(invalid.controller.selectSession({...provider,revision:'mutable'}),/exact identity/);assert.equal(invalid.r.queries.length,0);

  const calls=[],row=(identity,alias='R session')=>({instance:{identity,alias,project:'project',principal:'principal',state:'active'},observed_in_this_host:true});
  const plain={...provider,instance:'not-r',plugin:'text.tools',revision:'sha256:'+'9'.repeat(64)};
  const busy={...provider,instance:'unavailable-r'},stopped={...provider,instance:'stopped-r'};
  const preview={...provider,instance:'fixture-preview-r'};
  const rows=[row(provider,'分析会话'),row(plain),row(busy),{...row(stopped),observed_in_this_host:false},
    {...row(preview),instance:{...row(preview).instance,purpose:'fixture_preview'}}];
  const capabilities=[{capability:{id:'r.session',version:1},kind:'query'},{capability:{id:'r.execute',version:2},kind:'operation'},{capability:{id:'r.format',version:1},kind:'operation'}];
  const client={view:{project:'project',principal:'principal'},query:async(cap,args)=>{
    calls.push(structuredClone({cap,args}));
    if(cap.id==='plugins.instances')return{status:'ready',data:{instances:rows,next:'next-page'}};
    if(cap.id==='plugins.inspect')return{status:'ready',data:{summary:{revision:args.revision},manifest:{id:args.revision===provider.revision?provider.plugin:plain.plugin,capabilities:args.revision===provider.revision?capabilities:[]}}};
    assert.equal(cap.id,'r.session');if(args.binding.provider.instance==='unavailable-r')throw new Error('disconnected');
    return{status:'ready',data:{state:'unstarted',session_id:null}};
  }};
  const page=await readSessions(client);assert.equal(page.next,'next-page');assert.equal(page.items.length,2);assert.equal(page.items[0].label,'分析会话');
  assert.equal(page.items[0].state,'unstarted');assert.equal(page.items[1].state,'unavailable');assert.equal(calls.filter(call=>call.cap.id==='plugins.inspect').length,2,'same revision inspected once per bounded page');
  assert.equal(calls.filter(call=>call.cap.id==='r.session').length,2);assert.equal(calls[0].args.limit,20);
  await assert.rejects(readSessions(client,'next-page'),/unavailable or incomplete/);
  rows[0].instance.project='other';await assert.rejects(readSessions(client),/another project/);rows[0].instance.project='project';
  rows[0].instance.principal='other';await assert.rejects(readSessions(client),/another project/);rows[0].instance.principal='principal';
  await assert.rejects(observeSession({...client,query:async()=>({status:'ready',data:{state:'idle',session_id:42}})},provider),/could not be observed/);
  console.log('Editor session checks passed: bounded scoped capability discovery, read-only unstarted/unavailable observations, persistent selection, immutable original targets, pending-save continuity and close fences.');
}
