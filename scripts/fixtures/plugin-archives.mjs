import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function checkArchiveTransfers(sdk) {
  const bytes=new TextEncoder().encode('Scientific source 中文 Ω\n'.repeat(8000));
  const blob=new Blob([bytes]),capture=await sdk.capturePluginArchive(blob,'original-upload');
  assert.equal(capture.reference.digest,'sha256:'+createHash('sha256').update(bytes).digest('hex'));
  assert.equal(sdk.MAX_PLUGIN_ARCHIVE_BYTES,374691157);
  assert.equal(sdk.ARCHIVE_CHUNK_BYTES,65536);
  bytes.fill(0); // Blob capture retains the original bytes independently.
  const parts=new Map(),seen=[];let calls=0;
  const writer={control:async(cap,args)=>{
    calls++;assert.equal(cap.id,'plugins.archive_stage');assert.equal(cap.version,1);assert.equal(args.offset%65536,0);
    const part=Buffer.from(args.base64,'base64');assert.equal(part.length,Math.min(65536,capture.reference.bytes-args.offset));parts.set(args.offset,part);
    const received=[...parts.values()].reduce((n,p)=>n+p.length,0);
    return {reference:structuredClone(args.reference),received,complete:received===args.reference.bytes};
  }};
  const complete=await sdk.stagePluginArchive(writer,capture,{progress:progress=>seen.push(progress.received)});
  assert.equal(complete.complete,true);assert.equal(complete.received,capture.reference.bytes);assert.ok(seen.length>1);
  const assembled=Buffer.concat([...parts.values()]);assert.equal('sha256:'+createHash('sha256').update(assembled).digest('hex'),capture.reference.digest);
  assert.deepEqual(await sdk.stagePluginArchive(writer,capture),complete); // Same complete upload is safe to restage.
  const before=calls;
  await assert.rejects(sdk.stagePluginArchive(writer,{...capture,reference:{...capture.reference,digest:'sha256:'+'a'.repeat(64)}}),/capture changed/);
  assert.equal(calls,before,'changed content was staged');
  for(const corrupt of [p=>({...p,received:0}),p=>({...p,complete:false}),p=>({...p,reference:{...p.reference,archive:'other'}})])
    await assert.rejects(sdk.stagePluginArchive({control:async(cap,args)=>corrupt(await writer.control(cap,args))},capture),/acknowledgement/);
  const stopped=new AbortController();let staged=0;
  await assert.rejects(sdk.stagePluginArchive({control:async(cap,args)=>{staged++;stopped.abort();return writer.control(cap,args);}},capture,{signal:stopped.signal}),/stopped/);assert.equal(staged,1);
  const reader={query:async(cap,args)=>{assert.equal(cap.id,'plugins.archive_read');const end=Math.min(args.offset+args.limit,assembled.length);return {status:'ready',data:{reference:structuredClone(capture.reference),offset:args.offset,base64:assembled.subarray(args.offset,end).toString('base64'),next:end===assembled.length?null:end}};}};
  assert.deepEqual(Buffer.from(await sdk.readPluginArchive(reader,capture.reference)),assembled);
  for(const corrupt of [p=>({...p,offset:1}),p=>({...p,next:1}),p=>({...p,base64:''}),p=>({...p,reference:{...p.reference,bytes:p.reference.bytes+1}}),p=>({...p,base64:Buffer.alloc(Buffer.from(p.base64,'base64').length).toString('base64')})])
    await assert.rejects(sdk.readPluginArchive({query:async(cap,args)=>({status:'ready',data:corrupt((await reader.query(cap,args)).data)})},capture.reference),/identity|range|incomplete|integrity/);
  await assert.rejects(sdk.readPluginArchive({query:async()=>({status:'partial',data:{}})},capture.reference),/identity/);
  await assert.rejects(sdk.readPluginArchive(reader,capture.reference,{maxBytes:1}),/limit/);
  const aborted=new AbortController();let reads=0;
  await assert.rejects(sdk.readPluginArchive({query:async(cap,args)=>{reads++;aborted.abort();return reader.query(cap,args);}},capture.reference,{signal:aborted.signal}),/stopped/);assert.equal(reads,1);
  for(const ref of [{...capture.reference,owner:{}},{...capture.reference,bytes:0},{...capture.reference,bytes:sdk.MAX_PLUGIN_ARCHIVE_BYTES+1},{...capture.reference,archive:'../outside'}])assert.equal(sdk.isPluginArchiveReference(ref),false);
  await assert.rejects(sdk.capturePluginArchive(new Blob([]),'empty'),/limit/);
  // Package reads have their own bound, independent of the 16 MiB media limit.
  const large=Buffer.alloc(17*1024*1024,91),ref={archive:'large',bytes:large.length,digest:'sha256:'+createHash('sha256').update(large).digest('hex')};
  assert.equal((await sdk.readPluginArchive({query:async(cap,args)=>{const end=Math.min(args.offset+args.limit,large.length);return {status:'ready',data:{reference:ref,offset:args.offset,base64:large.subarray(args.offset,end).toString('base64'),next:end===large.length?null:end}};}},ref)).length,large.length);
  console.log('Public archive transfers verify immutable capture, idempotent chunks, progress, native references, full digest, abortion and reads above the media limit.');
}
