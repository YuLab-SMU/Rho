import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Extensions } from './extensions.js';
import { RhoClient } from './client.js';

const help = `Independent Rho plugins (API 1)
  rho plugin create DIRECTORY [--id my-plugin]
  rho plugin check DIRECTORY
  rho plugin add SOURCE [--connection FILE]
  rho plugin list
  rho plugin market list
  rho plugin market add URL
  rho plugin market refresh|remove ID
  rho plugin market install ID PLUGIN_ID
  rho plugin update ID [--source SOURCE]
  rho plugin enable|disable|remove ID
  rho plugin dev DIRECTORY
  rho plugin call ID OPERATION --project RELATIVE_FOLDER --input JSON [--change-id ID]

SOURCE: npm package, local folder/.tgz, public HTTPS .tgz, or
git+https://host/repo.git#ref:relative/package
Management uses the running Rho's private connection file (default ~/Rho/state/connection.json).
Only install packages you trust: hosts run native code with your OS permissions.
Install skips lifecycle scripts. Build packages before adding them.
dev watches source and installs checked snapshots; an invalid edit keeps the previous version.
Remove preserves project files, live sessions, receipts and retained package revisions.
`;
export async function pluginCli(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { connection: { type: 'string' }, id: { type: 'string' }, source: { type: 'string' }, project: { type: 'string' }, input: { type: 'string' }, 'change-id': { type: 'string' }, help: { type: 'boolean' } } });
  const [command, target, operation, marketPlugin] = positionals;
  if (values.help || !command) { process.stdout.write(help); return; }
  if (command === 'create') {
    if (!target) throw new Error('Name a new plugin directory.');
    const id = values.id ?? path.basename(path.resolve(target));
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(id)) throw new Error('Use a lowercase plugin id containing letters, digits, dots, underscores or hyphens.');
    await fs.mkdir(path.resolve(target));
    const manifest = { apiVersion: 1, id, title: id, description: 'An independent Rho plugin.', host: 'host.mjs', operations: [
      { id: 'greet', title: 'Greet', description: 'Return a greeting without changing project data.', effect: 'read', methods: [], inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 120 } }, required: ['name'], additionalProperties: false } },
      { id: 'read-status', title: 'Read task status', description: 'Read the project task map and Agent sessions for a live status panel.', effect: 'read', methods: ['task.map.read', 'agent.sessions.list'], inputSchema: { type: 'object', additionalProperties: false } }
    ], skills: [{ id: 'guide', title: 'Use this plugin', file: 'SKILL.md' }], views: [{ id: 'main', title: id, file: 'view.html' }] };
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'rho-plugin-' + id, version: '0.1.0', type: 'module', license: 'MIT', rhoPlugin: 'rho-plugin.json', files: ['rho-plugin.json', 'host.mjs', 'view.html', 'SKILL.md'] }, null, 2) + '\n',
      'rho-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
      'host.mjs': `export async function run(operation, input, context) {
  if (operation === 'greet') return { greeting: 'Hello, ' + input.name + '!' };
  if (operation === 'read-status') {
    const [taskMap, agents] = await Promise.all([
      context.call('task.map.read', {}),
      context.call('agent.sessions.list', {})
    ]);
    return { taskMap, agents };
  }
  throw new Error('Unknown operation');
}
`,
      'SKILL.md': `# ${id}

Read \`extension.describe\` for the installed digest and operation schemas. The generated view reads the project's task map and Agent sessions through \`read-status\`.

The status operation is read-only. A missing task map or an unavailable Agent session is data to show as an empty or error state. It must not start work. Keep \`expectedDigest\` and a stable \`changeId\` for native operations, then use \`extension.read\` after a lost reply.
`,
      'view.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${id}</title>
