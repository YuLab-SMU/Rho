import type { ResourceReference } from '../../sdk/plugin-protocol/index.js';

export const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
export function downloadFilename(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value === '.' || value === '..' ||
      /[\u0000-\u001f\u007f/\\:]/u.test(value) || new TextEncoder().encode(value).length > 240)
    throw new Error('Choose a filename without a directory path or control characters.');
  return value;
}
function validReference(value: ResourceReference) {
  const owner=value?.owner, id=/^[A-Za-z0-9._:/-]{1,160}$/, digest=/^sha256:[a-f0-9]{64}$/;
  return !!owner && [owner.instance,owner.plugin,value.resource].every(v=>typeof v==='string'&&id.test(v)) &&
    [owner.revision,owner.artifact,value.digest].every(v=>typeof v==='string'&&digest.test(v)) &&
    typeof value.media_type==='string'&&value.media_type.length>0&&value.media_type.length<=128&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=MAX_DOWNLOAD_BYTES;
}
function sameReference(a: ResourceReference,b: ResourceReference) {
  return a.resource===b.resource&&a.digest===b.digest&&a.bytes===b.bytes&&a.media_type===b.media_type&&a.owner.instance===b.owner.instance&&
    a.owner.plugin===b.owner.plugin&&a.owner.revision===b.owner.revision&&a.owner.artifact===b.owner.artifact;
}
export type DownloadRead = (reference:ResourceReference,offset:number,limit:number)=>Promise<unknown>;
/** Independent browser-boundary verification after view-scoped Host admission.
 * No bytes, suggested name or completion state are journaled as science. */
export async function collectDownload(read:DownloadRead,reference:ResourceReference,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>>{
  if(!validReference(reference))throw new Error('The original resource exceeds the download limit or has an invalid identity.');
  const ref=structuredClone(reference),bytes=new Uint8Array(ref.bytes),limit=256*1024;let offset=0;
  const current=()=>{if(signal.aborted)throw new DOMException('Resource download stopped','AbortError');};
  do{
    current();const response=await read(ref,offset,limit) as {status?:string;data?:{reference:ResourceReference;offset:number;base64:string;next:number|null}};
    current();const part=response?.status==='ready'?response.data:undefined;
    if(!part||!validReference(part.reference)||!sameReference(ref,part.reference)||part.offset!==offset||typeof part.base64!=='string'||part.base64.length>Math.ceil(limit/3)*4)
      throw new Error('The original download resource or byte range changed.');
    let decoded:string;try{decoded=atob(part.base64);}catch{throw new Error('Download byte encoding is invalid.');}
    const end=Math.min(offset+limit,ref.bytes);
    if(decoded.length!==end-offset||part.next!==(end===ref.bytes?null:end))throw new Error('The original download is incomplete.');
    for(let i=0;i<decoded.length;i++)bytes[offset+i]=decoded.charCodeAt(i);offset=end;
  }while(offset<ref.bytes);
  const digest='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  current();if(digest!==ref.digest)throw new Error('The original download failed its checksum.');return bytes;
}
/** This signals a browser request, never a saved file. Browser settings, user
 * cancellation and disk failures are outside the page's acknowledgement. */
export function requestBrowserDownload(bytes:Uint8Array<ArrayBuffer>,filename:string){
  const name=downloadFilename(filename),link=document.createElement('a');
  // Use a download-only media type rather than a document supplied by a plugin.
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
  try{link.href=url;link.download=name;link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';link.target='_blank';link.hidden=true;document.body.append(link);link.click();}
  finally{link.remove();URL.revokeObjectURL(url);}
  return {download_requested:true};
}
export class PluginDownloads {
  private active:AbortController|null=null;
  private stopped=false;
  constructor(private read:DownloadRead,private request=requestBrowserDownload){}
  async start(reference:ResourceReference,filename:string){
    if(this.stopped)throw new Error('The view download connection is closed.');
    if(this.active)throw new Error('Wait for the current original download.');
    const name=downloadFilename(filename),abort=new AbortController();this.active=abort;
    try{const bytes=await collectDownload(this.read,reference,abort.signal);if(this.stopped||abort.signal.aborted)throw new Error('The view closed before download was requested.');return this.request(bytes,name);}
    finally{if(this.active===abort)this.active=null;}
  }
  dispose(){this.stopped=true;this.active?.abort();}
}
