import type { VisualDataSource, CustomComponent } from '../public/plugin-protocol/index.js';
import type { StudioDocument, DefinitionDraft, DefinitionKind } from './document.js';
import { own } from './visual.js';
const titles={data_sources:'Data sources',components:'Custom components'};
const fields:Record<DefinitionKind,{key:string;label:string;type:'text'|'json'|'checkbox'}[]>={
  data_sources:[{key:'capability',label:'Query capability',type:'text'},{key:'version',label:'Capability version',type:'text'},{key:'arguments',label:'Query arguments (JSON)',type:'json'},{key:'subscribe',label:'Subscribe to observations',type:'checkbox'}],
  components:[{key:'source',label:'Component source file',type:'text'},{key:'export',label:'Export name',type:'text'},{key:'properties_schema',label:'Properties schema (JSON)',type:'json'},{key:'input_schema',label:'Input schema (JSON)',type:'json'},{key:'output_schema',label:'Output schema (JSON)',type:'json'}],
};
export function definitionDraft(kind:DefinitionKind,id:string|null,value?:VisualDataSource|CustomComponent):DefinitionDraft {
  const values:DefinitionDraft['fields']={};
  if(kind==='data_sources') {const source=value as VisualDataSource|undefined;Object.assign(values,{capability:source?.capability.id??'',version:String(source?.capability.version??1),arguments:JSON.stringify(source?.arguments??{},null,2),subscribe:source?.subscribe??false});}
  else {const component=value as CustomComponent|undefined;Object.assign(values,{source:component?.source??'',export:component?.export??''});for(const key of ['properties_schema','input_schema','output_schema'] as const)values[key]=JSON.stringify(component?.[key]??{},null,2);}
  return {original:id,baseline:value?JSON.stringify(value):null,id:id??'',fields:values};
}
const dirty=(kind:DefinitionKind,draft:DefinitionDraft)=>{const original=definitionDraft(kind,draft.original,draft.baseline?JSON.parse(draft.baseline):undefined);return draft.id!==original.id||JSON.stringify(draft.fields)!==JSON.stringify(original.fields);};
export function definitionPanel(host:HTMLElement,current:()=>StudioDocument|null,editable:()=>boolean,change:(work:()=>void)=>void,schedule:()=>void,report:(error:unknown)=>void) {
  const dom=host.ownerDocument,panels: (()=>void)[]=[];
  for(const kind of ['data_sources','components'] as const) {
    const detail=dom.createElement('details'),summary=dom.createElement('summary'),body=dom.createElement('div');summary.textContent=titles[kind];detail.append(summary,body);host.append(detail);
    const label=(text:string,control:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement)=>{const label=dom.createElement('label');label.textContent=text;control.id=`definition-${kind}-${body.querySelectorAll('label').length}`;label.htmlFor=control.id;body.append(label,control);};
    const selection=dom.createElement('select');selection.setAttribute('aria-label',`${titles[kind]} selection`);body.append(selection);
    const fresh=dom.createElement('button');fresh.textContent=kind==='data_sources'?'New data source':'New component';body.append(fresh);
    const identity=dom.createElement('input');label(kind==='data_sources'?'Data source ID':'Component ID',identity);
    const inputs:Record<string,HTMLInputElement|HTMLTextAreaElement>={};
    for(const field of fields[kind]){const input=field.type==='json'?dom.createElement('textarea'):dom.createElement('input');if(input instanceof HTMLInputElement)input.type=field.type==='checkbox'?'checkbox':'text';else input.spellcheck=false;label(field.label,input);inputs[field.key]=input;}
    const hint=dom.createElement('p');hint.className='small';hint.textContent=kind==='data_sources'?'Editing does not query the provider. Test observations with fixture data.':'Source stays unchanged. A renamed component must match its compiled registration.';body.append(hint);
    const status=dom.createElement('p');status.className='small';status.setAttribute('role','status');body.append(status);
    const save=dom.createElement('button'),reset=dom.createElement('button'),remove=dom.createElement('button');save.textContent=kind==='data_sources'?'Apply data source':'Apply component';reset.textContent=kind==='data_sources'?'Reset data source form':'Reset component form';remove.textContent=kind==='data_sources'?'Remove data source':'Remove component';body.append(save,reset,remove);
    let draft:DefinitionDraft|null=null,path='',key='';
    const retain=(value:DefinitionDraft|null)=>{current()!.retainDefinitionDraft(kind,value);schedule();};
    const pick=(id:string|null)=>{const doc=current()!;draft=definitionDraft(kind,id,id?own<VisualDataSource|CustomComponent>(doc.canvas![kind],id):undefined);retain(draft);render();};
    fresh.onclick=()=>change(()=>pick(null));selection.onchange=()=>change(()=>pick(selection.value||null));
    reset.onclick=()=>change(()=>{const doc=current()!,id=draft?.original;pick(id&&own<VisualDataSource|CustomComponent>(doc.canvas![kind],id)?id:null);});
    const capture=()=>{
      if(!editable()||!draft)return;
      const next=structuredClone(draft);next.id=identity.value;
      for(const [key,input] of Object.entries(inputs))next.fields[key]=input instanceof HTMLInputElement&&input.type==='checkbox'?input.checked:input.value;
      try{retain(next);draft=next;render();}catch(error){report(error);}
    };
    identity.oninput=capture;for(const input of Object.values(inputs))input.oninput=capture;
    save.onclick=()=>change(()=>{
      if(!draft)return;const f=draft.fields;
      const value=kind==='data_sources'?{capability:{id:String(f.capability),version:Number(f.version)},arguments:JSON.parse(String(f.arguments)),subscribe:f.subscribe===true}:{source:String(f.source),export:String(f.export),properties_schema:JSON.parse(String(f.properties_schema)),input_schema:JSON.parse(String(f.input_schema)),output_schema:JSON.parse(String(f.output_schema))};
      current()!.updateDefinition(kind,draft.original,draft.id,value,draft.baseline);pick(draft.id);
    });
    remove.onclick=()=>change(()=>{if(!draft?.original||draft.baseline===null)return;current()!.removeDefinition(kind,draft.original,draft.baseline);pick(null);});
    function render() {
      const doc=current(),visual=doc?.canvas;detail.hidden=!visual;
      if(!doc||!visual){path='';draft=null;return;}
      const saved=own(doc.data.definitionDrafts??{},doc.data.selected)?.[kind];
      const currentPath=`${doc.data.revision}:${doc.data.selected}`;
      if(path!==currentPath||saved!==undefined){path=currentPath;draft=saved?structuredClone(saved):null;}
      if(!draft){const id=Object.keys(visual[kind])[0]??null;draft=definitionDraft(kind,id,id?own<VisualDataSource|CustomComponent>(visual[kind],id):undefined);}
      // Applied forms follow source/Undo. An un-applied draft survives source changes
      // and its captured baseline prevents overwriting a newer definition.
      if(!dirty(kind,draft)&&draft.original!==null&&JSON.stringify(own<VisualDataSource|CustomComponent>(visual[kind],draft.original))!==draft.baseline){const id=own<VisualDataSource|CustomComponent>(visual[kind],draft.original)?draft.original:Object.keys(visual[kind])[0]??null;draft=definitionDraft(kind,id,id?own<VisualDataSource|CustomComponent>(visual[kind],id):undefined);if(saved)doc.retainDefinitionDraft(kind,draft);}
      const changed=dirty(kind,draft),enabled=editable()&&!doc.error(),ids=Object.keys(visual[kind]),next=JSON.stringify(ids);
      if(key!==next){key=next;selection.replaceChildren(new Option('New definition',''),...ids.map(id=>new Option(id,id)));}
      selection.value=draft.original??'';selection.disabled=!enabled||changed;fresh.disabled=!enabled||changed;
      if(identity.value!==draft.id)identity.value=draft.id;identity.disabled=!enabled;
      for(const [name,input] of Object.entries(inputs)){const value=draft.fields[name];if(input instanceof HTMLInputElement&&input.type==='checkbox')input.checked=value===true;else if(input.value!==String(value??''))input.value=String(value??'');input.disabled=!enabled;}
      save.disabled=!enabled||!changed;reset.disabled=!enabled;remove.disabled=!enabled||changed||draft.original===null;
      status.textContent=changed?'Unapplied form draft retained. Apply or reset before choosing another definition.':'';
      if(saved&&changed)detail.open=true;
    }
    panels.push(render);
  }
  return ()=>panels.forEach(render=>render());
}
