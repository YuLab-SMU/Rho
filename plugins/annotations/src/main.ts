import {connectPluginView, inspectOriginalOperation, verifyOriginalOperation, isTerminalOperation, sameOperationValue} from '../public/plugin-ui/index.js';
import type {OperationIntent, OriginalOperationRecord} from '../public/plugin-ui/index.js';
import type {InstanceRef, JsonValue, ProviderBinding} from '../public/plugin-protocol/index.js';

type Observation<T> = {status:string; data?:T; notices?:string[]};
type AnnotationRef = {annotation_id:string; revision:number};
type Source = {reference:{provider:InstanceRef; contribution:'files'; window:string; selector:unknown}; text:string; title:string; version:string};
type Row = {revision:{annotation:AnnotationRef;note:string;deleted:boolean;updated_at_ms:number};source:{title:string;source_version:string};anchor:unknown};
type Pending = {kind:'freeze'|'create'|'update'|'delete'; intent:OperationIntent; selectedText?:string};
type State = {provider:InstanceRef|null;path:string;source:Source|null;draft:string;evidence:string|null;frozenText:string;frozenTitle:string;frozenVersion:string;selected:AnnotationRef|null;pending:Pending|null;last:{id:string;status:string}|null};
type Receipt = {request_id:string;outcome:{kind:string;evidence_id?:string;annotation?:AnnotationRef}};
const client=await connectPluginView();
const key=(id:string)=>({id,version:1});
const json=(value:unknown)=>value as JsonValue;
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const find=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const provider=find<HTMLSelectElement>('provider'),path=find<HTMLInputElement>('path'),sourceText=find<HTMLTextAreaElement>('source-text'),note=find<HTMLTextAreaElement>('note');
const saved=client.view.state as Partial<State>|null;
const state:State={provider:saved?.provider??null,path:saved?.path??'',source:saved?.source??null,draft:saved?.draft??'',evidence:saved?.evidence??null,frozenText:saved?.frozenText??'',frozenTitle:saved?.frozenTitle??'',frozenVersion:saved?.frozenVersion??'',selected:saved?.selected??null,pending:saved?.pending??null,last:saved?.last??null};
let rows:Row[]=[],after:string|null=null,root:string|null=null,busy=false,stopped=false,saveTimer:ReturnType<typeof setTimeout>|null=null,saveQueue:Promise<unknown>=Promise.resolve();
function notice(text:string,failure=false){const element=find('notice');element.textContent=text;element.classList.toggle('error',failure);element.hidden=!text;}
async function persist(){if(stopped)throw Error('The annotation view is closed.');const snapshot=structuredClone(state);const task=saveQueue.then(()=>client.setState(json(snapshot)));saveQueue=task.catch(()=>undefined);await task;}
function schedule(){if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;void persist().catch(e=>notice(`Draft was not saved: ${errorText(e)}`,true));},180);}
async function flush(){if(saveTimer){clearTimeout(saveTimer);saveTimer=null;await persist();}await saveQueue;}
function render(){
 path.value=state.path;sourceText.value=state.source?.text??'';note.value=state.draft;
 find('source-status').textContent=state.source?`${state.source.title} · frozen candidate ${state.source.version.slice(0,18)} · live source may change`:'No file selected.';
 find<HTMLButtonElement>('capture-selection').disabled=busy||!!state.pending||!state.source;
 find<HTMLButtonElement>('capture-whole').disabled=busy||!!state.pending||!state.source;
 find<HTMLButtonElement>('save').disabled=busy||!!state.pending||(!state.selected&&!state.evidence);
 find<HTMLButtonElement>('delete').hidden=!state.selected;find<HTMLButtonElement>('delete').disabled=busy||!!state.pending;
 find<HTMLButtonElement>('open-file').disabled=busy||!!state.pending;
 find<HTMLButtonElement>('new').disabled=busy||!!state.pending;
 find('editor-title').textContent=state.selected?`Edit revision ${state.selected.revision}`:'New note';
 find('evidence-status').textContent=state.selected?`${state.frozenTitle} · original version ${state.frozenVersion} · revision ${state.selected.revision} · current source status unknown`:state.evidence?`Frozen evidence ${state.evidence.slice(0,18)} · ${state.frozenTitle} · ready for a note`:'Capture source text to begin.';
 const quote=find('frozen-text');quote.hidden=(!state.evidence&&!state.selected)||!state.frozenText;quote.textContent=state.frozenText;
 const pending=find('pending');pending.hidden=!state.pending;
 find('pending-text').textContent=state.pending?`Original ${state.pending.kind} request is unconfirmed. Inspect its Operation before another write.`:'';
 find('note-count').textContent=rows.length?`${rows.length} shown`:'';
 const list=find('notes');list.replaceChildren();
 if(!rows.length){const empty=document.createElement('p');empty.className='meta';empty.textContent='No saved notes in this project.';list.append(empty);}
 for(const item of rows){const button=document.createElement('button');button.type='button';button.className='note-item';button.setAttribute('aria-current',String(state.selected?.annotation_id===item.revision.annotation.annotation_id));button.textContent=item.revision.note.slice(0,130)||'Untitled note';const meta=document.createElement('small');meta.textContent=`${item.source.title} · revision ${item.revision.annotation.revision} · ${item.source.source_version.slice(0,18)}`;button.append(meta);button.onclick=()=>void work(()=>openNote(item.revision.annotation));list.append(button);}
 find<HTMLButtonElement>('more').hidden=!after;
}
async function work(action:()=>Promise<void>){if(busy||stopped)return;busy=true;render();notice('');try{await action();}catch(e){notice(errorText(e),true);}finally{busy=false;render();}}
async function observe<T>(id:string,args:unknown):Promise<T>{const reply=await client.query<Observation<T>>(key(id),json(args));if(reply.status!=='ready'||reply.data===undefined)throw Error(reply.notices?.join('; ')||`${id} is unavailable.`);return reply.data;}
async function binding(instance:InstanceRef,id:string,target:string|null=null):Promise<ProviderBinding>{const found=await observe<ProviderBinding>('plugins.resolve',{instance,capability:key(id)});if(!sameOperationValue(found.capability,key(id))||!sameOperationValue(found.provider,instance)||found.project!==client.view.project)throw Error('The selected provider binding changed.');return {...found,target};}
async function read<T>(instance:InstanceRef,id:string,args:unknown,target:string|null=null):Promise<T>{return observe<T>(id,{binding:await binding(instance,id,target),arguments:args});}
async function projectRoot(){if(root)return root;const paths=await observe<{project_root:string}>('workspace.paths',{});if(!paths.project_root?.startsWith('/'))throw Error('The project path is unavailable.');root=paths.project_root;return root;}
const catalog:InstanceRef[]=[];
async function sources(){
 provider.replaceChildren(new Option('Choose Files…',''));
 let cursor:string|null=null;
 for(let pageNumber=0;pageNumber<8;pageNumber++){
  const page:{instances:{instance:{identity:InstanceRef;alias:string;state:string;project:string;principal:string};observed_in_this_host:boolean}[];next:string|null}=await observe('plugins.instances',{after:cursor,limit:20});
  for(const item of page.instances){const p=item.instance;if(item.observed_in_this_host&&p.state==='active'&&p.identity.plugin==='org.rho.files'&&p.project===client.view.project&&p.principal===client.view.principal){catalog.push(structuredClone(p.identity));provider.add(new Option(p.alias,p.identity.instance));}}
  if(!page.next||page.next===cursor)break;cursor=page.next;
 }
 if(state.provider&&!Array.from(provider.options).some(option=>option.value===state.provider?.instance))provider.add(new Option('Saved Files provider (unavailable)',state.provider.instance));
 provider.value=state.provider?.instance??'';
}
async function openFile(){
 if(!state.provider)throw Error('Choose a Files provider.');
 const chosen=path.value.trim();if(!chosen||chosen.startsWith('/')||chosen.includes('\\')||chosen.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Choose a project-relative file path.');
 const nativeRoot=await projectRoot();
 const page=await read<{file?:unknown;skipped?:unknown}>(state.provider,'files.read_text',{path:chosen,start_line:1,limit_lines:1},nativeRoot);
 if(!page.file||page.skipped)throw Error('The original text file is unavailable.');
 const reference={provider:structuredClone(state.provider),contribution:'files' as const,window:client.view.window,selector:page.file};
 const preview=await read<{text:string;truncated:boolean;item:{title:string};data:{annotation_source?:{source_version:string}}}>(state.provider,'files.context.preview',{reference,inclusion:{kind:'text'},max_bytes:16384},nativeRoot);
 if(preview.truncated||typeof preview.text!=='string'||!preview.data.annotation_source?.source_version)throw Error('The source preview is incomplete; it was not captured.');
 state.path=chosen;state.source={reference,text:preview.text,title:preview.item.title,version:preview.data.annotation_source.source_version};state.evidence=null;state.frozenText='';state.selected=null;state.draft='';await persist();render();notice('Select text in the source, then capture it.');
}
async function list(append=false){const result=await read<{kind:string;items:Row[];next_after:string|null}>(client.view.instance,'annotations.read',{kind:'list',after:append?after:null,limit:30,include_deleted:false});if(result.kind!=='list'||!Array.isArray(result.items))throw Error('The annotation list is invalid.');rows=append?[...rows,...result.items]:result.items;after=result.next_after;render();}
async function openNote(ref:AnnotationRef){if(state.pending)throw Error('Inspect the original write before opening another note.');const result=await read<{kind:string;revision:{note:string;evidence_id:string};evidence:{source:{title:string;source_version:string};fragment:unknown}}>(client.view.instance,'annotations.read',{kind:'read',annotation:ref});if(result.kind!=='read')throw Error('The saved note is unavailable.');state.selected=structuredClone(ref);state.evidence=result.revision.evidence_id;state.draft=result.revision.note;state.source=null;state.frozenText=typeof result.evidence.fragment==='object'&&result.evidence.fragment!==null&&'text' in result.evidence.fragment&&typeof result.evidence.fragment.text==='string'?result.evidence.fragment.text:JSON.stringify(result.evidence.fragment);state.frozenTitle=result.evidence.source.title;state.frozenVersion=result.evidence.source.source_version;await persist();render();}
async function write(kind:Pending['kind'],command:unknown,selectedText?:string){
 if(state.pending)throw Error('Inspect the original unconfirmed write first.');
 find('conflict').hidden=true;
 await flush();
 const request=crypto.randomUUID(),args={binding:await binding(client.view.instance,'annotations.write'),arguments:{request_id:request,command},preconditions:null};
 const intent:OperationIntent={view:client.view.view,request,capability:key('annotations.write'),arguments:json(args),operation:null,preconditions:[]};
 state.pending={kind,intent,...(selectedText!==undefined?{selectedText}:{})};await persist();render();
 try{const record=await verifyOriginalOperation(await client.invoke(key('annotations.write'),json(args),{requestId:request}),intent);if(!state.pending)throw Error('The original request state was lost.');state.pending.intent.operation=record.operation.operation_id;await persist();await waitForOriginal(record);}
 catch(e){notice(`Original ${kind} request is unconfirmed: ${errorText(e)}`,true);}
}
async function settle(record:OriginalOperationRecord){const pending=state.pending;if(!pending)throw Error('The original request is no longer retained.');
 if(!isTerminalOperation(record.status)){pending.intent.operation=record.operation.operation_id;await persist();notice('The original operation is still running. Inspect it again to settle.');return;}
 state.last={id:record.operation.operation_id,status:record.status};
 if(record.status==='succeeded'){
  const receipt=record.output as Receipt;if(receipt?.request_id!==pending.intent.request)throw Error('The original annotation receipt differs from its saved request.');
  if(pending.kind==='freeze'){if(receipt.outcome.kind!=='evidence'||!receipt.outcome.evidence_id||!state.source)throw Error('The original freeze has no matching evidence.');state.evidence=receipt.outcome.evidence_id;state.frozenText=pending.selectedText??'';state.frozenTitle=state.source.title;state.frozenVersion=state.source.version;state.selected=null;}
  else if(pending.kind==='create'||pending.kind==='update'){if(receipt.outcome.kind!=='annotation'||!receipt.outcome.annotation)throw Error('The original note has no revision.');state.selected=receipt.outcome.annotation;}
  else if(pending.kind==='delete'){state.selected=null;state.evidence=null;state.frozenText='';state.draft='';}
 }else find('conflict').textContent=`${pending.kind} ${record.status}: ${record.error??'Inspect the original result.'} Your draft is retained. Refresh notes before editing again.`;
 find('conflict').hidden=record.status==='succeeded';state.pending=null;await persist();
 if(record.status==='succeeded'){notice(`${pending.kind} saved in original Operation ${record.operation.operation_id.slice(0,10)}.`);if(pending.kind!=='freeze')await list();}
}
async function waitForOriginal(first:OriginalOperationRecord){let record=first;for(let attempt=0;attempt<24&&!isTerminalOperation(record.status)&&!stopped;attempt++){await new Promise(resolve=>setTimeout(resolve,100));if(!state.pending)throw Error('The original request state was lost.');record=await inspectOriginalOperation(client,state.pending.intent);}if(!stopped)await settle(record);}
async function recover(){if(!state.pending)throw Error('No original write is waiting.');const record=await inspectOriginalOperation(client,state.pending.intent);state.pending.intent.operation=record.operation.operation_id;await persist();await waitForOriginal(record);}
async function capture(whole:boolean){if(!state.source)throw Error('Read a source first.');const start=sourceText.selectionStart,end=sourceText.selectionEnd;if(!whole&&start===end)throw Error('Select a quote in the source text.');const selectedText=whole?state.source.text:state.source.text.slice(start,end);const anchor=whole?{kind:'whole_item'}:{kind:'text_quote',quote:selectedText,start,end,unit:'utf16'};await write('freeze',{kind:'freeze',reference:state.source.reference,inclusion:{kind:'text'},anchor},selectedText);}
provider.onchange=()=>{const selected=Array.from(provider.options).find(option=>option.selected);state.provider=selected?.value?catalog.find(item=>item.instance===selected.value)??null:null;state.source=null;state.evidence=null;state.frozenText='';state.selected=null;schedule();render();};
path.oninput=()=>{state.path=path.value;schedule();};note.oninput=()=>{state.draft=note.value;schedule();};
find('open-file').onclick=()=>void work(openFile);find('capture-selection').onclick=()=>void work(()=>capture(false));find('capture-whole').onclick=()=>void work(()=>capture(true));
find('save').onclick=()=>void work(async()=>{if(!state.draft.trim())throw Error('Write a note before saving.');if(state.selected)await write('update',{kind:'update',expected:state.selected,note:state.draft,labels:[],marks:[]});else if(state.evidence)await write('create',{kind:'create',evidence_id:state.evidence,note:state.draft,labels:[],marks:[],continued_from:null});});
find('delete').onclick=()=>void work(async()=>{if(state.selected)await write('delete',{kind:'delete',expected:state.selected});});
find('recover').onclick=()=>void work(recover);find('refresh').onclick=()=>void work(async()=>{await list();notice('Saved notes refreshed.');});find('more').onclick=()=>void work(()=>list(true));
find('new').onclick=()=>void work(async()=>{state.selected=null;state.draft='';await persist();});
const close=await client.installCloseHandler({async flush(){await flush();},resume(){render();}});
close.subscribe(()=>{const failure=close.getSnapshot().error;if(failure)notice(failure,true);});
window.addEventListener('pagehide',()=>{stopped=true;if(saveTimer)clearTimeout(saveTimer);client.dispose();},{once:true});
render();
await work(async()=>{let catalogError:string|null=null;try{await sources();}catch(error){catalogError=errorText(error);}await list();if(state.pending)notice('An original annotation write is unconfirmed. Inspect it before another write.');else if(catalogError)notice(`Files selection is unavailable: ${catalogError}`,true);});
