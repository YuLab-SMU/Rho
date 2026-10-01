// Real contained Files observations; no browser annotation editor is exercised.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function annotationFiles({files, notes, window, project, binding, invoke, pluginQuery, query, port}) {
  const name = '注释-source.R', filename = path.join(project, name);
  const original = 'a🧬中z\r\nprint(42)\n';
  fs.writeFileSync(filename, original);
  const observe = async () => {
    // Files' bounded read port reports partial observations even when this small
    // page is complete; the contributed preview itself must be complete.
    const observation = await port('query_snapshot', {capability: {id: 'files.read_text', version: 1}, arguments: {binding: await binding(files, 'files.read_text'), arguments: {path: name}}});
    assert.equal(observation.status, 'ready');
    assert.ok(['partial', 'complete'].includes(observation.completeness));
    const page = observation.data;
    assert.equal(page.complete, true);
    assert.ok(page.file);
    const reference = {provider: files, contribution: 'files', window, selector: page.file};
    const preview = await pluginQuery(files, 'files.context.preview', {reference, inclusion: {kind: 'text'}, max_bytes: 16384});
    assert.equal(preview.truncated, false);
    return {reference, preview};
  };
  const write = async (request_id, command, request = randomUUID(), expected = 'succeeded') =>
    invoke('annotations.write', {binding: await binding(notes, 'annotations.write'), arguments: {request_id, command}}, request, expected);
  const first = await observe(), quote = '🧬中';
  const start = first.preview.text.indexOf(quote);
  assert.ok(start > 0);
  const command = {kind: 'freeze', reference: first.reference, inclusion: {kind: 'text'}, anchor: {kind: 'text_quote', quote, start, end: start + quote.length, unit: 'utf16'}};
  const frozen = await write('file-freeze', command, 'host-file-freeze');
  const create = {kind: 'create', evidence_id: frozen.output.outcome.evidence_id, note: 'Review original file quote', labels: [], marks: [], continued_from: null};
  const saved = await write('file-note', create);
  const annotation = saved.output.outcome.annotation;
  const record = await pluginQuery(notes, 'annotations.read', {kind: 'read', annotation});
  assert.equal(record.evidence.fragment.text, quote);
  assert.deepEqual(record.evidence.selection.reference, first.reference);
  assert.equal(record.evidence.source.source_version, first.preview.data.annotation_source.source_version);
  const notePreview = {reference: {provider: notes, contribution: 'annotations', window, selector: annotation}, inclusion: {kind: 'note_and_evidence'}, max_bytes: 16384};
  const context = await pluginQuery(notes, 'annotations.context.preview', notePreview);
  assert.ok(context.text.includes(quote));
  const fresh = await observe();
  assert.deepEqual(fresh.preview.data.annotation_source, first.preview.data.annotation_source);
  fs.writeFileSync(filename, 'changed file version\n');
  const changed = await observe();
  assert.equal(changed.preview.data.annotation_source.source_id, first.preview.data.annotation_source.source_id);
  assert.notEqual(changed.preview.data.annotation_source.source_version, first.preview.data.annotation_source.source_version);
  await write('file-stale', command, randomUUID(), 'failed');
  assert.equal((await pluginQuery(notes, 'annotations.read', {kind: 'receipt', request_id: 'file-stale'})).receipt, null);
  // Atomic save of the original bytes changes the native observation, not its
  // content version. The obsolete reference still cannot capture it anew.
  fs.writeFileSync(filename + '.next', original);
  fs.renameSync(filename + '.next', filename);
  const replaced = await observe();
  assert.notEqual(replaced.reference.selector.native_identity, first.reference.selector.native_identity);
  assert.deepEqual(replaced.preview.data.annotation_source, first.preview.data.annotation_source);
  await write('file-replaced-stale', command, randomUUID(), 'failed');
  const newCommand = {...command, reference: replaced.reference};
  await write('file-replaced-fresh', newCommand);
  assert.deepEqual(await pluginQuery(notes, 'annotations.read', {kind: 'read', annotation}), record);
  const report = {files, annotation, source: record.evidence.source, repeated_observation_stable: true, changed_source_refused: true, atomic_save_stable: true, restart_verified: false};
  return {report, async afterRestart() {
    assert.equal((await query('plugins.instance', {instance: files})).instance.state, 'suspended');
    assert.deepEqual((await write('file-freeze', command)).output, frozen.output);
    assert.equal((await write('file-freeze', command, 'host-file-freeze')).operation.operation_id, frozen.operation.operation_id);
    assert.deepEqual((await write('file-note', create)).output, saved.output);
    assert.deepEqual(await pluginQuery(notes, 'annotations.read', {kind: 'read', annotation}), record);
    assert.deepEqual(await pluginQuery(notes, 'annotations.context.preview', notePreview), context);
    await write('file-unavailable', newCommand, randomUUID(), 'failed');
    assert.equal((await pluginQuery(notes, 'annotations.read', {kind: 'receipt', request_id: 'file-unavailable'})).receipt, null);
    assert.equal((await query('plugins.instance', {instance: files})).instance.state, 'suspended');
    report.restart_verified = true;
  }};
}
