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
  const [command, target, operation] = positionals;
  if (values.help || !command) { process.stdout.write(help); return; }
  if (command === 'create') {
    if (!target) throw new Error('Name a new plugin directory.');
    const id = values.id ?? path.basename(path.resolve(target));
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(id)) throw new Error('Use a lowercase plugin id containing letters, digits, dots, underscores or hyphens.');
    await fs.mkdir(path.resolve(target));
    const manifest = { apiVersion: 1, id, title: id, description: 'An independent Rho plugin.', host: 'host.mjs', operations: [{ id: 'greet', title: 'Greet', description: 'Return a greeting without changing project data.', effect: 'read', methods: [], inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 120 } }, required: ['name'], additionalProperties: false } }], skills: [{ id: 'guide', title: 'Use this plugin', file: 'SKILL.md' }], views: [{ id: 'main', title: id, file: 'view.html' }] };
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'rho-plugin-' + id, version: '0.1.0', type: 'module', license: 'MIT', rhoPlugin: 'rho-plugin.json', files: ['rho-plugin.json', 'host.mjs', 'view.html', 'SKILL.md'] }, null, 2) + '\n',
      'rho-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
      'host.mjs': `export async function run(operation, input, context) {\n  if (operation === 'greet') return { greeting: 'Hello, ' + input.name + '!' };\n  throw new Error('Unknown operation');\n}\n`,
      'SKILL.md': `# ${id}\n\nRead extension.describe for the installed digest and operation schemas. Call greet with a name. This operation reads only. Use a stable changeId for native operations; observe extension.read after a lost reply.\n`,
      'view.html': `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${id}</title><style>body{font:16px system-ui;margin:24px;color:#24312b}input,button{font:inherit;padding:8px}output{display:block;margin-top:16px}</style><h1>${id}</h1><form><label>Your name <input name="name" value="World" maxlength="120"></label> <button>Greet</button></form><output aria-live="polite"></output><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const out=document.querySelector('output');try{const result=await rho.call('greet',{name:e.target.elements.name.value});out.textContent=result.value?.greeting||result.error}catch(error){out.textContent=error.message}};</script></html>\n`,
      'README.md': `# ${id}\n\nDevelop: \`rho plugin dev .\`\nCheck: \`rho plugin check .\`\nDistribute: \`npm pack --ignore-scripts\`, then share the tarball, Git package source or publish to your own npm namespace.\n\nSee Rho's docs/THIRD-PARTY-PLUGINS.md for the host and iframe APIs, permissions and contribution process.\n`,
    };
    for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(target, file), text, { flag: 'wx' });
    process.stdout.write(`Created ${path.resolve(target)}. Run rho plugin check, then rho plugin dev.\n`); return;
  }
  if (command === 'check') {
    if (!target) throw new Error('Name a plugin directory.');
    const checked = await new Extensions('').check(path.resolve(target));
    process.stdout.write(JSON.stringify({ valid: true, ...checked }, null, 2) + '\n'); return;
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
  if (command === 'list') result = await list();
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
    const root = path.resolve(target), checked = await new Extensions('').check(root); let busy = false, pending = false;
    const update = async () => {
      if (busy) { pending = true; return; } busy = true;
      try { const p = (await list()).find(p => p.id === checked.manifest.id); const installed = await install({ source: root, ...(p ? { replace: p.id, expectedDigest: p.digest } : {}) }); process.stdout.write(`Installed ${installed.id} ${installed.version} ${installed.digest}. Reopen its view to load this snapshot.\n`); }
      catch (e) { process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n'); }
      finally { busy = false; if (pending) { pending = false; void update(); } }
    };
    await update(); let timer: ReturnType<typeof setTimeout>;
    watch(root, { recursive: true }, (_event, filename) => { if (filename?.split(/[\\/]/).some(p => p === 'node_modules' || p === '.git')) return; clearTimeout(timer); timer = setTimeout(() => void update(), 400); });
    process.stdout.write('Watching ' + root + '. Stop with Ctrl-C.\n'); return;
  } else throw new Error('Unknown plugin command.\n' + help);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
