import {expect,it,vi} from 'vitest';
import {collectDownload,downloadFilename,PluginDownloads} from '../src/plugin-download';
import type {ResourceReference} from '../../sdk/plugin-protocol/index.js';
const owner={instance:'one',plugin:'plugin',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
async function reference(bytes:Uint8Array<ArrayBuffer>):Promise<ResourceReference>{return{owner,resource:'original',bytes:bytes.length,media_type:'image/png',digest:'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')};}
const response=(ref:ResourceReference,bytes:Uint8Array)=>({status:'ready',data:{reference:ref,offset:0,base64:btoa(String.fromCharCode(...bytes)),next:null}});
it('allows a bounded Unicode filename and refuses paths, controls and empty names',()=>{
 expect(downloadFilename('原图 α.png')).toBe('原图 α.png');for(const name of ['',' ','../plot','/plot','x\\y','a:b','a\nb',' plot.png','x'.repeat(241),'..'])expect(()=>downloadFilename(name)).toThrow();
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
