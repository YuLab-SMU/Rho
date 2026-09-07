import { Documents } from './documents';
import type { DirectoryPage } from './generated/DirectoryPage';
import type { WorkspaceSnapshotData } from './generated/WorkspaceSnapshotData';
import type { BindingSummary } from './generated/BindingSummary';
import { HostClient, json, message } from './host-client';
import type { WorkbenchInfo } from './generated/WorkbenchInfo';
import type { RConfiguration } from './generated/RConfiguration';
import type { ApplicationState } from './generated/ApplicationState';
import type { OperationRecord } from './generated/OperationRecord';
import type { Invocation } from './generated/Invocation';
import type { RuntimeStatus } from './generated/RuntimeStatus';
import type { RecentOperations } from './generated/RecentOperations';
import type { OutputEvent } from './generated/OutputEvent';
import type { OutputEvents } from './generated/OutputEvents';
import type { MediaReference } from './generated/MediaReference';
import type { OutputPage } from './generated/OutputPage';
import type { Precondition } from './generated/Precondition';

export interface PendingRequest { invocation: Invocation; operationId?: string; error?: string }
export const terminal = (status: string) => ['succeeded','failed','cancelled','uncertain'].includes(status);

/** Documents, requests and observations outlive every panel and layout. */
export class Studio {
  info: WorkbenchInfo | null = null;
  readonly documents = new Documents(this);
  directory: DirectoryPage | null = null;
  directoryError = '';
  directoryLoading = false;
  objects: WorkspaceSnapshotData | null = null;
  objectsObservedAt: number | null = null;
  objectsNotice = '';
  inspectors = new Map<string,{binding:BindingSummary;observedAt:number;notice:string}>();
  selectedObject: string | null = null;

