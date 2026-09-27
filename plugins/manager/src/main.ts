import {connectPluginView} from '../public/plugin-ui/index.js';
import type {PluginCatalogPage, PluginInspection, PluginInstanceObservation, PluginInstanceObservations, ScenarioPage,
  ScenarioRevision, PluginViewRecord, PluginWindowNode, WindowScenarioSnapshot, SaveScenario} from '../public/plugin-protocol/index.js';
import {Manager, initial, read, short, same, matches, viewsOf, viewMatches, checkpointInput, own, type Saved} from './model.js';
const client = await connectPluginView();
const restored = client.view.state as Partial<Saved>;
const manager = new Manager(client,{...initial(),...restored});
let catalog: PluginCatalogPage = {items:[],next:null,total:0}, instances: PluginInstanceObservations = {instances:[],next:null,total:0};
let scenes: ScenarioPage = {scenarios:[],next:null}, current: WindowScenarioSnapshot | null = null;
let inspection: PluginInspection | null = null, instance: PluginInstanceObservation | null = null, definition: ScenarioRevision | null = null;
let knownViews: PluginViewRecord[] = [], inspections = new Map<string,PluginInspection>();
let selections: Record<string,string> = Object.create(null), viewSelections: Record<string,string> = Object.create(null), busy = false, stopped = false, composing = false;
let error = '', notice = '', openVersion = 0, openGroup: string | null = null;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
const get = <T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag:K,text='',className='')=>{const e=document.createElement(tag);e.textContent=text;e.className=className;return e;};
const message = (e:unknown)=>e instanceof Error?e.message:String(e);
const layoutViews = (layout:PluginWindowNode):string[]=>layout.kind==='tabs'?layout.views:layout.kind==='split'?layout.children.flatMap(layoutViews):[];
const containingGroup = (layout:PluginWindowNode,view:string):string|null=>layout.kind==='tabs'?(layout.views.includes(view)?layout.id:null):layout.kind==='split'?layout.children.map(child=>containingGroup(child,view)).find(Boolean)??null:null;
function button(title:string,action:()=>Promise<unknown>|void,className='',readOnly=false) {const b=node('button',title,className);if(readOnly)b.dataset.readOnly='true';b.disabled=busy||!!manager.state.pending&&!readOnly;b.onclick=()=>act(action);return b;}
function block(title:string,...children:HTMLElement[]){const e=node('div','','block');e.append(node('h3',title),...children);return e;}
function heading(title:string,...children:HTMLElement[]){const e=node('div','','block');e.append(node('h2',title),...children);return e;}
const identity = (value:string)=>node('code',value,'identity');
function detail(title:string,value:unknown){const e=node('details');e.append(node('summary',title),node('pre',JSON.stringify(value,null,2)));return e;}
function act(work:()=>Promise<unknown>|void) {
  if (busy||stopped||composing) return;
  busy=true;error='';renderControls();
  void Promise.resolve().then(work).catch(e=>{error=message(e);}).finally(()=>{busy=false;renderControls();});
}
async function save(){clearTimeout(draftTimer);await manager.save();}
function saveDraftSoon(){clearTimeout(draftTimer);draftTimer=setTimeout(()=>{if(stopped||composing)return;void save().catch(e=>{error=message(e);renderControls();});},350);}
function renderControls(){
  get('error').textContent=error;get('error').hidden=!error;get('notice').textContent=busy?'Working…':notice;
  get('recovery').hidden=!manager.state.pending;
  const pending=manager.state.pending;
  get('pending').textContent=pending?`${pending.intent.capability.id} · ${pending.intent.operation??'Acknowledgement unavailable'} · ${pending.intent.request}`:'';
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=busy||!!pending);
  document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea').forEach(input=>input.disabled=busy||!!pending);
  get<HTMLButtonElement>('inspect-request').disabled=busy;
  get<HTMLButtonElement>('retry-request').disabled=busy||pending?.intent.view!==client.view.view;
  // Reading, navigation and preserving text remain possible with unresolved work.
  for(const id of ['refresh','back','keep-draft','cancel-open'])get<HTMLButtonElement>(id).disabled=busy;
  document.querySelectorAll<HTMLButtonElement>('[data-read-only]').forEach(b=>b.disabled=busy);
  document.querySelectorAll<HTMLButtonElement>('nav button').forEach(b=>b.disabled=busy);
  const switchButton=document.querySelector<HTMLButtonElement>('[data-switch]');if(switchButton)switchButton.disabled=busy||!!pending||!manager.state.preparation?.ready;
  const selfRelease=document.querySelector<HTMLButtonElement>('[data-self-release]');if(selfRelease)selfRelease.disabled=true;
  document.querySelectorAll<HTMLButtonElement>('[data-protected]').forEach(b=>b.disabled=true);
}
async function refresh(more=false){
  const section=manager.state.section;
  if(section==='installed'){
    const page=await read<PluginCatalogPage>(client,'plugins.list',{after:more?catalog.next:null,limit:100});
    catalog={...page,items:more?[...catalog.items,...page.items]:page.items};
  }else if(section==='instances'){
    const page=await read<PluginInstanceObservations>(client,'plugins.instances',{after:more?instances.next:null,limit:100,include_previews:true});
    instances={...page,instances:more?[...instances.instances,...page.instances]:page.instances};
  }else{
    const page=await read<ScenarioPage>(client,'scenarios.list',{after:more?scenes.next:null,limit:100});
    scenes={...page,scenarios:more?[...scenes.scenarios,...page.scenarios]:page.scenarios};
    current=await read(client,'windows.scenario',{window:client.view.window});
  }
  notice='';
  renderList();
  if(manager.state.selected)await loadDetail(manager.state.selected);
}
async function select(id:string){manager.state.scroll=get('list').scrollTop;manager.state.selected=id;manager.state.detail=true;await save();await loadDetail(id);renderList();get('detail').scrollTop=0;requestAnimationFrame(()=>get('back').focus());}
function renderList(){
  const section=manager.state.section;
  document.body.dataset.section=section;document.body.dataset.detail=String(manager.state.detail);
  get('subtitle').textContent=section==='installed'?'Installed revisions, their purpose, and the instances using them.':section==='instances'?'View lifetime and service lifetime are separate.':'Each window chooses a scenario. Running work keeps its original target.';
  document.querySelector('h1')!.textContent=section==='installed'?'Plugins':section==='instances'?'Instances':'Scenarios';
  document.querySelectorAll<HTMLElement>('nav button').forEach(b=>b.setAttribute('aria-current',String(b.dataset.section===section)));
  const list=get('list');list.replaceChildren();
  if(section==='scenarios'){
    const bar=node('div','','toolbar');bar.append(button(manager.state.draft?'Continue draft':'New scenario',()=>edit()));list.append(bar);
  }else{
    const labels=node('div','','row table-head');labels.setAttribute('aria-hidden','true');
    labels.append(...(section==='installed'?['PLUGIN','REVISION','REFERENCES']:['INSTANCE / REVISION','STATE','WORK']).map(label=>node('span',label)));list.append(labels);
  }
  const items=section==='installed'?catalog.items.map(p=>({id:p.revision,name:p.name,description:p.description,revision:`${p.version} · ${short(p.revision)}`,usage:`${p.reference_count} protecting references`})):
    section==='instances'?instances.instances.map(p=>({id:p.instance.identity.instance,name:p.instance.alias,description:`${p.instance.purpose==='fixture_preview'?'Fixture preview · ':''}${p.instance.identity.plugin} · ${short(p.instance.identity.revision)}`,revision:p.observed_in_this_host?p.instance.state.replaceAll('_',' '):'Recorded · unavailable in this Host',usage:p.retained_calls===null?'Work count unavailable':`${p.retained_calls} retained calls`})):
    scenes.scenarios.map(p=>({id:p.revision,name:p.name,description:current?.scenario?.revision===p.revision?'Current window':`Checkpoint ${short(p.revision)}`,revision:'',usage:''}));
  for(const item of items){const row=button('',()=>select(item.id),'row'+(section==='scenarios'?' scenario-row':''),true);row.setAttribute('aria-pressed',String(manager.state.selected===item.id));const title=node('span');title.append(node('span',item.name,'name'),node('span',item.description,'sub'));row.append(title);if(section!=='scenarios')row.append(node('span',item.revision),node('span',item.usage));list.append(row);}
  if(!items.length)list.append(node('p','No items on this page.','empty'));
  const next=section==='installed'?catalog.next:section==='instances'?instances.next:scenes.next;
  if(next)list.append(button('Load more',()=>refresh(true),'',true));
  list.scrollTop=manager.state.scroll;
  if(!manager.state.selected)get('contents').replaceChildren(node('p','Select an item to inspect.','empty'));
  renderControls();
}
async function loadDetail(id:string){
  get('contents').replaceChildren(node('p','Reading exact identity…','empty'));
  const section=manager.state.section;
  if(section==='installed'){
    inspection=await read(client,'plugins.inspect',{revision:id});renderInspection();
  }else if(section==='instances'){
    const found=instances.instances.find(x=>x.instance.identity.instance===id);if(!found)throw new Error('This instance is not on the loaded page.');
    instance=await read(client,'plugins.instance',{instance:found.instance.identity});renderInstance();
  }else{
    definition=await read<ScenarioRevision>(client,'scenarios.get',{revision:id});
    inspections=new Map();const diagnostics:string[]=[];
    for(const rev of new Set(Object.values(definition.instances).map(i=>i.revision))){try{inspections.set(rev,await read(client,'plugins.inspect',{revision:rev}));}catch(e){diagnostics.push(message(e));}}
    instances=await read(client,'plugins.instances',{after:null,limit:100});
    current=await read(client,'windows.scenario',{window:client.view.window});
    knownViews=[];
    const ids=new Set([...manager.state.retained_views,client.view.view,...layoutViews(current!.layout.layout),...Object.values(current?.scenario?.views??{}),...Object.values(manager.state.preparation?.request.views??{})]);
    for(const view of ids){try{knownViews.push(await read(client,'views.inspect',{view}));}catch{/* Expired views are not reusable candidates. */}}
    manager.state.retained_views=knownViews.filter(v=>!v.closed).map(v=>v.view).slice(-256);await save();
    if(manager.state.preparation?.definition.id!==id){selections=Object.create(null);viewSelections=Object.create(null);}
    renderScenario(diagnostics);
  }
  document.body.dataset.detail=String(manager.state.detail);renderControls();
}
function renderInspection(){
  const p=inspection!;const out=get('contents');out.replaceChildren(heading(p.manifest.name,node('p',p.manifest.description),identity(p.manifest.id)));
  out.append(block('Selected revision',node('p',`${p.manifest.version} · ${short(p.summary.revision)}`),identity(p.summary.revision),...p.artifacts.map(a=>block(`Artifact · ${a.target}`,identity(a.id)))),
    block('Contributions',...p.manifest.views.map(v=>node('p',v.title)),...p.manifest.capabilities.map(c=>node('p',`${c.capability.id}@${c.capability.version}`))),
    block('Protecting references',node('p',`${p.summary.reference_count} references. Instances and saved scenario history can keep this revision in use.`)),
    detail('Dependencies and requested capabilities',{dependencies:p.manifest.dependencies,requires:p.manifest.requires,optional_requires:p.manifest.optional_requires??[]}));
  const actions=node('div','','actions');actions.append(button('Create branch',async()=>{
    const created=await manager.invoke('plugins.branch',{name:`${p.manifest.name} experiment`,revision:p.summary.revision}) as {branch:string};await refresh();notice=`Created branch ${created.branch}.`;
  }));
  const remove=button('Remove revision',async()=>{await manager.invoke('plugins.remove',{revision:p.summary.revision});manager.state.selected='';manager.state.detail=false;await save();await refresh();},'danger');
  if(p.summary.reference_count>0){remove.dataset.protected='true';remove.title='Unbind retained references before removing this revision.';}actions.append(remove);out.append(actions);
  out.append(node('p','Package import and export currently use the plugin CLI. Every installed revision uses the same package validation and permissions.','small'));
}
function renderInstance(){
  const p=instance!,i=p.instance,out=get('contents');out.replaceChildren(heading(i.alias,node('p',`${i.identity.plugin} · ${short(i.identity.revision)}`)));
  out.append(block('Actual instance',identity(i.identity.instance),identity(i.identity.revision),identity(i.identity.artifact)),
    block('Purpose',node('p',i.purpose==='fixture_preview'?'Fixture preview · Backend disabled':'Runtime instance')),
    block('State',node('p',p.observed_in_this_host?i.state.replaceAll('_',' '):'Recorded instance; unavailable in this Host'),node('p',i.diagnostic??'')),
    block('Retained work',node('p',p.retained_calls===null?'No current Host observation.':`${p.retained_calls} calls; ${p.pending_messages??'unknown'} pending messages.`)),detail('Configuration',i.configuration));
  const actions=node('div','','actions');actions.append(button('Open view',()=>openInstance()));
  const release=button(i.state==='cleanup_failed'?'Retry cleanup':'Release instance',async()=>{await manager.invoke('plugins.release',{instance:i.identity});await refresh();},'danger');
  if(same(i.identity,client.view.instance))release.dataset.selfRelease='true';actions.append(release);out.append(actions);
  out.append(node('p','Release stops new calls and requests cleanup. Retained work or native resources can keep the instance draining. Closing a view does not release this instance.','small'));
  if(p.stderr)out.append(detail('Backend diagnostics',p.stderr));
}
function renderScenario(diagnostics:string[]=[]){
  const d=definition!,prep=manager.state.preparation?.definition.id===d.id?manager.state.preparation:null,out=get('contents');
  out.replaceChildren(heading(d.name,node('p',current?.scenario?.revision===d.id?'Selected in this window':'Saved checkpoint'),identity(d.id)));
  const bar=node('div','','actions');bar.append(button('Edit checkpoint',()=>edit(d)));
  if(d.parent)bar.append(button('Previous checkpoint',async()=>{manager.state.selected=d.parent!;await save();await loadDetail(d.parent!);},'',true));
  bar.append(button(prep?'Review a new switch':'Review switch',async()=>{current=await read(client,'windows.scenario',{window:client.view.window});await manager.begin(d,current!.layout.version);selections=Object.create(null);viewSelections=Object.create(null);renderScenario();}));out.append(bar);
  const grid=node('div','','switch-grid'),composition=node('div'),preview=node('aside','','preview');grid.append(composition,preview);out.append(grid);
  for(const [alias,wanted]of Object.entries(d.instances)){
    const line=node('section','','alias');line.append(node('strong',alias),node('span',inspections.get(wanted.revision)?.manifest.name??wanted.plugin,'small'),identity(wanted.revision));
    if(prep){
      const fixed=own(prep.request.instances,alias);
      if(fixed)line.append(node('p','Prepared instance'),identity(fixed.instance));
      else{const label=node('label',`Instance for ${alias}`),select=node('select');select.setAttribute('aria-label',`Instance for ${alias}`);select.append(new Option('Create a new instance',''));
        for(const candidate of instances.instances.filter(i=>matches(i,wanted)))select.append(new Option(`Reuse ${candidate.instance.alias} · ${candidate.instance.identity.instance}`,candidate.instance.identity.instance));
        select.value=selections[alias]??'';select.onchange=()=>{selections[alias]=select.value;for(const view of viewsOf(d.layout))if(view.instance===alias)delete viewSelections[view.id];renderScenario();};line.append(label,select);}
    }composition.append(line);
  }
  composition.append(block('Default providers',...d.providers.map(p=>node('p',`${p.capability.id}@${p.capability.version} → ${p.instance}${p.target?' · '+p.target:''}`))));
  for(const v of viewsOf(d.layout)){
    const line=block(`View · ${v.contribution}`,node('p',v.instance));
    if(prep){
      const fixed=own(prep.request.views,v.id);
      if(fixed)line.append(node('p','Prepared view'),identity(fixed));
      else{const selectedInstance=own(prep.request.instances,v.instance)??instances.instances.find(i=>i.instance.identity.instance===selections[v.instance])?.instance.identity;
        const select=node('select');select.setAttribute('aria-label',`View for ${v.id}`);select.append(new Option('Open checkpoint state in a new view',''));
        if(selectedInstance)for(const candidate of knownViews.filter(i=>viewMatches(i,v,selectedInstance,client.view.window)))select.append(new Option(`Keep live state · ${candidate.view}`,candidate.view));
        select.value=viewSelections[v.id]??'';select.onchange=()=>viewSelections[v.id]=select.value;line.append(select);}
    }composition.append(line);
  }
  composition.append(detail('Saved layout',d.layout));
  preview.append(block('Before switching',node('p',diagnostics.length?diagnostics.join('\n'):'Exact installed revisions observed. Prepare to validate permissions, dependencies and live instances.')),
    block('New interactions',node('p',`Use the providers and layout saved in ${d.name}.`)),
    block('Still retained',...instances.instances.filter(i=>i.observed_in_this_host&&i.instance.state!=='released').map(i=>node('p',`${i.instance.alias} · ${short(i.instance.identity.revision)} · ${i.instance.state}`))),
    block('Drafts and windows',node('p','Hidden views retain their live state. A new view opens the checkpoint’s saved state. Other windows keep their selection.')));
  if(prep){
    preview.append(node('p',`Prepared against window layout ${prep.request.expected_layout_version}. Later layout edits require reviewing a new switch.`,'small'));
    const actions=node('div','','actions');actions.append(button(prep.ready?'Validate again':'Prepare selection',async()=>{try{await manager.prepare(inspections,selections,viewSelections,instances.instances);notice='Preparation passed. Switching is now available.';}finally{renderScenario();}}));
    const apply=button(`Switch to ${d.name}`,async()=>{await manager.apply();await refresh();notice=`Selected ${d.name}. Existing work keeps its original instance.`;},'primary');apply.dataset.switch='true';actions.append(apply);bar.append(actions);
    if(prep.ready)preview.append(node('p','Ready to switch. Native preconditions are checked again when applied.','success'));
    preview.append(node('p','Prepared instances and views remain available if you leave or preparation fails. Release them explicitly from Instances.','small'));
    if(instances.next)preview.append(button('Load more existing instances',async()=>{const page=await read<PluginInstanceObservations>(client,'plugins.instances',{after:instances.next,limit:100});instances={...page,instances:[...instances.instances,...page.instances]};renderScenario();}));
  }
  renderControls();
}
async function edit(d?:ScenarioRevision){
  if(manager.state.draft===null){const payload:SaveScenario=d?{scenario:d.scenario,expected_head:scenes.scenarios.find(s=>s.scenario===d.scenario)?.revision??d.id,name:d.name,instances:d.instances,providers:d.providers,layout:d.layout}:
    {scenario:`scenario-${crypto.randomUUID()}`,expected_head:null,name:'Untitled scenario',instances:{},providers:[],layout:{kind:'empty'}};
    manager.state.draft=JSON.stringify(payload,null,2);await save();}
  get<HTMLTextAreaElement>('source').value=manager.state.draft;get('edit-error').textContent='';get<HTMLDialogElement>('edit-dialog').showModal();get('source').focus();
}
async function openInstance(){
  inspection=await read(client,'plugins.inspect',{revision:instance!.instance.identity.revision});
  if(!inspection!.manifest.views.length)throw new Error('This revision does not contribute a view.');
  const snapshot=await read<WindowScenarioSnapshot>(client,'windows.scenario',{window:client.view.window});openVersion=snapshot.layout.version;
  openGroup=containingGroup(snapshot.layout.layout,client.view.view);
  if(!openGroup)throw new Error('Show this manager in the current window layout before opening a view beside it.');
  const select=get<HTMLSelectElement>('contribution');select.replaceChildren(...inspection!.manifest.views.map(v=>new Option(v.title,v.id)));
  get('open-error').textContent='';get<HTMLDialogElement>('open-dialog').showModal();
}
get('refresh').onclick=()=>act(()=>refresh());
document.querySelectorAll<HTMLButtonElement>('nav button').forEach(b=>b.onclick=()=>act(async()=>{manager.state.section=b.dataset.section as Saved['section'];manager.state.selected='';manager.state.detail=false;manager.state.scroll=0;await save();await refresh();}));
get('back').onclick=()=>act(async()=>{manager.state.detail=false;await save();renderList();requestAnimationFrame(()=>get('list').querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus({preventScroll:true}));});
get('inspect-request').onclick=()=>act(async()=>{await manager.recover();notice='Original request inspected. Continue explicitly when ready.';await refresh();});
get('retry-request').onclick=()=>act(async()=>{await manager.dispatch();await refresh();});
get<HTMLTextAreaElement>('source').oninput=()=>{manager.state.draft=get<HTMLTextAreaElement>('source').value;saveDraftSoon();};
get('keep-draft').onclick=()=>act(async()=>{await save();get<HTMLDialogElement>('edit-dialog').close();renderList();});
get('save-checkpoint').onclick=()=>act(async()=>{try{
  const value=checkpointInput(JSON.parse(manager.state.draft!));await manager.invoke('scenarios.checkpoint',value,{kind:'checkpoint'});get<HTMLDialogElement>('edit-dialog').close();await refresh();
}catch(e){get('edit-error').textContent=message(e);throw e;}});
get('cancel-open').onclick=()=>get<HTMLDialogElement>('open-dialog').close();
get('confirm-open').onclick=()=>act(async()=>{try{
  await manager.invoke('windows.open_view',{view:{instance:instance!.instance.identity,contribution:get<HTMLSelectElement>('contribution').value,window:client.view.window,
    configuration:JSON.parse(get<HTMLTextAreaElement>('view-config').value),state:JSON.parse(get<HTMLTextAreaElement>('view-state').value)},expected_layout_version:openVersion,group:openGroup});get<HTMLDialogElement>('open-dialog').close();
}catch(e){get('open-error').textContent=message(e);throw e;}});
document.addEventListener('compositionstart',()=>composing=true);document.addEventListener('compositionend',()=>{composing=false;if(manager.state.draft!==null)saveDraftSoon();});
get<HTMLDialogElement>('edit-dialog').addEventListener('cancel',e=>{e.preventDefault();act(async()=>{await save();get<HTMLDialogElement>('edit-dialog').close();renderList();});});
client.installCloseHandler({flush:async()=>{if(busy||composing)throw new Error('Finish the current interaction before closing.');await save();},resume:()=>{}});
addEventListener('pagehide',()=>{stopped=true;clearTimeout(draftTimer);client.dispose();},{once:true});
act(()=>refresh());
