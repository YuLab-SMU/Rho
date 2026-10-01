// Local ACP peer only. Agent/MCP/Host/Process and the launched process are real.
module.exports = async ({cwd, sendRequest, catalog, rpc, save, session, prompts}) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const {randomUUID, createHash} = require('node:crypto');
  const input = JSON.parse(fs.readFileSync(path.join(cwd, 'native-process-input.json'), 'utf8'));
  const tools = catalog.structuredContent.tools;
  assert.deepEqual(tools.map(tool => tool.selection.name), input.mode === 'readonly' ? ['prepare'] : ['prepare', 'run', 'read']);
  assert.deepEqual(tools[0].selection.target.binding.provider, input.provider);
  const invocation = (tool, arguments_) => ({send_request:sendRequest, tool_request:randomUUID(), tool, arguments:arguments_, preconditions:null});
  const call = arguments_ => rpc('tools/call', {name:'rho_call', arguments:arguments_});
  const prepared = await call(invocation('prepare', {capability:{id:'process.run_local',version:2}, arguments:input.arguments, preconditions:[], target:null}));
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
  const args = prepared.structuredContent.result.data.arguments;
  assert.equal(args.program, input.arguments.program);
  const evidence = {session, prompts, send_request:sendRequest, mode:input.mode, prepared:prepared.structuredContent.result.data};
  if (input.mode === 'readonly') {
    await rpc('tools/call', {name:'rho_call', arguments:invocation('run', args)}, randomUUID(), -32602);
    save({...evidence, unselected_run_refused:true}); return;
  }
  assert.deepEqual(tools[1].selection.target.binding.provider, input.provider);
  // A model cannot smuggle another provider into the run's argument schema.
  await rpc('tools/call', {name:'rho_call', arguments:invocation('run', {...args, binding:{provider:'forged'}})}, randomUUID(), -32602);
  const request = invocation('run', args);
  save({...evidence, invocation:request, forged_binding_refused:true});
  const original = await call(request);
  assert.notEqual(original.isError, true, JSON.stringify(original));
  assert.equal(original.structuredContent.result.status, 'succeeded', JSON.stringify(original));
  if (input.mode === 'stop') return; // The stopped peer need not receive a reply.
  assert.deepEqual(await call(request), original, 'A native tool retry must not replay the process');
  const reference = original.structuredContent.result.output.report;
  assert.deepEqual(reference.owner, input.provider);
  const chunks = []; let offset = 0;
  do {
    const reply = await call(invocation('read', {reference, offset, limit:65536}));
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    const page = reply.structuredContent.result.data;
    assert.deepEqual(page.reference, reference); assert.equal(page.offset, offset);
    chunks.push(Buffer.from(page.base64, 'base64'));
    if (page.next == null) break;
    assert.ok(page.next > offset); offset = page.next;
  } while (chunks.length < 8);
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, reference.bytes);
  assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'), reference.digest);
  const report = JSON.parse(bytes);
  assert.equal(Buffer.from(report.stdout.bytes).toString(), input.arguments.stdin);
  assert.equal(Buffer.from(report.stderr.bytes).toString(), 'process stderr 中文');
  assert.equal(report.exit_code, 0); assert.equal(report.termination, 'exited');
  save({...evidence, invocation:request, forged_binding_refused:true, result:original.structuredContent, report, resource_verified:true});
};
