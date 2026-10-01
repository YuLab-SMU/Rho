import type {ResourceReference} from '../public/plugin-protocol/index.js';
import type {MediaReference} from '../public/r-protocol/index.js';
import {Model} from './shared/model.js';
import type {SavedPlot} from './outputs.js';
interface ExportPort {downloadResource(reference:ResourceReference,filename:string):Promise<void>;}
/** Export is an explicit presentation request for the observed original. It
 * neither renders a new image nor submits, repeats or cancels scientific work. */
export class PlotsExport extends Model<{busy:boolean;notice:string;error:string}> {
  private task:Promise<void>|null=null;
  private notice='';private error='';private stopped=false;
  constructor(private port:ExportPort,private find:(reference:MediaReference)=>SavedPlot|undefined){super();}
  protected readSnapshot(){return{busy:this.task!==null,notice:this.notice,error:this.error};}
  original(selected:MediaReference):Promise<void>{
    if(this.stopped)return Promise.reject(new Error('The Plots view is closed.'));
    if(this.task)return Promise.reject(new Error('Wait for the current original download.'));
    this.notice='';this.error='';
    const plot=this.find(selected),extension=plot?({'image/png':'png','image/jpeg':'jpg','image/svg+xml':'svg'} as Record<string,string>)[plot.reference.media_type]:null;
    if(!plot||!extension){this.error='Choose an observed original plot to export.';this.publish();return Promise.reject(new Error(this.error));}
    const reference=structuredClone(plot.reference),filename=`plot-${plot.native.sequence}.${extension}`;
    // Call synchronously within the actual button handler. Deferring this first
    // SDK request to an unrelated effect would lose its user-action provenance.
    const task=this.port.downloadResource(reference,filename).then(()=>{
      if(!this.stopped)this.notice='Original download requested.';
    }).catch(error=>{if(!this.stopped)this.error=error instanceof Error?error.message:String(error);throw error;})
      .finally(()=>{this.task=null;if(!this.stopped)this.publish();});
    this.task=task;this.publish();return task;
  }
  stop(){this.stopped=true;this.dispose();}
}
