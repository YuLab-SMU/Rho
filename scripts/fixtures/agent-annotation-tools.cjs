// Deterministic external ACP peer; the Agent, MCP, Host and note owner are real.
module.exports = async ({cwd, sendRequest, catalog, rpc, save, session, prompts, prompt}) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const {randomUUID} = require('node:crypto');
  const input = JSON.parse(fs.readFileSync(path.join(cwd, 'native-annotation-input.json'), 'utf8'));
  const tools = catalog.structuredContent.tools;
  assert.deepEqual(tools.map(tool => tool.selection.name), input.write ? ['read', 'write'] : ['read']);
  for (const tool of tools) {
    assert.equal(tool.selection.target.type, 'provider');
    assert.deepEqual(tool.selection.target.binding.provider, input.provider);
  }
  const invocation = (tool, args) => ({send_request:sendRequest, tool_request:randomUUID(), tool, arguments:args, preconditions:null});
  const call = args => rpc('tools/call', {name:'rho_call', arguments:args});
  const original = await call(invocation('read', {kind:'read', annotation:input.original}));
  assert.notEqual(original.isError, true);
  assert.equal(original.structuredContent.result.data.revision.note, 'Check the original 🧬 result');
  const evidence = {session, prompts, send_request:sendRequest, original:original.structuredContent.result.data, writes:[]};
  if (input.image) {
    const images=prompt.filter(part=>part.type==='image');assert.equal(images.length,1);
    assert.equal(images[0].mimeType,'image/png');const bytes=Buffer.from(images[0].data,'base64');
    assert.equal(bytes.length,input.image.bytes);assert.equal('sha256:'+require('node:crypto').createHash('sha256').update(bytes).digest('hex'),input.image.sha256);
    evidence.image_verified=true;
  } else assert.equal(prompt.filter(part=>part.type==='image').length,0);
  const create = {request_id:'native-note-create', command:{kind:'create', evidence_id:input.evidence_id, note:'Agent-authored note 中文 🧬', labels:[], marks:[], continued_from:null}};
  if (!input.write) {
    await rpc('tools/call', {name:'rho_call', arguments:invocation('write', create)}, randomUUID(), -32602);
    evidence.unselected_write_refused = true;
  } else {
    // Model arguments cannot invent a principal/author field.
    await rpc('tools/call', {name:'rho_call', arguments:invocation('write', {...create, author:{kind:'human',id:'forged'}})}, randomUUID(), -32602);
    evidence.forged_author_refused = true;
    const write = async (args, status) => {
      const request = invocation('write', args), result = await call(request);
      assert.equal(result.structuredContent.result.status, status, JSON.stringify(result));
      assert.deepEqual(await call(request), result, 'Exact native retry must retain the original result');
      evidence.writes.push({invocation:request, result:result.structuredContent});
      save(evidence);
      return result.structuredContent.result.output;
    };
    const created = await write(create, 'succeeded');
    const first = created.outcome.annotation;
    const changed = await write({request_id:'native-note-update', command:{kind:'update', expected:first, note:'Agent revised note 中文 🧬', labels:[], marks:[]}}, 'succeeded');
    await write({request_id:'native-note-stale', command:{kind:'update', expected:first, note:'Must not overwrite', labels:[], marks:[]}}, 'failed');
    const retained = await call(invocation('read', {kind:'read', annotation:changed.outcome.annotation}));
    assert.notEqual(retained.isError, true);
    assert.equal(retained.structuredContent.result.data.revision.note, 'Agent revised note 中文 🧬');
    assert.deepEqual(retained.structuredContent.result.data.evidence, evidence.original.evidence);
    assert.deepEqual(retained.structuredContent.result.data.revision.author, evidence.original.revision.author);
    const failed = await call(invocation('read', {kind:'receipt', request_id:'native-note-stale'}));
    assert.equal(failed.structuredContent.result.data.receipt, null);
    evidence.current = retained.structuredContent.result.data;
  }
  save(evidence);
};
