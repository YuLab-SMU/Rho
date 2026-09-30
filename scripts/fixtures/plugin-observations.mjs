import assert from 'node:assert/strict';
export async function checkObservationsAndOperations(sdk) {
 const source={capability:{id:'files.read_text',version:1},arguments:{binding:{provider:{instance:'original'}},arguments:{path:'notes.txt'}},subscribe:true};
 for(const intervalMs of [0,99,60001,NaN,100.5])assert.throws(()=>sdk.createPollingVisualSubscription({query:async()=>null},{intervalMs}),/interval/);
 const reads=[],events=[];let stop,resolveSecond;
 const second=new Promise(resolve=>resolveSecond=resolve);
 const subscribe=sdk.createPollingVisualSubscription({query:async(cap,args)=>{reads.push(structuredClone({cap,args}));args.binding.provider.instance='mutated by reader';return {sequence:reads.length};}},{intervalMs:100});
 const captured=structuredClone(source);stop=subscribe(captured,value=>{events.push(value);if(events.length===2){stop();resolveSecond();}},error=>assert.fail(String(error)));
 captured.arguments.binding.provider.instance='replacement';await second;
 assert.deepEqual(reads,Array(2).fill({cap:source.capability,args:source.arguments}));assert.deepEqual(events,[{sequence:1},{sequence:2}]);
 let count=0,late=0;const releases=[];let started;
 const inFlight=new Promise(resolve=>started=resolve);
 const bounded=sdk.createPollingVisualSubscription({query:()=>new Promise(resolve=>{count++;releases.push(resolve);if(count===8)started();})},{intervalMs:100});
 const stops=Array.from({length:20},()=>bounded(source,()=>late++,()=>late++));await inFlight;assert.equal(count,8);stops.forEach(stop=>stop());releases.forEach(resolve=>resolve(null));await Promise.resolve();await Promise.resolve();assert.equal(late,0);assert.equal(count,8);
 const intent={view:'original-view',request:'gesture-0',capability:{id:'files.apply_patch',version:1},arguments:{binding:{provider:'original'},patch:'patch'},preconditions:[{sha256:'expected'}],operation:null};
 const record={operation:{operation_id:'original-op',caller:{kind:'plugin',id:intent.view},client_request_id:await sdk.operationRequestId(intent.view,intent.request),capability:intent.capability,normalized_arguments:intent.arguments,preconditions:intent.preconditions},status:'succeeded',outcome:'succeeded',output:{changed:true},error:null};
 assert.deepEqual(await sdk.verifyOriginalOperation(record,intent),record);
 const mutable=structuredClone(intent),checking=sdk.verifyOriginalOperation(record,mutable);mutable.arguments.binding.provider='replacement during digest';assert.deepEqual(await checking,record);
 for(const corrupt of [r=>r.operation.caller.id='another',r=>r.operation.client_request_id='another',r=>r.operation.normalized_arguments.binding.provider='replacement',r=>r.operation.preconditions=[],r=>r.outcome=null,r=>r.status='unknown']) {
  const value=structuredClone(record);corrupt(value);await assert.rejects(sdk.verifyOriginalOperation(value,intent),/original plugin request/);
 }
 const calls=[];const client={view:{view:'replacement-view'},operation:()=>assert.fail('replacement view must use public read, not caller-owned operation route'),query:async(cap,args)=>{
  calls.push({cap,args});return cap.id==='operation.list_recent'?{status:'ready',data:{operations:[{operation_id:'original-op'}]}}:{status:'ready',data:{record}};
 }};
 assert.deepEqual(await sdk.inspectOriginalOperation(client,intent),record);assert.equal(calls[0].args.client_request_id,record.operation.client_request_id);assert.equal(calls[1].cap.id,'operation.get');
 await assert.rejects(sdk.inspectOriginalOperation({...client,query:async()=>({status:'ready',data:{operations:[]}})},intent),/No unique original/);
 console.log('Public polling observations keep original arguments, bound concurrent reads, stop without late publication; original-operation inspection rejects mismatches and supports replacement-view readonly recovery.');
}
