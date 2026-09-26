import assert from 'node:assert/strict';
export async function checkEditorController({EditorController,make,sdk,applyPatch}) {
  const clone=value=>structuredClone(value),encode=text=>new TextEncoder().encode(text);
  const hash=async text=>(await sdk.captureDraftContent(encode(text))).content.digest;
  const source={plugin:'org.rho.files',instance:'files',revision:'sha256:'+'c'.repeat(64),artifact:'sha256:'+'d'.repeat(64)};
  const initial='\ufeff甲\r\n乙\n',path='中文 文件.R';
  const ready=async condition=>{for(let n=0;n<2000&&!condition();n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(condition(),'expected controller phase was reached');};
  const fixture=async(isNew=false)=>{
    const f=make(),native={files:new Map([[path,initial]]),records:[],attempts:[],gate:null,lost:false,mutations:0};
    const observation=async path=>({path,kind:native.files.has(path)?'regular':'absent',sha256:native.files.has(path)?await hash(native.files.get(path)):null,
      byte_size:native.files.has(path)?encode(native.files.get(path)).length:0,mode:null,modified_at_ns:null});
    const stored=()=>JSON.parse(Buffer.concat(f.state.document.content.chunks.map(chunk=>Buffer.from(f.state.stages.find(stage=>stage.digest===chunk.digest).base64,'base64'))).toString('utf8'));
    const query=f.client.query,invoke=f.client.invoke,operation=f.client.operation;
    f.client.query=async(cap,args)=>{
      if(cap.id==='workspace.paths')return{status:'ready',data:{project_root:'/project'}};
      if(cap.id==='files.snapshot')return{status:'ready',data:{root:'/project',files:await Promise.all(args.arguments.paths.map(observation))}};
      if(cap.id==='files.read_file'){
        assert.deepEqual(args.binding.provider,source);const a=args.arguments,file=await observation(a.path);assert.equal(a.expected_sha256,file.sha256);
        const data=encode(native.files.get(a.path)),end=Math.min(a.offset+a.limit_bytes,data.length);
        return{status:'ready',data:{file,offset:a.offset,bytes:[...data.slice(a.offset,end)],has_more:end<data.length}};
      }
      if(cap.id==='operation.get'){const record=native.records.find(record=>record.operation.operation_id===args.operation_id);if(record)return{status:'ready',data:{record:clone(record)}};}
      if(cap.id==='operation.list_recent'){
        const page=await query(cap,args);page.data.operations.push(...native.records.filter(record=>record.operation.client_request_id===args.client_request_id).map(record=>clone(record.operation)));return page;
      }
      return query(cap,args);
    };
    f.client.invoke=async(cap,args,options)=>{
      if(cap.id!=='files.apply_patch')return invoke(cap,args,options);
      native.attempts.push(clone({cap,args,options}));assert.deepEqual(stored().save.intent.arguments,args,'captured file intent is durably synchronized before native admission');
      assert.equal(stored().save.intent.request,options.requestId);
      const request=await sdk.operationRequestId(f.client.view.view,options.requestId);
      let record=native.records.find(record=>record.operation.client_request_id===request);
      if(!record){record={operation:{operation_id:'native-'+native.records.length,client_request_id:request,caller:{kind:'plugin',id:f.client.view.view},capability:clone(cap),normalized_arguments:clone(args),preconditions:[]},status:'accepted',outcome:null,output:null,error:null};native.records.push(record);}
      if(native.gate)await native.gate;
      if(native.lost){native.lost=false;throw new Error('Native admission acknowledgement lost');}
      return clone(record);
    };
    f.client.operation=async id=>{const record=native.records.find(record=>record.operation.operation_id===id);return record?clone(record):operation(id);};
    const finish=async()=>{
      for(const record of native.records){if(record.status!=='accepted')continue;
        const args=record.operation.normalized_arguments,pre=args.preconditions[0],before=await observation(pre.subject);
        if(before.sha256!==pre.expected){record.status=record.outcome='failed';record.error='Original file changed';continue;}
        const raw=applyPatch(native.files.get(pre.subject)??'',args.arguments.patch,{autoConvertLineEndings:false});assert.equal(typeof raw,'string');
        native.files.set(pre.subject,raw);native.mutations++;record.status=record.outcome='succeeded';record.output={after:{root:'/project',files:[await observation(pre.subject)]},affected_paths:[pre.subject]};
      }
    };
    const configuration={source,file:isNew?null:await observation(path)},controller=new EditorController(f.client,configuration);await controller.open();
    return{...f,native,controller,stored,finish,configuration};
  };
  const f=await fixture();assert.equal(f.controller.document.raw,initial);
  f.controller.document.update(f.controller.document.state.update({changes:{from:2,to:3,insert:'新'}}));const captured=f.controller.document.raw;
  let accepted;f.native.gate=new Promise(resolve=>accepted=resolve);const save=f.controller.save();await ready(()=>f.native.records.length===1);
  f.controller.document.update(f.controller.document.state.update({changes:{from:f.controller.document.state.doc.length,insert:'later'}}));const later=f.controller.document.raw;
  accepted();await save;assert.equal(f.controller.pending.intent.operation,'native-0');assert.equal(f.native.files.get(path),initial);
  await f.controller.pause();assert.equal(f.stored().document.raw,'甲\r\n新\nlater');assert.equal(f.stored().save.raw,captured);
  f.controller.resume();const draftSaves=f.state.calls.length,stateWrites=f.state.saved.length;
  await f.controller.inspectSave();await f.controller.inspectSave();
  assert.equal(f.state.calls.length,draftSaves,'unchanged native observations do not create draft saves');
  assert.equal(f.state.saved.length,stateWrites,'unchanged native observations do not create view-state operations');
  await f.controller.pause();
  assert.equal(f.native.records[0].status,'accepted','closing saves the pending identity without waiting for native completion');
  f.controller.stop();await f.finish();assert.equal(f.native.files.get(path),captured);
  f.client.view={...f.client.view,view:'reopened-editor',state:clone(f.client.view.state)};
  const reopened=new EditorController(f.client,f.configuration);await reopened.open();assert.equal(reopened.document.raw,later);await reopened.inspectSave();
  assert.equal(reopened.document.raw,later);assert.equal(reopened.document.snapshot.baseRaw,captured);assert.equal(reopened.document.dirty,true);assert.equal(reopened.pending,null);assert.equal(f.native.attempts.length,1);
  const noChange=await fixture();await noChange.controller.save();assert.equal(noChange.native.attempts.length,0);
  const conflict=await fixture();conflict.controller.document.update(conflict.controller.document.state.update({changes:{from:0,insert:'changed'}}));
  await conflict.controller.save();conflict.native.files.set(path,'external');await conflict.finish();await conflict.controller.inspectSave();assert.equal(conflict.controller.document.snapshot.baseRaw,initial);
  assert.ok(conflict.controller.pending);assert.match(conflict.controller.error,/changed/);assert.equal(conflict.native.mutations,0);await conflict.controller.acknowledgeFileFailure();assert.equal(conflict.controller.pending,null);
  const local=conflict.controller.document.raw;
  await conflict.controller.compareDisk();assert.equal(conflict.controller.document.raw,local);assert.equal(conflict.controller.disk.raw,'external');
  await conflict.controller.pause();conflict.controller.stop();conflict.client.view={...conflict.client.view,view:'comparison-reopened'};
  const comparison=new EditorController(conflict.client,conflict.configuration);await comparison.open();assert.equal(comparison.disk.raw,'external');assert.equal(comparison.document.raw,local);
  conflict.native.files.set(path,'external again');await assert.rejects(comparison.acceptDisk(false),/changed again/);assert.equal(comparison.document.snapshot.baseRaw,initial);
  await comparison.compareDisk();await comparison.acceptDisk(false);assert.equal(comparison.document.raw,local);assert.equal(comparison.document.snapshot.baseRaw,'external again');assert.equal(comparison.disk,null);assert.equal(conflict.native.mutations,0);
  await comparison.save();await conflict.finish();await comparison.inspectSave();assert.equal(conflict.native.files.get(path),local);
  const loadDisk=await fixture(),diskRaw='\ufeffdisk\r\nsecond\n';loadDisk.native.files.set(path,diskRaw);await loadDisk.controller.compareDisk();
  await assert.rejects(loadDisk.controller.save(),/Finish the disk comparison/);await loadDisk.controller.acceptDisk(true);
  assert.equal(loadDisk.controller.document.raw,diskRaw);assert.equal(loadDisk.controller.document.dirty,false);assert.equal(loadDisk.native.attempts.length,0);
  const fresh=await fixture(true);fresh.controller.document.update(fresh.controller.document.state.update({changes:{from:0,insert:'新 file\n'}}));
  await assert.rejects(fresh.controller.save(path),/target exists/);assert.equal(fresh.native.attempts.length,0);
  await fresh.controller.save('new.R');assert.equal(fresh.native.attempts[0].args.preconditions[0].expected,null);await fresh.finish();await fresh.controller.inspectSave();assert.equal(fresh.native.files.get('new.R'),'新 file\n');assert.equal(fresh.controller.document.dirty,false);
  const replace=await fixture(true);replace.controller.document.update(replace.controller.document.state.update({changes:{from:0,insert:'replace\n'}}));
  await replace.controller.save(path,true);assert.equal(replace.native.attempts[0].args.preconditions[0].expected,await hash(initial));await replace.finish();await replace.controller.inspectSave();assert.equal(replace.native.files.get(path),'replace\n');
  const lost=await fixture();lost.controller.document.update(lost.controller.document.state.update({changes:{from:0,insert:'new'}}));lost.native.lost=true;
  await assert.rejects(lost.controller.save(),/admission acknowledgement lost/);const request=lost.controller.pending.intent.request;await lost.controller.retrySave();
  assert.equal(lost.native.attempts.length,2);assert.equal(lost.native.attempts[1].options.requestId,request);assert.equal(lost.native.records.length,1);await lost.finish();await lost.controller.inspectSave();assert.equal(lost.native.mutations,1);
  const draftFailure=await fixture();draftFailure.controller.document.update(draftFailure.controller.document.state.update({changes:{from:0,insert:'new'}}));draftFailure.state.failPersist=true;
  await assert.rejects(draftFailure.controller.save(),/acknowledgement lost/);assert.equal(draftFailure.native.attempts.length,0);assert.equal(draftFailure.controller.pending,null);assert.equal(draftFailure.controller.document.dirty,true);
  const closing=await fixture();closing.controller.document.update(closing.controller.document.state.update({changes:{from:0,insert:'new'}}));let releaseDraft;
  closing.state.settlementGate=new Promise(resolve=>releaseDraft=resolve);const preparing=closing.controller.save();await ready(()=>closing.state.records.length===1);
  const closure=closing.controller.pause();releaseDraft();await assert.rejects(preparing,/preparing to close/);await closure;
  assert.equal(closing.native.attempts.length,0);assert.equal(closing.stored().save,null);assert.equal(closing.controller.document.dirty,true);
  const corrupt=await fixture();corrupt.controller.document.update(corrupt.controller.document.state.update({changes:{from:0,insert:'new'}}));await corrupt.controller.save();await corrupt.finish();
  corrupt.native.records[0].output.after.files[0].sha256='sha256:'+'e'.repeat(64);await assert.rejects(corrupt.controller.inspectSave(),/receipt/);assert.ok(corrupt.controller.pending);assert.equal(corrupt.controller.document.snapshot.baseRaw,initial);
  console.log('Editor controller checks passed: durable pre-admission captures, later edits, non-blocking close, original-result reopening, native conflicts, explicit replacement, idempotent retry and false-receipt refusal.');
  return {fixture};
}
