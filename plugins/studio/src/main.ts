import { connectPluginView } from '../public/plugin-ui/index.js';
import type { PluginCatalogPage, PluginInspection, PluginInstanceObservations, WindowScenarioSnapshot, VisualNode } from '../public/plugin-protocol/index.js';
import { Studio, read, sourceTree, sourceText } from './model.js';
import { bytes, diagnostic, isVisual, kinds, node, own, put } from './visual.js';
import { renderCanvas } from './canvas.js';
import { developmentPanel } from './development-panel.js';
import { scenarioPanel } from './scenario-panel.js';
import { agentPanel } from './agent-panel.js';
import { archivePanel } from './archive-panel.js';
const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className='')=>{const item=document.createElement(tag);item.textContent=text;item.className=className;return item;};
const short=(id:string)=>id.startsWith('sha256:')?id.slice(7,15):id;
const client=await connectPluginView(),studio=new Studio(client);
document.body.dataset.pane='workspace';
let ready=false,busy=false,preparing=false,composing=false,stopped=false,timer:ReturnType<typeof setTimeout>|undefined,error='',notice='',sync='Opening saved draft…';
let navigationMode:'files'|'nodes'='nodes';
let catalog:PluginCatalogPage={items:[],next:null,total:0},history:string[]=[],historyNext:string|null=null,historySelected:string|null=null,sourceKey='',inspectorKey='',fixtureKey='';
let task:Promise<unknown>|null=null;
const renderScenario=scenarioPanel(studio,action,schedule,()=>!ready||busy||preparing||!!studio.assistance.data.pending||!!studio.pending||!!studio.development.data.pending||!!studio.development.data.testing?.pending||!!studio.archives.data.pending||studio.drafts.unresolved);
const renderDevelopment=developmentPanel(studio,action,schedule,()=>!ready||busy||preparing||!!studio.assistance.data.pending||!!studio.pending||!!studio.application.data.pending||!!studio.archives.data.pending||studio.drafts.unresolved);
const renderArchives=archivePanel(studio,action,schedule,()=>!ready||busy||preparing,()=>!ready||busy||preparing||!!studio.assistance.data.pending||!!studio.pending||!!studio.development.data.pending||!!studio.development.data.testing?.pending||!!studio.application.data.pending||studio.drafts.unresolved);
const renderAgent=agentPanel(studio,action,schedule,()=>!ready||busy||preparing||composing);
const frozen=()=>!ready||busy||preparing||!!studio.assistance.data.pending||!!studio.pending||!!studio.development.data.pending||!!studio.development.data.testing?.pending||!!studio.application.data.pending||!!studio.archives.data.pending||studio.drafts.unresolved;
// A document save captures an older body while typing may continue. Source
// mutations freeze editing; an in-flight draft transfer must not drop keystrokes.
const editable=()=>ready&&!busy&&!preparing&&!studio.assistance.data.pending&&!studio.pending&&!studio.development.data.pending&&!studio.development.data.testing?.pending&&!studio.application.data.pending&&!studio.archives.data.pending&&!!studio.branch;
function show(id:string,text:string){get(id).textContent=text;get(id).hidden=!text;}
function dialogErrors(){document.querySelectorAll<HTMLElement>('.dialog-error').forEach(item=>{item.textContent=error;item.hidden=!error;});}
function report(e:unknown){error=diagnostic(e);show('error',error);dialogErrors();}
function schedule(){sync='Draft has unsynchronized changes';get('sync').textContent=sync;clearTimeout(timer);if(ready&&!preparing&&!stopped&&!composing)timer=setTimeout(()=>void flush().catch(report).finally(render),400);}
async function flush(){clearTimeout(timer);if(!ready)throw Error('Inspect the saved draft before replacing its contents.');if(studio.document&&sourceKey===`${studio.document.data.revision}:${studio.document.data.selected}`&&document.activeElement===get('source'))studio.document.edit(studio.document.data.selected,get<HTMLTextAreaElement>('source').value);const before=JSON.stringify([studio.document?.snapshot,studio.branch,studio.pending,studio.development.data,studio.application.data,studio.archives.data,studio.assistance.data]);await studio.flush();const unchanged=before===JSON.stringify([studio.document?.snapshot,studio.branch,studio.pending,studio.development.data,studio.application.data,studio.archives.data,studio.assistance.data]);sync=unchanged?'Draft synchronized':'Draft has unsynchronized changes';get('sync').textContent=sync;if(!unchanged&&!preparing)schedule();}
function action(work:()=>Promise<unknown>){if(busy||preparing||composing||stopped)return;busy=true;error='';render();task=Promise.resolve().then(work).catch(report).finally(()=>{busy=false;task=null;render();});}
function change(work:()=>void){if(!editable()||composing)return;try{work();error='';schedule();render();}catch(e){report(e);}}
function button(label:string,work:()=>Promise<unknown>,disabled=false){const b=el('button',label,'item');b.disabled=disabled;b.onclick=()=>action(work);return b;}
function savePosition(){const doc=studio.document,source=get<HTMLTextAreaElement>('source');if(doc&&sourceKey===`${doc.data.revision}:${doc.data.selected}`)put(doc.data.positions,doc.data.selected,{start:source.selectionStart,end:source.selectionEnd,top:source.scrollTop,left:source.scrollLeft});}
function chooseNode(id:string){const doc=studio.document;if(!doc)return;doc.data.selectedNode=id;doc.data.inspector=null;inspectorKey='';schedule();render();}
function render(){
  if(stopped||composing)return;
  renderDevelopment();renderScenario();renderArchives();renderAgent();
  const doc=studio.document,buffer=doc?.current,invalid=doc?.error()??'',valid=!!doc?.canvas&&!invalid;
  show('error',error);dialogErrors();show('notice',notice);get('notice-banner').hidden=!notice;get('sync').textContent=sync;
  get('subtitle').textContent=studio.plugin?`${studio.plugin} / ${studio.branch?.name??'Read-only revision'}`:'Choose a revision to develop.';
  document.querySelectorAll<HTMLElement>('#revision-list [data-revision]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.revision===doc?.data.revision)));
  get('editing').textContent=`Editing / ${doc?short(doc.data.revision):'none'}${doc?.dirty?' · changed':''}`;
  for(const id of ['choose','history','refresh-context','sync-now'])get<HTMLButtonElement>(id).disabled=!ready||busy||preparing;
  get<HTMLButtonElement>('history').disabled||=!doc;
  for(const id of ['check','checkpoint'])get<HTMLButtonElement>(id).disabled=!editable()||studio.drafts.unresolved||!doc?.dirty;
  get<HTMLButtonElement>('undo').disabled=!editable()||!doc?.data.past.length;
  get<HTMLButtonElement>('redo').disabled=!editable()||!doc?.data.future.length;
  get('recovery').hidden=!studio.pending;get('draft-recovery').hidden=!studio.drafts.unresolved;
  if(studio.pending)get('pending').textContent=`${studio.pending.intent.capability.id}\n${studio.pending.intent.operation??studio.pending.intent.request}`;
  for(const id of ['recover','retry','recover-draft','retry-draft','ack-draft'])get<HTMLButtonElement>(id).disabled=busy||preparing;
  get<HTMLButtonElement>('retry').disabled||=studio.pending?.intent.view!==client.view.view||studio.drafts.unresolved;
  get('empty').hidden=!!buffer;get('path').textContent=doc?.data.selected??'';
  get<HTMLButtonElement>('copy-source').disabled=busy||preparing||!buffer;
  show('invalid',invalid?`${invalid} Source retained; the canvas shows its last valid structure.`:'');
  get('files-section').hidden=navigationMode!=='files';get('nodes-section').hidden=navigationMode!=='nodes';for(const name of ['files','nodes'])get(`tree-${name}`).setAttribute('aria-current',String(name===navigationMode));
  const mode=doc?.data.mode??'canvas',canvas=get('canvas'),source=get<HTMLTextAreaElement>('source');
  canvas.hidden=mode!=='canvas'||!buffer;source.hidden=mode==='canvas'||!buffer;source.readOnly=!editable();
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b=>{b.setAttribute('aria-current',String(b.dataset.mode===mode));b.disabled=busy||preparing||!doc;});
  if(doc&&buffer){
    const next=`${doc.data.revision}:${doc.data.selected}`;
    if(source.value!==buffer.text||sourceKey!==next){const position=own(doc.data.positions,doc.data.selected);source.value=buffer.text;if(position){source.setSelectionRange(position.start,position.end);source.scrollTop=position.top;source.scrollLeft=position.left;}sourceKey=next;}
    if(mode==='canvas'){if(doc.canvas)renderCanvas(canvas,doc.canvas,doc.data.fixtures,doc.data.selectedNode,chooseNode);else canvas.replaceChildren(el('p','This source has no valid visual declaration. Use Source files to edit it.'));}
  }
  const files=get('files'),fileKey=JSON.stringify([doc?.paths,doc?.data.selected,busy,preparing]);
  if(files.dataset.key!==fileKey){files.dataset.key=fileKey;files.replaceChildren();for(const path of doc?.paths??[]){const b=button(path,async()=>{savePosition();await studio.loadFile(path);if(!isVisual(path))studio.document!.data.mode='source';inspectorKey='';document.body.dataset.pane='workspace';schedule();},busy||preparing);b.setAttribute('aria-current',String(path===doc?.data.selected));files.append(b);}}
  const nodes=get('nodes'),focusedNode=nodes.contains(document.activeElement)?(document.activeElement as HTMLElement)?.dataset.nodeName:null;nodes.replaceChildren();
  if(doc?.canvas){const visual=doc.canvas;const add=(id:string,depth:number)=>{const n=visual.nodes[id]!,b=el('button',`${id} · ${n.kind}`,'item');b.dataset.nodeName=id;b.style.paddingLeft=`${10+Math.min(depth,8)*12}px`;b.setAttribute('aria-current',String(id===doc.data.selectedNode));b.onclick=()=>chooseNode(id);b.draggable=editable()&&valid&&id!==visual.root;
    b.ondragstart=event=>{event.dataTransfer?.setData('text/plain',id);};b.ondragover=event=>{if(editable()&&valid)event.preventDefault();};b.ondrop=event=>{event.preventDefault();const moving=event.dataTransfer?.getData('text/plain');if(moving)change(()=>doc.move(moving,id,n.children.length));};nodes.append(b);n.children.forEach(child=>add(child,depth+1));};add(visual.root,0);if(focusedNode)Array.from(nodes.querySelectorAll<HTMLElement>('[data-node-name]')).find(b=>b.dataset.nodeName===focusedNode)?.focus({preventScroll:true});}
  const selected=doc?.canvas&&own(doc.canvas.nodes,doc.data.selectedNode),key=JSON.stringify([doc?.data.selected,doc?.data.selectedNode,selected]);
  get('node-id').textContent=selected?`${doc!.data.selectedNode} / ${selected.kind}`:'Select a node on the canvas or tree.';
  if(inspectorKey!==key){inspectorKey=key;get<HTMLInputElement>('node-text').value=selected?String(selected.properties.text??selected.properties.label??''):'';
    const retained=doc?.data.inspector;get<HTMLTextAreaElement>('node-properties').value=retained&&retained.path===doc?.data.selected&&retained.node===doc?.data.selectedNode?retained.text:selected?JSON.stringify(selected,null,2):'';}
  for(const id of ['node-text','node-properties','update-node','node-up','node-down','delete-node'])get<HTMLInputElement>(id).disabled=!editable()||!valid||!selected;
  get<HTMLButtonElement>('add-node').disabled=!editable()||!valid||!selected;
  get<HTMLButtonElement>('new-file').disabled=!editable();get<HTMLButtonElement>('remove-file').disabled=!editable()||!buffer||doc?.data.selected==='plugin.json';
  const fixtures=JSON.stringify(doc?.data.fixtures??{},null,2);if(fixtureKey!==fixtures){fixtureKey=fixtures;get<HTMLTextAreaElement>('fixtures').value=fixtures;}
  get<HTMLButtonElement>('update-fixtures').disabled=busy||preparing||!doc;
  get<HTMLButtonElement>('create-branch').disabled=frozen()||!doc;
  get<HTMLButtonElement>('restore-history').disabled=!editable()||!!doc?.dirty||!historySelected;
  get<HTMLButtonElement>('branch-history').disabled=frozen()||!!doc?.dirty||!historySelected;
}
async function context(){
  const current=await read<WindowScenarioSnapshot>(client,'windows.scenario',{window:client.view.window});
  const selected=current.scenario?Object.entries(current.scenario.instances).filter(([,instance])=>instance.plugin===studio.plugin):[];
  get('scenario').textContent=current.scenario?`Scenario / ${selected.length?selected.map(([alias,instance])=>`${alias}: ${short(instance.revision)}`).join(', '):'plugin not selected'}`:'Scenario / none selected';
  const instances=await read<PluginInstanceObservations>(client,'plugins.instances',{after:null,limit:100});
  const matching=instances.instances.filter(i=>i.instance.identity.plugin===studio.plugin&&(i.instance.purpose??'runtime')==='runtime');
  get('running').textContent=studio.plugin?`Running / ${matching.length?matching.map(i=>`${short(i.instance.identity.revision)} · ${i.instance.state}${i.observed_in_this_host?'':' · retained record'}`).join(', '):'none in observed page'}${instances.next?' · partial page':''}`:'Running / choose a plugin';
}
async function listRevisions(more=false){
  const page:PluginCatalogPage=await read(client,'plugins.list',{after:more?catalog.next:null,limit:100});catalog=more?{...page,items:[...catalog.items,...page.items]}:page;
  const list=get('revision-list');list.replaceChildren();
  for(const item of catalog.items){const b=button(`${item.name} · ${item.version} / ${short(item.revision)}`,async()=>{await studio.select(item.revision);await listBranches();await context();notice='Source captured. Select a branch or create one to edit.';});b.dataset.revision=item.revision;b.setAttribute('aria-current',String(item.revision===studio.document?.data.revision));list.append(b);}
  get('more-revisions').hidden=catalog.next===null;await listBranches();
}
async function listBranches(){const list=get('branch-list');list.replaceChildren();if(!studio.plugin)return;list.append(el('h3','Development branches'));for(const branch of await studio.branches(studio.plugin))list.append(button(`${branch.name} · ${short(branch.head)}`,async()=>{await studio.select(branch.head,branch);get<HTMLDialogElement>('chooser').close();notice='Development branch selected.';}));}
async function inspectHistory(revision:string){
  historySelected=revision;const inspection:PluginInspection=await read(client,'plugins.inspect',{revision});
  get('comparison-title').textContent=inspection.parent?`${short(inspection.parent)} → ${short(revision)}`:`${short(revision)} · original source`;
  const after=await sourceTree(client,revision),before=inspection.parent?await sourceTree(client,inspection.parent):{},host=get('changes');host.replaceChildren();
  for(const path of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()){
    if(JSON.stringify(own(before,path))===JSON.stringify(own(after,path)))continue;
    const detail=el('details'),summary=el('summary',`${path} · ${!own(before,path)?'added':!own(after,path)?'removed':'changed'}`),content=el('div','', 'compare-columns');detail.append(summary,content);host.append(detail);
    let loaded=false;detail.ontoggle=()=>{if(!detail.open||loaded)return;loaded=true;void Promise.all([inspection.parent&&own(before,path)?sourceText(client,inspection.parent,path,before[path]!):Promise.resolve('File absent'),own(after,path)?sourceText(client,revision,path,after[path]!):Promise.resolve('File absent')]).then(([left,right])=>{content.append(el('pre',`Parent\n${left}`),el('pre',`Selected\n${right}`));}).catch(e=>content.append(el('p',diagnostic(e))));};
  }
  if(!host.childElementCount)host.append(el('p','Source files match their parent.'));
  document.querySelectorAll<HTMLElement>('#revisions [data-revision]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.revision===revision)));render();
}
async function listHistory(more=false){
  if(!studio.document)return;
  if(!more){history=[];get('revisions').replaceChildren();historyNext=studio.document.data.revision;}
  for(let count=0;count<20&&historyNext;count++){
    const revision=historyNext;if(history.includes(revision))throw Error('History repeated a revision.');
    const inspection:PluginInspection=await read(client,'plugins.inspect',{revision});history.push(revision);historyNext=inspection.parent;
    const b=button(`${short(revision)} · ${inspection.artifacts.length?'Built artifact recorded':'Source only'}${studio.branch?.origin===revision?' · branch origin':''}`,async()=>{await inspectHistory(revision);get('history-dialog').dataset.detail='true';});b.dataset.revision=revision;get('revisions').append(b);
  }
  get('more-history').hidden=!historyNext;get('branch-origin').textContent=`${studio.branch?.name??'Source revision'} / Origin: ${studio.branch?.origin??'not recorded'}`;
  if(!more)await inspectHistory(studio.document.data.revision);
}
for(const kind of kinds)get<HTMLSelectElement>('node-kind').append(new Option(kind,kind));
for(const pane of ['navigation','workspace','inspector'])get(`show-${pane}`).onclick=()=>{document.body.dataset.pane=pane;if(pane==='navigation'){navigationMode='files';render();const selected=document.querySelector<HTMLElement>('#files [aria-current=true]');selected?.focus({preventScroll:true});selected?.scrollIntoView({block:'nearest'});}};
for(const name of ['files','nodes'] as const)get(`tree-${name}`).onclick=()=>{navigationMode=name;render();};
get('dismiss-notice').onclick=()=>{notice='';render();};
get('back-history').onclick=()=>{get('history-dialog').dataset.detail='false';document.querySelector<HTMLElement>('#revisions [aria-current=true]')?.focus({preventScroll:true});};
get('choose').onclick=()=>action(async()=>{get<HTMLDialogElement>('chooser').showModal();await listRevisions();});
get('more-revisions').onclick=()=>action(()=>listRevisions(true));get('close-chooser').onclick=()=>get<HTMLDialogElement>('chooser').close();
get('create-branch').onclick=()=>action(async()=>{await studio.createBranch(get<HTMLInputElement>('branch-name').value);await listBranches();get<HTMLDialogElement>('chooser').close();notice='Development branch created. Source changes are synchronized as a draft.';});
get('check').onclick=()=>action(async()=>{const checked=await studio.check();notice=`Source valid · proposed checkpoint ${short(checked.proposal.revision)}. No artifact has been built.`;});
get('checkpoint').onclick=()=>action(async()=>{await studio.checkpoint();notice=`Source checkpoint ${short(studio.document!.data.revision)} saved. Running instances are unchanged.`;});
get('recover').onclick=()=>action(async()=>{await studio.recover();notice='Original source request confirmed.';});get('retry').onclick=()=>action(()=>studio.dispatch());
get('recover-draft').onclick=()=>action(async()=>{await studio.drafts.inspect();if(!ready){await studio.open();ready=true;}else await flush();});
get('retry-draft').onclick=()=>action(async()=>{await studio.drafts.retryOriginal();if(!ready){await studio.open();ready=true;}else await flush();});
get('ack-draft').onclick=()=>action(()=>studio.drafts.acknowledgeFailure());
get('sync-now').onclick=()=>action(flush);get('refresh-context').onclick=()=>action(context);
get('copy-source').onclick=()=>action(async()=>{await client.copyText(studio.document!.current!.text);notice='Source copied.';});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b=>b.onclick=()=>{if(!studio.document||busy||preparing)return;savePosition();studio.document.data.mode=b.dataset.mode as 'canvas'|'declaration'|'source';navigationMode=b.dataset.mode==='source'?'files':'nodes';schedule();render();});
get('undo').onclick=()=>change(()=>{savePosition();studio.document!.undo();studio.document!.data.inspector=null;});get('redo').onclick=()=>change(()=>{savePosition();studio.document!.undo(true);studio.document!.data.inspector=null;});
const source=get<HTMLTextAreaElement>('source');
source.addEventListener('input',()=>{if(!editable()||composing)return;try{studio.document!.edit(studio.document!.data.selected,source.value);savePosition();schedule();render();}catch(e){report(e);}});
source.addEventListener('select',()=>{if(studio.document&&!composing){savePosition();schedule();}});source.addEventListener('scroll',savePosition);
document.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);});document.addEventListener('compositionend',event=>{composing=false;(event.target as HTMLElement).dispatchEvent(new Event('input',{bubbles:true}));schedule();render();});
document.addEventListener('keydown',event=>{if(event.isComposing||composing||!editable()||document.querySelector('dialog[open]'))return;if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();change(()=>{savePosition();studio.document!.undo(event.shiftKey);studio.document!.data.inspector=null;});}});
get('node-text').addEventListener('input',()=>{if(composing)return;change(()=>{const doc=studio.document!,selected=structuredClone(doc.canvas!.nodes[doc.data.selectedNode]!);put(selected.properties,selected.kind==='button'?'label':'text',get<HTMLInputElement>('node-text').value);doc.data.inspector=null;doc.updateNode(doc.data.selectedNode,selected);});});
get('node-properties').addEventListener('input',()=>{const doc=studio.document;if(!doc||!editable())return;const text=get<HTMLTextAreaElement>('node-properties').value;if(bytes(text).length>128*1024){report(Error('Node properties exceed the 128 KiB editing limit.'));return;}doc.data.inspector={path:doc.data.selected,node:doc.data.selectedNode,text};schedule();});
get('update-node').onclick=()=>change(()=>{const doc=studio.document!;doc.updateNode(doc.data.selectedNode,JSON.parse(get<HTMLTextAreaElement>('node-properties').value) as VisualNode);doc.data.inspector=null;inspectorKey='';});
get('add-node').onclick=()=>change(()=>{const doc=studio.document!,kind=get<HTMLSelectElement>('node-kind').value as typeof kinds[number];const component=kind==='custom'?Object.keys(doc.canvas!.components)[0]??null:null;if(kind==='custom'&&!component)throw Error('Declare a custom component and its source in the declaration before adding it.');doc.append(doc.data.selectedNode,kind,component);});
get('delete-node').onclick=()=>change(()=>studio.document!.deleteNode(studio.document!.data.selectedNode));
for(const [id,offset] of [['node-up',-1],['node-down',1]] as const)get(id).onclick=()=>change(()=>{const doc=studio.document!,selected=doc.data.selectedNode,parent=Object.entries(doc.canvas!.nodes).find(([,n])=>n.children.includes(selected));if(!parent)throw Error('The root cannot be reordered.');doc.move(selected,parent[0],Math.max(0,parent[1].children.indexOf(selected)+offset));});
get('update-fixtures').onclick=()=>{if(busy||preparing||!studio.document)return;try{const fixtures=JSON.parse(get<HTMLTextAreaElement>('fixtures').value);if(!fixtures||Array.isArray(fixtures)||typeof fixtures!=='object'||bytes(JSON.stringify(fixtures)).length>128*1024)throw Error('Fixture data must be an object no larger than 128 KiB.');studio.document.data.fixtures=fixtures;schedule();render();}catch(e){report(e);}};
get('new-file').onclick=()=>get<HTMLDialogElement>('file-dialog').showModal();get('cancel-file').onclick=()=>get<HTMLDialogElement>('file-dialog').close();
get('confirm-file').onclick=()=>{if(!editable())return;try{const path=get<HTMLInputElement>('file-path').value,root=node();studio.document!.add(path,isVisual(path)?JSON.stringify({format_version:1,root:'root',nodes:{root},data_sources:{},components:{}},null,2)+'\n':'');get<HTMLDialogElement>('file-dialog').close();schedule();render();}catch(e){report(e);}};
get('remove-file').onclick=()=>change(()=>studio.document!.remove(studio.document!.data.selected));
get('history').onclick=()=>action(async()=>{get('history-dialog').dataset.detail='false';get<HTMLDialogElement>('history-dialog').showModal();await listHistory();});get('close-history').onclick=()=>get<HTMLDialogElement>('history-dialog').close();get('more-history').onclick=()=>action(()=>listHistory(true));
get('restore-history').onclick=()=>action(async()=>{await studio.restore(historySelected!);await listHistory();notice='History restored as a new source checkpoint.';});
get('branch-history').onclick=()=>action(async()=>{await studio.select(historySelected!);await studio.createBranch(`branch-${short(historySelected!)}`);get<HTMLDialogElement>('history-dialog').close();notice='New branch created from the selected immutable source.';});
try{
  const close=await client.installCloseHandler({flush:async()=>{if(composing)throw Error('Finish the active text composition before closing.');preparing=true;clearTimeout(timer);render();if(task)await task;savePosition();await flush();},resume:()=>{preparing=false;render();}});
  close.subscribe(()=>{if(close.getSnapshot().error)report(close.getSnapshot().error);});
  await studio.open();ready=true;navigationMode=studio.document?.data.mode==='source'?'files':'nodes';sync='Draft synchronized';await context();
}catch(e){report(e);sync='Saved draft or context needs inspection';}
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);studio.archives.dispose();studio.drafts.stop();client.dispose();});render();
