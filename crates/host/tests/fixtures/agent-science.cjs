#!/usr/bin/env node
// Local ACP peer for ordinary-plugin acceptance. Never contacts a model or reads
// native credentials; all fixture input and evidence belong to its disposable cwd.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {randomUUID, createHash} = require('node:crypto');
// Backend processes inherit only PATH/locale. The disposable launcher directory
// supplies this marker without weakening the Host's environment boundary.
assert.equal(fs.readFileSync(path.join(__dirname, 'rho-science-fixture'), 'utf8'), 'disposable');
let cwd, session, endpoint, headers, mcpSession, pending, prompts = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => send({jsonrpc:'2.0', id, result:value});
const config = () => [{id:'model', category:'model', type:'select', name:'Model', currentValue:'fixture', options:[{value:'fixture', name:'Fixture'}]}];
const save = value => {
  const temporary = path.join(cwd, 'native-science-evidence.tmp');
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, path.join(cwd, 'native-science-evidence.json'));
};
async function rpc(method, params, id = randomUUID(), expectedErrorCode) {
  const response = await fetch(endpoint, {method:'POST', headers:{...headers, 'content-type':'application/json', accept:'application/json, text/event-stream', 'mcp-protocol-version':'2025-06-18', ...(mcpSession ? {'mcp-session-id':mcpSession} : {})}, body:JSON.stringify({jsonrpc:'2.0', ...(id === null ? {} : {id}), method, params}), signal:AbortSignal.timeout(60000)});
  assert.ok(response.ok);
  mcpSession ??= response.headers.get('mcp-session-id');
  const text = await response.text();
  if (id === null) return;
  let value;
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    // Stream initialization/keepalive events can contain an empty data field.
    // Parse complete SSE events, preserving multiline JSON and ignoring only
    // events with no payload; malformed nonempty events remain fixture failures.
    const messages = text.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      return data.trim() ? [JSON.parse(data)] : [];
    });
    value = messages.find(item => item.id === id);
  } else if (text.trim()) value = JSON.parse(text);
  assert.equal(value?.id, id, `${method}: missing correlated MCP response (HTTP ${response.status})`);
  if (expectedErrorCode !== undefined) {
    assert.equal(value.error?.code, expectedErrorCode, `${method}: expected a protocol refusal`);
    assert.equal(value.result, undefined);
    return value.error;
  }
  assert.equal(value.error, undefined, `${method}: MCP returned an error`);
  return value.result;
}
async function prompt(message) {
  const id = message.id;
  pending = id;
  prompts++;
  const text = message.params.prompt.filter(p => p.type === 'text').map(p => p.text).join('\n');
  const sendRequest = text.match(/Use rho_call with send_request=([0-9a-f-]{36}) /)?.[1];
  assert.ok(sendRequest, 'Original Send identity must arrive through native input');
  assert.ok(endpoint, 'A discovery session cannot start a scientific turn');
  const attachments = message.params.prompt.filter(p => p.type === 'resource').map(p => ({
    mime_type: p.resource.mimeType, bytes: Buffer.byteLength(p.resource.text),
    sha256: createHash('sha256').update(p.resource.text).digest('hex'),
  }));
  const expectedAttachments = path.join(cwd, 'native-science-attachments.json');
  if (fs.existsSync(expectedAttachments)) assert.deepEqual(attachments, JSON.parse(fs.readFileSync(expectedAttachments, 'utf8')));
  let contexts = [];
  const expectedContext = path.join(cwd, 'native-science-context.json');
  if (fs.existsSync(expectedContext)) {
    const captured = message.params.prompt.find(part => part.type === 'text' && part.text.startsWith('User-selected source context for this original Send.'));
    assert.ok(captured, 'The actual captured source bytes must reach native Agent input');
    contexts = JSON.parse(captured.text.slice(captured.text.indexOf('[')));
    const expected = JSON.parse(fs.readFileSync(expectedContext, 'utf8'));
    assert.equal(contexts.length, 1); assert.deepEqual(contexts[0].selection, expected.selection); assert.equal(contexts[0].text, expected.text);
  }
  if (!mcpSession) {
    await rpc('initialize', {protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'rho-science-fixture', version:'1'}});
    await rpc('notifications/initialized', {}, null);
  }
  const catalog = await rpc('tools/call', {name:'rho_tools', arguments:{send_request:sendRequest}});
  if (fs.existsSync(path.join(cwd, 'native-studio-input.json'))) {
    await require('./agent-studio-tools.cjs')({cwd, sendRequest, catalog, rpc, save, session, prompts});
    send({jsonrpc:'2.0', method:'session/update', params:{sessionId:session, update:{sessionUpdate:'agent_message_chunk', content:{type:'text', text:'The selected Studio branch has a new checkpoint. Build and preview it in Studio.'}}}});
    result(id, {stopReason:'end_turn'});
    pending = null;
    return;
  }
  if (fs.existsSync(path.join(cwd, 'native-core-input.json'))) {
    await require('./agent-core-tools.cjs')({cwd, sendRequest, catalog, rpc, save, session, prompts});
    result(id, {stopReason:'end_turn'});
    pending = null;
    return;
  }
  assert.equal(catalog.structuredContent.tools.length, 1);
  assert.equal(catalog.structuredContent.tools[0].selection.name, 'execute');
  const input = JSON.parse(fs.readFileSync(path.join(cwd, 'native-science-input.json'), 'utf8'));
  const invocation = {send_request:sendRequest, tool_request:randomUUID(), tool:'execute', arguments:input, preconditions:null};
  const evidence = {session, prompts, invocation, attachments, contexts};
  save(evidence);
  const original = await rpc('tools/call', {name:'rho_call', arguments:invocation});
  assert.notEqual(original.isError, true);
  assert.equal(original.structuredContent.result.status, 'succeeded');
  const stopped = pending !== id;
  if (!stopped) {
    assert.deepEqual(await rpc('tools/call', {name:'rho_call', arguments:invocation}), original);
    const history = path.join(cwd, 'native-science-history.json');
    if (fs.existsSync(history)) {
      const {messages} = JSON.parse(fs.readFileSync(history, 'utf8'));
      assert.ok(Number.isInteger(messages) && messages > 0 && messages <= 120);
      for (let index = 1; index <= messages; index++) {
        send({jsonrpc:'2.0', method:'session/update', params:{sessionId:session, update:{sessionUpdate:'agent_message_chunk', content:{type:'text', text:`History sample ${String(index).padStart(3, '0')} 中文`}}}});
        // Distinct native activity separates adjacent ACP message chunks. This
        // reports local fixture activity and never issues another scientific call.
        send({jsonrpc:'2.0', method:'session/update', params:{sessionId:session, update:{sessionUpdate:'tool_call', toolCallId:`history-${index}`, title:`Local history marker ${index}`, status:'completed'}}});
      }
    }
    send({jsonrpc:'2.0', method:'session/update', params:{sessionId:session, update:{sessionUpdate:'agent_message_chunk', content:{type:'text', text:'Original scientific result observed 中文'}}}});
    result(id, {stopReason:'end_turn'});
    pending = null;
  }
  save({...evidence, result:original.structuredContent, stopped});
}
const lines = readline.createInterface({input:process.stdin});
lines.on('line', line => {
  const message = JSON.parse(line), p = message.params || {};
  if (message.method === 'initialize') result(message.id, {protocolVersion:1, agentInfo:{name:'Local scientific fixture', version:'1'}, agentCapabilities:{loadSession:true, promptCapabilities:{embeddedContext:true}, sessionCapabilities:{close:{}}}});
  else if (message.method === 'session/new' || message.method === 'session/load') {
    cwd = p.cwd; session = message.method === 'session/load' ? p.sessionId : randomUUID();
    assert.ok(p.mcpServers.length <= 1);
    endpoint = p.mcpServers[0]?.url;
    if (endpoint) {
      assert.equal(new URL(endpoint).hostname, '127.0.0.1');
      headers = Object.fromEntries(p.mcpServers[0].headers.map(h => [h.name,h.value]));
    }
    const retainedSession = path.join(cwd, 'native-science-session.json');
    if (message.method === 'session/load') {
      assert.equal(JSON.parse(fs.readFileSync(retainedSession, 'utf8')).session, session);
      const resumed = path.join(cwd, 'native-science-resumes.json');
      const count = fs.existsSync(resumed) ? JSON.parse(fs.readFileSync(resumed, 'utf8')).resumes : 0;
      fs.writeFileSync(resumed, JSON.stringify({session, resumes:count + 1, prompts}));
    } else if (endpoint) fs.writeFileSync(retainedSession, JSON.stringify({session}));
    result(message.id, {sessionId:session, configOptions:config()});
  } else if (message.method === 'session/set_config_option') result(message.id, {configOptions:config()});
  else if (message.method === 'session/prompt') void prompt(message).catch(error => {
    save({prompts, error:error.message});
    if (pending === message.id) send({jsonrpc:'2.0', id:message.id, error:{code:-32603, message:'Local scientific fixture failed; inspect disposable evidence'}});
    pending = null;
  });
  else if (message.method === 'session/cancel' || message.method === 'session/close') {
    if (pending) result(pending, {stopReason:'cancelled'});
    pending = null;
    if (message.id !== undefined) result(message.id, {});
  } else if (message.id !== undefined) send({jsonrpc:'2.0', id:message.id, error:{code:-32601, message:'Unsupported fixture method'}});
});
lines.on('close', () => process.exit(0));
