import type {PluginViewConnection,PluginViewRecord,PluginWindowLayout} from '../../sdk/plugin-protocol/index.js';
import {Model,readonlyMap} from './shared/model';
import {pluginLayoutViews} from './plugin-layout';
interface WindowView {id:string;title:string;visible:boolean;connected:boolean;error:string;}
interface ViewPorts {
  connect(view:string):Promise<PluginViewConnection>;
  inspect(view:string):Promise<PluginViewRecord>;
  title(record:PluginViewRecord):Promise<string>;
}
/** Window-owned presentation identities. Hiding a tab never discards its live
 * document. Only a scoped closed observation releases a retained frame. No
 * connection credential is included in render snapshots or persisted layout. */
export class PluginWindowViews extends Model<ReadonlyMap<string,WindowView>> {
  private entries=new Map<string,WindowView>();
  private connections=new Map<string,PluginViewConnection>();
  private work=new Map<string,Promise<void>>();
  private scope:Pick<PluginWindowLayout,'project'|'principal'|'window'>|null=null;
  private stopped=false;
  private hiddenCursor=0;
  constructor(readonly window:string,private ports:ViewPorts){super();}
  protected readSnapshot(){return readonlyMap(new Map([...this.entries].map(([id,entry])=>[id,Object.freeze({...entry})])));}
  connection(view:string):PluginViewConnection|null{return this.connections.get(view)??null;}
  private scoped(record:PluginViewRecord,id:string){
    if(!this.scope||record.view!==id||record.window!==this.scope.window||record.project!==this.scope.project||record.principal!==this.scope.principal)
      throw new Error('The view observation belongs to another window or authority.');
    const previous=this.connections.get(id)?.view.instance,current=record.instance;
    if(previous&&['instance','plugin','revision','artifact'].some(field=>previous[field as keyof typeof previous]!==current[field as keyof typeof current]))
      throw new Error('The retained view changed its original plugin identity.');
  }
  observe(layout:PluginWindowLayout){
    if(this.stopped)return;
    if(layout.window!==this.window||this.scope&&(layout.project!==this.scope.project||layout.principal!==this.scope.principal))throw new Error('The window layout changed its original scope.');
    this.scope={window:layout.window,project:layout.project,principal:layout.principal};
    const visible=new Set(pluginLayoutViews(layout.layout));
    if(visible.size>256)throw new Error('The window exceeds its view quota.');
    let changed=false;
    for(const [id,entry] of this.entries){const selected=visible.has(id);if(entry.visible!==selected){this.entries.set(id,{...entry,visible:selected});changed=true;}}
    for(const id of visible)if(!this.entries.has(id)){this.entries.set(id,{id,title:id,visible:true,connected:false,error:''});changed=true;}
    if(changed)this.publish();
  }
  private run(id:string,action:()=>Promise<void>,report=true){
    const prior=this.work.get(id);if(prior)return prior;
    const task=Promise.resolve().then(action).catch(error=>{
      if(report&&!this.stopped&&this.entries.has(id)){this.entries.set(id,{...this.entries.get(id)!,error:error instanceof Error?error.message:String(error)});this.publish();}
      throw error;
    }).finally(()=>this.work.delete(id));this.work.set(id,task);return task;
  }
  connect(id:string):Promise<void>{
    if(this.stopped||!this.entries.has(id))return Promise.reject(new Error('The view is not present in this window.'));
    if(this.connections.has(id))return Promise.resolve();
    return this.run(id,async()=>{
      const connection=await this.ports.connect(id);if(this.stopped)return;this.scoped(connection.view,id);
      if(connection.view.closed)throw new Error('This view is already closed.');
      this.connections.set(id,connection);
      const title=await this.ports.title(connection.view).catch(()=>connection.view.contribution);if(this.stopped)return;
      this.entries.set(id,{...this.entries.get(id)!,title:title||connection.view.contribution,connected:true,error:''});this.publish();
    });
  }
  /** An explicit failed-frame retry rechecks the same identity; it never opens a
   * replacement view or changes a running provider. */
  failed(id:string,error:string){if(!this.stopped&&this.entries.has(id)){this.entries.set(id,{...this.entries.get(id)!,error});this.publish();}}
  async retry(id:string){
    if(this.stopped||!this.entries.has(id))throw new Error('The view is not present in this window.');
    const record=await this.ports.inspect(id);if(this.stopped)return;this.scoped(record,id);
    if(record.closed){this.release(id);return;}
    this.connections.delete(id);this.entries.set(id,{...this.entries.get(id)!,connected:false,error:''});this.publish();await this.connect(id);
  }
  confirmedClosed(record:PluginViewRecord){
    if(this.stopped)return;this.scoped(record,record.view);
    if(!record.closed)throw new Error('The view has not been confirmed closed.');
    this.release(record.view);
  }
  private release(id:string){this.connections.delete(id);this.entries.delete(id);this.publish();}
  /** A small round-robin observation of hidden documents. Missing/failed reads
   * remain uncertain and cannot attest to closure or discard local drafts. */
  async inspectHidden(){
    if(this.stopped)return;
    const hidden=[...this.entries.values()].filter(entry=>!entry.visible);if(!hidden.length)return;
    const selected=Array.from({length:Math.min(4,hidden.length)},(_,n)=>hidden[(this.hiddenCursor+n)%hidden.length]);this.hiddenCursor=(this.hiddenCursor+selected.length)%hidden.length;
    await Promise.allSettled(selected.map(entry=>this.run(entry.id,async()=>{
      const record=await this.ports.inspect(entry.id);if(this.stopped)return;this.scoped(record,entry.id);if(record.closed)this.release(entry.id);
    },false)));
  }
  stop(){this.stopped=true;this.connections.clear();this.dispose();}
}
