import assert from 'node:assert/strict';

export async function testHandoffs(HandoffModel, NativeAgentModel, operationRequestId) {
  const clone = structuredClone, sourceRef = {kind:'native',task_id:'source'}, targetRef = {kind:'rho',conversation_id:'target'};
  const selection = {source:'plugin',label:'Original document',reference:{source:'original'},inclusion:'{"kind":"text"}'};
  function fixture() {
    let state = {}, version = 0, lost = false, saveFailed = false, sourceGate = null, syncError = false;
    const instance={instance:'agent',plugin:'org.rho.agent',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
    const source={source:sourceRef,title:'Archived source',body:'Goal:\nOriginal goal\n\nConfirmed:\n\nNext:\n',context:[selection],revision:'original-source',truncated:false,notices:['Source attachments stay in their task.']};
    const target={target:targetRef,title:'Target',draft:{text:'Existing target input',context:[],assets:['existing-attachment']},draft_version:4,controller:{window_id:'window',incarnation:'view:view'},control_generation:null,writable:true,reason:null};
    const calls=[],reads=[],syncs=[],refreshes=[],records=[],receipts=new Map();
    const client={
      get view(){return {view:'view',window:'window',project:'project',instance,state:clone(state),state_version:version};},
      async setState(value){if(saveFailed)throw Error('State save failed');state=clone(value);version++;return this.view;},
      async query(cap,args){
        reads.push(clone({cap,args}));let data;
        if(cap.id==='operation.list_recent')data={operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))};
        else {
          assert.deepEqual(args.binding,{provider:instance,project:'project',capability:cap,target:null});assert.equal(args.preconditions,null);
          if(cap.id==='agent.handoff.source'){if(sourceGate)await sourceGate;data=source;}
          else if(cap.id==='agent.handoff.target')data=target;
          else if(cap.id==='agent.handoff.receipt')data=receipts.get(args.arguments.request_id)??null;
          else throw Error('Unexpected query '+cap.id);
        }
        return {status:'ready',completeness:data===null?'partial':'complete',data:clone(data)};
      },
      async invoke(cap,args,options){
        const editor=state.handoffs.editors['native:source'];assert.deepEqual(editor.pending.arguments,args,'Save complete original request before invoking');
        assert.equal(editor.pending.request,options.requestId);assert.equal(cap.id,'agent.handoff.append');calls.push(clone({cap,args,options}));
        const scoped=await operationRequestId('view',options.requestId);let record=records.find(r=>r.operation.client_request_id===scoped);
        if(!record){
          const input=args.arguments;assert.equal(input.target_draft_version,target.draft_version);
          target.draft.text+='\n\n'+input.body;target.draft.context=clone(input.context);target.draft_version++;
          const receipt={request_id:input.request_id,source:clone(input.source),target:clone(input.target),target_draft_version:target.draft_version,created_at_ms:100};receipts.set(input.request_id,receipt);
          record={operation:{operation_id:'op-'+records.length,caller:{kind:'plugin',id:'view'},client_request_id:scoped,capability:clone(cap),normalized_arguments:clone(args),preconditions:[]},status:'succeeded',outcome:'succeeded',output:clone(receipt),error:null};records.push(record);
        }
        if(lost){lost=false;throw Error('Lost handoff reply');}return clone(record);
      },
      async operation(id){return clone(records.find(r=>r.operation.operation_id===id));},
    };
    return {client,source,target,calls,reads,syncs,refreshes,records,receipts,
      open(){const owner=new NativeAgentModel(client);return {owner,model:new HandoffModel(client,owner,async ref=>{syncs.push(clone(ref));if(syncError)throw Error('Draft unresolved');},async ref=>refreshes.push(clone(ref)))};},
      lose(){lost=true;},failSave(){saveFailed=true;},failSync(){syncError=true;},holdSource(promise){sourceGate=promise;},
    };
  }
  let count=0;async function check(name,fn){try{await fn();count++;}catch(error){throw Error(name,{cause:error});}}
  async function ready(f){const opened=f.open();await opened.model.prepare(sourceRef);await opened.model.selectTarget(sourceRef,targetRef);return opened;}
  await check('refresh preserves reviewed text and deliberately removed references',async()=>{
    const f=fixture(),{model}=await ready(f);model.edit(sourceRef,'Reviewed 中文 Ω');await model.remove(sourceRef,selection);
    f.source.body='Changed source goal';f.source.revision='later';f.source.context.push({...selection,label:'Later',reference:{source:'later'}});
    await model.reloadSource(sourceRef);assert.equal(model.editor(sourceRef).body,'Reviewed 中文 Ω');assert.deepEqual(model.editor(sourceRef).context,[]);
    assert.equal(model.editor(sourceRef).observation.revision,'later');assert.equal(f.calls.length,0);
    const next=f.open();assert.equal(next.model.editor(sourceRef).body,'Reviewed 中文 Ω');assert.equal(next.model.targets.size,0);
  });
  await check('changed target requires another review before dispatch',async()=>{
    const f=fixture(),{model}=await ready(f);f.target.draft.text='New local target draft';f.target.draft_version++;
    await assert.rejects(model.append(sourceRef),/target draft changed/);assert.equal(f.calls.length,0);assert.equal(model.targets.get('native:source').draft.text,'New local target draft');
    await model.append(sourceRef);assert.equal(f.calls.length,1);assert.ok(f.target.draft.text.startsWith('New local target draft\n\n'));assert.deepEqual(f.target.draft.assets,['existing-attachment']);
    assert.deepEqual(f.syncs.at(-1),targetRef);assert.deepEqual(f.refreshes,[targetRef]);
  });
  await check('lost reply survives reload and receipt inspection never resends',async()=>{
    const f=fixture();let {model}=await ready(f);f.lose();await assert.rejects(model.append(sourceRef),/Lost handoff reply/);
    const original=clone(model.editor(sourceRef).pending);model=f.open().model;assert.equal(f.calls.length,1);assert.deepEqual(model.editor(sourceRef).pending,original);
    await model.check(sourceRef);assert.equal(f.calls.length,1);assert.equal(model.editor(sourceRef).pending,null);assert.equal(model.editor(sourceRef).receipt.request_id,original.request);
    await assert.rejects(model.append(sourceRef),/original handoff/);assert.equal(f.calls.length,1);
  });
  await check('absent receipt and absent Operation retain the exact original request',async()=>{
    const f=fixture(),{model}=await ready(f);f.lose();await assert.rejects(model.append(sourceRef));const intent=clone(model.editor(sourceRef).pending);
    f.receipts.clear();const saved=f.records.splice(0);await assert.rejects(model.check(sourceRef),/unconfirmed/);assert.deepEqual(model.editor(sourceRef).pending,intent);
    f.records.push(...saved);f.source.revision='changed';const reads=f.reads.length;await model.retry(sourceRef);
    assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.reads.length,reads);assert.equal(f.target.draft_version,5);
  });
  await check('failed persistence never dispatches and preserves the unsent original',async()=>{
    const f=fixture(),{model}=await ready(f);f.failSave();await assert.rejects(model.append(sourceRef),/State save failed/);
    assert.equal(f.calls.length,0);assert.ok(model.editor(sourceRef).pending);assert.equal(f.open().model.editor(sourceRef).pending,null);
  });
  await check('unresolved target draft prevents submission',async()=>{
    const f=fixture(),{model}=await ready(f);f.failSync();await assert.rejects(model.append(sourceRef),/Draft unresolved/);assert.equal(f.calls.length,0);assert.equal(model.editor(sourceRef).pending,null);
  });
  await check('receipt identity and saved version are checked before accepting success',async()=>{
    const f=fixture(),{model}=await ready(f);f.lose();await assert.rejects(model.append(sourceRef));const request=model.editor(sourceRef).pending.request;
    f.receipts.get(request).target_draft_version=99;await assert.rejects(model.check(sourceRef),/receipt does not match/);assert.ok(model.editor(sourceRef).pending);assert.equal(f.refreshes.length,0);
  });
  await check('forged original Operation cannot clear recovery',async()=>{
    const f=fixture(),{model}=await ready(f);f.lose();await assert.rejects(model.append(sourceRef));f.receipts.clear();f.records[0].operation.caller.id='different-view';
    await assert.rejects(model.check(sourceRef),/does not match/);assert.ok(model.editor(sourceRef).pending);assert.equal(f.calls.length,1);
  });
  await check('restored pending input cannot retarget another instance',async()=>{
    const f=fixture(),{model}=await ready(f);f.lose();await assert.rejects(model.append(sourceRef));const value=f.client.view.state;
    value.handoffs.editors['native:source'].pending.arguments.binding.provider.instance='other';await f.client.setState(value);
    assert.throws(()=>f.open(),/another source, target, view or instance/);assert.equal(f.calls.length,1);
  });
  await check('known original rejection keeps the editor but requires a fresh target',async()=>{
    const f=fixture(),{model}=await ready(f);f.lose();await assert.rejects(model.append(sourceRef));f.receipts.clear();
    f.records[0].status='failed';f.records[0].outcome='failed';f.records[0].output=null;f.records[0].error='Source changed';
    await assert.rejects(model.check(sourceRef),/Source changed/);assert.equal(model.editor(sourceRef).pending,null);assert.equal(model.targets.size,0);assert.ok(model.editor(sourceRef).body);
  });
  await check('disposal invalidates an outstanding read without dispatch',async()=>{
    const f=fixture();let release;f.holdSource(new Promise(resolve=>release=resolve));const {model}=f.open();
    const reading=model.prepare(sourceRef);while(!f.reads.length)await new Promise(resolve=>setTimeout(resolve,0));model.dispose();release();
    await assert.rejects(reading,/view is closed/);assert.equal(f.calls.length,0);
  });
  console.log(`Ordinary handoff model: ${count} checks passed; reviewed drafts, target CAS, original receipts and lost replies. Native/Host acceptance remains separate.`);
}
