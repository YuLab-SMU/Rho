import type {CapabilityKey,ContextItem,ContextPreview,ContextReference,InstanceRef,PluginInspection,PluginInstanceObservations,JsonValue} from '../public/plugin-protocol/index.js';
import {sameOperationValue,type PluginViewClient} from '../public/plugin-ui/index.js';
export type Source = {reference:ContextReference;preview:CapabilityKey;inclusion:unknown;text:string;title:string;version:string;lineage:string;resources:ContextPreview['resources']};
export type SourceChoice = {provider:InstanceRef;title:string;contribution:string;search:CapabilityKey;preview:CapabilityKey;modes:{title:string;inclusion:unknown}[]};
export async function observe<T>(client:PluginViewClient,id:string,args:unknown,complete=false):Promise<T>{
  const reply=await client.query<{status:string;completeness?:string;data?:T;notices?:string[]}>({id,version:1},args as JsonValue);
  if(reply.status!=='ready'||complete&&reply.completeness!=='complete'||reply.data===undefined)throw Error(reply.notices?.join('; ')||`${id} is unavailable.`);
  return reply.data;
}
export async function previewSource(client:PluginViewClient,reference:ContextReference,capability:CapabilityKey,inclusion:unknown):Promise<Source>{
  if(reference.window!==client.view.window)throw Error('This source belongs to another window.');
  const preview=await observe<ContextPreview>(client,capability.id,{binding:{provider:reference.provider,project:client.view.project,capability,target:null},arguments:{reference,inclusion,max_bytes:16384},preconditions:null},true);
  const identity=(preview.data as {annotation_source?:{source_id:string;source_version:string}}).annotation_source;
  if(!sameOperationValue(preview.item.reference,reference)||preview.truncated||typeof preview.text!=='string'||new TextEncoder().encode(preview.text).length>16384||!identity?.source_id||!identity.source_version)
    throw Error('The exact source is unavailable, changed, or too large to capture. Choose a smaller inclusion. Your draft is retained.');
  return {reference:structuredClone(reference),preview:structuredClone(capability),inclusion:structuredClone(inclusion),text:preview.text,title:preview.item.title,version:identity.source_version,lineage:identity.source_id,resources:preview.resources};
}
export async function sourceChoices(client:PluginViewClient):Promise<SourceChoice[]>{
  const choices:SourceChoice[]=[];let cursor:string|null=null;
  for(let i=0;i<8;i++){
    const page:PluginInstanceObservations=await observe<PluginInstanceObservations>(client,'plugins.instances',{after:cursor,limit:20});
    for(const observed of page.instances){
      const instance=observed.instance;
      if(!observed.observed_in_this_host||instance.state!=='active'||instance.project!==client.view.project||instance.principal!==client.view.principal||(instance.purpose??'runtime')!=='runtime'||instance.identity.plugin==='org.rho.annotations')continue;
      const inspection=await observe<PluginInspection>(client,'plugins.inspect',{revision:instance.identity.revision});
      if(inspection.manifest.id!==instance.identity.plugin||inspection.summary.revision!==instance.identity.revision||!inspection.artifacts.some(a=>a.id===instance.identity.artifact))throw Error('Source inspection differs from the observed provider.');
      for(const context of inspection.manifest.contexts){
        const descriptor=inspection.manifest.capabilities.find(c=>sameOperationValue(c.capability,context.preview));
        const inclusion=(descriptor?.input_schema as any)?.properties?.inclusion;
        const variants=inclusion?.oneOf??inclusion?.anyOf??(inclusion?.properties?.kind?[inclusion]:[]);
        const modes=variants.flatMap((variant:any)=>{
          const kind=variant.properties?.kind?.const;
          // Expose only declared simple inclusions; arbitrary schemas need their owner's UI.
          return typeof kind==='string'&&(variant.required??[]).every((name:string)=>name==='kind')?[{title:variant.title??kind,inclusion:{kind}}]:[];
        });
        if(modes.length)choices.push({provider:instance.identity,title:`${instance.alias} · ${context.title}`,contribution:context.id,search:context.search,preview:context.preview,modes});
      }
    }
    if(!page.next)break;if(page.next===cursor)throw Error('Source pagination did not advance.');cursor=page.next;
  }
  return choices;
}
export type {ContextItem};
