import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function testContextArtifacts({contextArtifacts,originalImage,producingRun}){
 const provider={plugin:'org.example.source',instance:'owner',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)},bytes=Buffer.from([1,2,3]);
 const resource={owner:provider,resource:'original',media_type:'image/png',bytes:3,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
 const selection={source:'plugin',reference:{provider},inclusion:'{}',label:'Source'},artifact={label:'Plot 1',resource,operation:'original-run'};
 assert.deepEqual(contextArtifacts(selection,{}),[]);
 assert.deepEqual(contextArtifacts(selection,{contribution:{artifacts:[artifact]},agent_context_images:[{sha256:resource.digest}]}),[artifact]);
 const links=contextArtifacts(selection,{artifacts:[artifact]});links[0].resource.resource='later';assert.equal(resource.resource,'original');
 for(const value of [null,[artifact,artifact],[{...artifact,resource:{...resource,owner:{...provider,instance:'other'}}}],[{...artifact,operation:'https://untrusted.test/?x=1'}],Array(9).fill(artifact)])
  assert.throws(()=>contextArtifacts(selection,{artifacts:value}));
 let fault='',calls=[];
 const client={async query(cap,args){calls.push(cap.id);
  if(cap.id==='resources.read')return {data:{reference:resource,offset:0,next:null,base64:(fault==='digest'?Buffer.from([4,5,6]):bytes).toString('base64')}};
  assert.equal(cap.id,'operation.get');assert.deepEqual(args,{operation_id:'original-run'});
  return {status:'ready',completeness:fault==='partial'?'partial':'complete',data:{record:{operation:{operation_id:fault==='id'?'another':'original-run',capability:{id:'example.produce',version:1},normalized_arguments:{binding:{provider:fault==='owner'?{...provider,instance:'another'}:provider},arguments:{code:fault==='long'?'🙂'.repeat(17000):'original code'}}},status:fault==='live'?'running':'succeeded',output:{reference:resource}}}};
 }};
 assert.deepEqual(Buffer.from(await (await originalImage(client,artifact)).arrayBuffer()),bytes);
 fault='digest';await assert.rejects(originalImage(client,artifact),/integrity/);
 for(const media_type of ['image/svg+xml','text/html'])await assert.rejects(originalImage(client,{...artifact,resource:{...resource,media_type}}),/PNG/);
 fault='';const run=await producingRun(client,artifact);assert.equal(run.status,'succeeded');assert.ok(run.details.includes('original code'));assert.equal(run.truncated,false);
 fault='long';const long=await producingRun(client,artifact);assert.ok(long.truncated);assert.equal(Array.from(long.details).length,16384);assert.ok(!/[\uD800-\uDBFF]$/.test(long.details));
 for(fault of ['partial','id','owner','live'])await assert.rejects(producingRun(client,artifact),/original producing run/);
 assert.ok(calls.every(id=>['resources.read','operation.get'].includes(id)));
 console.log('Captured artifact links: exact owner, bounded references, original bytes/digest and producing-run identities pass; only public queries.');
}
