import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {ComponentSource} from '../public/agent-input/input.js';
import type {HelpSnapshot} from './help.js';
/** Capture what the reader actually shows, including both sets of file identities. */
export function helpContext(provider:InstanceRef,window:string,state:HelpSnapshot,kind:string):ComponentSource {
  const {copy,index,page}=state;
  if(!['text','excerpt'].includes(kind)||!index||!page?.found||!page.complete||state.loading||state.requiresNewObservation||state.staleIndex||page.topic!==state.topic)
    throw Error('Wait for the complete original Help topic before preparing its input.');
  return {title:`${kind==='excerpt'?'Help excerpt':'Help'} ${copy.package}::${page.topic}`.slice(0,160),
    reference:{provider:structuredClone(provider),window,contribution:'help',selector:{session:copy.nativeSession,observation:copy.observation,
      package:copy.package,library:copy.libraryPath,topic:page.topic,index_files:structuredClone(index.files),help_files:structuredClone(page.help_files)}},
    inclusion:{kind},preview:{id:'r.context.help.preview',version:1}};
}
