/** Reference-only annotation navigation. Scientific observation stays with the source owner. */
import type {CapabilityKey,ContextReference,ContextPreview,InstanceRef,JsonValue,PluginInspection,PluginInstanceObservations,PluginWindowLayout,PluginWindowNode,PluginViewRecord} from '../plugin-protocol/index.js';
import type {PluginViewClient} from './index.js';
import {inspectOriginalOperation,verifyOriginalOperation,isTerminalOperation,sameOperationValue,type OperationIntent,type OriginalOperationRecord} from './operations.js';
import {ViewRequestError} from './index.js';
export interface AnnotationComponentSource {reference:ContextReference;title:string;inclusion:unknown;preview:CapabilityKey;}
export interface AnnotationNavigationState {source:AnnotationComponentSource|null;pending:OperationIntent|null;opened:PluginViewRecord|null;}
export interface AnnotationSenderOptions {
 client:Pick<PluginViewClient,'view'|'query'|'invoke'|'operation'>;saved?:AnnotationNavigationState;
 persist(state:AnnotationNavigationState):Promise<void>;guard():void;
 capture(kind:string):AnnotationComponentSource|Promise<AnnotationComponentSource>;modes:{value:string;label:string}[];
}
const json=(value:unknown)=>value as JsonValue,key=(id:string)=>({id,version:1});
export function componentAnnotationDialog(options:AnnotationSenderOptions){
 let state:AnnotationNavigationState=structuredClone(options.saved??{source:null,pending:null,opened:null}),busy=false,disposed=false;
 let candidates:InstanceRef[]=[],error='',preview='';
 const dialog=document.createElement('dialog');dialog.className='rho-annotation-input';dialog.setAttribute('aria-label','Annotate this input');
 dialog.innerHTML='<div class="annotation-heading"><strong>Annotate this input</strong><button data-annotation="close" type="button">Back to source</button></div><label>Include<select data-annotation="mode" aria-label="Annotation inclusion"></select></label><pre data-annotation="preview"></pre><label>Annotations instance<select data-annotation="instance" aria-label="Annotations instance"></select></label><p data-annotation="status" role="status"></p><p data-annotation="error" role="alert" hidden></p><div class="annotation-actions"><button data-annotation="refresh" type="button">Prepare current source</button><button data-annotation="inspect" type="button" hidden>Inspect original operation</button><button data-annotation="open" type="button">Open notes</button></div>';
 const style=document.createElement('style');style.textContent='.rho-annotation-input{box-sizing:border-box;color:#1D2738;background:#FFFFFF;font:13px/20px Inter,system-ui,sans-serif;border:1px solid #DDE3EC;border-radius:12px;padding:20px;width:min(600px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}.rho-annotation-input::backdrop{background:#1D27384D}.rho-annotation-input .annotation-heading,.rho-annotation-input .annotation-actions{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}.rho-annotation-input label{display:block;margin:12px 0}.rho-annotation-input select{font:inherit;display:block;width:100%;max-width:100%;margin-top:4px}.rho-annotation-input button{font:inherit;background:#FFFFFF;color:#1D2738;border:1px solid #DDE3EC;border-radius:6px;padding:6px 10px;cursor:pointer;white-space:normal}.rho-annotation-input button:disabled{opacity:.5;cursor:default}.rho-annotation-input pre{position:static;max-height:240px;overflow:auto;font:12px/20px Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border:0;padding:0;width:auto;box-shadow:none}.rho-annotation-input [role=alert]{color:#B33F49}.rho-annotation-input [hidden]{display:none!important}';
 document.head.append(style);document.body.append(dialog);
 const get=<T extends HTMLElement=HTMLElement>(id:string)=>dialog.querySelector(`[data-annotation="${id}"]`) as T;
 const mode=get<HTMLSelectElement>('mode'),instance=get<HTMLSelectElement>('instance');options.modes.forEach(item=>mode.add(new Option(item.label,item.value)));
 const preferred=['text','images','transcript'].find(value=>options.modes.some(item=>item.value===value));if(preferred)mode.value=preferred;
 function guard(){if(disposed)throw Error('The source view is closed.');options.guard();}
 async function save(){guard();await options.persist(structuredClone(state));guard();}
 async function read<T>(id:string,args:unknown):Promise<T>{const reply=await options.client.query<{status:string;completeness?:string;data?:T}>(key(id),json(args));guard();if(reply.status!=='ready'||reply.completeness&&reply.completeness!=='complete'||reply.data===undefined)throw Error(`${id} is unavailable.`);return reply.data;}
 function render(){
  get('preview').textContent=preview||state.source?.title||'Prepare an exact source reference.';get('error').textContent=error;get('error').hidden=!error;
  get('status').textContent=state.pending?'The original open request is retained. Inspect it before another action.':state.opened?'Notes opened with the original source. Back to source preserves your reading position.':'Opening notes does not change the source or send to an Agent.';
  for(const button of dialog.querySelectorAll<HTMLButtonElement>('button'))button.disabled=busy;
  get<HTMLButtonElement>('refresh').disabled=busy||!!state.pending;get<HTMLButtonElement>('open').disabled=busy||!!state.pending||!!state.opened||!state.source||!instance.value;
  mode.disabled=busy||!!state.pending;instance.disabled=busy||!!state.pending||!!state.opened;get('inspect').hidden=!state.pending;
 }
 function act(work:()=>Promise<void>){if(busy)return;busy=true;error='';render();void work().catch(e=>{error=e instanceof Error?e.message:String(e);}).finally(()=>{busy=false;render();});}
 async function check(source:AnnotationComponentSource){
  if(source.reference.window!==options.client.view.window||!source.title||source.title.length>200)throw Error('Choose an exact source from this window.');
  const value=await read<ContextPreview>(source.preview.id,{binding:{provider:source.reference.provider,project:options.client.view.project,capability:source.preview,target:null},arguments:{reference:source.reference,inclusion:source.inclusion,max_bytes:16384},preconditions:null});
  if(!sameOperationValue(value.item.reference,source.reference)||value.truncated||!(value.data as any)?.annotation_source?.source_version)throw Error('The source is changed, too large, or does not offer annotation evidence. Choose a smaller supported inclusion.');preview=value.text;
 }
 async function prepare(){
  guard();if(state.pending)throw Error('Inspect the original note opening first.');const source=await options.capture(mode.value);guard();await check(source);
  state={source:structuredClone(source),pending:null,opened:null};await save();candidates=[];let cursor:string|null=null;
  for(let i=0;i<8;i++){
   const page:PluginInstanceObservations=await read('plugins.instances',{after:cursor,limit:20});
   for(const item of page.instances)if(item.observed_in_this_host&&item.instance.state==='active'&&(item.instance.purpose??'runtime')==='runtime'&&item.instance.identity.plugin==='org.rho.annotations'&&item.instance.project===options.client.view.project&&item.instance.principal===options.client.view.principal)candidates.push(item.instance.identity);
   if(!page.next)break;if(page.next===cursor)throw Error('Annotation provider pagination did not advance.');cursor=page.next;
  }
  instance.replaceChildren(new Option('Choose an active Annotations instance',''));candidates.forEach(item=>instance.add(new Option(item.instance,item.instance)));
  if(candidates.length===1)instance.value=candidates[0].instance;if(!candidates.length)error='No active Annotations instance. Activate or restore one in Plugins, then prepare again.';
 }
 function group(node:PluginWindowNode):string|null{return node.kind==='tabs'?node.views.includes(options.client.view.view)?node.id:null:node.kind==='split'?node.children.map(group).find(Boolean)??null:null;}
 function validate(){
  const pending=state.pending,args=pending?.arguments as any;
  if(!pending||pending.view!==options.client.view.view||pending.capability.id!=='windows.open_view'||args?.view?.contribution!=='annotations'||args.view.window!==options.client.view.window||args.view.configuration?.source_request?.return_view!==options.client.view.view||!sameOperationValue(args.view.configuration.source_request.source,state.source))throw Error('The retained annotation opening differs from this source view.');
 }
 async function finish(record:OriginalOperationRecord){
  validate();const pending=state.pending!;pending.operation=record.operation.operation_id;await save();
  for(let i=0;i<20&&!isTerminalOperation(record.status);i++){await new Promise(resolve=>setTimeout(resolve,50));guard();record=await inspectOriginalOperation(options.client,pending);}
  if(record.status!=='succeeded'){if(['failed','cancelled'].includes(record.status)){state.pending=null;await save();}throw Error(record.error??`Original annotation opening is ${record.status}.`);}
  const view=(record.output as {view:PluginViewRecord})?.view,args=pending.arguments as any;
  if(!view||!sameOperationValue(view.instance,args.view.instance)||view.project!==options.client.view.project||view.principal!==options.client.view.principal||view.window!==options.client.view.window||view.contribution!=='annotations'||!sameOperationValue(view.configuration,args.view.configuration)||!sameOperationValue(view.state,args.view.state))throw Error('The annotation opening receipt differs from the original source.');
  state.opened=view;state.pending=null;try{await save();}catch(e){state.opened=null;state.pending=pending;throw e;}dialog.close();
 }
 async function openNotes(){
  guard();if(state.pending||state.opened||!state.source)throw Error('Prepare a source or inspect its original opening first.');const target=candidates.find(item=>item.instance===instance.value);if(!target)throw Error('Choose an observed Annotations provider.');await check(state.source);
  const inspected=await read<PluginInspection>('plugins.inspect',{revision:target.revision});if(inspected.manifest.id!=='org.rho.annotations'||inspected.summary.revision!==target.revision||!inspected.artifacts.some(a=>a.id===target.artifact)||!(inspected.manifest.views.find(view=>view.id==='annotations')?.configuration_schema as any)?.properties?.source_request)throw Error('This Annotations revision does not accept component input.');
  const layout=await read<PluginWindowLayout>('windows.layout',{window:options.client.view.window}),groupId=group(layout.layout);
  if(layout.project!==options.client.view.project||layout.principal!==options.client.view.principal||!groupId)throw Error('The source is no longer placed in this window.');
  const request=crypto.randomUUID();state.pending={view:options.client.view.view,request,capability:key('windows.open_view'),arguments:json({view:{instance:target,contribution:'annotations',window:options.client.view.window,configuration:{source_request:{request_id:crypto.randomUUID(),source:state.source,return_view:options.client.view.view}},state:{}},expected_layout_version:layout.version,group:groupId}),operation:null,preconditions:[]};await save();validate();
  try{await finish(await verifyOriginalOperation(await options.client.invoke(state.pending.capability,state.pending.arguments,{requestId:request}),state.pending));}
  catch(e){const code=e instanceof ViewRequestError?(e.diagnostic as {code?:string})?.code:null;if(code&&['invalid_input','content_changed','not_found','access_denied'].includes(code)){state.pending=null;await save();}throw e;}
 }
 get('close').onclick=()=>dialog.close();get('refresh').onclick=()=>act(prepare);mode.onchange=()=>act(prepare);instance.onchange=render;get('open').onclick=()=>act(openNotes);
 get('inspect').onclick=()=>act(async()=>{validate();await finish(await inspectOriginalOperation(options.client,state.pending!));});
 dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});render();
 return {open(){guard();dialog.showModal();if(!state.pending)act(prepare);},get busy(){return busy;},dispose(){disposed=true;dialog.remove();style.remove();}};
}
