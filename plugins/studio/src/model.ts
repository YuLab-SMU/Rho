import type { PluginBranch, PluginBranchPage, PluginCheckpoint, PluginInspection, PluginSourcePage, PluginSourceChunk, PackageFile, CheckpointPlugin } from '../public/plugin-protocol/index.js';
import { ViewRequestError } from '../public/plugin-ui/index.js';
import { AgentAssistance, type AgentState } from './agent.js';
import { DraftSync } from './draft-sync.js';
import { Development, type DevelopmentState } from './development.js';
import { ScenarioApplication, type ScenarioState } from './scenario.js';
import { Archives, type ArchiveState } from './archive.js';
import { StudioDocument, MAX_TEXT_BYTES, type Snapshot } from './document.js';
import { bytes, own, put } from './visual.js';
import { type Client, type Intent, type RecordReply, json, same, verifyOriginal, inspectOriginal, terminal } from './operations.js';
export async function read<T>(client:Client,id:string,args:unknown):Promise<T> {
  const result=await client.query<{status:string;data?:T;notices?:string[]}>({id,version:1},json(args));
  if(result.status!=='ready'||result.data==null)throw Error(result.notices?.join('\n')||`${id} is unavailable.`);return result.data;
}
export async function sourceTree(client:Client,revision:string) {
  const files:Record<string,PackageFile>={},seen=new Set<string>();let after:string|null=null,total:number|null=null;
  // Native package paths sort as UTF-8, not JavaScript's UTF-16 code units.
  const later=(path:string,cursor:string)=>{const left=bytes(path),right=bytes(cursor);for(let i=0;i<Math.min(left.length,right.length);i++)if(left[i]!==right[i])return left[i]!>right[i]!;return left.length>right.length;};
  do {
    const page:PluginSourcePage=await read(client,'plugins.source_tree',{revision,after,limit:100});
    if(page.revision!==revision||!Number.isInteger(page.total)||page.total<0||page.total>8192||total!==null&&page.total!==total)throw Error('Source page changed its captured revision or size.');
    total=page.total;
    for(const [path,file] of Object.entries(page.files)) { if(own(files,path)||after!==null&&!later(path,after))throw Error('Source pagination repeated a file.');put(files,path,file); }
    if(page.next!==null&&(!Object.hasOwn(files,page.next)||seen.has(page.next)||after!==null&&!later(page.next,after)))throw Error('Source pagination did not advance.');
    after=page.next;if(after!==null)seen.add(after);
    if(Object.keys(files).length>8192)throw Error('Source inventory exceeds its limit.');
  }while(after!==null);
  if(Object.keys(files).length!==total)throw Error('The source inventory is incomplete.');return files;
}
export async function sourceText(client:Client,revision:string,path:string,file:PackageFile) {
  if(file.bytes>MAX_TEXT_BYTES)throw Error('This source is larger than 128 KiB. Its original bytes remain in the revision; choose another text file.');
  const data=new Uint8Array(file.bytes);let offset=0;
  do {
    const chunk:PluginSourceChunk=await read(client,'plugins.read_source',{revision,path,offset,limit:65536});
    if(chunk.revision!==revision||chunk.path!==path||!same(chunk.file,file)||chunk.offset!==offset)throw Error('Source read returned a different file or offset.');
    const decoded=Uint8Array.from(atob(chunk.content_base64),c=>c.charCodeAt(0));
    if(decoded.length>65536||offset+decoded.length>data.length||chunk.next_offset!==null&&chunk.next_offset!==offset+decoded.length||chunk.next_offset!==null&&decoded.length===0)throw Error('Source chunk is incomplete or exceeds its captured size.');
    data.set(decoded,offset);offset+=decoded.length;
    if(chunk.next_offset===null)break;
  }while(true);
  const hash='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');
  if(offset!==file.bytes||hash!==file.digest)throw Error('Source content does not match its captured digest.');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(data);if(text.includes('\0'))throw Error('This source is binary. Its original bytes are retained.');return text;
}
type Pending={intent:Intent;proposal:PluginCheckpoint|null;restore:boolean};
interface Payload { schema:1;plugin:string|null;branch:PluginBranch|null;document:Snapshot|null;pending:Pending|null;development?:DevelopmentState;application?:ScenarioState;archives?:ArchiveState; assistance?:AgentState; }
export class Studio {
  readonly drafts:DraftSync;
  readonly assistance:AgentAssistance;
  readonly development:Development;
  readonly application:ScenarioApplication;
  readonly archives:Archives;
  document:StudioDocument|null=null;
  plugin:string|null=null;
  branch:PluginBranch|null=null;
  pending:Pending|null=null;
  private queue:Promise<unknown>=Promise.resolve();
  constructor(readonly client:Client) {
    this.drafts=new DraftSync(client);
    this.assistance=new AgentAssistance(client,()=>this.flush(),()=>{
      if(this.pending||this.development?.data.pending||this.development?.data.testing?.pending||this.application?.data.pending||this.archives?.data.pending||this.drafts.unresolved)throw Error('Inspect the original Studio request before opening Agent.');
    });
    this.development=new Development(client,()=>this.flush(),()=>{
      if(this.assistance.data.pending||this.pending||this.application?.data.pending||this.archives?.data.pending||this.drafts.unresolved)throw Error('Inspect the original source, scenario, archive or draft request before starting development work.');
    });
    this.application=new ScenarioApplication(client,()=>this.flush(),()=>{
      if(this.assistance.data.pending||this.pending||this.development.data.pending||this.development.data.testing?.pending||this.archives?.data.pending||this.drafts.unresolved)throw Error('Inspect the original source, development, archive or draft request before changing the scenario.');
    });
    this.archives=new Archives(client,()=>this.flush(),()=>{
      if(this.assistance.data.pending||this.pending||this.development.data.pending||this.development.data.testing?.pending||this.application.data.pending||this.drafts.unresolved)throw Error('Inspect the original source, development, scenario or draft request before another archive action.');
    });
  }
  private payload():Payload { return {schema:1,plugin:this.plugin,branch:this.branch,document:this.document?.snapshot??null,pending:this.pending,development:this.development.data,application:this.application.data,archives:this.archives.data,assistance:this.assistance.data}; }
  flush() {
    const capture=bytes(JSON.stringify(this.payload()));
    const task=this.queue.then(()=>this.drafts.save(capture,{encoding:'org.rho.studio.draft.v1'}));this.queue=task.catch(()=>undefined);return task;
  }
  async open() {
    if(this.drafts.unresolved)await this.drafts.inspect();
    const body=await this.drafts.read();if(body===null)return;
    const saved=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)) as Payload;
    if(saved.schema!==1||!['plugin','branch','document','pending'].every(key=>Object.hasOwn(saved,key)))throw Error('The saved Studio draft has an unsupported format.');
    const doc=saved.document===null?null:new StudioDocument(saved.document);
    if(saved.branch&&(!doc||saved.branch.plugin!==saved.plugin||saved.branch.head!==doc.data.revision))throw Error('The saved branch differs from the captured source.');
    this.plugin=saved.plugin;this.branch=saved.branch;this.document=doc;this.pending=saved.pending;
    if(this.pending)await this.validatePending();
    if(saved.development)await this.development.restore(saved.development);
    if(saved.application)this.application.restore(saved.application);
    if(saved.archives)this.archives.restore(saved.archives);
    if(saved.assistance)this.assistance.restore(saved.assistance);
  }
  private async validatePending() {
    const pending=this.pending!,intent=pending.intent;
    if(!intent||!/^[A-Za-z0-9._-]{1,128}$/.test(intent.view)||!/^[A-Za-z0-9._-]{1,128}$/.test(intent.request)||intent.operation!==null&&!/^[A-Za-z0-9._:/-]{1,160}$/.test(intent.operation)||intent.capability.version!==1)throw Error('The retained request has an invalid identity.');
    const args=intent.arguments as any;
    if(intent.capability.id==='plugins.branch') {
      if(pending.proposal!==null||args?.revision!==this.document?.data.revision||typeof args.name!=='string')throw Error('The retained branch request differs from its source.');
    }else if(intent.capability.id==='plugins.checkpoint') {
      if(!this.branch||!this.document||!pending.proposal||pending.proposal.branch!==this.branch.id||args?.branch!==this.branch.id||args.expected_head!==pending.proposal.parent||![pending.proposal.parent,pending.proposal.revision].includes(this.document.data.revision))throw Error('The retained checkpoint differs from its captured branch or source.');
    }else throw Error('The retained request is not a Studio source operation.');
  }
  private available() { if(this.assistance.data.pending||this.pending||this.development.data.pending||this.development.data.testing?.pending||this.application?.data.pending||this.archives.data.pending||this.drafts.unresolved)throw Error('Inspect the original unconfirmed request before changing the development target.'); }
  async select(revision:string,branch:PluginBranch|null=null) {
    this.available();if(this.document?.dirty)throw Error('Checkpoint current edits before choosing another revision.');
    const inspection:PluginInspection=await read(this.client,'plugins.inspect',{revision});
    if(inspection.summary.revision!==revision||branch&&(branch.head!==revision||branch.plugin!==inspection.summary.plugin))throw Error('The selected branch differs from its revision.');
    const doc=StudioDocument.create(revision,await sourceTree(this.client,revision));
    this.document=doc;this.plugin=inspection.summary.plugin;this.branch=branch;
    const path=doc.paths.find(path=>path.startsWith('views/')&&path.endsWith('.json'))??'plugin.json';
    await this.loadFile('plugin.json');if(path!=='plugin.json')await this.loadFile(path);doc.data.selected=path;await this.flush();
  }
  async branches(plugin:string) {
    const result:PluginBranch[]=[];let after:string|null=null;
    do { const page:PluginBranchPage=await read(this.client,'plugins.branches',{plugin,after,limit:100});
      for(const branch of page.branches) {if(branch.plugin!==plugin||result.some(b=>b.id===branch.id))throw Error('Branch page changed its identity.');result.push(branch);}
      if(page.next!==null&&(after!==null&&page.next<=after||!page.branches.some(b=>b.id===page.next)))throw Error('Branch pagination did not advance.');after=page.next;
      if(result.length>8192)throw Error('Too many development branches to display.');
    }while(after!==null);return result;
  }
  async loadFile(path:string) {
    const doc=this.document;if(!doc)throw Error('Choose a revision first.');
    if(!own(doc.data.buffers,path)) {const file=own(doc.data.files,path);if(!file)throw Error('This source path is absent.');doc.load(path,await sourceText(this.client,doc.data.revision,path,file.metadata));}
    doc.data.selected=path;doc.data.selectedNode=doc.canvas?.root??'';
  }
  async createBranch(name:string) {
    this.available();if(!this.document)throw Error('Choose a source revision for the branch point.');
    // Fork the immutable baseline and keep its local edits. This is also the
    // escape from a stale branch head, without overwriting another writer.
    await this.begin('plugins.branch',{revision:this.document.data.revision,name},null,false);
  }
  async check() {
    this.available();if(!this.document||!this.branch)throw Error('Choose or create a development branch first.');
    const request=this.document.checkpoint(this.branch.id);if(!Object.keys(request.changes).length)throw Error('There are no source changes to check.');
    const proposal:PluginCheckpoint=await read(this.client,'plugins.check_source',request);
    if(proposal.branch!==this.branch.id||proposal.parent!==this.document.data.revision)throw Error('Source validation returned another branch or parent.');
    return {request,proposal};
  }
  async checkpoint() { const {request,proposal}=await this.check();await this.begin('plugins.checkpoint',request,proposal,false); }
  async restore(revision:string) {
    this.available();if(!this.document||!this.branch||this.document.dirty)throw Error('Checkpoint current edits before restoring source history.');
    const inspection:PluginInspection=await read(this.client,'plugins.inspect',{revision});if(inspection.summary.plugin!==this.plugin)throw Error('History must belong to the same plugin.');
    const before=await sourceTree(this.client,this.document.data.revision),after=await sourceTree(this.client,revision),changes:CheckpointPlugin['changes']={};
    for(const path of new Set([...Object.keys(before),...Object.keys(after)]))if(!same(own(before,path),own(after,path)))put(changes,path,own(after,path)?{kind:'copy',revision,path}:{kind:'remove'});
    if(!Object.keys(changes).length)throw Error('These source contents already match.');
    const request={branch:this.branch.id,expected_head:this.document.data.revision,changes};
    const proposal:PluginCheckpoint=await read(this.client,'plugins.check_source',request);
    if(proposal.branch!==request.branch||proposal.parent!==request.expected_head)throw Error('Restore validation returned another branch or parent.');
    await this.begin('plugins.checkpoint',request,proposal,true);
  }
  private async begin(id:string,args:unknown,proposal:PluginCheckpoint|null,restore:boolean) {
    this.available();this.pending={intent:{view:this.client.view.view,request:crypto.randomUUID(),capability:{id,version:1},arguments:json(structuredClone(args)),operation:null},proposal,restore};
    // Never dispatch an intent without an acknowledged synchronized draft.
    await this.flush();await this.dispatch(true);
  }
  async dispatch(first=false) {
    if(!this.pending||this.pending.intent.view!==this.client.view.view)throw Error('Only the original view can retry this request. Inspect its original Operation.');
    await this.validatePending();await this.flush();const intent=this.pending.intent;
    let reply:unknown;
    try{reply=await this.client.invoke(intent.capability,intent.arguments,{requestId:intent.request});}
    catch(error) {
      const code=error instanceof ViewRequestError?(error.diagnostic as any)?.code:null;
      if(first&&['invalid_input','content_changed','not_found','access_denied'].includes(code)) {this.pending=null;await this.flush();}
      throw error;
    }
    await this.finish(await verifyOriginal(reply,intent));
  }
  async recover() { if(!this.pending)throw Error('No source request is pending.');await this.validatePending();await this.finish(await inspectOriginal(this.client,this.pending.intent)); }
  private async finish(record:RecordReply) {
    const pending=this.pending!;pending.intent.operation=record.operation.operation_id;await this.flush();
    const deadline=Date.now()+8000;
    while(!terminal(record.status)&&Date.now()<deadline) {await new Promise(done=>setTimeout(done,100));record=await inspectOriginal(this.client,pending.intent);}
    if(record.status!=='succeeded') {
      if(['failed','cancelled'].includes(record.status)) {this.pending=null;await this.flush();}
      throw Error(record.error||`Original source request is ${record.status}.`);
    }
    if(pending.intent.capability.id==='plugins.branch') {
      const id=(record.output as any)?.branch,args=pending.intent.arguments as any;
      if(typeof id!=='string'||!id)throw Error('Branch receipt has no identity.');
      this.branch={id,plugin:this.plugin!,name:args.name,head:args.revision,origin:args.revision};
    }else {
      if(!same(record.output,pending.proposal))throw Error('Checkpoint receipt differs from its prepared immutable revision.');
      const revision=pending.proposal!.revision,files=await sourceTree(this.client,revision);
      if(pending.restore) {this.document=StudioDocument.create(revision,files);await this.loadFile('plugin.json');}
      else this.document!.committed(revision,files);
      this.branch!.head=revision;
    }
    this.pending=null;
    try{await this.flush();}catch(error){this.pending=pending;throw error;}
  }
}
