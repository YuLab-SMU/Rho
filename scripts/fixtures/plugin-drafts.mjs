import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
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
  await checkDraftFlush(sdk, capture, record);
  console.log('Public draft transfers verify frozen Unicode captures, scoped exact versions, bounded verified chunks, acknowledgement identity, corruption, interruption and empty-content authority.');
}

async function checkDraftFlush(sdk, capture, draft) {
  const view={view:'view',instance:{instance:'instance',plugin:'example.drafts',revision:draft.source.revision,artifact:hash('artifact')},
    project:draft.project,principal:draft.principal,window:draft.window,contribution:draft.source.contribution,configuration:{},state:{draft:draft.draft,version:1},state_version:0,closed:false};
  const channel=new MessageChannel();
  const client=new sdk.PluginViewClient(channel.port1,{protocol_version:1,connection:'connection',features:['view_close_v1'],view});
  const calls=[];let phase={phase:'open'},sequence=0;
  let releaseReceipt,waiting;
  const receipt=new Promise(resolve=>{releaseReceipt=resolve;});
  const readingReceipt=new Promise(resolve=>{waiting=resolve;});
  channel.port2.on('message',async message=>{
    const body=message.body;calls.push(body);let result={view:view.view,state_version:view.state_version,close:phase};
    if(body.type==='control') {
      assert.equal(body.capability.id,'documents.stage');assert.equal(body.arguments.window,view.window);
      result={digest:body.arguments.digest,bytes:Buffer.from(body.arguments.base64,'base64').length};
    } else if(body.type==='invoke') {
      assert.equal(body.capability.id,'documents.save');assert.equal(body.request_id,'original-save');
      assert.deepEqual(body.arguments.content,capture.content);
      result={status:'accepted',operation:{operation_id:'draft-save'}};
    } else if(body.type==='get_operation') {
      assert.equal(body.operation_id,'draft-save');waiting();await receipt;
      result={status:'succeeded',output:{...draft,version:2,content:capture.content}};
    } else if(body.type==='set_state') {
      assert.equal(body.expected_version,view.state_version);view.state_version++;view.state=body.state;
      result={status:'succeeded',output:structuredClone(view)};
    }
    channel.port2.postMessage({protocol_version:1,connection:'connection',view:view.view,sequence:++sequence,request:message.request,ok:true,result});
  });
  let observing;
  try {
    const cooperation=await client.installCloseHandler({flush:async()=>{
      const content=await sdk.stageDraftContent(client,{draft:draft.draft,upload:'close-capture'},capture);
      const accepted=await client.invoke({id:'documents.save',version:1},{window:view.window,draft:draft.draft,upload:'close-capture',source:draft.source,expected_version:1,content,metadata:{}},{requestId:'original-save'});
      const saved=await client.operation(accepted.operation.operation_id);
      if(saved.status!=='succeeded') throw new Error('Original save has not settled');
      await client.setState({draft:draft.draft,version:saved.output.version});
    }});
    phase={phase:'requested',operation:'close'};
    observing=cooperation.observe();await readingReceipt;
    assert.equal(cooperation.getSnapshot().preparing,true);
    assert.equal(calls.filter(call=>call.type==='control').length,capture.chunks.length);
    assert.equal(calls.some(call=>call.type==='prepare_close'),false,'close waits for original save settlement');
    for(const [method,id,version] of [['invoke','documents.discard',1],['invoke','documents.save',2],['control','documents.stage',2],['control','documents.save',1],['invoke','documents.stage',1],['invoke','fixture.run',1]])
      await assert.rejects(client[method]({id,version},{}),/closure is preparing/);
    releaseReceipt();await observing;
    assert.deepEqual(view.state,{draft:draft.draft,version:2});
    const prepared=calls.filter(call=>call.type==='prepare_close');
    assert.equal(prepared.length,1);assert.equal(prepared[0].state_version,1);assert.equal(prepared[0].operation,'close');
    const at=calls.findIndex(call=>call.type==='prepare_close');
    assert.ok(calls.findIndex(call=>call.type==='set_state')<at);
    assert.equal(calls.some(call=>call.type==='cancel'),false);
    console.log('Close-time draft transfer waits for the original save and reference state, while unrelated actions and capability versions remain fenced.');
  } finally {releaseReceipt();client.dispose();channel.port2.close();await observing?.catch(()=>{});}
}
