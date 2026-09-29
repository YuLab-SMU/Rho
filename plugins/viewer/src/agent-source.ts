import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {ComponentSource} from '../public/agent-input/input.js';
import type {SavedOutput} from './outputs.js';
export function viewerContext(provider:InstanceRef,window:string,output:SavedOutput,kind:string):ComponentSource {
  if(!['text','metadata'].includes(kind))throw Error('Choose saved HTML source or output details.');
  return {title:`${kind==='metadata'?'HTML output details':'Saved HTML source'} ${output.sequence}`,
    reference:{provider:structuredClone(provider),window,contribution:'viewer',selector:{operation:output.operation,sequence:output.sequence,
      session:output.session,reference:structuredClone(output.reference)}},inclusion:{kind},preview:{id:'r.context.viewer.preview',version:1}};
}
