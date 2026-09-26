import assert from 'node:assert/strict';

export async function checkEditorCode({EditorController,fixture,sdk,history,undo,StateEffect}) {
  const clone=value=>structuredClone(value),encode=text=>new TextEncoder().encode(text);
  const source={plugin:'org.rho.r',instance:'r-selected',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
  const wait=async condition=>{for(let i=0;i<2000&&!condition();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(condition());};
  const edit=(controller,text)=>controller.document.update(controller.document.state.update({changes:{from:0,to:controller.document.state.doc.length,insert:text},userEvent:'input.type'}));
  const make=async(initial='x=1\ny=2')=>{
    const f=await fixture(true);f.controller.stop();
    const state={records:[],attempts:[],session:'session',sessionGate:null,admissionGate:null,readGate:null,lost:false,queries:[]};
    const query=f.client.query,invoke=f.client.invoke,operation=f.client.operation;
    f.client.query=async(cap,args)=>{
      state.queries.push(clone({cap,args}));
      if(cap.id==='r.session'){
        assert.deepEqual(args,{binding:{provider:source,capability:cap,project:'project',target:null},arguments:{}});
        if(state.sessionGate)await state.sessionGate;
        return{status:'ready',data:{session_id:state.session}};
      }
      if(cap.id==='operation.get'){
        const record=state.records.find(record=>record.operation.operation_id===args.operation_id);
        if(record){if(state.readGate)await state.readGate;return{status:'ready',data:{record:clone(record)}};}
      }
      const page=await query(cap,args);
      if(cap.id==='operation.list_recent')page.data.operations.push(...state.records.filter(record=>record.operation.client_request_id===args.client_request_id).map(record=>clone(record.operation)));
      return page;
    };
    f.client.invoke=async(cap,args,options)=>{
      if(!['r.execute','r.format'].includes(cap.id))return invoke(cap,args,options);
      state.attempts.push(clone({cap,args,options}));assert.deepEqual(f.stored().code.intent.arguments,args,'code and exact request are synchronized before native admission');
      assert.equal(f.stored().code.intent.request,options.requestId);
      assert.deepEqual(args.binding.provider,source);assert.equal(args.binding.target,'session');
      const request=await sdk.operationRequestId(f.client.view.view,options.requestId);
      let record=state.records.find(record=>record.operation.client_request_id===request);
      if(!record){record={operation:{operation_id:'r-native-'+state.records.length,caller:{kind:'plugin',id:f.client.view.view},client_request_id:request,capability:clone(cap),normalized_arguments:{...clone(args),preconditions:args.preconditions??null},preconditions:[]},status:'accepted',outcome:null,output:null,error:null};state.records.push(record);}
      if(state.admissionGate)await state.admissionGate;
      if(state.lost){state.lost=false;throw new Error('R admission acknowledgement lost');}
      return clone(record);
    };
    f.client.operation=async id=>{const record=state.records.find(record=>record.operation.operation_id===id);if(record){if(state.readGate)await state.readGate;return clone(record);}return operation(id);};
    const configuration={...f.configuration,runtime:source},controller=new EditorController(f.client,configuration);await controller.open();edit(controller,initial);
    const finish=(code='x <- 1\ny <- 2',status='succeeded')=>{
      const record=state.records.at(-1),args=record.operation.normalized_arguments.arguments,format=record.operation.capability.id==='r.format';
      record.status=record.outcome=status;record.error=status==='succeeded'?null:'Original '+status;
      record.output={operation_id:record.operation.operation_id,session_id:args.expected_session,source:clone(format?args.source:args.run.source),output_mode:format?null:'console',
        value_in_report:false,value:format?{code,changed:code!==args.code,tool_version:'fixture'}:null,
        report:{owner:clone(source),resource:'report',digest:'sha256:'+'c'.repeat(64),bytes:1,media_type:'application/json'}};
    };
    return{...f,configuration,controller,r:state,finish};
  };
  const independent=await fixture(true);await assert.rejects(independent.controller.startCode('document'),/No R provider/);assert.equal(independent.native.attempts.length,0);
  const missing=await make();missing.r.session=null;await assert.rejects(missing.controller.startCode('document'),/Start the selected R session/);assert.equal(missing.r.attempts.length,0);
  const run=await make();run.controller.document.update(run.controller.document.state.update({selection:{anchor:4,head:7}}));
  await run.controller.startCode('selection');assert.equal(run.r.attempts[0].args.arguments.run.code,'y=2');assert.equal(run.r.attempts[0].args.arguments.run.source.kind,'selection');
  const saves=run.state.calls.length;await run.controller.inspectCode();await run.controller.inspectCode();assert.equal(run.state.calls.length,saves,'unchanged observations do not save another draft');
  run.finish();await run.controller.inspectCode();assert.equal(run.controller.code.status,'succeeded');
  run.controller.document.update(run.controller.document.state.update({selection:{anchor:0}}));await run.controller.startCode('selection');
  assert.equal(run.r.attempts[1].args.arguments.run.source.kind,'line');assert.equal(run.r.attempts[1].args.arguments.run.code,'x=1');
  run.finish();await run.controller.inspectCode();await run.controller.startCode('document');assert.equal(run.r.attempts[2].args.arguments.run.code,'x=1\ny=2');
  const capture=await make();let observed;capture.r.sessionGate=new Promise(resolve=>observed=resolve);
  const preparing=capture.controller.startCode('document');edit(capture.controller,'later=TRUE');await wait(()=>capture.r.queries.some(q=>q.cap.id==='r.session'));
  observed();await preparing;assert.equal(capture.r.attempts[0].args.arguments.run.code,'x=1\ny=2','capture belongs to the initiating click, before any async observation');assert.equal(capture.controller.document.raw,'later=TRUE');
  const failed=await make();await failed.controller.startCode('document');failed.finish('', 'failed');await failed.controller.inspectCode();
  assert.equal(failed.controller.code.error,'Original failed');await assert.rejects(failed.controller.startCode('document'),/Inspect the original/);await failed.controller.dismissCode();assert.equal(failed.controller.code,null);
  const uncertain=await make();await uncertain.controller.startCode('document');uncertain.finish('', 'uncertain');await uncertain.controller.inspectCode();await assert.rejects(uncertain.controller.dismissCode(),/no confirmed terminal/);assert.ok(uncertain.controller.code);
  const lost=await make();lost.r.lost=true;await assert.rejects(lost.controller.startCode('document'),/acknowledgement lost/);
  const original=lost.controller.code.intent.request;await lost.controller.retryCode();assert.equal(lost.r.attempts.length,2);assert.equal(lost.r.attempts[1].options.requestId,original);assert.equal(lost.r.records.length,1);
  const unsaved=await make();unsaved.state.failPersist=true;await assert.rejects(unsaved.controller.startCode('format'),/acknowledgement lost/);assert.equal(unsaved.r.attempts.length,0);assert.equal(unsaved.controller.code,null);
  const closure=await make();let release;closure.state.settlementGate=new Promise(resolve=>release=resolve);const request=closure.controller.startCode('format');await wait(()=>closure.state.records.length===1);
  const closing=closure.controller.pause();release();await assert.rejects(request,/preparing to close/);await closing;assert.equal(closure.r.attempts.length,0);assert.equal(closure.stored().code,null);
  const nativeClose=await make();let accept;nativeClose.r.admissionGate=new Promise(resolve=>accept=resolve);
  const admission=nativeClose.controller.startCode('format');await wait(()=>nativeClose.r.records.length===1);edit(nativeClose.controller,'later=TRUE');const close=nativeClose.controller.pause();accept();await admission;await close;
  assert.equal(nativeClose.r.records[0].status,'accepted');assert.equal(nativeClose.stored().document.raw,'later=TRUE');nativeClose.controller.stop();nativeClose.finish();
  nativeClose.client.view={...nativeClose.client.view,view:'reopened-editor'};
  const reopened=new EditorController(nativeClose.client,nativeClose.configuration);await reopened.open();await assert.rejects(reopened.retryCode(),/another view/);await reopened.inspectCode();
  assert.equal(reopened.document.raw,'later=TRUE');assert.equal(reopened.code.formatted.code,'x <- 1\ny <- 2');assert.equal(reopened.code.applied,false);assert.equal(nativeClose.r.attempts.length,1);
  await reopened.pause();reopened.stop();nativeClose.client.view={...nativeClose.client.view,view:'format-comparison-restored'};
  const comparison=new EditorController(nativeClose.client,nativeClose.configuration);await comparison.open();assert.equal(comparison.code.formatted.code,'x <- 1\ny <- 2');
  comparison.document.update(comparison.document.state.update({effects:StateEffect.reconfigure.of([history()])}));
  await comparison.applyFormat(comparison.document.snapshot.version);assert.equal(comparison.document.raw,'x <- 1\ny <- 2');assert.equal(comparison.code.applied,true);
  assert.equal(undo({state:comparison.document.state,dispatch:transaction=>comparison.document.update(transaction)}),true);assert.equal(comparison.document.raw,'later=TRUE');
  assert.equal(nativeClose.native.mutations,0,'applying a format never writes a project file');
  const stale=await make();await stale.controller.startCode('format');edit(stale.controller,'newer');stale.finish();await stale.controller.inspectCode();
  let inspect;stale.r.readGate=new Promise(resolve=>inspect=resolve);const apply=stale.controller.applyFormat(stale.controller.document.snapshot.version);edit(stale.controller,'latest');inspect();
  await assert.rejects(apply,/document changed/);assert.equal(stale.controller.document.raw,'latest');assert.equal(stale.controller.code.applied,false);
  const inspectOnly=await make();await inspectOnly.controller.startCode('format');inspectOnly.finish();
  await inspectOnly.controller.inspectCode(false);assert.equal(inspectOnly.controller.document.raw,'x=1\ny=2');assert.equal(inspectOnly.controller.code.applied,false);
  assert.equal(inspectOnly.controller.code.formatted.code,'x <- 1\ny <- 2','opening a comparison cannot apply a result even when the original document is unchanged');
  const format=await make();format.controller.document.update(format.controller.document.state.update({effects:StateEffect.reconfigure.of([history()])}));
  await format.controller.startCode('format');format.finish();await format.controller.inspectCode();assert.equal(format.controller.document.raw,'x <- 1\ny <- 2');assert.equal(format.controller.code.applied,true);
  assert.equal(undo({state:format.controller.document.state,dispatch:transaction=>format.controller.document.update(transaction)}),true);assert.equal(format.controller.document.raw,'x=1\ny=2');
  const wrong=await make();await wrong.controller.startCode('format');wrong.finish();wrong.r.records[0].output.session_id='another';await assert.rejects(wrong.controller.inspectCode(),/another request/);assert.equal(wrong.controller.document.raw,'x=1\ny=2');
  const large=await make('中'.repeat(22000));await assert.rejects(large.controller.startCode('format'),/64 KiB/);assert.equal(large.r.queries.length,0);assert.equal(large.r.attempts.length,0);
  edit(large.controller,'中'.repeat(90000));await assert.rejects(large.controller.startCode('document'),/256 KiB/);assert.equal(large.r.queries.length,0);
  large.controller.document.update(large.controller.document.state.update({selection:{anchor:0,head:3}}));await large.controller.startCode('selection');assert.equal(large.r.attempts[0].args.arguments.run.code,'中中中');
  const rebound=await make();await rebound.controller.startCode('format');await rebound.controller.pause();rebound.controller.stop();
  const other=new EditorController(rebound.client,{...rebound.configuration,runtime:{...source,instance:'another-r'}});await assert.rejects(other.open(),/R provider or session/);
  const forged=await make();await forged.controller.startCode('format');await forged.controller.pause();forged.controller.stop();
  const payload=forged.stored();payload.code.text='changed';await forged.owner.save(encode(JSON.stringify(payload)));forged.client.view.state=clone(forged.owner.snapshot);
  const restored=new EditorController(forged.client,forged.configuration);await assert.rejects(restored.open(),/captured text/);
  console.log('Editor R action checks passed: explicit existing session, captured selection/line/document, durable original admission, close/reopen recovery, late-result comparison, version-fenced undoable formatting and no implicit file write.');
}
