import assert from 'node:assert/strict';
export async function checkEditorExternalRun({EditorController,DraftSync,make,edit,sdk}) {
  const clone=value=>structuredClone(value),encode=value=>new TextEncoder().encode(JSON.stringify(value));
  const f=await make('answer <- 42L\n');
  f.client.view.instance={plugin:'org.rho.editor',instance:'editor',revision:f.client.view.instance.revision,artifact:'sha256:'+'e'.repeat(64)};
  await f.controller.flush();
  const draft=clone(f.state.document),payload=f.stored(),runtime=f.configuration.runtime;
  const capture={operation:'agent-editor-parent',reference:{provider:f.client.view.instance,window:f.client.view.window,contribution:'documents',selector:{draft:draft.draft,version:draft.version,digest:draft.content.digest}},
    document_version:payload.document.version,code_digest:(await sdk.captureDraftContent(new TextEncoder().encode(payload.document.raw))).content.digest,runtime,session:'session',source:{view_id:`draft:${draft.draft}`,label:'Untitled.R',kind:'document'}};
  const parent={operation:{operation_id:capture.operation,capability:{id:'editor.run',version:1},normalized_arguments:{binding:{provider:capture.reference.provider,project:'project'},arguments:{reference:capture.reference,runtime,expected_session:'session'}}},status:'running',output:null,error:null};
  const child={operation:{operation_id:'captured-native',causation_id:capture.operation,caller:{kind:'plugin',id:'editor'},capability:{id:'r.execute',version:2},normalized_arguments:{binding:{provider:runtime,project:'project',target:'session'},arguments:{expected_session:'session',run:{code:payload.document.raw,source:capture.source,output_mode:'console'}}}},status:'succeeded',output:{operation_id:'captured-native',session_id:'session',source:capture.source,output_mode:'console'},error:null};
  let execution=null,reads=0;const query=f.client.query;
  f.client.query=async(cap,args)=>{
    if(cap.id!=='editor.run.inspect')return query(cap,args);
    reads++;assert.deepEqual(args.arguments,{operation:capture.operation,window:capture.reference.window});assert.deepEqual(args.binding.provider,capture.reference.provider);
    return {status:'ready',completeness:'complete',data:{parent:clone(parent),execution:clone(execution)}};
  };
  const remote=new DraftSync(f.client);await remote.save(encode({...payload,externalRun:capture}),draft.metadata);
  edit(f.controller,'typed before the receipt refresh');
  const invoke=f.client.invoke;
  f.client.invoke=async(cap,args,options)=>{
    if(cap.id==='documents.save'&&args.expected_version!==f.state.document.version)f.state.outcome='failed';
    return invoke(cap,args,options);
  };
  await assert.rejects(f.controller.flush(),/failed/);f.state.outcome='succeeded';
  assert.equal(f.controller.document.raw,'typed before the receipt refresh');
  await f.controller.drafts.acknowledgeFailure();
  assert.equal(await f.controller.refreshDocument(),true);assert.equal(f.controller.document.raw,'typed before the receipt refresh');assert.deepEqual(f.controller.externalRun,capture);await f.controller.flush();assert.equal(f.stored().document.raw,'typed before the receipt refresh');
  await f.controller.inspectExternalRun();assert.equal(f.controller.externalResult.parent.status,'running');
  await assert.rejects(f.controller.startCode('document'),/original Agent run/);assert.equal(f.r.attempts.length,0);
  const saved=f.state.calls.length;await f.controller.inspectExternalRun();assert.equal(f.state.calls.length,saved,'inspection never writes a second result store');
  edit(f.controller,'later unsaved edit');await f.controller.flush();await f.controller.pause();f.controller.stop();
  f.client.view={...f.client.view,view:'reopened-editor'};
  const reopened=new EditorController(f.client,f.configuration);await reopened.open();assert.equal(reopened.document.raw,'later unsaved edit');assert.deepEqual(reopened.externalRun,capture);
  execution=child;parent.status='uncertain';await reopened.inspectExternalRun();assert.equal(reopened.externalResult.code,'answer <- 42L\n');
  assert.equal(reopened.externalResult.parent.status,'uncertain');assert.equal(reopened.externalResult.execution.status,'succeeded');
  await assert.rejects(reopened.dismissExternalRun(),/no confirmed terminal/);assert.equal(f.r.attempts.length,0);
  for(const corrupt of [value=>value.operation.causation_id='other',value=>value.operation.normalized_arguments.arguments.run.code='replaced',value=>value.operation.normalized_arguments.binding.target='new-session',value=>value.output.operation_id='other']){
    execution=clone(child);corrupt(execution);await assert.rejects(reopened.inspectExternalRun(),/differs/);
  }
  execution=child;parent.status='succeeded';await reopened.inspectExternalRun();await reopened.dismissExternalRun();assert.equal(reopened.externalRun,null);assert.equal(reopened.document.raw,'later unsaved edit');assert.equal(f.r.attempts.length,0);
  const forged=clone(capture);forged.reference.provider.instance='foreign';const p=f.stored();await reopened.drafts.save(encode({...p,externalRun:forged}),f.state.document.metadata);reopened.stop();
  const rejected=new EditorController(f.client,f.configuration);await assert.rejects(rejected.open(),/another document/);
  assert.ok(reads>=8);console.log('Editor external Agent run checks passed: durable shared capture, original read-only inspection, no native replay, reopen with newer edits, failed/uncertain gating, and provider/code/session/result identity fences.');
}
