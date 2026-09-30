import type { CheckpointPlugin, PackageFile, VisualDocument, VisualNode, VisualNodeKind, VisualCondition, DataBinding, VisualDataSource, CustomComponent } from '../public/plugin-protocol/index.js';
import { bytes, diagnostic, isVisual, node, own, parseVisual, put, sourcePath } from './visual.js';
export const MAX_TEXT_BYTES=128*1024;
const MAX_HISTORY_BYTES=4*1024*1024;
export interface Buffer { text:string; lastValid:VisualDocument|null; removed:boolean; executable:boolean; }
interface Original { metadata:PackageFile; text:string|null; }
interface Change { path:string; before:Buffer|null; after:Buffer|null; }
export type DefinitionKind='data_sources'|'components';
export interface DefinitionDraft { original:string|null; baseline:string|null; id:string; fields:Record<string,string|boolean>; }
function validateDefinitionDraft(value:DefinitionDraft,kind:DefinitionKind) {
  if(!value||!(value.original===null||typeof value.original==='string')||!(value.baseline===null||typeof value.baseline==='string')||typeof value.id!=='string'||!value.fields||typeof value.fields!=='object'||Array.isArray(value.fields)||Object.values(value.fields).some(v=>typeof v!=='string'&&typeof v!=='boolean')||bytes(JSON.stringify(value)).length>MAX_TEXT_BYTES)throw Error('The definition draft exceeds 128 KiB or has invalid fields.');
  if((value.original===null)!==(value.baseline===null))throw Error('Invalid definition baseline.');
  if(value.original!==null)parseVisual(JSON.stringify({format_version:1,root:'root',nodes:{root:node()},data_sources:{},components:{},[kind]:{[value.original]:JSON.parse(value.baseline!)}}));
}
export interface Snapshot {
  revision:string; files:Record<string,Original>; buffers:Record<string,Buffer>;
  past:Change[][]; future:Change[][]; selected:string; selectedNode:string; mode:'canvas'|'declaration'|'source';
  fixtures:Record<string,unknown>;
  positions:Record<string,{start:number;end:number;top:number;left:number}>;
  inspector:{path:string;node:string;text:string}|null;
  definitionDrafts?:Record<string,Partial<Record<DefinitionKind,DefinitionDraft>>>;
}
const clone = <T>(value:T):T => structuredClone(value);
const equal = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
export const encode = (data:Uint8Array) => { let value=''; for(const byte of data)value+=String.fromCharCode(byte); return btoa(value); };
export class StudioDocument {
  readonly data:Snapshot;
  constructor(snapshot:Snapshot) {
    this.data=clone(snapshot);
    // Retained drafts are versioned local data, not instructions or a replacement source.
    if(!snapshot||bytes(JSON.stringify(snapshot)).length>7*1024*1024||!/^sha256:[a-f0-9]{64}$/.test(snapshot.revision)||!['canvas','declaration','source'].includes(snapshot.mode)||
      !Array.isArray(snapshot.past)||!Array.isArray(snapshot.future)||snapshot.past.length+snapshot.future.length>64)throw Error('The Studio draft has an invalid source or history.');
    for(const key of ['files','buffers','fixtures','positions'] as const)if(!snapshot[key]||typeof snapshot[key]!=='object'||Array.isArray(snapshot[key]))throw Error('The Studio draft has an invalid file map.');
    const buffer=(path:string,value:Buffer|null) => {
      sourcePath(path); if(value===null)return;
      if(typeof value.text!=='string'||bytes(value.text).length>MAX_TEXT_BYTES||typeof value.removed!=='boolean'||typeof value.executable!=='boolean')throw Error('The retained file exceeds the text limit or has invalid content.');
      if(value.lastValid!==null)parseVisual(JSON.stringify(value.lastValid));
    };
    for(const [path,value] of Object.entries(snapshot.buffers))buffer(path,value);
    for(const change of [...snapshot.past,...snapshot.future].flat()) { buffer(change.path,change.before); buffer(change.path,change.after); }
    for(const [path,file] of Object.entries(snapshot.files)) {
      sourcePath(path); if(!file?.metadata||!/^sha256:[a-f0-9]{64}$/.test(file.metadata.digest)||!Number.isSafeInteger(file.metadata.bytes)||file.metadata.bytes<0||typeof file.metadata.executable!=='boolean'||!(file.text===null||typeof file.text==='string'))throw Error('The retained source inventory is invalid.');
    }
    for(const position of Object.values(snapshot.positions))if(!position||![position.start,position.end,position.top,position.left].every(value=>Number.isFinite(value)&&value>=0))throw Error('The retained source position is invalid.');
    if(snapshot.definitionDrafts!==undefined) {
      if(!snapshot.definitionDrafts||typeof snapshot.definitionDrafts!=='object'||Array.isArray(snapshot.definitionDrafts))throw Error('Invalid definition drafts.');
      for(const [path,drafts] of Object.entries(snapshot.definitionDrafts)) {
        sourcePath(path);if(!isVisual(path)||!drafts||typeof drafts!=='object'||Array.isArray(drafts))throw Error('Invalid definition draft path.');
        for(const [kind,draft] of Object.entries(drafts)){if(!['data_sources','components'].includes(kind))throw Error('Invalid definition draft kind.');validateDefinitionDraft(draft,kind as DefinitionKind);}
      }
    }
    if(snapshot.inspector!==null&&(!snapshot.inspector||typeof snapshot.inspector.text!=='string'||bytes(snapshot.inspector.text).length>MAX_TEXT_BYTES))throw Error('The retained property draft is invalid.');
  }
  static create(revision:string,files:Record<string,PackageFile>) {
    return new StudioDocument({revision,files:Object.fromEntries(Object.entries(files).map(([path,metadata])=>[path,{metadata,text:null}])),buffers:{},past:[],future:[],selected:'',selectedNode:'',mode:'canvas',fixtures:{},positions:{},inspector:null});
  }
  get snapshot() { return clone(this.data); }
  get paths() { return [...new Set([...Object.keys(this.data.files),...Object.keys(this.data.buffers)])].filter(path=>!own(this.data.buffers,path)?.removed).sort(); }
  get current() { return own(this.data.buffers,this.data.selected); }
  get canvas() { return this.current?.lastValid??null; }
  error(path=this.data.selected) {
    const file=own(this.data.buffers,path); if(!file||!isVisual(path)||file.removed)return '';
    try{parseVisual(file.text);return '';}catch(error){return diagnostic(error);}
  }
  load(path:string,text:string) {
    sourcePath(path); if(own(this.data.buffers,path))return;
    const original=own(this.data.files,path); if(!original)throw Error('This file is absent from the captured revision.');
    if(bytes(text).length>MAX_TEXT_BYTES||text.includes('\0'))throw Error('This file is binary or larger than the text editor limit. Its immutable source is retained.');
    const value=this.buffer(path,text,original.metadata.executable);
    if(bytes(JSON.stringify(this.data)).length+bytes(JSON.stringify([text,value])).length>6*1024*1024)throw Error('The loaded source reached the 6 MiB draft limit. Use another Studio view for additional files.');
    original.text=text; put(this.data.buffers,path,value);
  }
  private buffer(path:string,text:string,executable=false,previous:Buffer|null=null):Buffer {
    if(bytes(text).length>MAX_TEXT_BYTES)throw Error('Text editing is limited to 128 KiB per file.');
    let lastValid=previous?.lastValid??null;
    if(isVisual(path))try{lastValid=parseVisual(text);}catch{/* Preserve invalid text and the last valid canvas. */}
    return {text,lastValid,removed:false,executable};
  }
  private transaction(changes:Change[]) {
    if(!changes.length)return;
    const next=clone(this.data);
    for(const change of changes)if(change.after===null)delete next.buffers[change.path];else put(next.buffers,change.path,clone(change.after));
    next.past.push(clone(changes));next.future=[];
    while(next.past.length>64||bytes(JSON.stringify(next.past)).length>MAX_HISTORY_BYTES)next.past.shift();
    if(bytes(JSON.stringify(next)).length>6*1024*1024)throw Error('This draft reached its 6 MiB editing limit. Checkpoint changes and open a new Studio view.');
    Object.assign(this.data,next);
  }
  edit(path:string,text:string) {
    const before=own(this.data.buffers,path); if(!before||before.removed)throw Error('Open the source file before editing.');
    if(before.text===text)return;
    this.transaction([{path,before:clone(before),after:this.buffer(path,text,before.executable,before)}]);
  }
  private declaredFiles(path:string,adding:boolean):Change {
    const before=own(this.data.buffers,'plugin.json'); if(!before)throw Error('Open plugin.json before changing the source inventory.');
    const manifest=JSON.parse(before.text),files=manifest?.source?.files;
    if(!Array.isArray(files)||!files.every((f:any)=>typeof f==='string'))throw Error('The manifest source inventory is invalid.');
    if(!adding && (manifest.source.lockfiles?.includes(path)||manifest.source.build_instructions===path))throw Error('Update the manifest’s lockfile or build instructions before removing this file.');
    manifest.source.files=adding?[...new Set([...files,path])].sort():files.filter((file:string)=>file!==path);
    return {path:'plugin.json',before:clone(before),after:this.buffer('plugin.json',JSON.stringify(manifest,null,2)+'\n',before.executable,before)};
  }
  add(path:string,text:string) {
    sourcePath(path); if(this.paths.includes(path)||path==='plugin.json')throw Error('That source path already exists.');
    this.transaction([{path,before:clone(own(this.data.buffers,path)??null),after:this.buffer(path,text)},this.declaredFiles(path,true)]);
    this.data.selected=path;
  }
  remove(path:string) {
    const before=own(this.data.buffers,path); if(!before||path==='plugin.json')throw Error('Open a non-manifest text file before removing it.');
    this.transaction([{path,before:clone(before),after:{...clone(before),removed:true}},this.declaredFiles(path,false)]);
    this.data.selected='plugin.json';
  }
  changeVisual(change:(doc:VisualDocument)=>void) {
    const file=this.current;if(!file||!isVisual(this.data.selected))throw Error('Open a visual declaration first.');
    // An invalid source is never overwritten by a canvas gesture.
    const doc=parseVisual(file.text);change(doc);const text=JSON.stringify(doc,null,2)+'\n';parseVisual(text);this.edit(this.data.selected,text);
  }
  updateNode(id:string,value:VisualNode) { this.changeVisual(doc=>{if(!own(doc.nodes,id))throw Error('The node no longer exists.');put(doc.nodes,id,clone(value));}); }
  retainDefinitionDraft(kind:DefinitionKind,draft:DefinitionDraft|null) {
    if(!isVisual(this.data.selected))throw Error('Open a visual declaration first.');
    if(draft)validateDefinitionDraft(draft,kind as DefinitionKind);
    const next=clone(this.data.definitionDrafts??{}),drafts=own(next,this.data.selected)??{};
    if(draft)put(drafts,kind,clone(draft));else delete drafts[kind];put(next,this.data.selected,drafts);
    if(bytes(JSON.stringify({...this.data,definitionDrafts:next})).length>6*1024*1024)throw Error('This draft reached its 6 MiB editing limit.');
    this.data.definitionDrafts=next;
  }
  updateDefinition(kind:DefinitionKind,original:string|null,id:string,value:VisualDataSource|CustomComponent,baseline:string|null) {
    this.changeVisual(doc=>{
      const map=doc[kind] as Record<string,VisualDataSource|CustomComponent>;
      if(original!==null&&(!own(map,original)||JSON.stringify(own(map,original))!==baseline))throw Error('This definition changed in the declaration. Reset the form to the current definition before applying.');
      if(id!==original&&own(map,id))throw Error('That definition ID already exists.');
      if(kind==='components'&&!this.paths.includes((value as CustomComponent).source))throw Error('Add the custom source file to this package before declaring its component.');
      if(original!==null)delete map[original];put(map,id,clone(value));
      if(original!==null&&id!==original) {
        const binding=(b:DataBinding|null)=>{if(b?.source===original)b.source=id;};
        const condition=(c:VisualCondition|null)=>{if(!c)return;if(c.kind==='not')condition(c.condition);else if(c.kind==='all')c.conditions.forEach(condition);else binding(c.binding);};
        for(const node of Object.values(doc.nodes)) {
          if(kind==='components'){if(node.component===original)node.component=id;continue;}
          Object.values(node.bindings).forEach(binding);condition(node.visible_when);
          for(const actions of Object.values(node.events))for(const action of actions){if(action.kind==='refresh'&&action.source===original)action.source=id;else if(action.kind==='open_view')binding(action.resource);}
        }
      }
    });
  }
  removeDefinition(kind:DefinitionKind,id:string,baseline:string) {
    this.changeVisual(doc=>{
      if(!own<VisualDataSource|CustomComponent>(doc[kind],id)||JSON.stringify(own<VisualDataSource|CustomComponent>(doc[kind],id))!==baseline)throw Error('This definition changed. Reset the form before removing it.');
      delete doc[kind][id];
      try{parseVisual(JSON.stringify(doc));}catch{throw Error('This definition is still referenced. Remove its node bindings, conditions or actions first.');}
    });
  }
  append(parent:string,kind:VisualNodeKind,component:string|null=null) {
    const id=`node-${crypto.randomUUID()}`;
    this.changeVisual(doc=>{const target=own(doc.nodes,parent);if(!target)throw Error('Select a parent node.');const child=node(kind);child.component=component;if(kind==='text')child.properties.text='New text';if(kind==='button')child.properties.label='Button';put(doc.nodes,id,child);target.children.push(id);});
    this.data.selectedNode=id;
  }
  move(id:string,parent:string,index:number) {
    this.changeVisual(doc=>{if(id===doc.root||!own(doc.nodes,id)||!own(doc.nodes,parent)||!Number.isInteger(index)||index<0)throw Error('Choose an existing non-root node and a parent.');
      for(const n of Object.values(doc.nodes))n.children=n.children.filter(child=>child!==id);
      const children=doc.nodes[parent]!.children;children.splice(Math.min(index,children.length),0,id);
    });
  }
  deleteNode(id:string) {
    this.changeVisual(doc=>{if(id===doc.root)throw Error('The root cannot be removed.');const remove=(key:string)=>{const n=own(doc.nodes,key);if(!n)throw Error('The node no longer exists.');n.children.forEach(remove);delete doc.nodes[key];};remove(id);for(const n of Object.values(doc.nodes))n.children=n.children.filter(child=>child!==id);});
    this.data.selectedNode=this.canvas!.root;
  }
  undo(redo=false) {
    const from=redo?this.data.future:this.data.past,to=redo?this.data.past:this.data.future,changes=from.pop();if(!changes)return;
    for(const change of changes) { const value=redo?change.after:change.before;if(value===null)delete this.data.buffers[change.path];else put(this.data.buffers,change.path,clone(value)); }
    to.push(changes);
    if(this.paths.includes(changes[0]!.path))this.data.selected=changes[0]!.path;
    if(!this.paths.includes(this.data.selected))this.data.selected=changes.map(change=>change.path).find(path=>this.paths.includes(path)&&own(this.data.buffers,path))??this.paths.find(path=>own(this.data.buffers,path))??'';
  }
  checkpoint(branch:string):CheckpointPlugin {
    const changes:CheckpointPlugin['changes']={};
    for(const [path,buffer] of Object.entries(this.data.buffers)) {
      const before=own(this.data.files,path);
      if(buffer.removed) { if(before)put(changes,path,{kind:'remove'}); }
      else if(!before||buffer.text!==before.text||buffer.executable!==before.metadata.executable)put(changes,path,{kind:'put',content_base64:encode(bytes(buffer.text)),executable:buffer.executable});
    }
    const request={branch,expected_head:this.data.revision,changes};
    if(Object.keys(changes).length>128||bytes(JSON.stringify(request)).length>256*1024)throw Error('This checkpoint exceeds 128 edits or 256 KiB. Keep a smaller change set; the draft is retained.');
    return request;
  }
  get dirty() { return Object.entries(this.data.buffers).some(([path,file])=>{const before=own(this.data.files,path);return file.removed?!!before:!before||file.text!==before.text||file.executable!==before.metadata.executable;}); }
  committed(revision:string,files:Record<string,PackageFile>) {
    this.data.revision=revision;
    this.data.files=Object.fromEntries(Object.entries(files).map(([path,metadata])=>[path,{metadata,text:own(this.data.buffers,path)?.text??null}]));
    // Undo history spans checkpoints. The captured baseline advances, history does not.
    for(const path of Object.keys(this.data.buffers))if(!Object.hasOwn(files,path))delete this.data.buffers[path];
  }
}
