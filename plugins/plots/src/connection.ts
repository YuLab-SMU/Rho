import type {InstanceRef,JsonValue} from '../public/plugin-protocol/index.js';
import type {PluginViewClient} from '../public/plugin-ui/index.js';
import {Model} from './shared/model.js';
import {Plots} from './plots.js';
import {PlotHistory} from './history.js';
import {matches,type PlotSelection} from './outputs.js';
import {mediaKey} from './output-ports.js';
type Client=Pick<PluginViewClient,'view'|'query'|'setState'>;
interface Snapshot{notice:string;saveError:string;}
/** Retained output choices belong to this exact view; no query starts R, reads
 * mutable session memory, or re-executes the producing code. */
export class PlotsConnection extends Model<Snapshot>{
  readonly history:PlotHistory;
  readonly plots:Plots;
  readonly source:InstanceRef;
  private selection:PlotSelection|null;
  private notice='';private saveError='';private saved='';
  private stopped=false;private paused=false;
  private saveQueue:Promise<void>=Promise.resolve();
  private saveTimer:ReturnType<typeof setTimeout>|undefined;
  private subscriptions:(()=>void)[]=[];
  private actions:JsonValue=null;
  private useConfiguredSelection=false;
  constructor(private client:Client,source:InstanceRef,private configured:PlotSelection|null=null,readonly pinned=false){
    super();this.source=Object.freeze(structuredClone(source));
    this.history=new PlotHistory(client,this.source);
    this.plots=new Plots({outputs:this.history,changed:()=>this.changed()});
    const saved=client.view.state as {plots?:unknown;selection?:PlotSelection|null;actions?:JsonValue}|null;
    this.plots.restore(saved?.plots);
    this.selection=structuredClone(saved?.selection??configured??null);this.actions=structuredClone(saved?.actions??null);
    this.useConfiguredSelection=!saved?.plots&&configured!==null;
    if(pinned&&!this.selection)throw new Error('Select an original plot for this pinned view.');
    this.history.selected(this.selection);this.saved=JSON.stringify(this.state());
    this.subscriptions.push(this.plots.subscribe(()=>this.changed()));
  }
  protected readSnapshot():Snapshot{return{notice:this.notice,saveError:this.saveError};}
  get actionState(){return structuredClone(this.actions);}
  async saveActions(value:JsonValue){this.actions=structuredClone(value);await this.flush();}
  private state(){
    const selected=this.plots.view('plots').selected;
    const plot=this.history.getSnapshot().plots.find(plot=>mediaKey(plot.native)===selected);
    if(plot)this.selection={operation_id:plot.operation,resource_id:plot.reference.resource};
    this.history.selected(this.selection);
    return{plots:this.plots.serialize(),selection:structuredClone(this.selection),actions:this.actions};
  }
  private changed(){
    if(this.stopped||this.paused)return;
    // Update the retention anchor before the next history page is incorporated.
    this.state();clearTimeout(this.saveTimer);
    this.saveTimer=setTimeout(()=>{this.saveTimer=undefined;void this.flush().catch(()=>undefined);},250);
  }
  async initialize(){
    try{
      if(this.selection){
        await this.history.restore(this.selection);if(this.stopped||this.paused)return;
        const plot=this.history.getSnapshot().plots.find(plot=>matches(plot,this.selection!));
        if(plot){if(this.pinned)this.plots.pin(plot.native);else if(this.useConfiguredSelection)this.plots.restoreSelection(plot.native);}
      }
      await this.refresh();
    }catch(error){if(!this.stopped){this.notice=String(error);this.publish();}throw error;}
  }
  async refresh(explicit=false){
    if(this.stopped||this.paused||!explicit&&this.history.getSnapshot().historyError)return;
    try{await this.history.refresh();if(!this.stopped&&!this.paused){this.notice='';this.publish();}}
    catch(error){if(!this.stopped&&!this.paused){this.notice=String(error);this.publish();}throw error;}
  }
  flush():Promise<void>{
    clearTimeout(this.saveTimer);this.saveTimer=undefined;
    const task=this.saveQueue.then(async()=>{
      if(this.stopped)throw new Error('The Plots view connection is closed.');
      const state=this.state(),encoded=JSON.stringify(state);if(encoded===this.saved)return;
      try{await this.client.setState(JSON.parse(encoded) as JsonValue);this.saved=encoded;this.saveError='';}
      catch(error){this.saveError=`Plot choices were not saved: ${String(error)}`;throw error;}
      finally{if(!this.stopped)this.publish();}
    });this.saveQueue=task.catch(()=>undefined);return task;
  }
  pause(){this.paused=true;this.history.pause();clearTimeout(this.saveTimer);this.saveTimer=undefined;}
  resume(){if(this.stopped)return;this.paused=false;this.history.resume();this.changed();}
  stop(){this.stopped=true;clearTimeout(this.saveTimer);this.subscriptions.forEach(unsubscribe=>unsubscribe());this.history.stop();this.plots.stop();this.dispose();}
}
