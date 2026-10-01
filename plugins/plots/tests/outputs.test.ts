import { expect, it } from "vitest";
import { plotsFrom, readOperation, readHistory, mergeHistory } from "../src/outputs.js";
import type { InstanceRef } from "../public/plugin-protocol/index.js";
const owner: InstanceRef={instance:'r-one',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
function fixture() {
  const reference={owner,resource:'plot',digest:'sha256:'+'c'.repeat(64),bytes:20,media_type:'image/png'};
  const source={view_id:'script',label:'分析.R',kind:'file'};
  return {operation:{operation_id:'original',accepted_at_ms:42,capability:{id:'r.execute',version:2},normalized_arguments:{binding:{provider:owner,target:'native'},arguments:{run:{source}}}},status:'succeeded',
    output:{operation_id:'original',session_id:'native',source,outputs:[{reference,native:{operation_id:'original',sequence:1,mime_type:'image/png',byte_size:20,sha256:reference.digest,display_id:null}}]}};
}
it('retains exact original PNG, JPEG and SVG outputs without interpreting another provider or unknown contract',()=>{
  const record=fixture();
  for(const mime of ['image/png','image/jpeg','image/svg+xml']) {
    record.output.outputs[0].reference.media_type=mime; record.output.outputs[0].native.mime_type=mime;
    const output=plotsFrom(record,owner)[0]; expect(output.inputSource?.label).toBe('分析.R'); expect(output.reference.media_type).toBe(mime);
    output.reference.resource='changed'; expect(record.output.outputs[0].reference.resource).toBe('plot');
  }
  expect(plotsFrom(record,{...owner,instance:'another'})).toEqual([]);
  expect(plotsFrom({...record,status:'running'},owner)).toEqual([]);
  record.operation.capability.version=3; expect(plotsFrom(record,owner)).toEqual([]);
});
it('rejects mismatched native session, output, source or resource identities',()=>{
  const changes=[(r:any)=>r.output.operation_id='other',(r:any)=>r.output.session_id='other',(r:any)=>r.output.source={...r.output.source,label:'other'},
    (r:any)=>r.output.outputs[0].native.operation_id='other',(r:any)=>r.output.outputs[0].native.sequence=-1,(r:any)=>r.output.outputs[0].native.sha256='wrong',
    (r:any)=>r.output.outputs[0].reference.owner={...owner,revision:'sha256:'+'d'.repeat(64)},(r:any)=>r.output.outputs.push(r.output.outputs[0])];
  for(const change of changes) {const record=fixture();change(record);expect(()=>plotsFrom(record,owner)).toThrow();}
});
it('keeps outputs from partial terminal runs and treats pre-start cancellation as no output',()=>{
  for(const status of ['failed','cancelled','uncertain']) expect(plotsFrom({...fixture(),status},owner)).toHaveLength(1);
  expect(plotsFrom({...fixture(),status:'cancelled',output:{operation_id:'original',started:false}},owner)).toEqual([]);
});
it('reads the requested original operation and validates bounded monotonic history',async()=>{
  const record=fixture(),calls:any[]=[];
  const reader={query:async<T>(cap:any,args:any)=>{calls.push({cap,args}); return (cap.id==='operation.get'?{data:{record}}:{data:{operations:[{operation_id:'original',capability:record.operation.capability,status:'succeeded'}],next_cursor:8}}) as T;}};
  expect((await readHistory(reader,owner,10)).plots).toHaveLength(1); expect(calls[0].args).toEqual({limit:25,before_cursor:10});
  await expect(readOperation(reader,owner,'foreign')).rejects.toThrow('original plot Operation');
  await expect(readHistory(reader,owner,8)).rejects.toThrow('continuation');
});
it('bounds history while preserving latest and explicitly selected originals across earlier pages',()=>{
  const base=plotsFrom(fixture(),owner)[0], all=Array.from({length:240},(_,n)=>({...base,operation:`run-${n}`,accepted:n}));
  const result=mergeHistory(all.slice(40),all.slice(0,40),{operation_id:'run-235',resource_id:'plot'},true);
  expect(result).toHaveLength(200); expect(result[0].operation).toBe('run-0');expect(result.at(-1)?.operation).toBe('run-239');expect(result.some(p=>p.operation==='run-235')).toBe(true);
});
