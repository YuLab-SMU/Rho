/** Preparing immutable bytes and asking the browser to download are separate
 * explicit actions. Original Operation recovery never triggers the browser. */
import type {PluginArchiveReceipt,PluginInspection} from '../public/plugin-protocol/index.js';
import {downloadFilename,isPluginArchiveReference,samePluginArchive} from '../public/plugin-ui/index.js';
import {type Client,type Intent,type RecordReply,json,same,inspectOriginal} from './operations.js';
export interface ArchiveExportState {
 revision:string;plugin:string;name:string;artifacts:{id:string;target:string}[];selected:string[];filename:string;
 receipt:PluginArchiveReceipt|null;original:Intent|null;
}
const digest=(value:unknown)=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
const input=(state:ArchiveExportState)=>({revision:state.revision,artifacts:state.selected});
function verifyReceipt(value:unknown,state:ArchiveExportState):PluginArchiveReceipt{
 const receipt=value as PluginArchiveReceipt;
 if(!receipt||!isPluginArchiveReference(receipt.reference)||receipt.revision!==state.revision||receipt.plugin!==state.plugin||!same(receipt.artifacts,state.selected))
  throw Error('Export returned another revision or artifact selection. Retain its original request.');
 return structuredClone(receipt);
}
function validate(state:ArchiveExportState|null){
 if(state===null)return;
 if(!digest(state.revision)||typeof state.plugin!=='string'||typeof state.name!=='string'||typeof state.filename!=='string'||state.filename.length>1024||
  !Array.isArray(state.artifacts)||state.artifacts.length>32||state.artifacts.some(a=>!a||!digest(a.id)||typeof a.target!=='string')||
  new Set(state.artifacts.map(a=>a.id)).size!==state.artifacts.length||!Array.isArray(state.selected)||state.selected.some((id,index)=>!state.artifacts.some(a=>a.id===id)||index>0&&state.selected[index-1]!>=id)||
  !Object.hasOwn(state,'receipt')||!Object.hasOwn(state,'original'))throw Error('The retained export has invalid metadata.');
 if(state.receipt){
  verifyReceipt(state.receipt,state);
  const original=state.original;
  if(!original||typeof original.view!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(original.view)||typeof original.request!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(original.request)||
   typeof original.operation!=='string'||!/^[A-Za-z0-9._:/-]{1,160}$/.test(original.operation)||!same(original.capability,{id:'plugins.archive_export',version:1})||!same(original.arguments,input(state)))
   throw Error('The retained export is missing its original request identity.');
 }else if(state.original!==null)throw Error('An export identity requires its verified receipt.');
}
export class ArchiveExport {
 constructor(private readonly client:Client,private readonly current:()=>ArchiveExportState|null,private readonly replace:(state:ArchiveExportState|null)=>void,
  private readonly persist:()=>Promise<unknown>,private readonly guard:()=>void,private readonly invoke:(args:unknown)=>Promise<unknown>){validate(current());}
 async configure(inspection:PluginInspection){
  this.guard();const old=this.current();
  if(old){if(old.revision!==inspection.summary.revision)throw Error('Discard the retained export before choosing another revision.');return;}
  const state:ArchiveExportState={revision:inspection.summary.revision,plugin:inspection.summary.plugin,name:inspection.summary.name,
   artifacts:inspection.artifacts.map(a=>({id:a.id,target:a.target})),selected:inspection.artifacts.map(a=>a.id).sort(),
   filename:`${inspection.summary.plugin}-${inspection.summary.revision.slice(7,19)}.rho-plugin`,receipt:null,original:null};
  validate(state);this.replace(state);await this.persist();
 }
 async select(ids:string[]){
  this.guard();const state=this.current();if(!state||state.receipt)throw Error('Choose an unprepared export first.');
  const previous=state.selected;state.selected=[...ids].sort();try{validate(state);}catch(error){state.selected=previous;throw error;}
  await this.persist();
 }
 async prepare(){
  this.guard();const state=this.current();if(!state||state.receipt)throw Error('Choose an unprepared revision before exporting.');
  validate(state);downloadFilename(state.filename);return this.invoke(input(state));
 }
 accept(record:RecordReply,intent:Intent){
  const state=this.current();
  if(!state||!same(intent.capability,{id:'plugins.archive_export',version:1})||!same(intent.arguments,input(state)))throw Error('The original export differs from its captured selection.');
  state.receipt=verifyReceipt(record.output,state);state.original=structuredClone(intent);
 }
 async inspect(){
  const state=this.current();if(!state?.receipt||!state.original)throw Error('No successful export is retained.');
  const record=await inspectOriginal(this.client,state.original);
  if(record.status!=='succeeded'||!same(verifyReceipt(record.output,state),state.receipt))throw Error('The original export result is unconfirmed.');return record;
 }
 async download(){
  this.guard();const state=this.current();if(!state?.receipt)throw Error('Prepare an export before downloading.');
  validate(state);
  // No asynchronous inspection or save before the gesture reaches the shell.
  // Native admission verifies current authority and the exact retained bytes.
  return this.client.downloadArchive(state.receipt.reference,downloadFilename(state.filename));
 }
 async discard(){
  this.guard();const state=this.current();if(!state)return;
  if(state.receipt){
   const reference=state.receipt.reference,result=await this.client.control<{reference:unknown;discarded:boolean}>({id:'plugins.archive_discard',version:1},json({reference}));
   if(!result||result.discarded!==true||!isPluginArchiveReference(result.reference)||!samePluginArchive(result.reference,reference))throw Error('Export cleanup is unconfirmed. The original reference was retained.');
  }
  this.replace(null);try{await this.persist();}catch(error){this.replace(state);throw error;}
 }
}
