import {testDefinitions} from './fixtures/studio-definitions.mjs';
import {testScenario} from './fixtures/studio-scenario.mjs';
import {testArchives} from './fixtures/studio-archive.mjs';
import {testBackendTest} from './fixtures/studio-backend-test.mjs';
import {testStudioAgent} from './fixtures/studio-agent.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildStudioPlugin} from './build-studio-plugin.mjs';
import {testDevelopment} from './fixtures/studio-development.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-studio-test-'));
let completed=false;
try {
 const plugin=buildStudioPlugin(path.join(directory,'studio'));
 const module=async name=>import(pathToFileURL(path.join(plugin,`dist/src/${name}.js`)));
 const {StudioDocument}=await module('document'),{node,parseVisual,fixtureVisible}=await module('visual'),{Studio,sourceText,sourceTree}=await module('model');
 const {operationRequestId,ViewRequestError}=await import(pathToFileURL(path.join(plugin,'dist/public/plugin-ui/index.js')));
 const {DraftSync}=await module('draft-sync');
 let fixtureState={},fixtureWrites=0;
 const previewClient={view:{view:'fixture',instance:{revision:'fixture-revision'},contribution:'studio',purpose:'fixture_preview',state:fixtureState},setState:async state=>{fixtureState=structuredClone(state);fixtureWrites++;},control:()=>assert.fail('preview must not stage real documents'),invoke:()=>assert.fail('preview must not save real documents'),query:()=>assert.fail('preview must not read real documents')};
 const fixtureDraft=new DraftSync(previewClient),fixtureText='{"draft":"中文 Ω"}',fixtureBytes=new TextEncoder().encode(fixtureText);
 assert.equal(await fixtureDraft.read(),null);assert.equal(await fixtureDraft.save(fixtureBytes),null,'no fabricated document receipt');await fixtureDraft.save(fixtureBytes);assert.equal(fixtureWrites,1);
 const reopenedFixture=new DraftSync({...previewClient,view:{...previewClient.view,state:fixtureState}});assert.equal(new TextDecoder().decode(await reopenedFixture.read()),fixtureText);
 await assert.rejects(reopenedFixture.save(new TextEncoder().encode('x'.repeat(256*1024))),/preview state limit/);assert.equal(new TextDecoder().decode(await reopenedFixture.read()),fixtureText);
 const failedFixture=new DraftSync({...previewClient,setState:async()=>{throw Error('fixture state unconfirmed');}});await assert.rejects(failedFixture.save(fixtureBytes),/unconfirmed/);assert.equal(await failedFixture.read(),null,'an unacknowledged save cannot claim a captured draft');
 const hash=text=>'sha256:'+createHash('sha256').update(text).digest('hex');
 const revision=hash('revision'),next=hash('next');
 const visual={format_version:1,root:'root',nodes:{root:{...node(),children:['title','custom']},title:{...node('text'),properties:{text:'Original 中文'}},custom:{...node('custom'),component:'chart'}},data_sources:{rows:{capability:{id:'data.observe',version:1},arguments:{},subscribe:true}},components:{chart:{source:'src/custom.ts',export:'Chart',properties_schema:{},input_schema:{},output_schema:{}}}};
 const binding={source:'rows',path:[]};
 const equality={kind:'equals',binding,value:{total:2,items:[{label:'中文',value:1},null]}};
 const fixtures={rows:{items:[{value:1,label:'中文'},null],total:2}};
 assert.equal(fixtureVisible(fixtures,equality),true,'fixture conditions compare object values independently of field insertion order');
 assert.equal(fixtureVisible({rows:{items:[null,{value:1,label:'中文'}],total:2}},equality),false,'array order remains meaningful');
 assert.equal(fixtureVisible({rows:{items:[{value:'1',label:'中文'},null],total:2}},equality),false,'value types remain meaningful');
 assert.equal(fixtureVisible({rows:{...fixtures.rows,extra:true}},equality),false,'additional fields remain meaningful');
 assert.equal(fixtureVisible({}, {kind:'exists',binding}),false,'missing root source does not exist');
 assert.equal(fixtureVisible({rows:null}, {kind:'exists',binding}),true,'explicit null is present');
 assert.equal(fixtureVisible({}, {kind:'equals',binding,value:null}),false,'missing root source is not explicit null');
 assert.equal(fixtureVisible(fixtures,{kind:'all',conditions:[equality,{kind:'not',condition:{kind:'exists',binding:{source:'rows',path:['missing']}}}]}),true);
 const manifest={id:'example.visual',source:{files:['views/panel.json','src/custom.ts','README.md','BUILD.md'],lockfiles:[],build_instructions:'BUILD.md'}};
 const content={'plugin.json':JSON.stringify(manifest,null,2),'views/panel.json':JSON.stringify(visual,null,2),'src/custom.ts':'export const Chart = () => "opaque source 中文";','README.md':'notes','BUILD.md':'Use the existing compiler.'};
 const metadata=text=>({digest:hash(text),bytes:Buffer.byteLength(text),executable:false});
 const files=Object.fromEntries(Object.entries(content).map(([key,text])=>[key,metadata(text)]));
 const doc=StudioDocument.create(revision,files);
 for(const [key,text]of Object.entries(content))doc.load(key,text);
 doc.data.selected='views/panel.json';doc.data.selectedNode='title';
 testDefinitions(StudioDocument,(await module('definition-panel')).definitionDraft,doc);
 doc.updateNode('title',{...doc.canvas.nodes.title,properties:{text:'Changed Ω'}});
 const valid=doc.current.text;doc.edit('views/panel.json',valid.slice(0,-9));assert.ok(doc.error());assert.equal(doc.canvas.nodes.title.properties.text,'Changed Ω');
 const broken=doc.current.text;assert.throws(()=>doc.append('root','button'));assert.equal(doc.current.text,broken);
 doc.undo();assert.equal(doc.current.text,valid);doc.undo();assert.equal(doc.canvas.nodes.title.properties.text,'Original 中文');doc.undo(true);assert.equal(doc.canvas.nodes.title.properties.text,'Changed Ω');
 doc.edit('src/custom.ts','export const Chart = () => "new implementation";');doc.undo();assert.equal(doc.data.selected,'src/custom.ts');assert.equal(doc.current.text,content['src/custom.ts']);
 doc.data.selected='views/panel.json';assert.equal(doc.canvas.components.chart.source,'src/custom.ts');
 const captured=doc.current.text;assert.throws(()=>doc.move('title','title',0));assert.equal(doc.current.text,captured,'failed cycle leaves declaration and history intact');
 doc.move('custom','title',0);assert.deepEqual(doc.canvas.nodes.title.children,['custom']);doc.undo();assert.deepEqual(doc.canvas.nodes.root.children,['title','custom']);
 doc.add('src/added.ts','new file');assert.ok(JSON.parse(doc.data.buffers['plugin.json'].text).source.files.includes('src/added.ts'));doc.undo();assert.ok(!doc.paths.includes('src/added.ts'));assert.ok(!JSON.parse(doc.data.buffers['plugin.json'].text).source.files.includes('src/added.ts'));doc.undo(true);
 doc.remove('src/added.ts');doc.undo();assert.ok(doc.paths.includes('src/added.ts'));
 const changes=doc.checkpoint('branch').changes;assert.equal(changes['src/added.ts'].kind,'put');assert.equal(changes['src/custom.ts'],undefined);
 const newFiles={...files,'src/added.ts':metadata('new file'),'plugin.json':metadata(doc.data.buffers['plugin.json'].text),'views/panel.json':metadata(doc.data.buffers['views/panel.json'].text)};
 doc.committed(next,newFiles);assert.equal(doc.dirty,false);doc.undo();assert.equal(doc.dirty,true,'undo after checkpoint compares against new native baseline');
 const restored=new StudioDocument(doc.snapshot);assert.deepEqual(restored.snapshot,doc.snapshot);
 const unsafe=structuredClone(visual);unsafe.nodes.title.events={mount:[{kind:'invoke',capability:{id:'science.write',version:1},arguments:{}}]};assert.throws(()=>parseVisual(JSON.stringify(unsafe)),/explicit user event/);
 unsafe.nodes.title.events={click:[{kind:'invoke',capability:{id:'science.write',version:1},arguments:{}}]};assert.doesNotThrow(()=>parseVisual(JSON.stringify(unsafe)));
 unsafe.nodes.title.bindings={text:{source:'rows',path:['__proto__']}};assert.throws(()=>parseVisual(JSON.stringify(unsafe)),/binding/);
 for(const change of [v=>{v.components.Chart=v.components.chart;},v=>{v.components.chart.export='  ';},v=>{v.data_sources.null=v.data_sources.rows;v.nodes.title.bindings={text:{source:null,path:[]}};}]){const invalid=structuredClone(visual);change(invalid);assert.throws(()=>parseVisual(JSON.stringify(invalid)));}
 const special=structuredClone(visual);Object.defineProperty(special.nodes,'__proto__',{value:node('text'),enumerable:true});special.nodes.root.children.push('__proto__');assert.ok(Object.hasOwn(parseVisual(JSON.stringify(special)).nodes,'__proto__'));
 let saved=null,fault=null,saveFault=false,records=[],invocations=[],catalogs={[revision]:{files,content},[next]:null};
 const client={view:{view:'studio-view',project:'project',principal:'user',window:'window',instance:{revision},contribution:'studio',state:{}},setState:async()=>{},operation:async id=>structuredClone(records.find(r=>r.operation.operation_id===id)),
  query:async(cap,args)=>{
   if(cap.id==='plugins.inspect')return{status:'ready',data:{summary:{revision:args.revision,plugin:'example.visual'},manifest,parent:null,artifacts:[]}};
   if(cap.id==='plugins.source_tree'){const catalog=catalogs[args.revision];return{status:'ready',data:{revision:args.revision,files:catalog.files,total:Object.keys(catalog.files).length,next:null}};}
   if(cap.id==='plugins.read_source'){const catalog=catalogs[args.revision],bytes=Buffer.from(catalog.content[args.path]);const end=Math.min(bytes.length,args.offset+args.limit);return{status:'ready',data:{revision:args.revision,path:args.path,file:catalog.files[args.path],offset:args.offset,content_base64:bytes.subarray(args.offset,end).toString('base64'),next_offset:end<bytes.length?end:null}};}
   if(cap.id==='plugins.check_source')return{status:'ready',data:{branch:args.branch,parent:args.expected_head,revision:next}};
   if(cap.id==='operation.list_recent')return{status:'ready',data:{operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))}};
   if(cap.id==='operation.get')return{status:'ready',data:{record:records.find(r=>r.operation.operation_id===args.operation_id)}};
   throw Error(cap.id);
  },invoke:async(cap,args,options)=>{
   assert.equal(saved.pending.intent.request,options.requestId,'captured intent is synchronized before dispatch');invocations.push(cap.id);
   if(fault==='reject')throw new ViewRequestError('head changed',{code:'content_changed'});
   const request=await operationRequestId(client.view.view,options.requestId);let record=records.find(r=>r.operation.client_request_id===request);
   if(!record){
    let output={branch:'branch'};
    if(cap.id==='plugins.checkpoint'){
     output={branch:args.branch,parent:args.expected_head,revision:next};const revised={...content};
     for(const [key,edit]of Object.entries(args.changes))if(edit.kind==='put')revised[key]=Buffer.from(edit.content_base64,'base64').toString();
     catalogs[next]={content:revised,files:Object.fromEntries(Object.entries(revised).map(([key,text])=>[key,metadata(text)]))};
    }
    record={operation:{operation_id:'op-'+records.length,caller:{kind:'plugin',id:client.view.view},client_request_id:request,capability:cap,normalized_arguments:args,preconditions:[]},status:'succeeded',outcome:'succeeded',output};records.push(record);
   }
   if(fault==='lost')throw Error('committed acknowledgement lost');
   if(fault==='mismatch')return{...record,operation:{...record.operation,caller:{kind:'plugin',id:'different'}}};
   return structuredClone(record);
  }};
 function controller(){const studio=new Studio(client);studio.drafts.save=async bytes=>{if(saveFault)throw Error('draft not acknowledged');saved=JSON.parse(new TextDecoder().decode(bytes));return{};};studio.drafts.read=async()=>saved?new TextEncoder().encode(JSON.stringify(saved)):null;return studio;}
 let studio=controller();await studio.select(revision);assert.equal(invocations.length,0,'source selection never starts an operation');
 await studio.createBranch('edit');assert.equal(studio.branch.id,'branch');
 studio.document.edit('views/panel.json',JSON.stringify({...visual,nodes:{...visual.nodes,title:{...visual.nodes.title,properties:{text:'checkpoint value'}}}},null,2));
 fault='lost';await assert.rejects(studio.checkpoint(),/acknowledgement lost/);assert.ok(studio.pending);assert.equal(records.length,2);
 studio=controller();await studio.open();assert.ok(studio.pending);assert.equal(invocations.length,2,'reopen only reads draft');
 fault=null;await studio.recover();assert.equal(studio.document.data.revision,next);assert.equal(studio.pending,null);assert.equal(records.length,2,'inspection never repeats a committed operation');assert.equal(studio.document.dirty,false);
 studio.document.edit('views/panel.json',studio.document.current.text+'\n');saveFault=true;await assert.rejects(studio.checkpoint(),/draft not acknowledged/);assert.equal(invocations.length,2,'no source invocation without acknowledged intent');saveFault=false;
 // A new clean controller can recover copied original intent but cannot replay it as a new view.
 const capturedIntent=structuredClone(saved);capturedIntent.pending={intent:{view:'studio-view',request:'retained',capability:{id:'plugins.checkpoint',version:1},arguments:{branch:'branch',expected_head:next,changes:{}},operation:null},proposal:{branch:'branch',parent:next,revision:hash('later')},restore:false};saved=capturedIntent;client.view.view='replacement';studio=controller();await studio.open();await assert.rejects(studio.dispatch(),/Only the original view/);assert.equal(invocations.length,2);

 // Fresh native rejection leaves edits intact, while a mismatched receipt stays unresolved.
 saved=null;client.view.view='studio-view';studio=controller();await studio.select(revision);await studio.createBranch('reject-test');
 studio.document.edit('views/panel.json',studio.document.current.text+'\n');const originalText=studio.document.current.text;
 fault='reject';await assert.rejects(studio.checkpoint(),/head changed/);assert.equal(studio.pending,null);assert.equal(studio.document.current.text,originalText);assert.equal(studio.document.data.revision,revision);
 fault=null;await studio.createBranch('conflict-fork');assert.equal(studio.document.current.text,originalText);assert.equal(studio.document.dirty,true);assert.equal(studio.branch.name,'conflict-fork');
 fault='mismatch';await assert.rejects(studio.checkpoint(),/original source request/);assert.ok(studio.pending);assert.equal(studio.document.data.revision,revision);fault=null;
 // UTF-8 may split between source pages; decode only after verifying the full byte capture.
 const large='a'.repeat(65535)+'中文 Ω';catalogs[revision].content['src/large.ts']=large;catalogs[revision].files['src/large.ts']=metadata(large);
 assert.equal(await sourceText(client,revision,'src/large.ts',metadata(large)),large);
 const corrupt={...client,query:async(cap,args)=>{const reply=await client.query(cap,args);if(cap.id==='plugins.read_source'&&args.offset===65536)reply.data.content_base64=Buffer.alloc(Buffer.from(reply.data.content_base64,'base64').length).toString('base64');return reply;}};
 await assert.rejects(sourceText(corrupt,revision,'src/large.ts',metadata(large)),/digest/);
 assert.equal(await sourceText(client,revision,'src/custom.ts',files['src/custom.ts']),content['src/custom.ts']);
 await assert.rejects(sourceText(client,revision,'src/custom.ts',{...files['src/custom.ts'],digest:hash('wrong')}),/different file/);
 const badClient={...client,query:async()=>({status:'ready',data:{revision,files,total:Object.keys(files).length,next:'BUILD.md'}})};await assert.rejects(sourceTree(badClient,revision),/pagination/);
 const unicodeClient={...client,query:async(_cap,args)=>({status:'ready',data:{revision,total:2,files:args.after?{'😀.ts':metadata('')}:{'\ue000.ts':metadata('')},next:args.after?null:'\ue000.ts'}})};assert.equal(Object.keys(await sourceTree(unicodeClient,revision)).length,2);
 await testDevelopment(module,operationRequestId,ViewRequestError);
 await testBackendTest(module,operationRequestId,ViewRequestError);
 await testScenario(module,operationRequestId,ViewRequestError);
 await testArchives(module,operationRequestId);
 await testStudioAgent(module,operationRequestId,ViewRequestError);
 if(process.argv.includes('--browser-agent')) {
  const {testStudioAgentRenderer}=await import('./studio-agent-renderer.mjs');
  await testStudioAgentRenderer(path.resolve(import.meta.dirname,'..'),plugin);
 }
 completed=true;console.log('Studio model: source/canvas shared undo, invalid drafts, opaque custom source, atomic inventory edits, native receipts, lost acknowledgements, reopen recovery, source integrity and bounded pagination passed.');
}finally{if(completed)fs.rmSync(directory,{recursive:true,force:true});else console.error(`Studio test retained at ${directory}`);}
