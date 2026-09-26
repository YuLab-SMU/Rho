import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkEditorController } from './fixtures/editor-controller.mjs';
import { checkEditorFormat } from './fixtures/editor-format.mjs';
import { checkEditorCode } from './fixtures/editor-code.mjs';
import { checkEditorSaveRun } from './fixtures/editor-save-run.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rho-editor-model-'));
try {
  for(const [from,to] of [['plugins/editor','.'],['sdk/plugin-ui','public/plugin-ui'],['sdk/plugin-protocol','public/plugin-protocol'],['plugins/files/sdk','public/files-protocol'],['plugins/r/sdk','public/r-protocol']])
    fs.cpSync(path.join(root,from),path.join(temporary,to),{recursive:true,filter:source=>!/[\\/](?:node_modules|compiled|dist)(?:[\\/]|$)/.test(source)});
  fs.symlinkSync(path.join(root,'ui/node_modules'),path.join(temporary,'node_modules'),'dir');
  const manifest=JSON.parse(fs.readFileSync(path.join(temporary,'package.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(temporary,'dependencies.lock'),'utf8'));
  for(const [name,version] of Object.entries({...manifest.dependencies,...manifest.devDependencies}))
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporary,'node_modules',name,'package.json'),'utf8')).version,version);
  for(const [name,expected] of Object.entries(lock.packages)) {
    const file=path.join(temporary,name,'package.json');
    if(!fs.existsSync(file)) {assert.ok(expected.optional,`Missing locked dependency ${name}`);continue;}
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,expected.version,`Changed locked dependency ${name}`);
  }
  execFileSync(process.execPath,[path.join(temporary,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json'],{cwd:temporary,stdio:'inherit'});
  const sdk=await import(pathToFileURL(path.join(temporary,'compiled/public/plugin-ui/index.js')).href);
  const {readFormattedCode}=await import(pathToFileURL(path.join(temporary,'compiled/src/r-format.js')).href);
  await checkEditorFormat({readFormattedCode,sdk});
  const {DraftSync}=await import(pathToFileURL(path.join(temporary,'compiled/src/draft-sync.js')).href);
  const {filePatch,rawOffset,normalizeText}=await import(pathToFileURL(path.join(temporary,'compiled/src/text.js')).href);
  const {applyPatch}=await import(pathToFileURL(path.join(root,'ui/node_modules/diff/libesm/index.js')).href);
  const before='\ufeff甲\r\n乙\n丙\r\n',after='\ufeff甲\r\n新\n丙\r\n';
  assert.equal(applyPatch(before,filePatch('中文 文件.R',before,after),{autoConvertLineEndings:false}),after);
  assert.equal(rawOffset('甲\r\n乙\n',2),3);assert.equal(normalizeText('甲\r\n乙\r'), '甲\n乙\n');
  assert.throws(()=>filePatch('../outside',null,'x'));assert.throws(()=>filePatch('large.R',null,'中'.repeat(80000)),/200 KiB/);
  const clones=value=>structuredClone(value);
  const {EditorDocument}=await import(pathToFileURL(path.join(temporary,'compiled/src/document.js')).href);
  const {EditorFiles}=await import(pathToFileURL(path.join(temporary,'compiled/src/files.js')).href);
  const {StateEffect}=await import(pathToFileURL(path.join(root,'ui/node_modules/@codemirror/state/dist/index.js')).href);
  const {history,undo}=await import(pathToFileURL(path.join(root,'ui/node_modules/@codemirror/commands/dist/index.js')).href);
  const hash=async text=>(await sdk.captureDraftContent(new TextEncoder().encode(text))).content.digest;
  const doc=EditorDocument.create(before,'中文 文件.R',await hash(before));
  doc.update(doc.state.update({effects:StateEffect.reconfigure.of([history()])}));
  doc.update(doc.state.update({changes:{from:2,to:3,insert:'新\n行'},selection:{anchor:3}}));
  assert.equal(doc.raw,'\ufeff甲\r\n新\r\n行\n丙\r\n');
  const capturedText=doc.raw,transaction=doc.state.update({changes:{from:doc.state.doc.length,insert:'later'}});
  doc.update(transaction);const resident=doc.state;doc.saved('中文 文件.R',capturedText,await hash(capturedText));
  assert.equal(doc.state,resident);assert.equal(doc.dirty,true);assert.ok(doc.raw.endsWith('later'));assert.equal(doc.snapshot.baseRaw,capturedText);
  const oldState=doc.state;assert.throws(()=>doc.update(transaction),/changed before/);
  assert.throws(()=>doc.update(doc.state.update({changes:{from:0,insert:'中'.repeat(200000)}})),/512 KiB/);assert.equal(doc.state,oldState);
  assert.throws(()=>doc.update(doc.state.update({changes:{from:0,insert:'\0'}})),/without NUL/);assert.equal(doc.state,oldState);
  doc.update(doc.state.update({effects:StateEffect.reconfigure.of([history()])}));assert.equal(undo({state:doc.state,dispatch:transaction=>doc.update(transaction)}),true);
  const restoredDoc=new EditorDocument(doc.snapshot);assert.equal(restoredDoc.raw,doc.raw);assert.equal(restoredDoc.path,doc.path);
  const formattedDoc=EditorDocument.create('\ufeffa=1\r\nb=2\n','format.R',await hash('\ufeffa=1\r\nb=2\n'));
  formattedDoc.update(formattedDoc.state.update({effects:StateEffect.reconfigure.of([history()])}));
  const formatVersion=formattedDoc.snapshot.version;formattedDoc.format('a <- 1\nb <- 2',formatVersion);
  assert.equal(formattedDoc.raw,'\ufeffa <- 1\r\nb <- 2');assert.equal(formattedDoc.snapshot.baseRaw,'\ufeffa=1\r\nb=2\n');assert.equal(formattedDoc.dirty,true);
  assert.throws(()=>formattedDoc.format('late',formatVersion),/document changed/);
  assert.equal(undo({state:formattedDoc.state,dispatch:transaction=>formattedDoc.update(transaction)}),true);assert.equal(formattedDoc.state.doc.toString(),'a=1\nb=2\n');
  const diskDoc=EditorDocument.create('local\n','disk.R',await hash('local\n'));
  diskDoc.update(diskDoc.state.update({effects:StateEffect.reconfigure.of([history()])}));
  diskDoc.update(diskDoc.state.update({changes:{from:0,insert:'recent '},userEvent:'input.type'}));
  const diskRaw='\ufeffdisk\r\nsecond\n';diskDoc.useDisk(diskRaw,await hash(diskRaw));
  assert.equal(diskDoc.raw,diskRaw);assert.equal(diskDoc.dirty,false);
  assert.equal(undo({state:diskDoc.state,dispatch:transaction=>diskDoc.update(transaction)}),true);
  assert.equal(diskDoc.state.doc.toString(),'recent local\n');assert.equal(diskDoc.dirty,true);assert.equal(diskDoc.snapshot.baseRaw,diskRaw);
  const huge='x'.repeat(700000),nativeBefore='\ufeff'+'甲\r\n🙂\n'.repeat(15000);
  const provider={plugin:'org.rho.files',instance:'files',revision:'sha256:'+'c'.repeat(64),artifact:'sha256:'+'d'.repeat(64)};
  const native=async value=>{const raw=typeof value==='string'?new TextEncoder().encode(value):value,file={path:'中文 文件.R',kind:'regular',sha256:(await sdk.captureDraftContent(raw)).content.digest,byte_size:raw.length,mode:null,modified_at_ns:null};
    const state={calls:[],changed:null,root:'/project'};
    const client={view:{project:'project'},query:async(cap,args)=>{
      state.calls.push({cap,args});if(cap.id==='workspace.paths')return{status:'ready',data:{project_root:state.root}};
      assert.deepEqual(args.binding.provider,provider);assert.equal(args.binding.project,'project');assert.equal(args.binding.target,'/project');
      if(cap.id==='files.snapshot')return{status:'ready',data:{root:'/project',files:[file]}};
      assert.equal(cap.id,'files.read_file');assert.equal(args.arguments.expected_sha256,file.sha256);
      const a=args.arguments,end=Math.min(a.offset+a.limit_bytes,raw.length),page={file:clones(file),offset:a.offset,bytes:[...raw.slice(a.offset,end)],has_more:end<raw.length};
      if(state.changed)state.changed(page);return{status:'ready',data:page};
    }};const owner=new EditorFiles(client,provider);await owner.connect();return{state,owner,file,client};};
  const nativeFile=await native(nativeBefore),observation=await nativeFile.owner.inspect('中文 文件.R');
  const opened=await nativeFile.owner.read(observation);assert.equal(opened.raw,nativeBefore);assert.equal(opened.readonly,null);assert.ok(nativeFile.state.calls.filter(call=>call.cap.id==='files.read_file').length>1);
  const emptyFile=await native('');assert.equal((await emptyFile.owner.read(emptyFile.file)).raw,'');assert.equal(emptyFile.state.calls.filter(call=>call.cap.id==='files.read_file').length,1);
  const largeFile=await native(huge),prefix=await largeFile.owner.read(largeFile.file);assert.equal(prefix.raw.length,65536);assert.match(prefix.readonly,/read-only prefix/);
  const previewDoc=EditorDocument.create(prefix.raw,prefix.file.path,prefix.file.sha256,prefix.readonly,prefix.file.byte_size);
  assert.equal(previewDoc.dirty,false);assert.throws(()=>previewDoc.update(previewDoc.state.update({changes:{from:0,insert:'x'}})),/read-only/);
  const invalidUtf8=await native(new Uint8Array(512*1024).fill(255)),replacement=await invalidUtf8.owner.read(invalidUtf8.file);
  assert.match(replacement.readonly,/not valid UTF-8/);assert.ok(new TextEncoder().encode(replacement.raw).length<=512*1024);
  assert.equal(EditorDocument.create(replacement.raw,replacement.file.path,replacement.file.sha256,replacement.readonly,replacement.file.byte_size).dirty,false);
  const binary=await native('a\0b');assert.match((await binary.owner.read(binary.file)).readonly,/binary/);
  const absent=await native('');absent.file.kind='absent';absent.file.sha256=null;assert.equal(await absent.owner.inspect('中文 文件.R'),null);
  for(const change of [page=>page.file.sha256='sha256:'+'e'.repeat(64),page=>page.offset=1,page=>page.bytes.pop(),page=>page.bytes[0]=256,page=>page.has_more=!page.has_more]){
    const bad=await native('exact');bad.state.changed=change;await assert.rejects(bad.owner.read(bad.file),/changed|incomplete/);
  }
  const corrupt=await native('exact');corrupt.state.changed=page=>page.bytes[0]=0;await assert.rejects(corrupt.owner.read(corrupt.file),/digest/);
  nativeFile.state.root='/changed';await assert.rejects(nativeFile.owner.connect(),/changed/);nativeFile.owner.stop();await assert.rejects(nativeFile.owner.read(nativeFile.file),/closed/);
  const source={revision:'sha256:'+'a'.repeat(64),contribution:'editor'};
  const view={view:'editor-view',project:'project',principal:'principal',window:'window',instance:{revision:source.revision},contribution:'editor',state:{}};
  const body=new TextEncoder().encode(JSON.stringify({text:'\ufeff'+'甲\r\n新 🙂\n'.repeat(35000)}));
  const make=()=>{
    const state={saved:[],calls:[],stages:[],records:[],document:null,stageGate:null,settlementGate:null,invokeLost:false,failPersist:false,failFinal:false,outcome:'succeeded',readCalls:0};
    const client={view:clones(view),
      setState:async value=>{state.saved.push(clones(value));if(state.failPersist||state.failFinal&&value.draft&&!value.pending)throw new Error('View state acknowledgement lost');client.view.state=clones(value);},
      control:async(cap,args)=>{assert.equal(cap.id,'documents.stage');if(state.stageGate)await state.stageGate;state.stages.push(clones(args));return{digest:args.digest,bytes:Buffer.from(args.base64,'base64').length};},
      invoke:async(cap,args,options)=>{
        state.calls.push({cap:clones(cap),args:clones(args),options:clones(options)});
        assert.deepEqual(state.saved.at(-1).pending.arguments,args,'intent is synchronized before invocation');
        const request=await sdk.operationRequestId(client.view.view,options.requestId);
        let record=state.records.find(item=>item.operation.client_request_id===request);
        if(!record){record={operation:{operation_id:'op-'+(state.records.length+1),caller:{kind:'plugin',id:client.view.view},client_request_id:request,capability:clones(cap),normalized_arguments:clones(args),preconditions:[]},status:'accepted',outcome:null,output:null,error:null};state.records.push(record);}
        if(state.invokeLost){state.invokeLost=false;throw new Error('Admission acknowledgement lost');}return clones(record);
      },
      operation:async id=>{
        const record=state.records.find(item=>item.operation.operation_id===id);if(!record)throw new Error('missing original');
        if(state.settlementGate)await state.settlementGate;
        if(!['succeeded','failed','cancelled','uncertain'].includes(record.status)){
          record.status=state.outcome;record.outcome=state.outcome;
          if(record.status==='succeeded'){
            const args=record.operation.normalized_arguments;
            record.output={draft:args.draft,window:args.window,project:view.project,principal:view.principal,source:clones(args.source),version:(args.expected_version??0)+1,content:clones(args.content),metadata:clones(args.metadata),discarded:false};
            state.document=clones(record.output);
          }else record.error='Original '+record.status;
        }return clones(record);
      },
      query:async(cap,args)=>{
        if(cap.id==='operation.get')return{status:'ready',data:{record:await client.operation(args.operation_id)}};
        if(cap.id==='operation.list_recent')return{status:'ready',data:{operations:state.records.filter(item=>item.operation.client_request_id===args.client_request_id).map(item=>item.operation)}};
        if(cap.id==='documents.inspect')return{status:'ready',data:clones(state.document)};
        assert.equal(cap.id,'documents.read');state.readCalls++;
        const record=state.document;assert.equal(args.expected_version,record.version);
        const all=Buffer.concat(record.content.chunks.map(chunk=>Buffer.from(state.stages.find(stage=>stage.digest===chunk.digest).base64,'base64'))),end=Math.min(args.offset+args.limit,all.length);
        return{status:'ready',data:{draft:record.draft,version:record.version,digest:record.content.digest,offset:args.offset,base64:all.subarray(args.offset,end).toString('base64'),next:end===all.length?null:end}};
      }};
    return{client,state,owner:new DraftSync(client)};
  };
  const normal=make(),captured=new Uint8Array(body),saved=normal.owner.save(captured,{encoding:'test'});captured.fill(0);
  const first=await saved;assert.ok(first.content.bytes>512*1024);assert.deepEqual(await normal.owner.read(),body);
  assert.ok(normal.state.readCalls>1);assert.equal(normal.state.saved.at(-1).pending,null);
  assert.ok(Buffer.byteLength(JSON.stringify(normal.state.saved.at(-1)))<32768);
  const stateWrites=normal.state.saved.length;
  await normal.owner.save(body,{encoding:'test'});assert.equal(normal.state.calls.length,1,'identical capture persists only its reference');
  assert.equal(normal.state.saved.length,stateWrites,'unchanged acknowledged reference creates no view-state operation');
  normal.state.document.version++;
  await assert.rejects(normal.owner.save(body,{encoding:'test'}),/draft version changed/);
  assert.equal(normal.state.saved.length,stateWrites,'a replaced native version cannot be confirmed from matching local bytes');
  normal.state.document.version--;
  const changed=new TextEncoder().encode('later edits');await normal.owner.save(changed,{encoding:'test'});assert.equal(normal.state.document.version,2);assert.deepEqual(await normal.owner.read(),changed);
  const frozen=make();let release;frozen.state.settlementGate=new Promise(done=>release=done);
  const a=frozen.owner.save(new TextEncoder().encode('first')),b=frozen.owner.save(new TextEncoder().encode('second'));
  while(!frozen.state.records.length)await new Promise(done=>setImmediate(done));
  assert.equal(frozen.state.calls.length,1);assert.equal(frozen.owner.snapshot.draft,null);release();await Promise.all([a,b]);
  assert.equal(frozen.state.calls.length,2);assert.equal(frozen.state.calls[1].args.expected_version,1);assert.equal(new TextDecoder().decode(await frozen.owner.read()),'second');
  const lost=make();lost.state.invokeLost=true;await assert.rejects(lost.owner.save(body),/Admission acknowledgement lost/);
  const original=lost.owner.snapshot.pending;await assert.rejects(lost.owner.save(changed),/unconfirmed/);assert.equal(lost.state.calls.length,1);
  const lostView={...lost.client,view:{...lost.client.view,view:'reopened-view',state:lost.owner.snapshot}};
  const reopened=new DraftSync(lostView);await assert.rejects(reopened.retryOriginal(),/another view/);assert.equal(lost.state.calls.length,1);
  await reopened.inspect();assert.equal(reopened.unresolved,false);assert.deepEqual(await reopened.read(),body);assert.equal(lost.state.calls.length,1,'inspection never replays from a reopened caller');
  assert.equal(original.request,lost.state.calls[0].options.requestId);
  const retry=make();retry.state.invokeLost=true;await assert.rejects(retry.owner.save(body),/Admission/);const request=retry.owner.snapshot.pending.request;
  await retry.owner.retryOriginal();assert.equal(retry.state.calls.length,2);assert.equal(retry.state.records.length,1);assert.equal(retry.state.calls[1].options.requestId,request);
  const unaccepted=make();unaccepted.state.failPersist=true;await assert.rejects(unaccepted.owner.save(body),/View state/);assert.equal(unaccepted.state.calls.length,0);
  await assert.rejects(unaccepted.owner.inspect(),/No unique original/);assert.equal(unaccepted.owner.unresolved,true);
  const finalLost=make();finalLost.state.failFinal=true;await assert.rejects(finalLost.owner.save(body),/View state/);assert.equal(finalLost.state.calls.length,1);assert.equal(finalLost.owner.unresolved,false);
  finalLost.state.failFinal=false;await finalLost.owner.save(body);assert.equal(finalLost.state.calls.length,1,'lost reference acknowledgement cannot create another save');
  const uncertain=make();uncertain.state.outcome='uncertain';await assert.rejects(uncertain.owner.save(body),/uncertain/);await assert.rejects(uncertain.owner.acknowledgeFailure(),/no confirmed failure/);
  await assert.rejects(uncertain.owner.save(changed),/unconfirmed/);assert.equal(uncertain.state.calls.length,1);assert.equal(uncertain.owner.unresolved,true);
  const failed=make();failed.state.outcome='failed';await assert.rejects(failed.owner.save(body),/failed/);await failed.owner.acknowledgeFailure();failed.state.outcome='succeeded';await failed.owner.save(body);assert.equal(failed.state.calls.length,2);
  for(const mutate of [record=>record.source.revision='sha256:'+'b'.repeat(64),record=>record.window='another',record=>record.content.digest='sha256:'+'b'.repeat(64),record=>record.version=99]){
    const bad=make(),inspect=bad.client.operation;bad.client.operation=async id=>{const record=await inspect(id);mutate(record.output);return record;};
    await assert.rejects(bad.owner.save(body),/scope|receipt/);assert.equal(bad.owner.unresolved,true);
  }
  const forged=make(),admit=forged.client.invoke;forged.client.invoke=async(...args)=>{const record=await admit(...args);record.operation.caller.id='another';return record;};
  await assert.rejects(forged.owner.save(body),/original document request/);assert.equal(forged.owner.unresolved,true);
  const stopped=make();let finish;stopped.state.settlementGate=new Promise(done=>finish=done);const inFlight=stopped.owner.save(body);
  while(!stopped.state.records.length)await new Promise(done=>setImmediate(done));stopped.owner.stop();finish();await assert.rejects(inFlight,/closed/);assert.equal(stopped.state.calls.length,1);
  assert.throws(()=>new DraftSync({...normal.client,view:{...normal.client.view,window:'other',state:normal.owner.snapshot}}),/scope/);
  const {EditorController}=await import(pathToFileURL(path.join(temporary,'compiled/src/controller.js')).href);
  const {fixture}=await checkEditorController({EditorController,make,sdk,applyPatch});
  const codeFixture=await checkEditorCode({EditorController,fixture,sdk,history,undo,StateEffect});
  await checkEditorSaveRun({EditorController,...codeFixture});
  console.log('Independent Editor text and draft synchronization checks passed: frozen/queued captures, exact reads, original request recovery, failure/uncertain retention, scope/receipt fences and close interruption.');
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
