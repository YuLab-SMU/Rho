import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function checkDraftTransfers(sdk) {
  const scope = { project: 'project', principal: 'principal', window: 'window-a' };
  const bytes = new TextEncoder().encode('\ufeff' + '研究 α🙂\r\n'.repeat(100_000));
  const buffer = bytes.slice(), capturing = sdk.captureDraftContent(buffer);
  buffer.fill(0);
  const capture = await capturing;
  assert.equal(capture.content.digest, hash(bytes), 'capture owns bytes before asynchronous hashing');
  assert.equal(capture.content.bytes, bytes.length);
  assert.ok(capture.chunks.length > 16);
  for (const [index, chunk] of capture.content.chunks.entries()) {
    const start = index * sdk.DRAFT_CHUNK_BYTES;
    assert.equal(chunk.digest, hash(bytes.slice(start, start + sdk.DRAFT_CHUNK_BYTES)));
    assert.equal(chunk.bytes, Buffer.from(capture.chunks[index], 'base64').length);
  }
  const writes = [];
  const writer = { view: scope, control: async (capability, args) => {
    assert.deepEqual(capability, { id: 'documents.stage', version: 1 });
    assert.equal(args.window, scope.window);
    writes.push(args);
    return { digest: args.digest, bytes: Buffer.from(args.base64, 'base64').length };
  }};
  const staged = await sdk.stageDraftContent(writer, { draft: 'draft-a', upload: 'capture-a' }, capture);
  assert.deepEqual(staged, capture.content);
  assert.equal(writes.length, capture.chunks.length);
  const before = writes.length;
  for (const change of [
    item => { item.content.digest = hash('wrong'); },
    item => { item.chunks[0] = Buffer.alloc(sdk.DRAFT_CHUNK_BYTES).toString('base64'); },
    item => { item.chunks[0] = ''; },
    item => { item.content.chunks[0].bytes = 1; },
    item => { item.content.bytes = sdk.MAX_DRAFT_BYTES + 1; },
    item => { item.chunks.pop(); },
    item => { delete item.chunks[0]; },
    item => { delete item.content.chunks[0]; },
  ]) {
    const bad = structuredClone(capture); change(bad);
    await assert.rejects(sdk.stageDraftContent(writer, { draft: 'draft-a', upload: 'capture-a' }, bad), /integrity|incomplete|invalid/);
    assert.equal(writes.length, before, 'invalid complete captures stage no partial bytes');
  }
  const mutable = structuredClone(capture);
  let written = 0;
  const captured = await sdk.stageDraftContent({ ...writer, control: async (cap, args) => {
    if (++written === 1) { mutable.chunks.fill(''); mutable.content.digest = hash('later'); }
    return writer.control(cap,args);
  }}, { draft: 'draft-a', upload: 'frozen' }, mutable);
  assert.deepEqual(captured,capture.content,'later caller edits cannot change an upload in flight');
  const stopped = new AbortController(); let stoppedWrites = 0;
  await assert.rejects(sdk.stageDraftContent({ ...writer, control: async (cap, args) => {
    stoppedWrites++; stopped.abort(); return writer.control(cap,args);
  }}, { draft: 'draft-a', upload: 'stopped' }, capture, { signal: stopped.signal }), /stopped/);
  assert.equal(stoppedWrites,1);
  await assert.rejects(sdk.stageDraftContent({ ...writer, control: async () => ({ digest: hash('wrong'), bytes: 1 }) },
    { draft: 'draft-a', upload: 'ack' }, capture), /acknowledgement/);
  await assert.rejects(sdk.captureDraftContent(new Uint8Array(sdk.MAX_DRAFT_BYTES+1)),/limit/);
  await assert.rejects(sdk.stageDraftContent(writer,{draft:'../invalid',upload:'capture'},capture),/identity/);
  const record = { ...scope, draft: 'draft-a', source: { revision: hash('source'), contribution: 'document' }, version: 1, content: capture.content, metadata: { name: '研究.R' }, discarded: false };
  let reads = 0;
  const reader = { view: scope, query: async (cap, args) => {
    reads++;
    assert.equal(args.window,scope.window); assert.equal(args.draft,record.draft);
    if (cap.id === 'documents.inspect') return { data: structuredClone(record) };
    assert.equal(cap.id,'documents.read'); assert.equal(args.expected_version,1); assert.equal(args.limit,sdk.DRAFT_CHUNK_BYTES);
    const end = Math.min(args.offset + args.limit,bytes.length);
    return { data: { draft: record.draft, version: 1, digest: hash(bytes), offset: args.offset, base64: Buffer.from(bytes.slice(args.offset,end)).toString('base64'), next: end===bytes.length?null:end }};
  }};
  assert.deepEqual(await sdk.readDraft(reader,record),bytes);
  assert.equal(reads,capture.chunks.length+1);
  for (const change of [
    item => {item.version=0;}, item=>{item.discarded=true;},item=>{item.source.contribution='Bad name';},
    item=>{item.window='other-window';},item=>{item.project='other-project';},item=>{item.principal='another-user';},
  ]) {
    const bad=structuredClone(record);change(bad);const before=reads;
    await assert.rejects(sdk.readDraft(reader,bad),/identity|scope|version|limit/);
    assert.equal(reads,before,'scope and malformed records are refused before reading');
  }
  await assert.rejects(sdk.readDraft(reader,record,{maxBytes:100}),/limit/);
  for (const field of ['version','draft','offset','digest','next','base64']) {
    const corrupted={...reader,query:async(cap,args)=>{
      const response=await reader.query(cap,args);
      if(cap.id==='documents.read') response.data[field]=field==='base64'?Buffer.alloc(Math.min(sdk.DRAFT_CHUNK_BYTES,bytes.length)).toString('base64'):'changed';
      return response;
    }};
    await assert.rejects(sdk.readDraft(corrupted,record),/identity|range|integrity/);
  }
  const changed={...reader,query:async(cap,args)=>{const response=await reader.query(cap,args);if(cap.id==='documents.inspect') response.data.version++;return response;}};
  await assert.rejects(sdk.readDraft(changed,record),/version changed/);
  const readStop = new AbortController();let stopReads=0;
  await assert.rejects(sdk.readDraft({...reader,query:async(cap,args)=>{stopReads++;readStop.abort();return reader.query(cap,args);}},record,{signal:readStop.signal}),/stopped/);
  assert.equal(stopReads,1);
  const empty=await sdk.captureDraftContent(new Uint8Array());
  assert.deepEqual(empty,{content:{digest:hash(''),bytes:0,chunks:[]},chunks:[]});
  const emptyRecord={...record,content:empty.content};let emptyReads=0;
  const emptyReader={view:scope,query:async(cap)=>{emptyReads++;return {data:cap.id==='documents.inspect'?emptyRecord:{draft:record.draft,version:1,digest:hash(''),offset:0,base64:'',next:null}};}};
  assert.equal((await sdk.readDraft(emptyReader,emptyRecord)).length,0);
  assert.equal(emptyReads,2,'even empty bytes require current scoped native observations');
  assert.equal(sdk.isDocumentDraft({...record,metadata:'x'.repeat(32769)}),false);
  console.log('Public draft transfers verify frozen Unicode captures, scoped exact versions, bounded verified chunks, acknowledgement identity, corruption, interruption and empty-content authority.');
}