<style>
  :root { color-scheme: light; --ink: #202927; --muted: #68736f; --line: #e1e6e3; --well: #f3f5f5; --accent: #1e6b52; --accent-soft: #e5f1e9; --failed: #b13f38; --failed-soft: #fbeeed; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px 22px 28px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #fff; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .mark { flex: none; width: 38px; height: 38px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); display: grid; place-content: center; font-weight: 600; font-size: 17px; }
  h1 { margin: 0; font-size: 17px; line-height: 1.3; font-weight: 650; }
  header p { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
  form { max-width: 520px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 10px; }
  label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; }
  .row { display: flex; gap: 8px; }
  input, button { min-height: 34px; padding: 6px 12px; border: 1px solid #cbd3ce; border-radius: 7px; font: inherit; color: inherit; background: #fff; }
  input { flex: 1; min-width: 0; }
  button { flex: none; font-weight: 500; cursor: pointer; color: #fff; background: var(--accent); border-color: var(--accent); }
  button:disabled { opacity: .55; cursor: default; }
  output { display: block; margin-top: 14px; padding: 11px 14px; border-radius: 8px; background: var(--well); white-space: pre-wrap; overflow-wrap: anywhere; }
  output:empty { display: none; }
  output.failed { color: var(--failed); background: var(--failed-soft); }
  .note { margin: 14px 0 0; font-size: 12px; color: var(--muted); }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
</style></head>
<body>
<header><span class="mark" aria-hidden="true">${id.charAt(0).toUpperCase()}</span><div><h1>${id}</h1><p>Task map and Agent activity from the current Rho project.</p></div><button id="refresh" type="button">Refresh</button></header>
<main aria-live="polite"><p id="state">Loading project status…</p><section id="tasks" hidden><h2>Tasks</h2><ul></ul></section><section id="agents" hidden><h2>Agents</h2><ul></ul></section></main>
<p class="note">This starter reads \`task.map.read\` and \`agent.sessions.list\`. It keeps loading, empty and error states visible so you can replace the view safely.</p>
<script>
  const state = document.querySelector('#state'), refresh = document.querySelector('#refresh');
  const tasks = document.querySelector('#tasks'), agents = document.querySelector('#agents');
  const list = (section, values, empty) => { const ul = section.querySelector('ul'); ul.replaceChildren(); for (const value of values) { const li = document.createElement('li'); li.textContent = value; ul.append(li); } section.hidden = values.length === 0; if (!values.length && empty) { const li = document.createElement('li'); li.textContent = empty; ul.append(li); section.hidden = false; } };
  async function load() {
    state.className = ''; state.textContent = 'Loading project status…'; refresh.disabled = true;
    try {
      const receipt = await rho.call('read-status');
      if (receipt.state !== 'completed') throw new Error(receipt.error || receipt.state);
      const taskItems = receipt.value.taskMap?.items ?? [];
      const agentItems = receipt.value.agents?.sessions ?? [];
      list(tasks, taskItems.map(item => item.title + ' · ' + item.state), 'No task map has been declared.');
      list(agents, agentItems.map(agent => agent.name || agent.id || 'Agent'), 'No Agent session is visible.');
      state.textContent = 'Updated just now';
    } catch (error) { state.className = 'failed'; state.textContent = 'Could not read project status: ' + error.message; tasks.hidden = true; agents.hidden = true; }
    finally { refresh.disabled = false; }
  }
  refresh.addEventListener('click', load); load();
</script>
</body></html>
`,
      'README.md': `# ${id}\n\nDevelop: \`rho plugin dev .\`\nCheck: \`rho plugin check .\`\nDistribute: \`npm pack --ignore-scripts\`, then share the tarball, Git package source or publish to your own npm namespace.\n\nThe generated status panel reads the project task map and Agent sessions through declared read operations. Replace its view and host with the capability your project needs, then run \`rho plugin check .\` after each change.\n\nSee Rho's docs/THIRD-PARTY-PLUGINS.md for the host and iframe APIs, permissions and contribution process.\n`,
    };
    for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(target, file), text, { flag: 'wx' });
    process.stdout.write(`Created ${path.resolve(target)}. Run rho plugin check, then rho plugin dev.\n`); return;
  }
  if (command === 'check') {
    if (!target) throw new Error('Name a plugin directory.');
    const manager = new Extensions('');
    const checked = await manager.check(path.resolve(target));
    const runtime = await manager.checkRuntime(path.resolve(target), checked);
    const valid = runtime.host === 'passed' && runtime.operations.every(operation => operation.state === 'passed');
    process.stdout.write(JSON.stringify({ valid, ...checked, runtime }, null, 2) + '\n');
    if (!valid) process.exitCode = 1;
    return;
  }
  const client = await RhoClient.fromFile(path.resolve(values.connection ?? path.join(homedir(), 'Rho', 'state', 'connection.json')));
  const list = async (): Promise<any[]> => (await client.call('extension.list', {}) as any).plugins;
  const find = async () => { const p = (await list()).find(p => p.id === target); if (!p) throw new Error('Plugin is not installed: ' + target); return p; };
  // npm/Git staging can take longer than the ordinary 30-second observation client.
  // There is no execution retry here; a lost response is reconciled with list.
  const install = async (body: any) => {
    const local = body.source.startsWith('file:') ? body.source.slice(5) : body.source;
    if (await fs.stat(path.resolve(local)).catch(() => null)) body = { ...body, source: path.resolve(local) };
    const response = await fetch(new URL('/api/v2/extension.install', client.connection.url), { method: 'POST', headers: { authorization: 'Bearer ' + client.connection.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result: any = await response.json(); if (!result.ok) throw new Error(result.error.message); return result.value;
  };
  let result;
  if (command === 'market') {
    const catalog = await client.call('extension.list', {});
    if (target === 'list') result = catalog.markets;
    else if (target === 'add' && operation) result = await client.call('extension.market.change', { action: 'add', url: operation });
    else if (['refresh', 'remove', 'install'].includes(target) && operation) {
      const market = catalog.markets.find(m => m.id === operation); if (!market) throw new Error('Market is not configured: ' + operation);
      if (target === 'install') {
        const entry = market.plugins.find(p => p.id === marketPlugin); if (!entry) throw new Error('Name a plugin id from this market.');
        const previous = catalog.plugins.find(p => p.id === entry.id);
        result = await install({ source: entry.source, market: { id: market.id, expectedDigest: market.digest, pluginId: entry.id }, ...(previous ? { replace: previous.id, expectedDigest: previous.digest } : {}) });
      } else result = await client.call('extension.market.change', { action: target as 'refresh' | 'remove', id: market.id, expectedRevision: market.revision });
    } else throw new Error('Use rho plugin market list|add URL|refresh ID|remove ID|install ID PLUGIN_ID.');
  } else if (command === 'list') result = await list();
  else if (command === 'add') { if (!target) throw new Error('Name a package source.'); result = await install({ source: target }); }
  else if (command === 'update') { const p = await find(); result = await install({ source: values.source ?? p.source, replace: p.id, expectedDigest: p.digest }); }
  else if (['enable', 'disable', 'remove'].includes(command)) { const p = await find(); result = await client.call('extension.manage', { pluginId: p.id, expectedDigest: p.digest, action: command as 'enable' | 'disable' | 'remove' }); }
  else if (command === 'call') {
    if (!operation || !values.project) throw new Error('Call needs an operation and --project.');
    const p = await find(), project = await client.call('project.open', { path: values.project });
    const changeId = values['change-id'] ?? randomUUID(); process.stderr.write('changeId: ' + changeId + '\n');
    result = await client.call('extension.call', { projectId: project.id, pluginId: p.id, expectedDigest: p.digest, operation, input: JSON.parse(values.input ?? '{}'), changeId });
  } else if (command === 'dev') {
    if (!target) throw new Error('Name a plugin directory.');
    const root = path.resolve(target), manager = new Extensions('');
    await manager.check(root);
    let busy = false, pending = false;
    const update = async () => {
      if (busy) { pending = true; return; } busy = true;
      try {
        const checked = await manager.check(root);
        const runtime = await manager.checkRuntime(root, checked);
        if (runtime.host !== 'passed' || runtime.operations.some(operation => operation.state !== 'passed')) throw new Error('Plugin runtime check failed: ' + JSON.stringify(runtime));
        const p = (await list()).find(p => p.id === checked.manifest.id);
        const installed = await install({ source: root, ...(p ? { replace: p.id, expectedDigest: p.digest } : {}) });
        process.stdout.write(`Installed ${installed.id} ${installed.version} ${installed.digest}. Reopen its view to load this snapshot.\n`);
      }
      catch (e) { process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n'); }
      finally { busy = false; if (pending) { pending = false; void update(); } }
    };
    await update(); let timer: ReturnType<typeof setTimeout>;
    watch(root, { recursive: true }, (_event, filename) => { if (filename?.split(/[\\/]/).some(p => p === 'node_modules' || p === '.git')) return; clearTimeout(timer); timer = setTimeout(() => void update(), 400); });
    process.stdout.write('Watching ' + root + '. Stop with Ctrl-C.\n'); return;
  } else throw new Error('Unknown plugin command.\n' + help);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
