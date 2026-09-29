import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {ComponentSource} from '../public/agent-input/input.js';
import {terminal,sameOwner,type Run} from './model.js';
export function consoleContext(provider:InstanceRef,window:string,run:Run|null,kind:string):ComponentSource {
 if(!run||!terminal(run.status)||!run.retained||!sameOwner(run.retained.owner,provider)||!['code','transcript'].includes(kind))throw Error('Select an original completed run with retained output.');
 return {title:'Console · '+run.code.split('\n')[0].slice(0,120),reference:{provider:structuredClone(provider),window,contribution:'console',
  selector:{operation:run.id,session:run.session,events:structuredClone(run.retained)}},inclusion:{kind},preview:{id:'r.context.console.preview',version:1}};
}
