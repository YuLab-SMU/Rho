import {connectPluginView, inspectOriginalOperation, verifyOriginalOperation, isTerminalOperation, sameOperationValue, readResource, ViewRequestError} from '../public/plugin-ui/index.js';
import type {OperationIntent, OriginalOperationRecord} from '../public/plugin-ui/index.js';
import type {InstanceRef, JsonValue, ProviderBinding, ContextReference, ResourceReference, PluginInspection, PluginInstanceObservations, PluginWindowLayout, PluginWindowNode, PluginViewRecord} from '../public/plugin-protocol/index.js';
import {observe as query,previewSource,sourceChoices,type Source,type SourceChoice,type ContextItem} from './sources.js';
import {draw,point,shape,type Mark,type Point,type Tool} from './marks.js';

type AnnotationRef = {annotation_id:string;revision:number};
type Capture = {capture_id:string;sha256:string;width:number;height:number;mime_type:string;byte_size:number;original_media:boolean};
type Revision = {annotation:AnnotationRef;note:string;labels:string[];marks:Mark[];evidence_id:string;deleted:boolean;updated_at_ms:number;continued_from:AnnotationRef|null};
type Evidence = {source:{title:string;source_id:string;source_version:string};anchor:{kind:string;capture?:Capture};selection:{reference:ContextReference;inclusion:string};fragment:{text?:string;resources?:ResourceReference[];data?:unknown}};
type Row = {revision:Revision;source:Evidence['source'];anchor:Evidence['anchor']};
type Pending = {kind:'freeze'|'create'|'update'|'delete'|'import'|'agent'|'back';intent:OperationIntent;selectedText?:string;source?:Source;image?:ResourceReference};
type State = {provider:InstanceRef|null;path:string;source:Source|null;draft:string;evidence:string|null;frozenText:string;frozenTitle:string;frozenVersion:string;selected:AnnotationRef|null;pending:Pending|null;last:{id:string;status:string}|null;
  labels:string[];marks:Mark[];capture:Capture|null;origin:Source|null;deleted:boolean;continuedFrom:AnnotationRef|null;filter:string;order:string;checked:AnnotationRef[];sourceRequest:string|null;agentOpened:PluginViewRecord|null;baseline:{note:string;labels:string[];marks:Mark[]}|null};
type Receipt = {request_id:string;outcome:{kind:string;evidence_id?:string;annotation?:AnnotationRef;capture?:Capture}};
type SourceRequest = {request_id:string;source:{reference:ContextReference;title:string;inclusion:unknown;preview:{id:string;version:number}};return_view:string};
const client=await connectPluginView(),key=(id:string)=>({id,version:1}),json=(value:unknown)=>value as JsonValue;
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const find=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const provider=find<HTMLSelectElement>('provider'),path=find<HTMLInputElement>('path'),sourceText=find<HTMLTextAreaElement>('source-text'),componentText=find<HTMLTextAreaElement>('component-text'),note=find<HTMLTextAreaElement>('note');
const configuration=client.view.configuration as {source_request?:SourceRequest};
document.body.classList.toggle('source-focused',!!configuration.source_request);
const saved=client.view.state as Partial<State>|null;
const state:State={provider:saved?.provider??null,path:saved?.path??'',source:saved?.source??null,draft:saved?.draft??'',evidence:saved?.evidence??null,frozenText:saved?.frozenText??'',frozenTitle:saved?.frozenTitle??'',frozenVersion:saved?.frozenVersion??'',selected:saved?.selected??null,pending:saved?.pending??null,last:saved?.last??null,
  labels:saved?.labels??[],marks:saved?.marks??[],capture:saved?.capture??null,origin:saved?.origin??null,deleted:saved?.deleted??false,continuedFrom:saved?.continuedFrom??null,filter:saved?.filter??'all',order:saved?.order??'newest',checked:saved?.checked??[],sourceRequest:saved?.sourceRequest??null,agentOpened:saved?.agentOpened??null,baseline:saved?.baseline??null};
