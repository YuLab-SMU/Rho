import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../ui/package.json',import.meta.url));
const {JSDOM}=require('jsdom');
/** Public sender under a real DOM; journal peer loses a reply after accepting. */
export async function checkComponentAnnotations(sdk){
 const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{url:'http://localhost'});
 const previous={document:globalThis.document,Option:globalThis.Option};globalThis.document=dom.window.document;globalThis.Option=dom.window.Option;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const owner={plugin:'org.rho.files',instance:'files',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)},notes={...owner,plugin:'org.rho.annotations',instance:'notes'};
 const view={view:'source-view',window:'window-one',project:'project-one',principal:'principal-one',instance:owner};
 const source={reference:{provider:owner,contribution:'files',window:view.window,selector:{digest:'original'}},title:'研究.R',inclusion:{kind:'text'},preview:{id:'files.context.preview',version:1}};
 let saved,record,invocations=0,refused=false;const persist=async state=>{saved=structuredClone(state);};
 const client={view,query:async(cap,args)=>{
  if(cap.id==='files.context.preview')return {status:'ready',completeness:'complete',data:{item:{reference:source.reference},text:'Original 中文 quote',truncated:refused,data:{annotation_source:{source_id:'file-one',source_version:'v1'}},resources:[]}};
  if(cap.id==='plugins.instances')return {status:'ready',data:{instances:[{observed_in_this_host:true,instance:{identity:notes,state:'active',purpose:'runtime',project:view.project,principal:view.principal}}],next:null}};
  if(cap.id==='plugins.inspect')return {status:'ready',data:{summary:{revision:notes.revision},artifacts:[{id:notes.artifact}],manifest:{id:notes.plugin,views:[{id:'annotations',configuration_schema:{properties:{source_request:{}}}}]}}};
  if(cap.id==='windows.layout')return {status:'ready',data:{window:view.window,project:view.project,principal:view.principal,version:7,layout:{kind:'split',id:'root',direction:'horizontal',weights:[1,1],children:[{kind:'tabs',id:'unrelated',selected:'another-view',views:['another-view']},{kind:'tabs',id:'source-group',selected:view.view,views:[view.view]}]}}};
  if(cap.id==='operation.list_recent')return {status:'ready',data:{operations:[{operation_id:record.operation.operation_id}]}};
  if(cap.id==='operation.get')return {status:'ready',data:{record}};
  throw Error('Unexpected query '+cap.id);
 },operation:async()=>record,invoke:async(cap,args,options)=>{
  invocations++;assert.equal(args.group,'source-group','Open beside the actual source, not the first tab group.');assert.equal(args.expected_layout_version,7);
  assert.deepEqual(args.view.configuration.source_request.source,source);
  record={operation:{operation_id:'original-open',caller:{kind:'plugin',id:view.view},client_request_id:await sdk.operationRequestId(view.view,options.requestId),capability:cap,normalized_arguments:structuredClone(args),preconditions:[]},status:'succeeded',outcome:'succeeded',output:{view:{...view,view:'notes-view',instance:notes,contribution:'annotations',configuration:args.view.configuration,state:args.view.state}},error:null};
  throw Error('Lost opening acknowledgement');
 }};
 const options={client,persist,guard(){},capture:()=>structuredClone(source),modes:[{value:'text',label:'Text'}]};
 const wait=async condition=>{const until=Date.now()+3000;while(!condition()){assert.ok(Date.now()<until,'Sender did not settle');await new Promise(done=>setTimeout(done,5));}};
 try{
  const sender=sdk.componentAnnotationDialog(options);sender.open();await wait(()=>!sender.busy);assert.equal(saved.source.reference.selector.digest,'original');
  document.querySelector('[data-annotation=open]').click();await wait(()=>!sender.busy);assert.ok(saved.pending);assert.equal(invocations,1);sender.dispose();
  const resumed=sdk.componentAnnotationDialog({...options,saved});resumed.open();document.querySelector('[data-annotation=inspect]').click();await wait(()=>!resumed.busy);assert.equal(saved.pending,null);assert.equal(saved.opened.view,'notes-view');assert.equal(invocations,1,'Recovery must not open a second annotation view.');resumed.dispose();
  refused=true;const stale=sdk.componentAnnotationDialog(options);stale.open();await wait(()=>!stale.busy);assert.match(document.querySelector('[data-annotation=error]').textContent,/changed|too large/);assert.equal(document.querySelector('[data-annotation=open]').disabled,true);stale.dispose();
  const corrupt=structuredClone(saved);corrupt.pending={view:'foreign-source',request:'original-request',capability:{id:'windows.open_view',version:1},arguments:record.operation.normalized_arguments,operation:null};
  const bad=sdk.componentAnnotationDialog({...options,saved:corrupt});bad.open();document.querySelector('[data-annotation=inspect]').click();await wait(()=>!bad.busy);assert.match(document.querySelector('[data-annotation=error]').textContent,/differs from this source/);assert.equal(invocations,1);bad.dispose();
  console.log('Annotation sender preserves exact source and tab group, recovers lost open without replay, and refuses partial source/foreign recovery.');
 }finally{globalThis.document=previous.document;globalThis.Option=previous.Option;dom.window.close();}
}
