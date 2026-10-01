import {expect,it,vi} from 'vitest';
import {MediaCache} from '../src/media-cache.js';
import type {SavedPlot} from '../src/outputs.js';
import {mediaKey} from '../src/output-ports.js';
const owner={instance:'r',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
async function plot(id:string,values=[1,2,3]):Promise<SavedPlot>{
 const bytes=new Uint8Array(values),digest='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 return {operation:id,status:'succeeded',session:'native',accepted:1,inputSource:null,native:{operation_id:id,sequence:1,mime_type:'image/png',byte_size:bytes.length,sha256:digest,display_id:null},reference:{owner,resource:id,digest,bytes:bytes.length,media_type:'image/png'}};
}
const reader={query:async<T>(_cap:any,args:any)=>({data:{reference:args.reference,offset:0,base64:btoa(String.fromCharCode(1,2,3)),next:null}} as T)};
it('retains only verified immutable originals and releases URLs with the view',async()=>{
 const first=await plot('first'),create=vi.fn(()=> 'blob:first'),revoke=vi.fn(),cache=new MediaCache(reader,{create,revoke});
 cache.load(first);await cache.settled();expect(create).toHaveBeenCalledOnce();expect(cache.getSnapshot().urls.get(mediaKey(first.native))).toBe('blob:first');
 cache.load(first);await cache.settled();expect(create).toHaveBeenCalledOnce();cache.stop();expect(revoke).toHaveBeenCalledWith('blob:first');
});
it('rejects changed bytes before creating an image URL and requires explicit retry',async()=>{
 const first=await plot('first',[4,5,6]),create=vi.fn(),cache=new MediaCache(reader,{create,revoke:vi.fn()});
 cache.load(first);await cache.settled();expect(create).not.toHaveBeenCalled();expect(cache.getSnapshot().errors.get(mediaKey(first.native))).toContain('integrity');
 cache.load(first);expect(cache.getSnapshot().loading.size).toBe(0);cache.stop();
});
it('keeps selected originals during LRU eviction and bounds unprotected bytes',async()=>{
 const first=await plot('first'),second=await plot('second'),third=await plot('third'),revoke=vi.fn();let sequence=0;
 const cache=new MediaCache(reader,{create:()=>`blob:${++sequence}`,revoke},6);cache.protect(new Set([mediaKey(first.native)]));
 for(const plot of [first,second,third]){cache.load(plot);await cache.settled();}
 expect(cache.getSnapshot().byteSize).toBe(6);expect(cache.getSnapshot().urls.has(mediaKey(first.native))).toBe(true);expect(cache.getSnapshot().urls.has(mediaKey(second.native))).toBe(false);
 expect(revoke).toHaveBeenCalledWith('blob:2');cache.stop();
});
it('ignores a late read after disposal without cancelling its producing Operation',async()=>{
 let finish!:(value:any)=>void;const calls:any[]=[],create=vi.fn(),first=await plot('first');
 const cache=new MediaCache({query:async<T>(cap:any,args:any)=>{calls.push(cap.id);return await new Promise<T>(resolve=>{finish=resolve;});}},{create,revoke:vi.fn()});
 cache.load(first);await Promise.resolve();cache.stop();finish({data:{reference:first.reference,offset:0,base64:'AQID',next:null}});await cache.settled();
 expect(create).not.toHaveBeenCalled();expect(calls).toEqual(['resources.read']);
});