// Retained drafts from the shipped Files view have no generic source descriptor.
if(state.source&&!state.source.preview)state.source={...state.source,preview:key('files.context.preview'),inclusion:{kind:'text'},resources:[],lineage:''};
if(state.pending?.kind==='freeze'&&!state.pending.source&&state.source)state.pending.source=structuredClone(state.source);
let rows:Row[]=[],after:string|null=null,root:string|null=null,busy=false,stopped=false,saveTimer:ReturnType<typeof setTimeout>|null=null,saveQueue:Promise<unknown>=Promise.resolve();
let choices:SourceChoice[]=[],items:ContextItem[]=[],activeChoice:SourceChoice|null=null,sourceAfter:JsonValue|null=null;
let imageUrl:string|null=null,imageIdentity='',imageReady=false,tool:Tool='select',stroke:Point[]|null=null,pointer:number|null=null,selectedMark:number|null=null,markUndo:Mark[][]=[];
let liveStatus='Current source status unknown.',agents:InstanceRef[]=[],agentSources:JsonValue[]=[],sourceImages:ResourceReference[]=[];
const canvas=find<HTMLCanvasElement>('mark-canvas'),image=find<HTMLImageElement>('capture-image');
function notice(text:string,failure=false){const element=find('notice');element.textContent=text;element.classList.toggle('error',failure);element.hidden=!text;}
async function persist(){if(stopped)throw Error('The annotation view is closed.');const snapshot=structuredClone(state);const task=saveQueue.then(()=>client.setState(json(snapshot)));saveQueue=task.catch(()=>undefined);await task;}
function schedule(){if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;void persist().catch(e=>notice(`Draft was not saved: ${errorText(e)}`,true));},180);}
async function flush(){if(saveTimer){clearTimeout(saveTimer);saveTimer=null;await persist();}await saveQueue;}
function filteredRows(){
 const visible=rows.filter(item=>{
  if(state.filter==='deleted')return item.revision.deleted;
  if(item.revision.deleted)return false;
  if(state.filter==='question'||state.filter==='change')return item.revision.labels.includes(state.filter==='question'?'Question':'Change request');
  if(state.filter==='history')return !state.source||item.source.source_version!==state.source.version;
  return true;
 });
 return visible.sort((a,b)=>(a.revision.updated_at_ms-b.revision.updated_at_ms)*(state.order==='oldest'?1:-1));
}
function render(){
 path.value=state.path;const fileText=state.source?.reference.contribution==='files'?state.source.text:'';if(sourceText.value!==fileText)sourceText.value=fileText;if(componentText.value!==(state.source?.text??''))componentText.value=state.source?.text??'';
 // Rendering busy/list state must not replace the text node or its IME composition.
 if(note.value!==state.draft)note.value=state.draft;
 note.readOnly=state.deleted;
 find<HTMLSelectElement>('note-label').value=state.labels[0]??'';
 const block=busy||!!state.pending;
 find('source-status').textContent=state.source?.reference.contribution==='files'?`${state.source.title} · version ${state.source.version.slice(0,18)}`:'No file selected.';
 find('component-status').textContent=state.source?`${state.source.title} · exact version ${state.source.version.slice(0,18)}`:'Select a component source and search for an item.';
 for(const id of ['capture-selection','capture-whole','capture-component-selection','capture-component-whole'])find<HTMLButtonElement>(id).disabled=block||!state.source;
 find<HTMLButtonElement>('save').disabled=block||state.deleted||(!state.selected&&!state.evidence);
 find<HTMLButtonElement>('delete').hidden=!state.selected||state.deleted;find<HTMLButtonElement>('delete').disabled=block;
 for(const id of ['open-file','new','refresh','discover-sources'])find<HTMLButtonElement>(id).disabled=block;
 find('editor-title').textContent=state.selected?`${state.deleted?'Deleted':'Edit'} revision ${state.selected.revision}`:'New note';
 find('evidence-status').textContent=state.selected||state.evidence?`${state.selected?`Revision ${state.selected.revision}`:`Frozen evidence ${state.evidence?.slice(0,18)}`} · ${state.frozenTitle} · original version ${state.frozenVersion.slice(0,36)} · ${liveStatus}`:'Capture source text or an image to begin.';
 const quote=find('frozen-text');quote.hidden=(!state.evidence&&!state.selected)||!state.frozenText;quote.textContent=state.frozenText;
 find('pending').hidden=!state.pending;find('pending-text').textContent=state.pending?`Original ${state.pending.kind} request is unconfirmed. Inspect it before another write.`:'';
 find<HTMLSelectElement>('note-filter').value=state.filter;find<HTMLSelectElement>('note-order').value=state.order;
 const shown=filteredRows();find('note-count').textContent=`${shown.length} shown`;
 find('filter-status').textContent=state.filter==='history'?(state.source?'Notes from other captured source versions.':'Showing saved versions. Select a current source to compare versions.'):'Versions remain attached to their captured source; current source status is unknown until checked. Order applies to the loaded page.';
 const list=find('notes');list.replaceChildren();
 if(!shown.length){const empty=document.createElement('p');empty.className='meta';empty.textContent=rows.some(row=>!row.revision.deleted)||state.filter==='deleted'?'No notes match this filter.':'No saved notes in this project.';list.append(empty);}
 for(const item of shown){
  const row=document.createElement('div');row.className='note-item';row.setAttribute('aria-current',String(state.selected?.annotation_id===item.revision.annotation.annotation_id));
  const check=document.createElement('input');check.type='checkbox';check.disabled=block||item.revision.deleted;check.setAttribute('aria-label',`Select ${item.revision.note.slice(0,80)||'Untitled note'}`);check.checked=state.checked.some(ref=>sameOperationValue(ref,item.revision.annotation));
  check.onchange=()=>{state.checked=state.checked.filter(ref=>ref.annotation_id!==item.revision.annotation.annotation_id);if(check.checked)state.checked.push(structuredClone(item.revision.annotation));schedule();render();};
  const button=document.createElement('button');button.className='note-copy';button.type='button';button.disabled=block;const title=document.createElement('strong');title.textContent=item.revision.note.slice(0,130)||'Untitled note';
  const meta=document.createElement('small');meta.textContent=`${item.source.title} · revision ${item.revision.annotation.revision}${item.revision.deleted?' · Deleted':''} · ${item.revision.labels.join(', ')} · source ${item.source.source_version.slice(0,18)}`;
  button.append(title,meta);button.onclick=()=>void work(()=>openNote(item.revision.annotation));row.append(check,button);list.append(row);
 }
 find<HTMLButtonElement>('more').hidden=!after;find<HTMLButtonElement>('more').disabled=block;
 const available=shown.filter(row=>!row.revision.deleted);find<HTMLInputElement>('select-visible').checked=!!available.length&&available.every(item=>state.checked.some(ref=>sameOperationValue(ref,item.revision.annotation)));
 find<HTMLInputElement>('select-visible').disabled=block||!available.length;find<HTMLButtonElement>('add-agent').disabled=block||!state.checked.length;
 find('back-source').hidden=!configuration.source_request;find<HTMLButtonElement>('back-source').disabled=block;
 find('check-source').hidden=!state.origin;find<HTMLButtonElement>('check-source').disabled=block;
 find('continue-note').hidden=!state.selected||state.deleted;find<HTMLButtonElement>('continue-note').disabled=block||!state.origin;
 find('previous-revision').hidden=!state.selected||state.selected.revision<=1;find<HTMLButtonElement>('previous-revision').disabled=block;
 find('image-editor').hidden=!imageReady;
 find('mark-tools').hidden=!state.capture;find('mark-text-label').hidden=!state.capture;find('mark-text').hidden=!state.capture;
 find('capture-view').hidden=!state.source?.resources?.length||!!state.evidence;find<HTMLButtonElement>('capture-view').disabled=block;
 find('capture-view').textContent=state.capture?'Attach captured view':'Capture image to annotate';
 find<HTMLButtonElement>('open-capture').disabled=block||!imageReady;
 const sourceImage=find<HTMLSelectElement>('source-image');sourceImage.hidden=!!state.capture||sourceImages.length<2;find('source-image-label').hidden=sourceImage.hidden;sourceImage.disabled=block;
 find('image-status').textContent=state.capture?`Captured view · ${state.capture.width} × ${state.capture.height} · ${state.marks.length} marks · source image retained separately.`:sourceImages.length?'Preview only. Capture the image before drawing.':'No image included.';
 find<HTMLButtonElement>('undo-mark').disabled=block||!markUndo.length;
 for(const button of find('mark-tools').querySelectorAll<HTMLButtonElement>('[data-tool]')){button.setAttribute('aria-pressed',String(button.dataset.tool===tool));button.disabled=block||state.deleted;}
 find('capture-frame').dataset.tool=tool;
 renderMarks();sourceControls();
}
function renderMarks(){
 draw(canvas,stroke?[...state.marks,...(shape(tool,stroke,find<HTMLInputElement>('mark-text').value)?[shape(tool,stroke,find<HTMLInputElement>('mark-text').value)!]:[])]:state.marks,selectedMark);
 const list=find('mark-list');list.replaceChildren();
 state.marks.forEach((mark,index)=>{
  const row=document.createElement('div');row.className='mark-row';const select=document.createElement('button');select.type='button';select.textContent=`${index+1}. ${mark.kind}${mark.kind==='text'?` · ${mark.text}`:''}`;select.setAttribute('aria-pressed',String(index===selectedMark));select.onclick=()=>{selectedMark=index;renderMarks();};
  const remove=document.createElement('button');remove.type='button';remove.className='quiet';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove mark ${index+1}`);remove.disabled=busy||!!state.pending||state.deleted;
  remove.onclick=()=>{markUndo.push(structuredClone(state.marks));state.marks.splice(index,1);selectedMark=null;schedule();render();};row.append(select,remove);list.append(row);
 });
}
async function work(action:()=>Promise<void>){if(busy||stopped)return;busy=true;render();notice('');try{await action();}catch(e){notice(errorText(e),true);}finally{busy=false;render();}}
const observe=<T>(id:string,args:unknown)=>query<T>(client,id,args);
async function binding(instance:InstanceRef,id:string,target:string|null=null):Promise<ProviderBinding>{const found=await observe<ProviderBinding>('plugins.resolve',{instance,capability:key(id)});if(!sameOperationValue(found.capability,key(id))||!sameOperationValue(found.provider,instance)||found.project!==client.view.project)throw Error('The selected provider binding changed.');return {...found,target};}
async function read<T>(instance:InstanceRef,id:string,args:unknown,target:string|null=null):Promise<T>{return observe<T>(id,{binding:await binding(instance,id,target),arguments:args,preconditions:null});}
async function projectRoot(){if(root)return root;const paths=await observe<{project_root:string}>('workspace.paths',{});if(!paths.project_root?.startsWith('/'))throw Error('The project path is unavailable.');root=paths.project_root;return root;}
const catalog:InstanceRef[]=[];
async function sources(){
 provider.replaceChildren(new Option('Choose Files…',''));catalog.length=0;let cursor:string|null=null;
 for(let i=0;i<8;i++){
  const page:PluginInstanceObservations=await observe<PluginInstanceObservations>('plugins.instances',{after:cursor,limit:20});
  for(const item of page.instances){const p=item.instance;if(item.observed_in_this_host&&p.state==='active'&&p.identity.plugin==='org.rho.files'&&p.project===client.view.project&&p.principal===client.view.principal){catalog.push(structuredClone(p.identity));provider.add(new Option(p.alias,p.identity.instance));}}
  if(!page.next)break;if(page.next===cursor)throw Error('Files pagination did not advance.');cursor=page.next;
 }
 if(state.provider&&!catalog.some(item=>item.instance===state.provider?.instance))provider.add(new Option('Saved Files provider (unavailable)',state.provider.instance));provider.value=state.provider?.instance??'';
}
function clearImage(){if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null;imageIdentity='';imageReady=false;image.removeAttribute('src');canvas.width=1;canvas.height=1;}
async function showImage(blob:Blob,identity:string){
 if(typeof createImageBitmap==='function'){const bitmap=await createImageBitmap(blob);try{if(bitmap.width<1||bitmap.height<1||bitmap.width>16384||bitmap.height>16384||bitmap.width*bitmap.height>8*1024*1024)throw Error('The image exceeds the capture pixel limit.');}finally{bitmap.close();}}
 if(stopped)return;clearImage();imageUrl=URL.createObjectURL(blob);imageIdentity=identity;image.src=imageUrl;await image.decode();
 if(stopped||imageIdentity!==identity)return;
 imageReady=true;canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;renderMarks();
}
async function previewImage(){
 sourceImages=state.source?.resources??[];
 if(!sourceImages.length){clearImage();return;}
 const resource=sourceImages[Number(find<HTMLSelectElement>('source-image').value)||0];if(!resource)throw Error('Choose an available source image.');
 try{const bytes=await readResource(client,resource,{maxBytes:8*1024*1024});await showImage(new Blob([bytes],{type:resource.media_type}),resource.digest);}
 catch(error){clearImage();notice(`Image not included: ${errorText(error)}. Text and your draft are retained.`,true);}
}
async function retainedImage(){
 const capture=state.capture;if(!capture){clearImage();return;}
 if(capture.byte_size<1||capture.byte_size>8*1024*1024||capture.width<1||capture.height<1||capture.width*capture.height>8*1024*1024)throw Error('The retained capture exceeds the image budget.');
 const chunks:Uint8Array[]=[];let offset=0;
 while(offset<capture.byte_size){
  const reply=await read<{capture:Capture;offset:number;base64:string;next:number|null}>(client.view.instance,'annotations.capture.read',{capture,offset,limit:65536});
  const expected=Math.min(65536,capture.byte_size-offset),next=offset+expected<capture.byte_size?offset+expected:null;
  if(!sameOperationValue(reply.capture,capture)||reply.offset!==offset||reply.next!==next)throw Error('The retained image read differs from its original capture.');
  const bytes=Uint8Array.from(atob(reply.base64),char=>char.charCodeAt(0));if(bytes.length!==expected)throw Error('The captured image is incomplete.');chunks.push(bytes);offset+=bytes.length;
 }
 const bytes=new Uint8Array(capture.byte_size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 const digest='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
 if(digest!==capture.sha256)throw Error('The captured image digest differs from the retained evidence.');
 await showImage(new Blob([bytes],{type:capture.mime_type}),capture.sha256);
 if(image.naturalWidth!==capture.width||image.naturalHeight!==capture.height)throw Error('The captured image dimensions differ from its evidence.');
}
function resetEditor(){state.selected=null;state.evidence=null;state.frozenText='';state.frozenTitle='';state.frozenVersion='';state.draft='';state.labels=[];state.marks=[];state.capture=null;state.origin=null;state.deleted=false;state.continuedFrom=null;state.baseline=null;markUndo=[];selectedMark=null;liveStatus='Current source status unknown.';}
async function protectDraft():Promise<boolean>{if(state.pending)throw Error('Inspect the original unconfirmed request first.');const draft={note:state.draft,labels:state.labels,marks:state.marks};const dirty=state.baseline?!sameOperationValue(draft,state.baseline):!!(state.draft.trim()||state.marks.length);if(!dirty)return true;return new Promise(resolve=>{const dialog=find<HTMLDialogElement>('replace-dialog');const settle=(answer:boolean)=>{dialog.close();resolve(answer);};find('keep-draft').onclick=()=>settle(false);find('replace-draft').onclick=()=>settle(true);dialog.oncancel=event=>{event.preventDefault();settle(false);};dialog.showModal();});}
async function selectSource(source:Source){
 const continuation=state.continuedFrom&&!state.evidence?state.continuedFrom:null,draft=state.draft;
 if(continuation){
  if(!state.origin||!state.origin.lineage||source.lineage!==state.origin.lineage||!sameOperationValue(source.reference.provider,state.origin.reference.provider)||source.reference.contribution!==state.origin.reference.contribution)throw Error('Choose the same source lineage to continue this note. Your draft is retained.');
  if(source.version===state.frozenVersion)throw Error('Choose a new source version. The original version still matches this capture.');
 }else if(!await protectDraft())return;
 resetEditor();state.source=source;if(continuation){state.continuedFrom=continuation;state.draft=draft;}await persist();await previewImage();render();notice(continuation?'Capture the new source version. The previous note stays linked; original marks remain on their original image.':'Select text or capture the whole item.');
}
async function openFile(){
 if(!state.provider)throw Error('Choose a Files provider.');const chosen=path.value.trim();
 if(!chosen||chosen.startsWith('/')||chosen.includes('\\')||chosen.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Choose a project-relative file path.');
 const page=await read<{file?:JsonValue;skipped?:unknown}>(state.provider,'files.read_text',{path:chosen,start_line:1,limit_lines:1},await projectRoot());if(!page.file||page.skipped)throw Error('The original text file is unavailable.');
 const reference={provider:structuredClone(state.provider),contribution:'files',window:client.view.window,selector:page.file};
 state.path=chosen;await selectSource(await previewSource(client,reference,key('files.context.preview'),{kind:'text'}));
}
async function discover(){
 choices=await sourceChoices(client);const select=find<HTMLSelectElement>('component-source');select.replaceChildren(new Option('Choose a component…',''));choices.forEach((choice,index)=>select.add(new Option(choice.title,String(index))));activeChoice=null;sourceControls();
}
function sourceControls(){
 const chosen=activeChoice!==null;find<HTMLButtonElement>('search-sources').disabled=busy||!chosen;find<HTMLButtonElement>('search-more').hidden=!sourceAfter;find<HTMLButtonElement>('search-more').disabled=busy||!chosen;
 const item=find<HTMLSelectElement>('component-item'),include=find<HTMLSelectElement>('component-inclusion');item.disabled=!items.length;include.disabled=!items.length;find<HTMLButtonElement>('preview-source').disabled=busy||!items.length;
}
async function search(more=false){
 if(!activeChoice)throw Error('Choose a component source.');
 const page=await read<{items:ContextItem[];next:JsonValue|null;notices:string[]}>(activeChoice.provider,activeChoice.search.id,{window:client.view.window,text:find<HTMLInputElement>('component-search').value,after:more?sourceAfter:null,limit:20});
 if(page.next&&sameOperationValue(page.next,sourceAfter))throw Error('Source search pagination did not advance.');
 items=more?[...items,...page.items]:page.items;sourceAfter=page.next;find('component-notices').textContent=page.notices.join(' ');
 const select=find<HTMLSelectElement>('component-item');select.replaceChildren();items.forEach((item,index)=>select.add(new Option(item.title,String(index))));if(!items.length)select.add(new Option('No matching source items',''));sourceControls();
}
async function componentPreview(){
 if(!activeChoice)throw Error('Choose a component source.');const item=items[Number(find<HTMLSelectElement>('component-item').value)],mode=activeChoice.modes[Number(find<HTMLSelectElement>('component-inclusion').value)];
 if(!item||!mode)throw Error('Choose a source item and inclusion.');await selectSource(await previewSource(client,item.reference,activeChoice.preview,mode.inclusion));
}
async function list(append=false){
 const result=await read<{kind:string;items:Row[];next_after:string|null}>(client.view.instance,'annotations.read',{kind:'list',after:append?after:null,limit:30,include_deleted:true});
 if(result.kind!=='list'||!Array.isArray(result.items))throw Error('The annotation list is invalid.');rows=append?[...rows,...result.items]:result.items;after=result.next_after;render();
}
async function origin(evidence:Evidence):Promise<Source|null>{
 try{
  const reference=evidence.selection.reference,inspection=await observe<PluginInspection>('plugins.inspect',{revision:reference.provider.revision});
  const capability=inspection.manifest.contexts.find(context=>context.id===reference.contribution)?.preview;if(!capability)return null;
  const data=evidence.fragment.data as {annotation_source?:{source_id:string}}|undefined;
  return {reference,preview:capability,inclusion:JSON.parse(evidence.selection.inclusion),text:evidence.fragment.text??'',title:evidence.source.title,version:evidence.source.source_version,lineage:data?.annotation_source?.source_id??'',resources:evidence.fragment.resources??[]};
 }catch{return null;}
}
async function openNote(ref:AnnotationRef,force=false){
 if(!force&&!await protectDraft())return;
 const result=await read<{kind:string;revision:Revision;evidence:Evidence}>(client.view.instance,'annotations.read',{kind:'read',annotation:ref});if(result.kind!=='read')throw Error('The saved note is unavailable.');
 resetEditor();state.selected=structuredClone(ref);state.evidence=result.revision.evidence_id;state.draft=result.revision.note;state.labels=result.revision.labels;state.marks=result.revision.marks;state.deleted=result.revision.deleted;state.continuedFrom=result.revision.continued_from;state.source=null;sourceImages=[];
 state.baseline={note:state.draft,labels:structuredClone(state.labels),marks:structuredClone(state.marks)};
 state.capture=result.evidence.anchor.kind==='captured_view'?result.evidence.anchor.capture??null:null;state.frozenText=result.evidence.fragment.text??JSON.stringify(result.evidence.fragment);state.frozenTitle=result.evidence.source.title;state.frozenVersion=result.evidence.source.source_version;state.origin=await origin(result.evidence);
 await persist();if(state.capture)await retainedImage();else clearImage();render();
}
async function dispatch(pending:Pending){
 if(state.pending)throw Error('Inspect the original unconfirmed request first.');await flush();state.pending=structuredClone(pending);await persist();render();
 try{const record=await verifyOriginalOperation(await client.invoke(pending.intent.capability,pending.intent.arguments,{requestId:pending.intent.request,preconditions:pending.intent.preconditions}),pending.intent);state.pending!.intent.operation=record.operation.operation_id;await persist();await waitForOriginal(record);}
 catch(e){const code=e instanceof ViewRequestError?(e.diagnostic as {code?:string})?.code:null;if(code&&['invalid_input','content_changed','not_found','access_denied'].includes(code)){state.pending=null;await persist();notice(`Request refused: ${errorText(e)}. Your draft is retained.`,true);}else notice(`Original ${pending.kind} request is unconfirmed: ${errorText(e)}`,true);}
}
async function write(kind:Pending['kind'],command:unknown,selectedText?:string){
 find('conflict').hidden=true;const request=crypto.randomUUID(),args={binding:await binding(client.view.instance,'annotations.write'),arguments:{request_id:request,command},preconditions:null};
 await dispatch({kind,intent:{view:client.view.view,request,capability:key('annotations.write'),arguments:json(args),operation:null,preconditions:[]},...(selectedText!==undefined?{selectedText}:{}),...(kind==='freeze'&&state.source?{source:structuredClone(state.source)}:{})});
}
async function settle(record:OriginalOperationRecord){
 const pending=state.pending;if(!pending)throw Error('The original request is no longer retained.');
 if(!isTerminalOperation(record.status)){pending.intent.operation=record.operation.operation_id;await persist();notice('The original operation is still running. Inspect it again to settle.');return;}
 // Uncertain is terminal to the journal, but it is not permission to submit another write.
 if(record.status==='uncertain'){await persist();notice('The original outcome is uncertain. Its identity and your draft remain retained; no replacement was submitted.',true);return;}
 state.last={id:record.operation.operation_id,status:record.status};
 if(record.status==='succeeded'){
  if(pending.kind==='agent'){
   const opened=(record.output as {view:PluginViewRecord}).view,args=pending.intent.arguments as any;
   if(!opened||!sameOperationValue(opened.instance,args.view.instance)||opened.contribution!=='agent'||opened.window!==client.view.window||opened.project!==client.view.project||opened.principal!==client.view.principal||!sameOperationValue(opened.configuration,args.view.configuration))throw Error('The Agent view receipt differs from the original selected notes.');
   state.agentOpened=opened;
  }else if(pending.kind!=='back'){
   const receipt=record.output as Receipt;if(receipt?.request_id!==pending.intent.request)throw Error('The original annotation receipt differs from its saved request.');
   if(pending.kind==='freeze'){
    if(receipt.outcome.kind!=='evidence'||!receipt.outcome.evidence_id||!pending.source)throw Error('The original freeze has no matching evidence.');
    state.evidence=receipt.outcome.evidence_id;state.frozenText=pending.selectedText??pending.source.text;state.frozenTitle=pending.source.title;state.frozenVersion=pending.source.version;state.origin=pending.source;state.selected=null;sourceImages=[];
   }else if(pending.kind==='create'||pending.kind==='update'){
    if(receipt.outcome.kind!=='annotation'||!receipt.outcome.annotation)throw Error('The original note has no revision.');state.selected=receipt.outcome.annotation;state.deleted=false;
    const command=(pending.intent.arguments as any).arguments.command;state.baseline=structuredClone({note:command.note,labels:command.labels,marks:command.marks});
   }else if(pending.kind==='import'){
    if(receipt.outcome.kind!=='capture'||!receipt.outcome.capture||!pending.image||receipt.outcome.capture.sha256!==pending.image.digest||receipt.outcome.capture.mime_type!==pending.image.media_type||receipt.outcome.capture.byte_size!==pending.image.bytes)throw Error('The original capture differs from the selected image.');
    state.capture=receipt.outcome.capture;state.marks=[];markUndo=[];
   }else if(pending.kind==='delete'){const deleted=(pending.intent.arguments as any).arguments.command.expected;state.checked=state.checked.filter(ref=>ref.annotation_id!==deleted.annotation_id);resetEditor();state.source=null;sourceImages=[];clearImage();}
  }
 }else find('conflict').textContent=`${pending.kind} ${record.status}: ${record.error??'Inspect the original result.'} Your text and marks are retained. Refresh notes before editing again.`;
 find('conflict').hidden=record.status==='succeeded';state.pending=null;await persist();
 if(record.status==='succeeded'){
  notice(`${pending.kind==='agent'?'Agent view opened; choose an editable task there':`${pending.kind} saved`} · original Operation ${record.operation.operation_id.slice(0,10)}.`);
  if(pending.kind==='import'){await retainedImage();notice('Captured image retained. Capture marked view to attach it to source evidence.');}
  if(['create','update','delete'].includes(pending.kind))await list();
 }
}
async function waitForOriginal(first:OriginalOperationRecord){let record=first;for(let attempt=0;attempt<24&&!isTerminalOperation(record.status)&&!stopped;attempt++){await new Promise(resolve=>setTimeout(resolve,100));if(!state.pending)throw Error('The original request state was lost.');record=await inspectOriginalOperation(client,state.pending.intent);}if(!stopped)await settle(record);}
async function recover(){if(!state.pending)throw Error('No original request is waiting.');const record=await inspectOriginalOperation(client,state.pending.intent);state.pending.intent.operation=record.operation.operation_id;await persist();await waitForOriginal(record);}
async function capture(whole:boolean,element=sourceText){
 if(!state.source)throw Error('Read a source first.');const start=element.selectionStart,end=element.selectionEnd;if(!whole&&start===end)throw Error('Select a quote in the source text.');
 const selectedText=whole?state.source.text:state.source.text.slice(start,end);const anchor=whole?{kind:'whole_item'}:{kind:'text_quote',quote:selectedText,start,end,unit:'utf16'};
 state.capture=null;state.marks=[];markUndo=[];await write('freeze',{kind:'freeze',reference:state.source.reference,inclusion:state.source.inclusion,anchor},selectedText);
}
async function importImage(){
 if(state.capture){if(!state.source)throw Error('The captured source reference is unavailable.');await write('freeze',{kind:'freeze',reference:state.source.reference,inclusion:state.source.inclusion,anchor:{kind:'captured_view',capture:state.capture}},state.source.text);return;}
 if(!sourceImages.length)throw Error('This source has no supported PNG/JPEG image.');const resource=sourceImages[Number(find<HTMLSelectElement>('source-image').value)||0];
 const request=crypto.randomUUID(),args={binding:await binding(client.view.instance,'annotations.capture.import'),arguments:{request_id:request,reference:resource},preconditions:null};
 await dispatch({kind:'import',image:resource,intent:{view:client.view.view,request,capability:key('annotations.capture.import'),arguments:json(args),operation:null,preconditions:[]}});
 if(state.capture&&!state.pending)await importImage();
}
async function checkSource(){
 if(!state.origin)throw Error('The saved source descriptor is unavailable. Frozen evidence remains readable.');
 try{const current=await previewSource(client,state.origin.reference,state.origin.preview,state.origin.inclusion);liveStatus=current.version===state.frozenVersion?'Original version available. Current live version is not established.':'Historical version · source changed.';}
 catch{liveStatus='Original source unavailable or changed. Frozen evidence is retained.';}
 render();
}
async function continueNote(){
 if(!state.selected||!state.origin)throw Error('Choose an existing note with a retained source reference.');
 state.continuedFrom=structuredClone(state.selected);state.selected=null;state.evidence=null;state.capture=null;state.marks=[];state.source=null;state.baseline=null;sourceImages=[];clearImage();document.body.classList.remove('source-focused');
 await persist();await discover();const index=choices.findIndex(choice=>sameOperationValue(choice.provider,state.origin!.reference.provider)&&choice.contribution===state.origin!.reference.contribution);
 if(index>=0){find<HTMLSelectElement>('component-source').value=String(index);find<HTMLSelectElement>('component-source').dispatchEvent(new Event('change'));await search();}
 notice('Select the new version of this source, preview it, then capture it. The previous note is retained; its marks stay on its original image.');
}
async function prepareAgent(){
 if(!state.checked.length||state.checked.length>16)throw Error('Select between one and sixteen saved note revisions.');
 agentSources=[];find('agent-preview').replaceChildren();find('agent-issue').textContent='';state.agentOpened=null;
 const selected=structuredClone(state.checked),include=find<HTMLInputElement>('include-note-images').checked;let issue='',imageCount=0;
 for(const ref of selected){
  const item=await read<{kind:string;revision:Revision;evidence:Evidence}>(client.view.instance,'annotations.read',{kind:'read',annotation:ref});
  if(item.revision.deleted)throw Error('A selected revision is deleted. Remove it from the selection.');
  const inclusion={kind:include&&item.evidence.anchor.kind==='captured_view'?'note_evidence_and_image':'note_and_evidence'};
  const reference={provider:client.view.instance,contribution:'annotations',window:client.view.window,selector:ref};
  const preview=await read<{text:string;truncated:boolean;resources:ResourceReference[]}>(client.view.instance,'annotations.context.preview',{reference,inclusion,max_bytes:16384});
  imageCount+=preview.resources.length;
  if(preview.truncated)throw Error('A selected note exceeds the context limit. Choose a smaller revision.');
  for(const resource of preview.resources){
   if(resource.bytes>2*1024*1024||!['image/png','image/jpeg'].includes(resource.media_type))issue='Image not included: a selected capture exceeds the Agent image limit (2 MiB PNG/JPEG). Select text only to continue.';
   else try{await readResource(client,resource,{maxBytes:2*1024*1024});}catch{issue='Image not included: a selected capture is unavailable. Select text only to continue.';}
  }
  const section=document.createElement('section'),title=document.createElement('strong'),text=document.createElement('pre');title.textContent=`${item.evidence.source.title} · selected revision ${ref.revision}`;text.textContent=preview.text;section.append(title,text);find('agent-preview').append(section);
  agentSources.push(json({source:'plugin',label:`${item.evidence.source.title} · note ${ref.revision}`.slice(0,160),reference,inclusion:JSON.stringify(inclusion)}));
 }
 if(imageCount>2)issue='Images not included: selected notes contain more than two images. Choose text only or select fewer notes.';
 find('agent-issue').textContent=issue;find<HTMLButtonElement>('open-agent').disabled=!!issue;
 const page=await observe<PluginInstanceObservations>('plugins.instances',{after:null,limit:100});agents=page.instances.filter(item=>item.observed_in_this_host&&item.instance.state==='active'&&item.instance.project===client.view.project&&item.instance.principal===client.view.principal&&item.instance.identity.plugin==='org.rho.agent').map(item=>item.instance.identity);
 const select=find<HTMLSelectElement>('agent-instance');select.replaceChildren(new Option('Choose an active Agent…',''));agents.forEach(item=>select.add(new Option(item.instance,item.instance)));
 if(!agents.length)find('agent-issue').textContent=[issue,'No active Agent. Activate or restore one in Plugins, then refresh this preview.'].filter(Boolean).join(' ');
 find<HTMLDialogElement>('agent-dialog').showModal();
}
function groupFor(node:PluginWindowNode,view:string):string|null{return node.kind==='tabs'?node.views.includes(view)?node.id:null:node.kind==='split'?node.children.map(child=>groupFor(child,view)).find(Boolean)??null:null;}
async function openAgent(){
 if(find('agent-issue').textContent)throw Error(find('agent-issue').textContent!);if(!agentSources.length)throw Error('Preview selected notes first.');
 const instance=agents.find(item=>item.instance===find<HTMLSelectElement>('agent-instance').value);if(!instance)throw Error('Choose an active Agent.');
 const inspection=await observe<PluginInspection>('plugins.inspect',{revision:instance.revision});if(!(inspection.manifest.views.find(view=>view.id==='agent')?.configuration_schema as any)?.properties?.component_request)throw Error('This Agent revision does not support component input.');
 const layout=await observe<PluginWindowLayout>('windows.layout',{window:client.view.window});const group=groupFor(layout.layout,client.view.view);if(!group)throw Error('The annotation view is no longer in this window.');
 const request=crypto.randomUUID(),args={view:{instance,contribution:'agent',window:client.view.window,configuration:{component_request:{request_id:crypto.randomUUID(),title:`Review ${agentSources.length} annotation${agentSources.length===1?'':'s'}`,sources:structuredClone(agentSources)}},state:{}},expected_layout_version:layout.version,group};
 find<HTMLDialogElement>('agent-dialog').close();await dispatch({kind:'agent',intent:{view:client.view.view,request,capability:key('windows.open_view'),arguments:json(args),operation:null,preconditions:[]}});
}
async function backSource(){
 const request=configuration.source_request;if(!request)throw Error('No source view was retained.');await flush();
 const layout=await observe<PluginWindowLayout>('windows.layout',{window:client.view.window});let found=false;
 const select=(node:PluginWindowNode):PluginWindowNode=>node.kind==='tabs'&&node.views.includes(request.return_view)?(found=true,{...node,selected:request.return_view}):node.kind==='split'?{...node,children:node.children.map(select)}:node;
 const changed=select(layout.layout);if(!found)throw Error('The original source view is no longer open. The note draft remains retained.');
 await dispatch({kind:'back',intent:{view:client.view.view,request:crypto.randomUUID(),capability:key('windows.update_layout'),arguments:json({window:client.view.window,expected_version:layout.version,layout:changed}),operation:null,preconditions:[]}});
}
provider.onchange=()=>{state.provider=catalog.find(item=>item.instance===provider.value)??null;schedule();};
path.oninput=()=>{state.path=path.value;schedule();};note.oninput=()=>{state.draft=note.value;schedule();};
find<HTMLSelectElement>('note-label').onchange=()=>{const label=find<HTMLSelectElement>('note-label').value;state.labels=label?[label]:[];schedule();};
find('open-file').onclick=()=>void work(openFile);find('capture-selection').onclick=()=>void work(()=>capture(false));find('capture-whole').onclick=()=>void work(()=>capture(true));
find('capture-component-selection').onclick=()=>void work(()=>capture(false,componentText));find('capture-component-whole').onclick=()=>void work(()=>capture(true,componentText));
find('save').onclick=()=>void work(async()=>{
 if(!state.draft.trim())throw Error('Write a note before saving.');if(state.deleted)throw Error('Deleted notes cannot be edited.');
 if(state.origin)await checkSource();
 if(state.selected)await write('update',{kind:'update',expected:state.selected,note:state.draft,labels:state.labels,marks:state.marks});
 else if(state.evidence)await write('create',{kind:'create',evidence_id:state.evidence,note:state.draft,labels:state.labels,marks:state.marks,continued_from:state.continuedFrom});
});
find('delete').onclick=()=>{if(state.selected)find<HTMLDialogElement>('delete-dialog').showModal();};
find('cancel-delete').onclick=()=>find<HTMLDialogElement>('delete-dialog').close();
find('confirm-delete').onclick=()=>{find<HTMLDialogElement>('delete-dialog').close();void work(async()=>{if(state.selected)await write('delete',{kind:'delete',expected:state.selected});});};
find('recover').onclick=()=>void work(recover);find('refresh').onclick=()=>void work(async()=>{await list();notice('Saved notes refreshed.');});find('more').onclick=()=>void work(()=>list(true));
find('new').onclick=()=>void work(async()=>{if(!await protectDraft())return;resetEditor();await persist();clearImage();});
find('discover-sources').onclick=()=>void work(discover);
find<HTMLSelectElement>('component-source').onchange=()=>{const value=find<HTMLSelectElement>('component-source').value;activeChoice=value?choices[Number(value)]??null:null;items=[];sourceAfter=null;const modes=find<HTMLSelectElement>('component-inclusion');modes.replaceChildren();activeChoice?.modes.forEach((mode,index)=>modes.add(new Option(mode.title,String(index))));sourceControls();};
find('search-sources').onclick=()=>void work(()=>search());find('search-more').onclick=()=>void work(()=>search(true));find('preview-source').onclick=()=>void work(componentPreview);
for(const id of ['note-filter','note-order'])find<HTMLSelectElement>(id).onchange=()=>{state.filter=find<HTMLSelectElement>('note-filter').value;state.order=find<HTMLSelectElement>('note-order').value;schedule();render();};
find<HTMLInputElement>('select-visible').onchange=()=>{const checked=find<HTMLInputElement>('select-visible').checked;for(const row of filteredRows().filter(item=>!item.revision.deleted)){state.checked=state.checked.filter(ref=>ref.annotation_id!==row.revision.annotation.annotation_id);if(checked)state.checked.push(structuredClone(row.revision.annotation));}schedule();render();};
find('add-agent').onclick=()=>void work(prepareAgent);find('close-agent').onclick=()=>find<HTMLDialogElement>('agent-dialog').close();find('preview-agent').onclick=()=>{find<HTMLDialogElement>('agent-dialog').close();void work(prepareAgent);};find('open-agent').onclick=()=>void work(openAgent);
find<HTMLInputElement>('include-note-images').onchange=()=>{find('agent-issue').textContent='Refresh the preview after changing image inclusion.';find<HTMLButtonElement>('open-agent').disabled=true;};
find('back-source').onclick=()=>void work(backSource);find('check-source').onclick=()=>void work(checkSource);find('continue-note').onclick=()=>void work(continueNote);
find('previous-revision').onclick=()=>void work(async()=>{if(state.selected)await openNote({...state.selected,revision:state.selected.revision-1});});
find('capture-view').onclick=()=>void work(importImage);
find<HTMLSelectElement>('source-image').onchange=()=>void work(previewImage);
find('open-capture').onclick=()=>{if(!imageUrl)return;find<HTMLImageElement>('large-capture').src=imageUrl;const large=find<HTMLCanvasElement>('large-marks');large.width=image.naturalWidth;large.height=image.naturalHeight;draw(large,state.marks);find<HTMLDialogElement>('capture-dialog').showModal();};find('close-capture').onclick=()=>find<HTMLDialogElement>('capture-dialog').close();
find('undo-mark').onclick=()=>{const previous=markUndo.pop();if(previous){state.marks=previous;selectedMark=null;schedule();render();}};
for(const button of find('mark-tools').querySelectorAll<HTMLButtonElement>('[data-tool]'))button.onclick=()=>{stroke=null;tool=button.dataset.tool as Tool;render();};
canvas.onpointerdown=event=>{
 if(busy||state.pending||state.deleted||!state.capture||tool==='select')return;
 if(state.marks.length>=256){notice('This note has reached the 256-mark limit.',true);return;}
 if(!state.evidence){notice('Capture marked view before drawing.',true);return;}
 const p=point(event,canvas.getBoundingClientRect());stroke=[p];pointer=event.pointerId;canvas.setPointerCapture(event.pointerId);renderMarks();
};
canvas.onpointermove=event=>{if(!stroke||pointer!==event.pointerId)return;const p=point(event,canvas.getBoundingClientRect());if(tool==='pen'){if(stroke.length<512)stroke.push(p);}else stroke=[stroke[0],p];renderMarks();};
canvas.onpointerup=event=>{if(!stroke||pointer!==event.pointerId)return;const mark=shape(tool,stroke,find<HTMLInputElement>('mark-text').value);stroke=null;pointer=null;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);if(mark){markUndo.push(structuredClone(state.marks));state.marks.push(mark);selectedMark=state.marks.length-1;schedule();}else if(tool==='text')notice('Type a text label before placing a text mark.',true);render();};
canvas.onpointercancel=()=>{stroke=null;pointer=null;renderMarks();};
window.addEventListener('keydown',event=>{
 if(event.isComposing||event.keyCode===229)return;
 if(event.key==='Escape'){
  if(stroke){event.preventDefault();stroke=null;renderMarks();}
  else if(tool!=='select'){event.preventDefault();tool='select';render();}
  else if(configuration.source_request&&!document.querySelector('dialog[open]')){event.preventDefault();void work(backSource);}
 }
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&event.target===canvas&&tool!=='select'){
  event.preventDefault();find<HTMLButtonElement>('undo-mark').click();
 }
 if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&event.target===note){event.preventDefault();find<HTMLButtonElement>('save').click();}
});
canvas.tabIndex=0;
const close=await client.installCloseHandler({async flush(){await flush();},resume(){render();}});close.subscribe(()=>{const failure=close.getSnapshot().error;if(failure)notice(failure,true);});
window.addEventListener('pagehide',()=>{stopped=true;if(saveTimer)clearTimeout(saveTimer);clearImage();client.dispose();},{once:true});
render();
await work(async()=>{
 let catalogError:string|null=null;try{await sources();}catch(error){catalogError=errorText(error);}await list();
 const request=configuration.source_request;
 if(request&&state.sourceRequest!==request.request_id&&!state.pending){
  if(request.source.reference.window!==client.view.window||typeof request.return_view!=='string')throw Error('The annotation entry belongs to another window.');
  await selectSource(await previewSource(client,request.source.reference,request.source.preview,request.source.inclusion));state.sourceRequest=request.request_id;await persist();find('component-capture').querySelector('h2')!.textContent='Original source';
 }else if(state.capture)await retainedImage();
 else if(state.source)await previewImage();
 if(state.pending)notice('An original request is unconfirmed. Inspect it before another write.');else if(catalogError)notice(`Files selection is unavailable: ${catalogError}`,true);
});
