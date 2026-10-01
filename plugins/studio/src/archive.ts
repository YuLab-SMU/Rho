/** Package transfer changes neither the editor nor an applied scenario. Original
 * mutation identities live in the same synchronized document as source edits. */
import type {PluginInspection} from '../public/plugin-protocol/index.js';
import {ViewRequestError} from '../public/plugin-ui/index.js';
import {ArchiveUpload,validateArchiveUpload,verifyArchiveImport,type ArchiveUploadState} from './archive-upload.js';
import {ArchiveExport,validateArchiveExport,type ArchiveExportState} from './archive-export.js';
import {type Client,type Intent,type RecordReply,json,same,terminal,verifyOriginal,inspectOriginal} from './operations.js';
export interface ArchiveState {upload:ArchiveUploadState|null;exported:ArchiveExportState|null;pending:Intent|null;}
const empty=():ArchiveState=>({upload:null,exported:null,pending:null});
export class Archives {
 data=empty();
 readonly upload:ArchiveUpload;
 readonly exported:ArchiveExport;
 constructor(private readonly client:Client,private readonly persist:()=>Promise<unknown>,private readonly guard:()=>void){
  this.upload=new ArchiveUpload(client,()=>this.data.upload,value=>this.data.upload=value,persist,()=>this.available());
  this.exported=new ArchiveExport(client,()=>this.data.exported,value=>this.data.exported=value,persist,()=>this.available(),args=>this.begin('plugins.archive_export',args));
 }
 restore(value:ArchiveState){
  if(!value||!['upload','exported','pending'].every(key=>Object.hasOwn(value,key)))throw Error('The retained archive state is incomplete.');
  validateArchiveUpload(value.upload);validateArchiveExport(value.exported);
  const previous=this.data;this.data=structuredClone(value);
  try{this.validateIntent();}catch(error){this.data=previous;throw error;}
 }
 private available(){this.guard();if(this.data.pending)throw Error('Inspect the original archive request before another action.');}
 private validateIntent(){
  const intent=this.data.pending;if(!intent)return;
  if(typeof intent.view!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(intent.view)||typeof intent.request!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(intent.request)||
   intent.operation!==null&&(typeof intent.operation!=='string'||!/^[A-Za-z0-9._:/-]{1,160}$/.test(intent.operation))||intent.capability?.version!==1)
   throw Error('The retained archive request has an invalid identity.');
  if(intent.capability.id==='plugins.archive_import'){
   const upload=this.data.upload;
   if(!upload?.inspection||!same(intent.arguments,{reference:upload.reference}))throw Error('The retained import differs from the inspected archive.');
  }else if(intent.capability.id==='plugins.archive_export'){
   const exported=this.data.exported;
   if(!exported||!same(intent.arguments,{revision:exported.revision,artifacts:exported.selected}))throw Error('The retained export differs from its source and artifacts.');
  }else throw Error('The retained request is not an archive operation.');
 }
 async configureExport(revision:string){
  this.available();
  const reply=await this.client.query<{status:string;data?:PluginInspection}>({id:'plugins.inspect',version:1},{revision});
  if(reply.status!=='ready'||reply.data?.summary.revision!==revision)throw Error('The exact source revision is unavailable.');
  await this.exported.configure(reply.data);
 }
 async import(){
  this.available();const upload=this.data.upload;
  if(!upload?.inspection||upload.imported)throw Error('Upload and inspect the retained file before importing its revision.');
  await this.begin('plugins.archive_import',{reference:upload.reference});
 }
 async inspectImport(){
  const upload=this.data.upload;
  if(!upload?.imported||!upload.original)throw Error('No successful import is retained.');
  const record=await inspectOriginal(this.client,upload.original);
  if(record.status!=='succeeded'||!same(verifyArchiveImport(record.output,upload),upload.imported))throw Error('The original import result is unconfirmed.');
  return record;
 }
 private async begin(id:string,args:unknown){
  this.available();this.data.pending={view:this.client.view.view,request:crypto.randomUUID(),capability:{id,version:1},arguments:json(structuredClone(args)),operation:null};
  await this.persist();await this.dispatch(true);
 }
 async dispatch(first=false){
  this.validateIntent();const intent=this.data.pending;
  if(!intent||intent.view!==this.client.view.view)throw Error('Only the original view can retry this archive request. Inspect its original Operation.');
  await this.persist();let reply:unknown;
  try{reply=await this.client.invoke(intent.capability,intent.arguments,{requestId:intent.request});}
  catch(error){
   const code=error instanceof ViewRequestError?(error.diagnostic as any)?.code:null;
   if(first&&['invalid_input','content_changed','not_found','access_denied'].includes(code)){
    this.data.pending=null;try{await this.persist();}catch(saveError){this.data.pending=intent;throw saveError;}
   }
   throw error;
  }
  await this.finish(await verifyOriginal(reply,intent));
 }
 async recover(){this.validateIntent();if(!this.data.pending)throw Error('No archive request is pending.');await this.finish(await inspectOriginal(this.client,this.data.pending));}
 private async finish(record:RecordReply){
  const intent=this.data.pending!;intent.operation=record.operation.operation_id;await this.persist();
  const deadline=Date.now()+2000;
  while(!terminal(record.status)&&Date.now()<deadline){await new Promise(done=>setTimeout(done,100));record=await inspectOriginal(this.client,intent);}
  if(!terminal(record.status))return;
  if(record.status==='uncertain')throw Error(record.error||'The original archive outcome is uncertain. Its request and bytes remain retained.');
  if(record.status==='succeeded'){
   if(intent.capability.id==='plugins.archive_import'){
    const upload=this.data.upload!;upload.imported=verifyArchiveImport(record.output,upload);upload.original=structuredClone(intent);
   }else this.exported.accept(record,intent);
  }
  this.data.pending=null;try{await this.persist();}catch(error){this.data.pending=intent;throw error;}
  if(record.status!=='succeeded')throw Error(record.error||`Original archive request ${record.status}.`);
 }
 dispose(){this.upload.dispose();}
}
