import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function annotationNativeAgent({agent, notes, original, evidenceId, image, project, invoke, binding, pluginQuery, query, port}) {
  const control = value => ({task_id:value.detail.summary.task.task_id, generation:value.detail.summary.attachment.generation});
  const commandBinding = await binding(agent, 'agent.native.command');
  const command = async command => (await invoke('agent.native.command', {binding:commandBinding, arguments:{request_id:randomUUID(), command}})).output;
  let task = await command({kind:'create', provider:'kimi', model:'fixture', effort:null});
  task = await command({kind:'connect', control:control(task)});
  const sends = [], writes = [];
  const nativeEvidence = () => JSON.parse(fs.readFileSync(path.join(project, 'native-science-evidence.json'), 'utf8'));
  for (const writable of [false, true]) {
    task = await command({kind:'save_draft', control:control(task), version:task.detail.draft.version,
      content:{text:writable ? 'Read the original note, create a related note, then revise that new note.' : 'Read the selected note only.', assets:[], context:!writable && image ? [image.selection] : []}});
    fs.writeFileSync(path.join(project, 'native-annotation-input.json'), JSON.stringify({write:writable, provider:notes, original, evidence_id:evidenceId, image:!writable && image ? {sha256:image.context.resources[0].digest,bytes:image.bytes.length} : null}));
    const tools = [{name:'read', target:{type:'provider', binding:await binding(notes, 'annotations.read')}}];
    if (writable) tools.push({name:'write', target:{type:'provider', binding:await binding(notes, 'annotations.write')}});
    const input = {binding:commandBinding, arguments:{request_id:randomUUID(), command:{kind:'send', control:control(task), draft_version:task.detail.draft.version}, tools}};
    const parent = await invoke('agent.native.command', input);
    const evidence = nativeEvidence();
    assert.equal(evidence.error, undefined, JSON.stringify(evidence));
    assert.equal(evidence.send_request, input.arguments.request_id);
    assert.equal(evidence.prompts, writable ? 2 : 1);
    if (!writable && image) assert.equal(evidence.image_verified,true);
    assert.equal(parent.output.receipt.status, 'succeeded');
    assert.equal(writable ? evidence.forged_author_refused : evidence.unselected_write_refused, true);
    if (!writable) assert.equal((await pluginQuery(notes, 'annotations.read', {kind:'receipt', request_id:'native-note-create'})).receipt, null);
    for (const write of evidence.writes) {
      const lookup = {send_request:input.arguments.request_id, tool_request:write.invocation.tool_request};
      const tool = await pluginQuery(agent, 'agent.native.tool', lookup);
      assert.equal(tool.phase, 'resolved');
      const child = (await query('operation.get', {operation_id:tool.operation})).record;
      assert.equal(child.operation.causation_id, parent.operation.operation_id);
      assert.deepEqual(child.operation.caller, {kind:'plugin', id:agent.instance});
      assert.equal(child.operation.capability.id, 'annotations.write');
      assert.deepEqual(child.operation.normalized_arguments.binding.provider, notes);
      assert.equal(child.status, write.result.result.status);
      assert.deepEqual(child.output, write.result.result.output);
      assert.equal((await pluginQuery(agent, 'agent.native.tool.operation', lookup)).operation.operation_id, tool.operation);
      writes.push({lookup, tool, child});
    }
    assert.equal((await invoke('agent.native.command', input)).output.receipt.status, 'succeeded');
    assert.equal(nativeEvidence().prompts, writable ? 2 : 1);
    sends.push({input, operation:parent.operation.operation_id, evidence});
    task = parent.output;
  }
  assert.equal(writes.length, 3);
  const verifyOperations = async () => {
    const records = [];
    let before_cursor = null;
    for (let page = 0; page < 10; page++) {
      // A journal page is a bounded observation, explicitly labelled partial.
      // Walk its cursors; each matching original record is then read in full.
      const observation = await port('query_snapshot', {capability:{id:'operation.list_recent',version:1}, arguments:{limit:100, before_cursor}});
      assert.equal(observation.status, 'ready');
      assert.ok(['complete', 'partial'].includes(observation.completeness));
      const result = observation.data;
      records.push(...result.operations);
      before_cursor = result.next_cursor;
      if (before_cursor === null) break;
    }
    assert.equal(before_cursor, null, 'Bounded original Operation history');
    const writesToInspect = records.filter(record => record.capability.id === 'annotations.write');
    const details = [];
    // Adding source cases must not saturate the Host's bounded query admission.
    // Inspect all records (including unexpected writes), in bounded batches.
    for (let start = 0; start < writesToInspect.length; start += 4) {
      details.push(...await Promise.all(writesToInspect.slice(start, start + 4)
        .map(async record => (await query('operation.get', {operation_id:record.operation_id})).record)));
    }
    const children = details.filter(record => record.operation.caller.id === agent.instance);
    assert.deepEqual(children.map(record => record.operation.operation_id).sort(), writes.map(({tool}) => tool.operation).sort(), 'Exactly the three original writes; no duplicate or forged-author Operation');
  };
  await verifyOperations();
  const report = {peer:'local deterministic ACP fixture', task:control(task).task_id, sends, writes, restart_verified:false};
  return {report, async afterRestart() {
    assert.equal((await query('plugins.instance', {instance:notes})).instance.state, 'suspended');
    for (const {input} of sends) assert.equal((await invoke('agent.native.command', input)).output.receipt.status, 'succeeded');
    for (const {lookup, tool} of writes) assert.deepEqual(await pluginQuery(agent, 'agent.native.tool', lookup), tool);
    assert.equal(nativeEvidence().prompts, 2, 'Send retry after Host restart must not invoke the peer');
    assert.equal((await query('plugins.instance', {instance:notes})).instance.state, 'suspended');
    await verifyOperations();
    report.restart_verified = true;
  }, async afterSourceResume() {
    const current = sends[1].evidence.current;
    assert.deepEqual(await pluginQuery(notes, 'annotations.read', {kind:'read', annotation:current.revision.annotation}), current);
    report.annotation_restored = true;
  }};
}
