import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {ComponentSource} from '../public/agent-input/input.js';
import type {ObjectPathElement} from '../public/r-protocol/index.js';
import type {ObjectSelection} from './resource-ports.js';
export function objectContext(provider:InstanceRef,window:string,selection:ObjectSelection|null,path:ObjectPathElement[],kind:string):ComponentSource {
  if(kind!=='summary'||!selection)throw Error('Open a current object observation before preparing its input.');
  return {title:`Object ${[selection.name,...path.map(part=>part.kind==='name'?part.name:`[${part.index}]`)].join(' › ')} · metadata`.slice(0,160),
    reference:{provider:structuredClone(provider),window,contribution:'objects',selector:{session:selection.native_session_id,
      name:selection.name,object_ref:selection.object_ref,observed_path:[],path:structuredClone(path)}},
    inclusion:{kind},preview:{id:'r.context.objects.preview',version:1}};
}
