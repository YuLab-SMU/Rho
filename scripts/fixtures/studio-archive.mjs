import assert from 'node:assert/strict';
export async function testArchives(module,operationRequestId){
 const {Studio}=await module('model'),{StudioDocument}=await module('document');
 const hash=ch=>'sha256:'+ch.repeat(64),revision=hash('a'),artifact=hash('b');
 const file=new Blob(['Local source 中文 Ω\n'.repeat(9000)]),chunks=new Map(),records=[],calls=[],downloads=[];
 let saved=null,lostChunk=false,lostReply=false,saveFault=false,finalSaveFault=false,cleanupFault=false,outcome='succeeded',wrongReceipt=false;
 const progress=reference=>{const received=[...chunks.values()].reduce((sum,part)=>sum+part.length,0);return{reference,received,complete:received===reference.bytes};};
 const inspection=reference=>({reference,revision,plugin:'example.archive',name:'Archive subject',version:'1',description:'Local source and UI',source_files:3,artifacts:[{id:artifact,target:'ui-web',file_count:1}]});
 const client={view:{view:'studio',window:'window',project:'project',principal:'user',instance:{revision:hash('c')},contribution:'studio',state:{}},setState:async()=>{},
  query:async(cap,args)=>{
   calls.push(cap.id);let data;
   if(cap.id==='plugins.archive_progress')data=progress(args.reference);
   else if(cap.id==='plugins.archive_inspect')data=inspection(args.reference);
   else if(cap.id==='plugins.inspect')data={summary:{revision:args.revision,plugin:'example.archive',name:'Archive subject'},artifacts:[{id:artifact,target:'ui-web'}]};
   else if(cap.id==='operation.list_recent')data={operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))};
   else if(cap.id==='operation.get')data={record:records.find(r=>r.operation.operation_id===args.operation_id)};
   else throw Error(cap.id);return{status:'ready',data:structuredClone(data)};
  },operation:async id=>structuredClone(records.find(r=>r.operation.operation_id===id)),
  control:async(cap,args)=>{
   calls.push(cap.id);
   if(cap.id==='plugins.archive_stage'){
    assert.deepEqual(saved.archives.upload.reference,args.reference,'exact reference acknowledged before staging');
    const bytes=Buffer.from(args.base64,'base64'),previous=chunks.get(args.offset);if(previous)assert.deepEqual(previous,bytes);
    chunks.set(args.offset,bytes);if(lostChunk){lostChunk=false;throw Error('chunk acknowledgement lost');}return progress(args.reference);
   }
   if(cap.id==='plugins.archive_discard'){if(cleanupFault)throw Error('cleanup unconfirmed');chunks.clear();return{reference:args.reference,discarded:true};}
   throw Error(cap.id);
  },downloadArchive:async(reference,filename)=>downloads.push({reference:structuredClone(reference),filename}),
  async invoke(cap,args,options){
   calls.push(cap.id);assert.ok(['plugins.archive_import','plugins.archive_export'].includes(cap.id),'archive workflow never activates, builds, branches or applies');
   assert.deepEqual(saved.archives.pending.arguments,args,'exact intent acknowledged before mutation');
   const request=await operationRequestId(this.view.view,options.requestId);let record=records.find(r=>r.operation.client_request_id===request);
   if(!record){const reference=cap.id==='plugins.archive_import'?args.reference:{archive:'export-'+records.length,digest:hash('d'),bytes:31};
    record={operation:{operation_id:'archive-'+records.length,caller:{kind:'plugin',id:this.view.view},client_request_id:request,capability:cap,normalized_arguments:structuredClone(args),preconditions:[]},status:outcome,outcome,
     output:{reference,revision:wrongReceipt?hash('e'):revision,plugin:'example.archive',artifacts:cap.id==='plugins.archive_import'?[artifact]:args.artifacts},error:null};records.push(record);
   }
   if(lostReply)throw Error('operation acknowledgement lost');return structuredClone(record);
  }};
 function controller(view='studio'){
  const owner=new Studio({...client,view:{...client.view,view}});
  owner.drafts.save=async body=>{const next=JSON.parse(new TextDecoder().decode(body));if(saveFault||finalSaveFault&&!next.archives.pending)throw Error('save unconfirmed');saved=next;return{};};
  owner.drafts.read=async()=>saved?new TextEncoder().encode(JSON.stringify(saved)):null;return owner;
 }
 let studio=controller();const initial=StudioDocument.create(revision,{'notes.txt':{digest:hash('f'),bytes:8,executable:false}});initial.load('notes.txt','Original');initial.data.selected='notes.txt';initial.edit('notes.txt','Unsaved source 中文 Ω');studio.document=initial;
 studio.plugin='example.archive';studio.branch={id:'branch',plugin:studio.plugin,name:'local branch',head:revision,origin:revision};
 const source=structuredClone(studio.document.snapshot);
 saveFault=true;await assert.rejects(studio.archives.upload.choose(file,'本地插件.rho-plugin'),/save unconfirmed/);assert.equal(calls.length,0);await assert.rejects(studio.archives.upload.stage(),/Reselect/);saveFault=false;
 await studio.archives.upload.choose(file,'本地插件.rho-plugin');const original=structuredClone(saved.archives.upload.reference);
 lostChunk=true;await assert.rejects(studio.archives.upload.stage(),/chunk acknowledgement lost/);
 studio=controller();await studio.open();await studio.archives.upload.inspect();assert.equal(studio.archives.data.upload.received,65536);assert.deepEqual(studio.document.snapshot,source);
 await assert.rejects(studio.archives.upload.choose(new Blob(['changed']),'other.rho-plugin'),/exact retained file/);
 await studio.archives.upload.choose(file,'same.rho-plugin');await studio.archives.upload.stage();assert.deepEqual(studio.archives.data.upload.reference,original);assert.equal(records.length,0);
 lostReply=true;await assert.rejects(studio.archives.import(),/acknowledgement lost/);const importedOperation=records.length;
 await assert.rejects(studio.archives.upload.discard(),/original archive/);await assert.rejects(studio.development.configure(revision),/archive/);await assert.rejects(studio.select(revision),/original unconfirmed/);
 studio=controller('replacement');await studio.open();await assert.rejects(studio.archives.dispatch(),/Only the original/);lostReply=false;await studio.archives.recover();
 assert.equal(records.length,importedOperation);assert.deepEqual(studio.document.snapshot,source);assert.equal(studio.branch.name,'local branch');assert.equal(studio.archives.data.upload.original.view,'studio');
 await studio.archives.inspectImport();await assert.rejects(studio.select(revision),/Checkpoint current edits/);
 cleanupFault=true;await assert.rejects(studio.archives.upload.discard(),/cleanup unconfirmed/);assert.ok(studio.archives.data.upload);cleanupFault=false;
 saveFault=true;await assert.rejects(studio.archives.upload.discard(),/save unconfirmed/);assert.ok(studio.archives.data.upload);saveFault=false;await studio.archives.upload.discard();
 await studio.archives.configureExport(revision);await studio.archives.exported.select([]);assert.deepEqual(studio.document.snapshot,source,'export only captures the immutable checkpoint');
 lostReply=true;await assert.rejects(studio.archives.exported.prepare(),/acknowledgement lost/);assert.deepEqual(records.at(-1).operation.normalized_arguments,{revision,artifacts:[]});assert.equal(downloads.length,0);
 studio=controller('another-view');await studio.open();await assert.rejects(studio.archives.dispatch(),/Only the original/);lostReply=false;
 finalSaveFault=true;await assert.rejects(studio.archives.recover(),/save unconfirmed/);assert.ok(studio.archives.data.pending);assert.ok(saved.archives.pending);finalSaveFault=false;
 studio=controller('another-view');await studio.open();await studio.archives.recover();assert.equal(records.length,importedOperation+1);assert.equal(downloads.length,0);
 await studio.archives.exported.inspect();studio.archives.data.exported.filename='源码 Ω.rho-plugin';await studio.archives.exported.download();assert.equal(downloads.length,1);assert.equal(downloads[0].filename,'源码 Ω.rho-plugin');assert.deepEqual(studio.document.snapshot,source);
 const corrupt=structuredClone(studio.archives.data);corrupt.exported.receipt.revision=hash('f');assert.throws(()=>studio.archives.restore(corrupt),/another revision/);
 await studio.archives.exported.discard();await studio.archives.configureExport(revision);outcome='uncertain';await assert.rejects(studio.archives.exported.prepare(),/uncertain/);await assert.rejects(studio.archives.recover(),/uncertain/);assert.ok(studio.archives.data.pending);assert.equal(studio.archives.data.exported.receipt,null);
 assert.equal(calls.includes('plugins.archive_receipt'),false,'catalog evidence never settles uncertainty');
 records.at(-1).status=records.at(-1).outcome='failed';await assert.rejects(studio.archives.recover(),/failed/);assert.equal(studio.archives.data.pending,null);
 outcome='succeeded';wrongReceipt=true;await assert.rejects(studio.archives.exported.prepare(),/another revision/);assert.ok(studio.archives.data.pending);assert.equal(downloads.length,1);
 studio.archives.dispose();console.log('Studio archives: persisted immutable transfers, reselection, source draft preservation, original request recovery across views, exact exports, explicit downloads and uncertain outcomes pass.');
}
