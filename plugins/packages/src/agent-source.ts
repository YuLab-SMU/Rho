import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {ComponentSource} from '../public/agent-input/input.js';
import type {PackageEntry} from '../public/r-protocol/index.js';
export interface PackageContextSelection {session:string;observation:string;copy:PackageEntry;}
export function packageContext(provider:InstanceRef,window:string,selection:PackageContextSelection|null,kind:string):ComponentSource {
 if(kind!=='metadata'||!selection?.session||!selection.observation||!selection.copy.library_path)throw Error('Inspect an installed copy in its original package observation.');
 const {session,observation,copy}=selection;
 return {title:Array.from(`Package ${copy.name} ${copy.version}`).slice(0,160).join(''),reference:{provider:structuredClone(provider),window,contribution:'packages',
  selector:{session,observation,package:copy.name,library:copy.library_path,version:copy.version}},inclusion:{kind},preview:{id:'r.context.packages.preview',version:1}};
}
