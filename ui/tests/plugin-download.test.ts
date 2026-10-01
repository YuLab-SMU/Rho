import {expect,it,vi} from 'vitest';
import {collectDownload,downloadFilename,PluginDownloads} from '../src/plugin-download';
import type {ResourceReference,PluginArchiveReference} from '../../sdk/plugin-protocol/index.js';
import type {ArchiveReader} from '../../sdk/plugin-ui/archives.js';
const owner={instance:'one',plugin:'plugin',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
async function reference(bytes:Uint8Array<ArrayBuffer>):Promise<ResourceReference>{return{owner,resource:'original',bytes:bytes.length,media_type:'image/png',digest:'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')};}
const response=(ref:ResourceReference,bytes:Uint8Array)=>({status:'ready',data:{reference:ref,offset:0,base64:btoa(String.fromCharCode(...bytes)),next:null}});
it('allows a bounded Unicode filename and refuses paths, controls and empty names',()=>{
 expect(downloadFilename('原图 α.png')).toBe('原图 α.png');for(const name of ['',' ','../plot','/plot','x\\y','a:b','a\nb','a\u0085b',' plot.png','x'.repeat(241),'..'])expect(()=>downloadFilename(name)).toThrow();
});
it('requests a download only after the complete original passes its digest',async()=>{
 const bytes=new Uint8Array([1,2,3]),ref=await reference(bytes),read=vi.fn(async()=>response(ref,bytes)),request=vi.fn(()=>({download_requested:true})),downloads=new PluginDownloads(read,request);
 expect(await downloads.start(ref,'原图.png')).toEqual({download_requested:true});expect(request).toHaveBeenCalledWith(bytes,'原图.png');expect(read).toHaveBeenCalledWith(ref,0,256*1024);downloads.dispose();
});
it('refuses incomplete, foreign or corrupted original bytes before initiating a browser request',async()=>{
 const bytes=new Uint8Array([1,2,3]),ref=await reference(bytes);
 for(const bad of [{...response(ref,bytes),status:'busy'},response(ref,new Uint8Array([1])),response({...ref,resource:'other'},bytes),response(ref,new Uint8Array([4,5,6]))]){
  const request=vi.fn(),downloads=new PluginDownloads(async()=>bad,request);await expect(downloads.start(ref,'plot.png')).rejects.toThrow();expect(request).not.toHaveBeenCalled();downloads.dispose();
 }
});
it('bounds allocation, still authorizes an empty original and preserves ordered continuations',async()=>{
 const empty=new Uint8Array(),ref=await reference(empty),read=vi.fn(async()=>response(ref,empty));expect(await collectDownload(read,ref,new AbortController().signal)).toEqual(empty);expect(read).toHaveBeenCalledOnce();
 await expect(collectDownload(read,{...ref,bytes:17*1024*1024},new AbortController().signal)).rejects.toThrow('limit');expect(read).toHaveBeenCalledOnce();
 const bytes=new Uint8Array(256*1024+2),large=await reference(bytes),offsets:number[]=[];
 const result=await collectDownload(async(ref,offset,limit)=>{offsets.push(offset);const end=Math.min(offset+limit,bytes.length);return{status:'ready',data:{reference:ref,offset,base64:btoa('A'.repeat(end-offset).replaceAll('A','\0')),next:end===bytes.length?null:end}};},large,new AbortController().signal);
 expect(result).toEqual(bytes);expect(offsets).toEqual([0,256*1024]);
});
it('rejects overlapping requests and stops an unsubmitted download when its view closes',async()=>{
 const bytes=new Uint8Array([1]),ref=await reference(bytes);let finish!:(value:any)=>void;
 const request=vi.fn(),downloads=new PluginDownloads(()=>new Promise(resolve=>finish=resolve),request),first=downloads.start(ref,'one.png');
 await expect(downloads.start(ref,'two.png')).rejects.toThrow('current');downloads.dispose();finish(response(ref,bytes));await expect(first).rejects.toThrow('stopped');expect(request).not.toHaveBeenCalled();
 await expect(downloads.start(ref,'three.png')).rejects.toThrow('closed');
});
it('rechecks original authority after collection and never treats denied or late authorization as a browser request',async()=>{
 const bytes=new Uint8Array([8]),ref=await reference(bytes),request=vi.fn(()=>({download_requested:true}));
 const denied=vi.fn(async()=>{throw new Error('View closure is preparing');}),one=new PluginDownloads(async()=>response(ref,bytes),request,denied);
 await expect(one.start(ref,'original.png')).rejects.toThrow('closure is preparing');expect(denied).toHaveBeenCalledWith(ref,'original.png');expect(request).not.toHaveBeenCalled();one.dispose();
 let finish!:()=>void;const authorize=vi.fn(()=>new Promise<void>(resolve=>finish=resolve)),two=new PluginDownloads(async()=>response(ref,bytes),request,authorize);
 const pending=two.start(ref,'original.png');await vi.waitFor(()=>expect(authorize).toHaveBeenCalledOnce());two.dispose();finish();
 await expect(pending).rejects.toThrow('closed before download');expect(request).not.toHaveBeenCalled();
});
const archiveReader=(ref:PluginArchiveReference,bytes:Uint8Array):ArchiveReader=>({query:async<T>(_cap,args)=>{
 const {offset,limit}=args as {offset:number;limit:number},end=Math.min(offset+limit,bytes.length);
 let text='';for(let start=offset;start<end;start+=8192)text+=String.fromCharCode(...bytes.subarray(start,Math.min(start+8192,end)));
 return {status:'ready',data:{reference:ref,offset,base64:btoa(text),next:end===bytes.length?null:end}} as T;
}});
it('uses the archive bound, exact checksums and original authorization before a package download',async()=>{
 const bytes=new Uint8Array(17*1024*1024),resource=await reference(bytes),ref={archive:'export',digest:resource.digest,bytes:bytes.length};
 const request=vi.fn((_bytes:Uint8Array,_filename:string)=>({download_requested:true})),authorize=vi.fn(async()=>{}),read=archiveReader(ref,bytes);
 const downloads=new PluginDownloads(vi.fn(),request,undefined,{reader:read,authorize});
 expect(await downloads.startArchive(ref,'源码.rho-plugin')).toEqual({download_requested:true});
 expect(request).toHaveBeenCalledOnce();const [captured,filename]=request.mock.calls[0]!;
 // Avoid expanding 17 million typed-array entries through the assertion
 // formatter; still verify every byte handed to the browser boundary.
 expect(captured.byteLength).toBe(bytes.byteLength);expect(captured.every(value=>value===0)).toBe(true);expect(filename).toBe('源码.rho-plugin');
 expect(authorize).toHaveBeenCalledWith(ref,'源码.rho-plugin');downloads.dispose();
});
it('shares one pending download across archives and resources and cancels it on disposal',async()=>{
 const bytes=new Uint8Array([1]),resource=await reference(bytes),ref={archive:'export',digest:resource.digest,bytes:1};let finish!:(value:any)=>void;
 const request=vi.fn(),authorize=vi.fn(async()=>{}),downloads=new PluginDownloads(vi.fn(),request,undefined,{reader:{query:()=>new Promise(resolve=>finish=resolve)},authorize});
 const pending=downloads.startArchive(ref,'source.rho-plugin');
 await expect(downloads.start(resource,'report.png')).rejects.toThrow('current');
 await expect(downloads.startArchive(ref,'again.rho-plugin')).rejects.toThrow('current');
 downloads.dispose();finish(response(ref as any,bytes));await expect(pending).rejects.toThrow('stopped');
 expect(authorize).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
});
it('never requests a package download after corrupt bytes, revoked authority or its transfer deadline',async()=>{
 const bytes=new Uint8Array([9]),resource=await reference(bytes),ref={archive:'export',digest:resource.digest,bytes:1};
 for(const corrupt of [true,false]){
  const request=vi.fn(),authorize=vi.fn(async()=>{throw Error('Read authority revoked');}),downloads=new PluginDownloads(vi.fn(),request,undefined,{reader:archiveReader(ref,corrupt?new Uint8Array([8]):bytes),authorize});
  await expect(downloads.startArchive(ref,'source.rho-plugin')).rejects.toThrow(corrupt?'integrity':'revoked');expect(request).not.toHaveBeenCalled();downloads.dispose();
 }
 vi.useFakeTimers();
 try{
  let finish!:(value:any)=>void;const request=vi.fn(),downloads=new PluginDownloads(vi.fn(),request,undefined,{reader:{query:()=>new Promise(resolve=>finish=resolve)},authorize:async()=>{}});
  const pending=downloads.startArchive(ref,'source.rho-plugin');const stopped=expect(pending).rejects.toThrow('stopped');
  await vi.advanceTimersByTimeAsync(540000);finish(response(ref as any,bytes));await stopped;expect(request).not.toHaveBeenCalled();downloads.dispose();
 }finally{vi.useRealTimers();}
});
