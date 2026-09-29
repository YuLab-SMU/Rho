import {expect,it} from 'vitest';
import {plotContext} from '../src/agent-source.js';
import {plotsFrom} from '../src/outputs.js';
const owner={instance:'r',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
function plot(id:string){
 const digest='sha256:'+'c'.repeat(64);
 return plotsFrom({operation:{operation_id:id,accepted_at_ms:1,capability:{id:'r.execute',version:1},normalized_arguments:{binding:{provider:owner}}},status:'succeeded',output:{operation_id:id,session_id:'native',outputs:[{reference:{owner,resource:id,digest,bytes:20,media_type:'image/png'},native:{operation_id:id,sequence:1,mime_type:'image/png',byte_size:20,sha256:digest,display_id:null}}]}},owner)[0];
}
it('captures one or two exact originals without following later display changes',()=>{
 const first=plot('first'),second=plot('second');
 const source=plotContext(owner,'window',[first,second],'images');
 first.reference.resource='later';
 expect(source.reference.selector).toMatchObject({plots:[{operation:'first',session:'native',reference:{resource:'first'}},{operation:'second',reference:{resource:'second'}}]});
 expect(source.title).toBe('Compare two plots');expect(source.preview.id).toBe('r.context.plots.preview');
 expect(plotContext(owner,'window',[second],'metadata').inclusion).toEqual({kind:'metadata'});
});
it('refuses empty, duplicate, excessive, foreign and implicit inclusions',()=>{
 const p=plot('one');
 for(const plots of [[],[p,p],[p,plot('two'),plot('three')],[{...p,reference:{...p.reference,owner:{...owner,instance:'foreign'}}}]])
  expect(()=>plotContext(owner,'window',plots,'images')).toThrow('different original plots');
 expect(()=>plotContext(owner,'window',[p],'capture')).toThrow();
});
