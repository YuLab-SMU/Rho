import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {ComponentSource} from '../public/agent-input/input.js';
import type {TextIdentity} from '../sdk/index.js';
export function fileContext(provider:InstanceRef,window:string,file:TextIdentity|null,kind:string):ComponentSource {
 if(!file||!file.path||!file.sha256||!file.native_identity||!['text','metadata'].includes(kind))throw Error('Select and read the original text file first.');
 return {title:Array.from(`File ${file.path}`).slice(0,80).join(''),reference:{provider:structuredClone(provider),window,contribution:'files',selector:structuredClone(file)},inclusion:{kind},preview:{id:'files.context.preview',version:1}};
}
