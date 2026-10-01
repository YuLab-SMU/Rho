import { readResource, type ResourceReader } from "../public/plugin-ui/index.js";
import { Model, readonlyMap, readonlySet } from "./shared/model.js";
import type { SavedPlot } from "./outputs.js";
import { mediaKey } from "./output-ports.js";
interface MediaSnapshot { urls: ReadonlyMap<string,string>; errors: ReadonlyMap<string,string>; loading: ReadonlySet<string>; byteSize: number; }
interface Adapter { create(bytes: Uint8Array<ArrayBuffer>, mime: string): string; revoke(url: string): void; }
/** One bounded verified original at a time. Reads have no execution/cancel route.
 * Browser object URLs are view-local and never stored in presentation state. */
export class MediaCache extends Model<MediaSnapshot> {
  private entries=new Map<string,{plot:SavedPlot;url:string;bytes:number;used:number}>();
  private queued=new Map<string,SavedPlot>();
  private errors=new Map<string,string>();
  private protected=new Set<string>();
  private clock=0;
  private active:{key:string;abort:AbortController;task:Promise<void>}|null=null;
  private stopped=false;
  constructor(private reader: ResourceReader, private adapter: Adapter, private budget=64*1024*1024) {super();}
  protected readSnapshot():MediaSnapshot {
    return {urls:readonlyMap(new Map([...this.entries].map(([key,entry])=>[key,entry.url]))),errors:readonlyMap(this.errors),
      loading:readonlySet(new Set([...this.queued.keys(),...(this.active?[this.active.key]:[])])),byteSize:[...this.entries.values()].reduce((n,e)=>n+e.bytes,0)};
  }
  load(plot:SavedPlot, priority=false) {
    if(this.stopped)return;
    const key=mediaKey(plot.native),entry=this.entries.get(key);
    if(entry){entry.used=++this.clock;return;}
    if(this.active?.key===key||this.errors.has(key))return;
    if(plot.reference.bytes>16*1024*1024||!['image/png','image/jpeg','image/svg+xml'].includes(plot.reference.media_type)) {
      this.errors.set(key,'Unsupported or oversized original plot.');this.publish();return;
    }
    if(!this.queued.has(key)&&this.queued.size>=200){this.errors.set(key,'Too many pending plot reads. Retry after the current reads finish.');this.publish();return;}
    this.queued.set(key,structuredClone(plot));
    if(priority)this.queued=new Map([[key,this.queued.get(key)!],...[...this.queued].filter(([id])=>id!==key)]);
    this.publish();this.start();
  }
  retry(plot:SavedPlot){this.errors.delete(mediaKey(plot.native));this.load(plot,true);this.publish();}
  reportDecodeError(plot:SavedPlot,url:string){const key=mediaKey(plot.native);if(this.entries.get(key)?.url===url){this.errors.set(key,'The browser could not decode this original plot.');this.publish();}}
  protect(keys:ReadonlySet<string>){this.protected=new Set(keys);this.evict();this.publish();}
  private evict(keep?:string){
    let bytes=[...this.entries.values()].reduce((n,e)=>n+e.bytes,0);
    for(const [key,entry] of [...this.entries].sort(([,a],[,b])=>a.used-b.used)){
      if(bytes<=this.budget)break;if(key===keep||this.protected.has(key))continue;
      this.adapter.revoke(entry.url);this.entries.delete(key);this.errors.delete(key);bytes-=entry.bytes;
    }
  }
  private start(){
    if(this.stopped||this.active||!this.queued.size)return;
    const [key,plot]=this.queued.entries().next().value!;this.queued.delete(key);
    const abort=new AbortController();
    const task=Promise.resolve().then(async()=>{
      try{
        const bytes=await readResource(this.reader,plot.reference,{signal:abort.signal});
        if(this.stopped||abort.signal.aborted)return;
        const url=this.adapter.create(bytes,plot.reference.media_type);
        this.entries.set(key,{plot,url,bytes:bytes.length,used:++this.clock});this.errors.delete(key);this.evict(key);
      }catch(error){if(!this.stopped&&!abort.signal.aborted)this.errors.set(key,error instanceof Error?error.message:String(error));}
      finally{if(this.active?.abort===abort)this.active=null;if(!this.stopped){this.publish();this.start();}}
    });
    this.active={key,abort,task};this.publish();
  }
  async settled(){while(this.active)await this.active.task;}
  stop(){
    this.stopped=true;this.active?.abort.abort();this.queued.clear();
    for(const entry of this.entries.values())this.adapter.revoke(entry.url);
    this.entries.clear();this.errors.clear();this.protected.clear();this.dispose();
  }
}
