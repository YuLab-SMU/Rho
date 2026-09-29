import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {ComponentSource} from '../public/agent-input/input.js';
import type {SavedPlot} from './outputs.js';
import {sameOwner} from './outputs.js';
export function plotContext(provider:InstanceRef,window:string,plots:readonly SavedPlot[],kind:string):ComponentSource {
  if(!['images','metadata'].includes(kind)||plots.length<1||plots.length>2||new Set(plots.map(p=>p.reference.resource)).size!==plots.length||plots.some(p=>!sameOwner(p.reference.owner,provider)))
    throw Error('Choose one or two different original plots from this R provider.');
  return {title:plots.length===2?'Compare two plots':`Plot ${plots[0].native.sequence}`,
    reference:{provider:structuredClone(provider),window,contribution:'plots',selector:{plots:plots.map(p=>({operation:p.operation,session:p.session,sequence:p.native.sequence,reference:structuredClone(p.reference)}))}},
    inclusion:{kind},preview:{id:'r.context.plots.preview',version:1}};
}
