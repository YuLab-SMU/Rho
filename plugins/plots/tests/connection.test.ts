import {expect,it} from 'vitest';
import {PlotsConnection} from '../src/connection.js';
import type {PluginViewClient} from '../public/plugin-ui/index.js';
import type {JsonValue} from '../public/plugin-protocol/index.js';
const owner={instance:'r',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
function fixture(){
 const writes:JsonValue[]=[],calls:string[]=[];let save=(state:JsonValue)=>Promise.resolve();
 const client={view:{state:{},view:'view',project:'project'},query:async<T>(cap:any)=>{calls.push(cap.id);return {data:{operations:[],next_cursor:null}} as T;},setState:async(state:JsonValue)=>{writes.push(state);await save(state);return {} as any;}} as unknown as Pick<PluginViewClient,'view'|'query'|'setState'>;
 return {client,writes,calls,setSave:(next:typeof save)=>save=next,connection:new PlotsConnection(client,owner)};
}
it('observes retained history without starting R and captures a final immediate choice',async()=>{
 const f=fixture();await f.connection.initialize();f.connection.plots.toggleHistory('plots');f.connection.pause();await f.connection.flush();
 expect((f.writes.at(-1) as any).plots.plotViews.plots.history).toBe(false);expect(f.calls).toEqual(['operation.list_recent']);
 await f.connection.refresh();expect(f.calls).toHaveLength(1);f.connection.stop();
});
it('serializes capture against acknowledged state, including a revert while a save is in flight',async()=>{
 const f=fixture();let finish!:()=>void;f.setSave(()=>new Promise(resolve=>finish=resolve));
 f.connection.plots.toggleHistory('plots');const first=f.connection.flush();await Promise.resolve();f.connection.plots.toggleHistory('plots');
 const last=f.connection.flush();f.setSave(()=>Promise.resolve());finish();await first;await last;
 expect(f.writes.map(state=>(state as any).plots.plotViews.plots.history)).toEqual([false,true]);f.connection.stop();
});
it('keeps failed choices visible and retries their final state without scientific effects',async()=>{
 const f=fixture();f.setSave(async()=>{throw new Error('storage unavailable');});f.connection.plots.toggleHistory('plots');
 await expect(f.connection.flush()).rejects.toThrow('storage unavailable');expect(f.connection.getSnapshot().saveError).toContain('not saved');
 f.setSave(()=>Promise.resolve());await f.connection.flush();expect(f.connection.getSnapshot().saveError).toBe('');expect(f.calls).toEqual([]);f.connection.stop();
});
it('requires an original selected plot for pinned presentation',()=>{
 const f=fixture();expect(()=>new PlotsConnection(f.client,owner,null,true)).toThrow('original plot');f.connection.stop();
});
it('reopens the acknowledged pinned selection rather than replacing it with the initial configured plot',async()=>{
 const f=fixture(),native={operation_id:'chosen-later',sequence:1,mime_type:'image/png',byte_size:3,sha256:'sha256:'+'c'.repeat(64),display_id:null};
 (f.client.view as any).state={selection:{operation_id:'chosen-later',resource_id:'later-resource'},plots:{plotViews:{plots:{selected:'chosen-later:1:'+native.sha256,follow:false,pinned:true,history:false,seen:1,transforms:{}}}}};
 const observed:string[]=[];f.client.query=async<T>(cap:any,args:any)=>{
  if(cap.id==='operation.list_recent')return {data:{operations:[],next_cursor:null}} as T;
  observed.push(args.operation_id);return {data:{record:{operation:{operation_id:'chosen-later',accepted_at_ms:2,capability:{id:'r.execute',version:1},normalized_arguments:{binding:{provider:owner,target:'native'}}},status:'succeeded',output:{operation_id:'chosen-later',session_id:'native',outputs:[{native,reference:{owner,resource:'later-resource',bytes:3,media_type:'image/png',digest:native.sha256}}]}}}} as T;
 };
 const reopened=new PlotsConnection(f.client,owner,{operation_id:'initial',resource_id:'initial-resource'},true);await reopened.initialize();
 expect(observed).toEqual(['chosen-later']);expect(reopened.plots.view('plots')).toMatchObject({selected:'chosen-later:1:'+native.sha256,pinned:true,history:false});reopened.stop();f.connection.stop();
});
