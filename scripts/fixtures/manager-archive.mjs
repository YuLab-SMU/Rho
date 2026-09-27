import assert from 'node:assert/strict';

export async function checkManagerArchive({ Manager, operationRequestId }) {
  const hash = ch => 'sha256:' + ch.repeat(64), data = new TextEncoder().encode('Archive source 科学\n'.repeat(8000)), file = new Blob([data]);
  let saved, saveFault = false, saveAfterImport = false, chunkLost = false, importLost = false, discardLost = false, outcome = 'succeeded', badReceipt = false;
  const chunks = new Map(), records = [], calls = [];
  const inspection = ref => ({ reference: ref, revision: hash('a'), plugin: 'example.local', name: 'Local package', version: '1', description: 'Source and UI', source_files: 2, artifacts: [{ id: hash('b'), target: 'ui-web', file_count: 1 }] });
  const progress = ref => { const received = [...chunks.values()].reduce((sum, bytes) => sum + bytes.length, 0); return { reference: ref, received, complete: received === ref.bytes }; };
  const client = {
    view: { view: 'manager', window: 'window' },
    setState: async state => { if (saveFault) throw Error('save unconfirmed'); saved = structuredClone(state); },
    control: async (cap, args) => {
      calls.push(cap.id); assert.ok(saved.upload, 'reference persisted before any byte transfer');
      assert.deepEqual(saved.upload.reference, args.reference);
      if (cap.id === 'plugins.archive_stage') {
        const bytes = Buffer.from(args.base64, 'base64'), old = chunks.get(args.offset);
        if (old) assert.deepEqual(old, bytes, 'only identical chunks can be retried');
        chunks.set(args.offset, bytes);
        if (chunkLost) { chunkLost = false; throw Error('chunk acknowledgement lost'); }
        return progress(args.reference);
      }
      if (cap.id === 'plugins.archive_discard') {
        chunks.clear();
        if (discardLost) { discardLost = false; throw Error('discard acknowledgement lost'); }
        return { reference: args.reference, discarded: true };
      }
      throw Error(cap.id);
    },
    query: async (cap, args) => {
      calls.push(cap.id);
      if (cap.id === 'plugins.archive_progress') return { status: 'ready', data: progress(args.reference) };
      if (cap.id === 'plugins.archive_inspect') return { status: 'ready', data: inspection(args.reference) };
      if (cap.id === 'operation.list_recent') return { status: 'ready', data: { operations: records.filter(r => r.operation.client_request_id === args.client_request_id).map(r => ({ operation_id: r.operation.operation_id })) } };
      if (cap.id === 'operation.get') return { status: 'ready', data: { record: records.find(r => r.operation.operation_id === args.operation_id) } };
      throw Error(cap.id);
    },
    operation: async id => records.find(r => r.operation.operation_id === id),
    async invoke(cap, args, options) {
      assert.ok(saved.pending, 'original intent persisted before import');
      assert.equal(cap.id, 'plugins.archive_import', 'archive actions cannot activate, build or change a scenario');
      calls.push(cap.id);
      const request = await operationRequestId(this.view.view, options.requestId);
      let record = records.find(r => r.operation.client_request_id === request);
      if (!record) {
        record = { operation: { operation_id: 'import-' + records.length, caller: { kind: 'plugin', id: this.view.view }, client_request_id: request, capability: cap, normalized_arguments: args, preconditions: [] },
          status: outcome, outcome, output: { reference: args.reference, revision: hash(badReceipt ? 'c' : 'a'), plugin: 'example.local', artifacts: [hash('b')] }, error: null };
        records.push(record);
      }
      if (importLost) throw Error('import acknowledgement lost');
      if (saveAfterImport) saveFault = true;
      return structuredClone(record);
    },
  };
  let manager = new Manager(client);
  const before = calls.length;
  saveFault = true;
  await assert.rejects(manager.upload.choose(file, '本地包.rho-plugin'), /save unconfirmed/);
  await assert.rejects(manager.upload.stage(), /Reselect/);
  assert.equal(calls.length, before, 'unconfirmed capture cannot stage bytes');
  saveFault = false;
  await manager.upload.choose(file, '本地包.rho-plugin'); const originalRef = structuredClone(saved.upload.reference);
  chunkLost = true; await assert.rejects(manager.upload.stage(), /chunk acknowledgement lost/);
  assert.equal(chunks.size, 1);
  manager = new Manager(client, saved);
  await assert.rejects(manager.upload.stage(), /Reselect/);
  await manager.upload.inspect(); assert.equal(manager.state.upload.received, 65536);
  await assert.rejects(manager.upload.choose(new Blob(['different']), 'other.rho-plugin'), /exact retained file/);
  assert.deepEqual(manager.state.upload.reference, originalRef);
  await manager.upload.choose(file, 'same bytes with another name.rho-plugin');
  await manager.upload.stage(); assert.equal(manager.state.upload.inspection.revision, hash('a'));
  assert.deepEqual(Buffer.concat([...chunks.values()]), Buffer.from(data));
  assert.equal(records.length, 0, 'staging and inspection never import');
  manager.state.draft = 'Unsaved scenario 中文'; manager.state.selected = 'keep-selection';
  importLost = true; await assert.rejects(manager.importArchive(), /import acknowledgement lost/);
  await assert.rejects(manager.upload.discard(), /original request/);
  const original = structuredClone(saved);
  const replacement = new Manager({ ...client, view: { view: 'replacement', window: 'window' } }, original);
  await assert.rejects(replacement.dispatch(), /Only the original/);
  importLost = false; await replacement.recover();
  assert.equal(records.length, 1); assert.equal(replacement.state.pending, null);
  assert.equal(replacement.state.upload.imported.revision, hash('a'));
  assert.equal((await replacement.inspectArchiveImport()).operation.operation_id, records[0].operation.operation_id);
  assert.equal(replacement.state.upload.original.view, 'manager');
  assert.equal(replacement.state.draft, 'Unsaved scenario 中文'); assert.equal(replacement.state.selected, 'keep-selection');
  await assert.rejects(replacement.importArchive(), /Inspect a complete archive/);
  discardLost = true; await assert.rejects(replacement.upload.discard(), /discard acknowledgement lost/);
  assert.ok(replacement.state.upload, 'unconfirmed discard keeps the reference');
  await replacement.upload.discard(); assert.equal(replacement.state.upload, null); assert.equal(records.length, 1);

  manager = new Manager(client); await manager.upload.choose(file, 'uncertain.rho-plugin'); await manager.upload.stage();
  outcome = 'uncertain'; await assert.rejects(manager.importArchive(), /uncertain/); assert.ok(manager.state.pending);
  await assert.rejects(manager.recover(), /uncertain/); assert.equal(manager.state.upload.imported, null);
  assert.equal(calls.includes('plugins.archive_receipt'), false, 'catalog evidence cannot settle an uncertain Operation');
  assert.equal(records.length, 2);

  chunks.clear(); outcome = 'succeeded'; badReceipt = true;
  manager = new Manager(client); await manager.upload.choose(file, 'corrupt-reply.rho-plugin'); await manager.upload.stage();
  await assert.rejects(manager.importArchive(), /different archive or revision/); assert.ok(manager.state.pending); assert.equal(manager.state.upload.imported, null);
  const corrupted = structuredClone(manager.state); corrupted.upload.inspection.reference.digest = hash('f');
  assert.throws(() => new Manager(client, corrupted), /inspection does not match/);
  manager.upload.dispose(); await assert.rejects(manager.upload.choose(file, 'closed.rho-plugin'), /original request/);

  chunks.clear(); badReceipt = false;
  manager = new Manager(client); await manager.upload.choose(file, 'save-failure.rho-plugin'); await manager.upload.stage();
  const priorImports = records.length; saveAfterImport = true;
  await assert.rejects(manager.importArchive(), /save unconfirmed/);
  assert.ok(manager.state.pending, 'failed result persistence keeps the original intent');
  assert.ok(saved.pending, 'the acknowledged view state still contains that intent');
  assert.equal(saved.upload.imported, null, 'a reload must recover the original result');
  assert.equal(records.length, priorImports + 1);
  saveFault = false; saveAfterImport = false;
  manager = new Manager(client, saved); await manager.recover();
  assert.equal(records.length, priorImports + 1, 'recovery never dispatches another import');
  assert.equal(manager.state.pending, null); assert.ok(manager.state.upload.original);
  saveFault = true; await assert.rejects(manager.upload.discard(), /save unconfirmed/);
  assert.ok(manager.state.upload, 'failed cleanup persistence retains its exact reference');
  saveFault = false; manager = new Manager(client, saved); await manager.upload.discard();
  assert.equal(manager.state.upload, null); assert.equal(records.length, priorImports + 1);
  console.log('Manager archive capture, partial upload reselection, explicit import, lost replies, replacement-view recovery, uncertainty and receipt identity pass.');
}
