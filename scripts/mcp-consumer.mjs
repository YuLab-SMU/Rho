import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import * as fs from 'node:fs/promises';

export async function connectMcp(packageRoot, connectionFile, observe = () => {}) {
  const entry = await fs.realpath(path.join(packageRoot, 'node_modules/@rho-workspace/plugin-agent/dist/mcp.js'));
  const require = createRequire(entry);
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  const client = new Client({ name: 'rho-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { PATH: process.env.PATH, RHO_AGENT_CONNECTION: connectionFile }, stderr: 'pipe' });
  transport.stderr.resume();
  await client.connect(transport);
  const call = client.callTool.bind(client);
  client.callTool = async (...args) => { const reply = await call(...args); observe(args[0], reply); return reply; };
  return client;
}

export const mcpToolNames = ['rho_index', 'rho_resolve', 'rho_call', 'rho_read'];
export async function mcpEnvelope(client, name, input = {}) {
  const reply = await client.callTool({ name, arguments: input });
  assert.equal('structuredContent' in reply, false);
  return JSON.parse(reply.content[0].text);
}
export async function resolveOperation(client, operation) {
  const index = await mcpEnvelope(client, 'rho_index', { search: operation, maxBytes: 65536 });
  if (!index.ok) return index;
  const entry = index.value.entries.find(e => e.id === operation);
  if (!entry) return { ok: false, error: { kind: 'scope', message: 'Operation is not available in the selected grant.' } };
  let cursor = null;
  do {
    const page = await mcpEnvelope(client, 'rho_resolve', { catalogRef: index.value.catalogRef, selected: [operation], cursor, maxBytes: 65536 });
    if (!page.ok) return page;
    cursor = page.value.next;
    assert.ok(page.value.complete || page.value.items.length, 'whole contract page advances');
  } while (cursor);
  return { ok: true, entry };
}
// Acceptance clients may reconstruct all pages. The product's model receives only
// the page it requested; no hidden tool fetch expands the model's context.
async function readResult(client, ref, pointer = '') {
  let offset = 0, value;
  for (;;) {
    const result = await mcpEnvelope(client, 'rho_read', { ref, path: pointer, offset, maxBytes: 65536 });
    assert.equal(result.ok, true, JSON.stringify(result));
    const page = result.value;
    if (page.type === 'string') value = (value ?? '') + page.value;
    else if (page.type === 'object' || page.type === 'array') {
      value ??= page.type === 'array' ? [] : Object.create(null);
      for (const entry of page.entries) value[entry.key] = Object.hasOwn(entry, 'value') ? entry.value : await readResult(client, ref, entry.path);
    } else return page.value;
    if (page.complete) return value;
    assert.ok(page.next > offset); offset = page.next;
  }
}
export async function callOperation(client, operation, input = {}, maxBytes = 65536) {
  const resolved = await resolveOperation(client, operation);
  if (!resolved.ok) return resolved;
  const result = await mcpEnvelope(client, 'rho_call', { operation, contractRef: resolved.entry.contractRef, input, maxBytes });
  if (result.result?.ref) {
    const value = await readResult(client, result.result.ref);
    await mcpEnvelope(client, 'rho_read', { ref: result.result.ref, release: true });
    return value;
  }
  return result;
}
