import {expect,it} from 'vitest';
import {objectContext} from '../src/agent-source.js';
const provider={plugin:'org.rho.r',instance:'r',revision:'revision',artifact:'artifact'};
it('captures the selected observation and exact nested path without sharing mutable state',()=>{
  const selection={name:'研究',object_ref:'original',native_session_id:'session'},path=[{kind:'name' as const,name:'child'}];
  const source=objectContext(provider,'window',selection,path,'summary');
  expect(source.reference).toMatchObject({provider,window:'window',contribution:'objects',selector:{session:'session',name:'研究',object_ref:'original',observed_path:[],path}});
  path[0].name='different';selection.object_ref='replacement';
  expect(source.reference.selector).toMatchObject({object_ref:'original',path:[{kind:'name',name:'child'}]});
  expect(source.title).toContain('child');expect(source.inclusion).toEqual({kind:'summary'});
});
it('refuses missing or unsupported observations instead of looking up another object',()=>{
  expect(()=>objectContext(provider,'window',null,[],'summary')).toThrow('current object');
  expect(()=>objectContext(provider,'window',{name:'x',object_ref:'a',native_session_id:'s'},[],'whole')).toThrow('current object');
});
