import {expect,it} from 'vitest';
import {helpContext} from '../src/agent-source.js';
import {copy,index,page} from './fixtures.js';
import type {HelpSnapshot} from '../src/help.js';
const provider={plugin:'org.rho.r',instance:'r',revision:'revision',artifact:'artifact'};
const state=()=>({copy:structuredClone(copy),index:structuredClone(index),page:structuredClone(page),topic:page.topic,
 loading:false,requiresNewObservation:false,staleIndex:false} as HelpSnapshot);
it('captures exact visible copy/topic and file identities without sharing mutable observations',()=>{
 const observed=state(),input=helpContext(provider,'window',observed,'text');
 expect(input.reference).toMatchObject({provider,window:'window',contribution:'help',selector:{session:copy.nativeSession,observation:copy.observation,package:copy.package,library:copy.libraryPath,topic:page.topic,index_files:index.files,help_files:page.help_files}});
 expect(input.inclusion).toEqual({kind:'text'});expect(helpContext(provider,'window',observed,'excerpt').title).toContain('excerpt');
 observed.index!.files[0]!.digest='later';expect((input.reference.selector as any).index_files).toEqual(index.files);
});
it('refuses changed, partial, busy or missing topic observations',()=>{
 for(const patch of [{loading:true},{requiresNewObservation:true},{staleIndex:true},{topic:'other'},{page:null},{page:{...page,complete:false}}])
  expect(()=>helpContext(provider,'window',{...state(),...patch} as HelpSnapshot,'text')).toThrow('original Help topic');
});
