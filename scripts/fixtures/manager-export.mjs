import assert from 'node:assert/strict';
export async function checkManagerExport({Manager,operationRequestId}){
 const hash=ch=>'sha256:'+ch.repeat(64),inspection={summary:{revision:hash('a'),plugin:'example.export',name:'Export subject'},artifacts:[{id:hash('c'),target:'native'},{id:hash('b'),target:'ui-web'}]};
 let saved,lost=false,uncertain=false,wrong=false,saveFault=false,cleanupLost=false;
 const records=[],calls=[],downloads=[];
 const client={view:{view:'export-manager',window:'window'},setState:async state=>{if(saveFault)throw Error('save unconfirmed');saved=structuredClone(state);},
  query:async(cap,args)=>{calls.push(cap.id);if(cap.id==='operation.list_recent')return{status:'ready',data:{operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))}};
   if(cap.id==='operation.get')return{status:'ready',data:{record:records.find(r=>r.operation.operation_id===args.operation_id)}};throw Error(cap.id);},
  operation:async id=>records.find(r=>r.operation.operation_id===id),
  control:async(cap,args)=>{assert.equal(cap.id,'plugins.archive_discard');assert.deepEqual(args.reference,saved.exported.receipt.reference);calls.push(cap.id);if(cleanupLost)throw Error('cleanup unconfirmed');return{reference:args.reference,discarded:true};},
  downloadArchive:async(reference,name)=>{downloads.push({reference:structuredClone(reference),name});},
  async invoke(cap,args,options){
   assert.equal(cap.id,'plugins.archive_export','export cannot build, activate, import or apply a scenario');assert.deepEqual(saved.pending.intent.arguments,args);calls.push(cap.id);
   const request=await operationRequestId(this.view.view,options.requestId);let record=records.find(r=>r.operation.client_request_id===request);
   if(!record){record={operation:{operation_id:'export-'+records.length,caller:{kind:'plugin',id:this.view.view},client_request_id:request,capability:cap,normalized_arguments:structuredClone(args),preconditions:[]},status:uncertain?'uncertain':'succeeded',outcome:uncertain?'uncertain':'succeeded',
    output:{reference:{archive:'export-'+records.length,digest:hash('d'),bytes:23},revision:wrong?hash('e'):args.revision,plugin:inspection.summary.plugin,artifacts:args.artifacts},error:null};records.push(record);}
   if(lost)throw Error('export acknowledgement lost');return structuredClone(record);
  }};
 let manager=new Manager(client);await manager.archiveExport.configure(inspection);
 assert.deepEqual(manager.state.exported.selected,[hash('b'),hash('c')]);assert.equal(calls.length,0);
 await manager.archiveExport.select([]);saveFault=true;await assert.rejects(manager.archiveExport.prepare(),/save unconfirmed/);assert.equal(calls.length,0);saveFault=false;
 manager.state.selected='keep-selection';manager.state.draft='Keep scenario 中文';lost=true;
 await assert.rejects(manager.archiveExport.prepare(),/acknowledgement lost/);assert.deepEqual(records[0].operation.normalized_arguments,{revision:hash('a'),artifacts:[]});assert.equal(downloads.length,0);
 await assert.rejects(manager.archiveExport.download(),/original request/);await assert.rejects(manager.archiveExport.discard(),/original request/);
 const replacement=new Manager({...client,view:{view:'replacement',window:'window'}},saved);
 await assert.rejects(replacement.dispatch(),/Only the original/);lost=false;await replacement.recover();assert.equal(records.length,1);assert.equal(downloads.length,0,'recovery never starts a browser side effect');
 assert.equal(replacement.state.selected,'keep-selection');assert.equal(replacement.state.draft,'Keep scenario 中文');
 await replacement.archiveExport.inspect();replacement.state.exported.filename='源码 Ω.rho-plugin';await replacement.archiveExport.download();
 assert.deepEqual(downloads,[{reference:records[0].output.reference,name:'源码 Ω.rho-plugin'}]);
 await assert.rejects(replacement.archiveExport.select([hash('b')]),/unprepared/);
 await assert.rejects(replacement.archiveExport.configure({...inspection,summary:{...inspection.summary,revision:hash('f')}}),/Discard/);
 cleanupLost=true;await assert.rejects(replacement.archiveExport.discard(),/cleanup unconfirmed/);assert.ok(replacement.state.exported);cleanupLost=false;
 saveFault=true;await assert.rejects(replacement.archiveExport.discard(),/save unconfirmed/);assert.ok(replacement.state.exported);saveFault=false;await replacement.archiveExport.discard();assert.equal(replacement.state.exported,null);
 manager=new Manager(client);await manager.archiveExport.configure(inspection);await manager.archiveExport.select([hash('c'),hash('b')]);await manager.archiveExport.prepare();
 assert.deepEqual(records[1].output.artifacts,[hash('b'),hash('c')]);assert.equal(downloads.length,1,'preparation never starts download');
 const corrupt=structuredClone(manager.state);corrupt.exported.receipt.artifacts=[];assert.throws(()=>new Manager(client,corrupt),/another revision or artifact selection/);
 manager=new Manager(client);await manager.archiveExport.configure(inspection);uncertain=true;await assert.rejects(manager.archiveExport.prepare(),/uncertain/);assert.ok(manager.state.pending);await assert.rejects(manager.recover(),/uncertain/);assert.equal(manager.state.exported.receipt,null);
 assert.equal(calls.includes('plugins.archive_receipt'),false,'catalog evidence cannot settle an uncertain export');
 uncertain=false;wrong=true;manager=new Manager(client);await manager.archiveExport.configure(inspection);await assert.rejects(manager.archiveExport.prepare(),/another revision/);assert.ok(manager.state.pending);
 console.log('Manager export captures exact source/artifacts, retains original recovery without downloading, preserves drafts and refuses uncertain or mismatched receipts.');
}
