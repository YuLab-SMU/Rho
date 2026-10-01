import {expect,it} from 'vitest';
import {packageContext,type PackageContextSelection} from '../src/agent-source.js';
const provider={instance:'r',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
const selection={session:'original-native',observation:'original-observation',copy:{name:'pkg',version:'1.2',library_path:'/library/one'}} as PackageContextSelection;
it('captures the exact installed copy independently of later selection changes',()=>{
 const current=structuredClone(selection),source=packageContext(provider,'window',current,'metadata');
 current.copy.library_path='/library/two';current.observation='new';
 expect(source.reference.selector).toEqual({session:'original-native',observation:'original-observation',package:'pkg',library:'/library/one',version:'1.2'});
 expect(source.preview.id).toBe('r.context.packages.preview');expect(source.reference.provider).toEqual(provider);
});
it('refuses missing original observation, library or unsupported inclusion',()=>{
 for(const value of [null,{...selection,observation:''},{...selection,session:''},{...selection,copy:{...selection.copy,library_path:null}}])expect(()=>packageContext(provider,'window',value,'metadata')).toThrow();
 expect(()=>packageContext(provider,'window',selection,'install')).toThrow();
});
