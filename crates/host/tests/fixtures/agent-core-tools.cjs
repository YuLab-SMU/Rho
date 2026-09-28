// Local acceptance only: exact Host tools through the native peer's private MCP.
module.exports = async ({cwd, sendRequest, catalog, rpc, save, session, prompts}) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const {randomUUID} = require('node:crypto');
  const input = JSON.parse(fs.readFileSync(path.join(cwd, 'native-core-input.json'), 'utf8'));
  const tools = catalog.structuredContent.tools;
  assert.deepEqual(tools.map(tool => tool.selection.name), ['head', 'checkpoint']);
  for (const tool of tools) {
    assert.equal(tool.selection.target.type, 'host');
    assert.deepEqual(tool.selection.target.fixed_arguments, {branch: input.branch});
    assert.equal(tool.input_schema.properties.branch, undefined);
    assert.ok(!tool.input_schema.required?.includes('branch'));
  }
  const invoke = (tool, args) => ({send_request:sendRequest, tool_request:randomUUID(), tool, arguments:args, preconditions:null});
  const head = await rpc('tools/call', {name:'rho_call', arguments:invoke('head', {})});
  assert.notEqual(head.isError, true);
  assert.equal(head.structuredContent.result.data.revision, input.arguments.expected_head);
  // Admission refuses a replaced captured field before tool execution, so this
  // is a correlated JSON-RPC invalid-params error, not an executed tool result.
  const denied = await rpc('tools/call', {name:'rho_call', arguments:invoke('checkpoint', {...input.arguments, branch:input.other_branch})}, randomUUID(), -32602);
  assert.match(denied.message, /Model arguments cannot replace a captured Host field/);
  const invocation = invoke('checkpoint', input.arguments);
  save({session, prompts, invocation});
  const original = await rpc('tools/call', {name:'rho_call', arguments:invocation});
  assert.notEqual(original.isError, true);
  assert.equal(original.structuredContent.result.status, 'succeeded');
  assert.equal(original.structuredContent.result.output.branch, input.branch);
  assert.deepEqual(await rpc('tools/call', {name:'rho_call', arguments:invocation}), original);
  save({session, prompts, invocation, result:original.structuredContent, rejected_scope_replacement:true});
};
