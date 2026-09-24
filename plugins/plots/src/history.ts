import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {ResourceReader} from '../public/plugin-ui/index.js';
import type {MediaReference} from '../public/r-protocol/index.js';
import {Model,immutable} from './shared/model.js';
import {mediaKey} from './output-ports.js';
import {readHistory,readOperation,mergeHistory,matches,type SavedPlot,type PlotSelection} from './outputs.js';
interface Snapshot {
  plots:readonly SavedPlot[];media:readonly MediaReference[];historyLoading:boolean;historyError:string;
  scanning:boolean;hasEarlier:boolean;limited:boolean;
}
/** Bounded journal observations. Recent scans continue across unrelated view
 * captures and never restart at page one before reaching their original frontier. */
export class PlotHistory extends Model<Snapshot> {
  private plots:SavedPlot[]=[];
  private selection:PlotSelection|null=null;
  private cursor:number|null=null;
  private initialized=false;
  private head:{cursor:number|null;frontier:Set<string>;first:string[]}|null=null;
  private frontier=new Set<string>();
  private task:Promise<void>|null=null;
  private error='';
  private stopped=false;
  private paused=false;
  private generation=0;
  constructor(private reader:ResourceReader,private source:InstanceRef){super();this.source=Object.freeze(structuredClone(source));}
  protected readSnapshot():Snapshot{return{plots:immutable([...this.plots]),media:immutable(this.plots.map(plot=>plot.native)),historyLoading:this.task!==null,
    historyError:this.error,scanning:this.head!==null,hasEarlier:this.cursor!==null,limited:this.plots.length>=200};}
  selected(value:PlotSelection|null){this.selection=value?structuredClone(value):null;}
  find(reference:MediaReference){return this.plots.find(plot=>mediaKey(plot.native)===mediaKey(reference));}
  private run(work:()=>Promise<void>):Promise<void>{
    if(this.stopped)return Promise.reject(new Error('Plot history connection is closed.'));
    if(this.paused)return Promise.resolve();
    if(this.task)return this.task;this.error='';
    this.task=Promise.resolve().then(work).catch(error=>{if(!this.stopped)this.error=error instanceof Error?error.message:String(error);throw error;})
      .finally(()=>{this.task=null;if(!this.stopped)this.publish();});this.publish();return this.task;
  }
  restore(selection:PlotSelection|null){
    this.selected(selection);
    if(!selection)return Promise.resolve();
    return this.run(async()=>{
      const generation=this.generation;
      const plots=await readOperation(this.reader,this.source,selection.operation_id);if(this.stopped||this.paused||generation!==this.generation)return;
      if(!plots.some(plot=>matches(plot,selection)))throw new Error('The selected original plot is unavailable; its identity was preserved.');
      this.plots=mergeHistory(this.plots,plots,selection,false);
    });
  }
  refresh(){return this.run(async()=>{
    const generation=this.generation;
    this.head??={cursor:null,frontier:new Set(this.frontier),first:[]};
    // Four bounded pages per turn. The caller schedules continuation; no hidden
    // loop monopolizes the view or retries a failed read automatically.
    for(let page=0;page<4&&this.head&&!this.stopped;page++){
      const head=this.head, result=await readHistory(this.reader,this.source,head.cursor);if(this.stopped||this.paused||generation!==this.generation)return;
      if(head.first.length===0)head.first=result.operations.slice(0,25);
      this.plots=mergeHistory(this.plots,result.plots,this.selection,false);
      if(result.next===null||result.operations.some(id=>head.frontier.has(id))||!this.initialized&&result.plots.length>0){
        if(!this.initialized)this.cursor=result.next;
        this.initialized=true;this.frontier=new Set(head.first);this.head=null;
      }else head.cursor=result.next;
      this.publish();
    }
  });}
  loadEarlier(){
    if(this.head)return this.refresh();
    if(!this.initialized||this.cursor===null)return Promise.resolve();
    return this.run(async()=>{
      const generation=this.generation;
      const page=await readHistory(this.reader,this.source,this.cursor);if(this.stopped||this.paused||generation!==this.generation)return;
      this.plots=mergeHistory(this.plots,page.plots,this.selection,true);this.cursor=page.next;
    });
  }
  async settled(){if(this.task)await this.task;}
  pause(){this.paused=true;this.generation++;}
  resume(){this.paused=false;}
  stop(){this.stopped=true;this.dispose();}
}