  r: RConfiguration | null = null;
  error = '';
  connected = false;
  consoleInput = '';
  records = new Map<string, OperationRecord>();
  pending: PendingRequest[] = [];
  recent: string[] = [];
  runtime: RuntimeStatus | null = null;
  outputEvents = new Map<string,OutputEvent[]>();
  outputNotices = new Map<string,string>();
  outputCursors = new Map<string,number>();
  private outputDone = new Set<string>();
  mediaUrls = new Map<string,string>();
  mediaErrors = new Map<string,string>();
  private mediaLoads = new Map<string,Promise<void>>();
  selectedPlot: string | null = null;
  plotZoom: number | null = null;
  recentCursor: number | null = null;
  showPanel?: (component:string,id?:string,name?:string,config?:unknown)=>void;
  private observedAt = 0;
  layout: unknown = null;
  state: ApplicationState = {key:'studio',version:null,value:null};
  syncError = '';
  unsynced = false;
  private revision = 0;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saving: Promise<void> | null = null;
  private generation = 0;
  private cursor = 0;
  private stopped = false;
  constructor(readonly client: HostClient) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => {this.listeners.delete(fn);}; };
  snapshot = () => this.revision;
  emit() { this.revision++; for (const listener of this.listeners) listener(); }
  get project() { return this.info?.project_root ?? null; }
  get busy() { return this.pending.some(p=>!p.error) || [...this.records.values()].some(r=>!terminal(r.status)); }
  get canRun() { return !!this.project && this.connected && !this.busy && !this.pending.length && this.runtime?.state === 'idle' && !!this.info?.capabilities.some(c=>c.capability.id==='workspace.run_r'); }
  async start() {
    try {
      [this.info, this.r] = await Promise.all([this.client.info(),this.client.rConfiguration()]);
      const recent = await this.client.readState(null,'recent');
      if (Array.isArray(recent.value)) this.recent = recent.value.filter((v): v is string=>typeof v === 'string');
      await this.restore();
      await this.observe();
      this.connected = true;
    } catch(error) { this.error = message(error); }
    this.emit();
    this.schedule();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.saveTimer); }
  async selectProject(path: string) {
    await this.flush();
    if (this.unsynced) throw new Error(this.syncError || '草稿尚未同步，项目未切换');
    this.info = await this.client.selectProject(path);
    this.generation++; this.cursor=0; this.records.clear(); this.pending=[]; this.layout=null; this.clearOutputs(); this.observedAt=0; this.directory=null;this.directoryError="";this.objects=null;this.inspectors.clear();
    await this.restore();
    await this.observe();
    const recent = await this.client.readState(null,'recent');
    this.recent = [this.project!, ...(Array.isArray(recent.value) ? recent.value.filter((v): v is string=>typeof v==='string' && v!==this.project):[])].slice(0,12);
    await this.client.writeState(null,{...recent,value:this.recent});
    this.emit();
  }
  async refreshInfo() { [this.info,this.r] = await Promise.all([this.client.info(),this.client.rConfiguration()]); this.emit(); }
  async restore() {
    if (!this.project) return;
    this.state = await this.client.readState(this.project,'studio');
    const data = this.state.value as {layout?:unknown;pending?:PendingRequest[];consoleInput?:string;documents?:unknown;selectedPlot?:string;cursor?:number} | null;
    this.layout = data?.layout ?? null;
    this.documents.restore(data?.documents);
    this.pending = Array.isArray(data?.pending) ? data.pending : [];
    this.consoleInput = typeof data?.consoleInput === 'string' ? data.consoleInput : '';
    this.selectedPlot=typeof data?.selectedPlot==='string'?data.selectedPlot:null;
    this.cursor=Number.isSafeInteger(data?.cursor) ? data!.cursor! : 0;
    for(const pending of this.pending) pending.error='请求尚未确认；刷新不会重新执行。';
    this.unsynced=false; this.syncError='';
  }
  persist() {
    this.unsynced=true; clearTimeout(this.saveTimer);
    this.saveTimer=setTimeout(()=>{void this.flush();},400);
  }
  serialize(): unknown { return {documents:this.documents.serialize(),layout:this.layout,pending:this.pending,consoleInput:this.consoleInput,selectedPlot:this.selectedPlot,cursor:this.cursor}; }
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saving) { await this.saving; if(this.unsynced && !this.syncError) await this.flush(); return; }
    if (!this.project || !this.unsynced) return;
    const project=this.project; const value=json(this.serialize());
    this.saving=(async()=>{
      try {
        const saved = await this.client.writeState(project,{...this.state,value});
        if (project!==this.project) return;
        this.state=saved; this.syncError='';
        this.unsynced=JSON.stringify(value)!==JSON.stringify(this.serialize());
      } catch(error) { this.syncError=message(error); this.unsynced=true; }
      finally { this.saving=null; this.emit(); }
    })();
    await this.saving;
    if (this.unsynced && !this.syncError) await this.flush();
  }
  async invoke(id:string,args:unknown,preconditions:Precondition[]=[]):Promise<OperationRecord> {
    if(!this.project) throw new Error('先打开项目');
    const project=this.project;
    if(new TextEncoder().encode(JSON.stringify(args)).length>256*1024)throw new Error('请求参数超过 256 KiB 上限；未提交，草稿仍保留');
    const request: PendingRequest = {invocation:{client_request_id:crypto.randomUUID(),capability:{id,version:1},arguments:json(args),preconditions}};
    if(new TextEncoder().encode(JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method:'invoke',params:request.invocation}}})).length>272*1024)throw new Error('请求超过 272 KiB 传输上限；未提交，草稿仍保留');
    this.pending.push(request); this.persist(); this.emit();
    await this.flush();
    if(this.unsynced) {
      this.pending=this.pending.filter(p=>p!==request); this.persist();
      throw new Error(`请求未提交：${this.syncError}`);
    }
    try {
      const record=await this.client.invoke(project,request.invocation);
      this.records.set(record.operation.operation_id,record);
      this.pending=this.pending.filter(p=>p!==request); this.persist(); this.emit();
      return record;
    } catch(error) { request.error=message(error); this.persist(); this.emit(); throw error; }
  }
  async run(code:string) { if(!this.canRun || !code.trim()) return; await this.invoke('workspace.run_r',{code}); }
  async cancel() {
    if(!this.project) return;
    for(const record of this.records.values()) if(!terminal(record.status)) await this.client.cancel(this.project,record.operation.operation_id);
  }
  async listDirectory(path='',append=false) {
    const project=this.project;if(!project)return;
    this.directoryLoading=true;this.directoryError='';this.emit();
    try {
      const result=await this.client.query(project,'project.list_directory',{path,after_name:append?this.directory?.next_name:null,limit:200});
      if(result.status!=='ready')throw new Error(result.notices.join('\n'));
      const page=result.data as DirectoryPage;
      if(this.project===project)this.directory={...page,entries:append&&this.directory?.path===path?[...this.directory.entries,...page.entries]:page.entries};
    }catch(error){this.directoryError=message(error);}finally{this.directoryLoading=false;this.emit();}
  }
  async inspectObject(name:string) {
    const project=this.project;if(!project)return;
    const snapshot=await this.client.query(project,'workspace.inspect_object',{name,max_items:20});
    if(project!==this.project)return;
    if(snapshot.status!=='ready'){this.objectsNotice=snapshot.notices.join('\n');this.emit();return;}
    this.inspectors.set(name,{binding:snapshot.data as BindingSummary,observedAt:snapshot.observed_at_ms,notice:snapshot.notices.join('\n')});
    this.selectedObject=name;this.showPanel?.('viewer',`object:${name}`,name,{name});this.emit();
  }
  clearOutputs() {
    for(const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
    this.outputEvents.clear();this.outputNotices.clear();this.outputCursors.clear();this.outputDone.clear();this.mediaUrls.clear();this.mediaErrors.clear();this.mediaLoads.clear();this.runtime=null;
  }
  mediaKey(reference:MediaReference) {return `${reference.operation_id}:${reference.sequence}:${reference.sha256}`;}
  get media():MediaReference[] {return [...this.outputEvents.values()].flatMap(events=>events.flatMap(e=>e.media?[e.media]:[]));}
  selectPlot(reference:MediaReference) {this.selectedPlot=this.mediaKey(reference);this.plotZoom=null;this.persist();this.emit();}
  locatePlot(reference:MediaReference) {this.selectPlot(reference);this.showPanel?.('plots');}
  async loadMedia(reference:MediaReference):Promise<void> {
    const key=this.mediaKey(reference), project=this.project;
    if(!project || this.mediaUrls.has(key) || this.mediaErrors.has(key))return;
    if(this.mediaLoads.has(key))return this.mediaLoads.get(key)!;
    const promise=(async()=>{
      try {
        if(!['image/png','image/jpeg','image/svg+xml'].includes(reference.mime_type) || reference.byte_size>16*1024*1024)throw new Error('不支持或过大的媒体输出');
        const bytes=new Uint8Array(reference.byte_size);let offset=0;
        do {
          const snapshot=await this.client.query(project,'workspace.read_output',{reference,offset,limit_bytes:65536});
          if(snapshot.status!=='ready')throw new Error(snapshot.notices.join('\n'));
          const page=snapshot.data as OutputPage;
          if(page.offset!==offset || JSON.stringify(page.reference)!==JSON.stringify(reference) || page.bytes.length>65536 || offset+page.bytes.length>bytes.length || (!page.bytes.length && page.has_more))throw new Error('媒体分段响应不一致');
          bytes.set(page.bytes,offset);offset+=page.bytes.length;
          if(!page.has_more)break;
        } while(offset<bytes.length);
        const digest='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
        if(offset!==bytes.length || digest!==reference.sha256)throw new Error('原始输出摘要不匹配');
        if(this.project===project)this.mediaUrls.set(key,URL.createObjectURL(new Blob([bytes],{type:reference.mime_type})));
      }catch(error){if(this.project===project)this.mediaErrors.set(key,message(error));}
      finally{this.mediaLoads.delete(key);this.emit();}
    })();
    this.mediaLoads.set(key,promise);return promise;
  }
  async loadRecent(older=false) {
    const project=this.project;if(!project)return;
    const page=await this.client.query(project,'operation.list_recent',{before_cursor:older?this.recentCursor:null,client_request_id:null,limit:30});
    if(page.status!=='ready')return;
    const data=page.data as RecentOperations;
    if(older || this.recentCursor===null)this.recentCursor=data.next_cursor;
    for(const summary of [...data.operations].reverse()) {
      if(!summary.capability.id.startsWith('workspace.'))continue;
      const existing=this.records.get(summary.operation_id);
      if(existing && existing.updated_at_ms===summary.updated_at_ms && existing.status===summary.status)continue;
      await this.acceptRecord(project,summary.operation_id);
    }
  }
  private async acceptRecord(project:string,id:string) {
    const record=await this.client.getOperation(project,id);
    if(project!==this.project || !record || record.operation.idempotency_scope!==project)return;
    this.records.set(id,record);
    const pending=this.pending.find(p=>p.invocation.client_request_id===record.operation.client_request_id);
    if(pending) {pending.operationId=id;pending.error=undefined;if(terminal(record.status)){this.pending=this.pending.filter(p=>p!==pending);this.persist();}}
    this.emit();
  }
  async observe() {
    const project=this.project;if(!project)return;
    await this.loadRecent();
    if(this.info?.capabilities.some(c=>c.capability.id==='workspace.runtime_status')) {
      const status=await this.client.query(project,'workspace.runtime_status');
      if(project===this.project && status.status==='ready')this.runtime=status.data as RuntimeStatus;
    }
    if(this.info?.capabilities.some(c=>c.capability.id==='workspace.snapshot')) {
      const objects=await this.client.query(project,'workspace.snapshot',{limit:200});
      if(project===this.project) {
        if(objects.status==='ready'){this.objects=objects.data as WorkspaceSnapshotData;this.objectsObservedAt=objects.observed_at_ms;this.objectsNotice='';}
        else this.objectsNotice=objects.notices.join('\n');
      }
    }
    for(const pending of [...this.pending]) {
      if(pending.operationId){await this.acceptRecord(project,pending.operationId);continue;}
      const page=await this.client.query(project,'operation.list_recent',{client_request_id:pending.invocation.client_request_id,limit:1});
      const summary=(page.data as RecentOperations | null)?.operations[0];
      if(summary)await this.acceptRecord(project,summary.operation_id);
    }
    this.observedAt=Date.now();this.emit();
  }
  private schedule() { if(!this.stopped) this.timer=setTimeout(()=>{void this.poll();},250); }
  private async poll() {
    const project=this.project,generation=this.generation;
    try {
      if(project) {
        if(Date.now()-this.observedAt>2000 || this.pending.some(p=>!p.operationId && !p.error))await this.observe();
        const events=await this.client.subscribe(project,this.cursor);
        if(generation!==this.generation)return;
        for(const id of new Set(events.map(e=>e.operation_id)))if(this.records.has(id))await this.acceptRecord(project,id);
        if(events.length)this.cursor=events.at(-1)!.sequence;
        for(const [id,record] of this.records) {
          if(this.outputDone.has(id) || !record.operation.capability.id.startsWith('workspace.'))continue;
          const snapshot=await this.client.query(project,'workspace.output_events',{operation_id:id,after_sequence:this.outputCursors.get(id)??0,limit:100});
          if(project!==this.project)return;
          if(snapshot.status!=='ready') {
            if(terminal(record.status)){this.outputNotices.set(id,snapshot.notices.join('\n'));this.outputDone.add(id);this.emit();}continue;
          }
          const page=snapshot.data as OutputEvents;
          if(page.operation_id!==id || !Number.isSafeInteger(page.next_sequence))throw new Error('输出关联不一致');
          this.outputCursors.set(id,page.next_sequence);
          if(page.events.length){this.outputEvents.set(id,[...(this.outputEvents.get(id)??[]),...page.events]);
            if(!this.selectedPlot){const media=page.events.find(e=>e.media)?.media;if(media)this.selectedPlot=this.mediaKey(media);}
            this.emit();
          }
          if(page.truncated || page.gap)this.outputNotices.set(id,[...page.notices,page.truncated?'输出已达到观察上限，后续内容省略。':''].filter(Boolean).join('\n'));
          if(terminal(record.status) && !page.has_more)this.outputDone.add(id);
        }
      }
      if(!this.connected){this.connected=true;this.emit();}
    }catch(error){if(this.connected){this.connected=false;this.error=message(error);this.emit();}}
    finally{this.schedule();}
  }
}
