import { HostClient, json, message } from './host-client';
import type { WorkbenchInfo } from './generated/WorkbenchInfo';
import type { RConfiguration } from './generated/RConfiguration';
import type { ApplicationState } from './generated/ApplicationState';
import type { OperationRecord } from './generated/OperationRecord';
import type { Invocation } from './generated/Invocation';
import type { Precondition } from './generated/Precondition';

export interface PendingRequest { invocation: Invocation; operationId?: string; error?: string }
export const terminal = (status: string) => ['succeeded','failed','cancelled','uncertain'].includes(status);

/** Documents, requests and observations outlive every panel and layout. */
export class Studio {
  info: WorkbenchInfo | null = null;
  r: RConfiguration | null = null;
  error = '';
  connected = false;
  consoleInput = '';
  records = new Map<string, OperationRecord>();
  pending: PendingRequest[] = [];
  recent: string[] = [];
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
  get canRun() { return !!this.project && this.connected && !this.busy && !!this.info?.capabilities.some(c=>c.capability.id==='workspace.run_r'); }
  async start() {
    try {
      [this.info, this.r] = await Promise.all([this.client.info(),this.client.rConfiguration()]);
      const recent = await this.client.readState(null,'recent');
      if (Array.isArray(recent.value)) this.recent = recent.value.filter((v): v is string=>typeof v === 'string');
      await this.restore();
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
    this.generation++; this.cursor=0; this.records.clear(); this.pending=[]; this.layout=null;
    await this.restore();
    const recent = await this.client.readState(null,'recent');
    this.recent = [this.project!, ...(Array.isArray(recent.value) ? recent.value.filter((v): v is string=>typeof v==='string' && v!==this.project):[])].slice(0,12);
    await this.client.writeState(null,{...recent,value:this.recent});
    this.emit();
  }
  async refreshInfo() { [this.info,this.r] = await Promise.all([this.client.info(),this.client.rConfiguration()]); this.emit(); }
  async restore() {
    if (!this.project) return;
    this.state = await this.client.readState(this.project,'studio');
    const data = this.state.value as {layout?:unknown;pending?:PendingRequest[];consoleInput?:string} | null;
    this.layout = data?.layout ?? null;
    this.pending = Array.isArray(data?.pending) ? data.pending : [];
    this.consoleInput = typeof data?.consoleInput === 'string' ? data.consoleInput : '';
    this.unsynced=false; this.syncError='';
  }
  persist() {
    this.unsynced=true; clearTimeout(this.saveTimer);
    this.saveTimer=setTimeout(()=>{void this.flush();},400);
  }
  serialize(): unknown { return {layout:this.layout,pending:this.pending,consoleInput:this.consoleInput}; }
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
    const request: PendingRequest = {invocation:{client_request_id:crypto.randomUUID(),capability:{id,version:1},arguments:json(args),preconditions}};
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
  private schedule() { if(!this.stopped) this.timer=setTimeout(()=>{void this.poll();},250); }
  private async poll() {
    const project=this.project, generation=this.generation;
    try {
      if(project) {
        const events=await this.client.subscribe(project,this.cursor);
        if(generation!==this.generation) return;
        const ids=[...new Set(events.map(e=>e.operation_id))];
        for(const id of ids) {
          const record=await this.client.getOperation(project,id);
          if(generation!==this.generation) return;
          if(record && (record.operation.idempotency_scope===project || record.operation.target.identity===project)) {
            this.records.set(id,record);
            const pending=this.pending.find(p=>p.invocation.client_request_id===record.operation.client_request_id);
            if(pending) { pending.operationId=id; if(terminal(record.status)) { this.pending=this.pending.filter(p=>p!==pending); this.persist(); } }
          }
        }
        if(events.length) { this.cursor=events.at(-1)!.sequence; this.emit(); }
      }
      if(!this.connected) {this.connected=true;this.emit();}
    } catch(error) { if(this.connected) { this.connected=false;this.error=message(error);this.emit(); } }
    finally { this.schedule(); }
  }
}
