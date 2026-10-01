/** Optional owner-authored artifact links in captured ContextPreview.data.
 * Labels and identities are evidence to inspect, never commands or URLs. */
import type {AgentContextSelection} from '../sdk/index.js';
import type {ResourceReference} from '../public/plugin-protocol/index.js';
import {isResourceReference,readResource} from '../public/plugin-ui/index.js';
import {type Client,same} from './operations.js';
export interface ContextArtifact {label:string;resource:ResourceReference;operation:string;}
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
export function contextArtifacts(selection:AgentContextSelection,data:unknown):ContextArtifact[]{
 const captured=object(data),ownerData=Array.isArray(captured?.agent_context_images)?object(captured?.contribution):captured;
 const artifacts=ownerData?.artifacts;if(artifacts===undefined)return [];
 const provider=object(selection.reference)?.provider;
 if(selection.source!=='plugin'||!provider||!Array.isArray(artifacts)||artifacts.length>8)throw Error('The saved artifact links are incomplete.');
 const seen=new Set<string>();
 for(const value of artifacts){
  const item=object(value);
  if(!item||typeof item.label!=='string'||!item.label.trim()||item.label.length>160||!isResourceReference(item.resource)||!same(item.resource.owner,provider)||
    typeof item.operation!=='string'||!/^[A-Za-z0-9._:/-]{1,160}$/.test(item.operation)||seen.has(item.resource.resource))throw Error('The saved artifact link differs from its source.');
  seen.add(item.resource.resource);
 }
 return structuredClone(artifacts) as ContextArtifact[];
}
export async function originalImage(client:Client,artifact:ContextArtifact):Promise<Blob>{
 const ref=artifact.resource;
 if(!['image/png','image/jpeg'].includes(ref.media_type)||ref.bytes<1||ref.bytes>2*1024*1024)throw Error('Original image preview supports PNG/JPEG up to 2 MiB.');
 const bytes=await readResource(client,ref,{maxBytes:2*1024*1024});
 return new Blob([bytes],{type:ref.media_type});
}
export async function producingRun(client:Client,artifact:ContextArtifact):Promise<{status:string;details:string;truncated:boolean}>{
 const reply=await client.query<{status:string;completeness:string;data:{record:unknown}}>({id:'operation.get',version:1},{operation_id:artifact.operation});
 const record=object(reply?.data?.record),operation=object(record?.operation),args=object(operation?.normalized_arguments),binding=object(args?.binding);
 if(reply.status!=='ready'||reply.completeness!=='complete'||operation?.operation_id!==artifact.operation||!same(binding?.provider,artifact.resource.owner)||
   !['succeeded','failed','cancelled','uncertain'].includes(String(record?.status)))throw Error('The original producing run is unavailable or differs from its source.');
 const details=JSON.stringify({operation_id:operation.operation_id,capability:operation.capability,input:args?.arguments,output:record?.output,error:record?.error},null,2);
 const limit=16384,characters=Array.from(details);return {status:String(record?.status),details:characters.slice(0,limit).join(''),truncated:characters.length>limit};
}
