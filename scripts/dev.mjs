#!/usr/bin/env node
// Rho from source: the browser application as web/ is on disk, in front of a Rho service.
//
//   npm run dev [-- --root PROJECTS_DIRECTORY --state-dir SERVICE_STATE] [--example on|off] [--port 5173] [--open]
//
// A saved stylesheet shows in place; a saved component shows once the page has reloaded itself.
// The service is the built one (dist/). Without folders it is the Rho already running on the
// folders `rho` uses, which is left running when this ends; when none runs, one is started here
// and stopped again when this ends. Changes under src/ need `npm run build:service` and a new
// service; a plugin's views follow that plugin's own build.
//
// The service answers only its own origin. A request this page makes is passed on as the
// service's own; a request from any other origin is passed on as it came and refused there.
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const usage = 'usage: npm run dev [-- --root PROJECTS_DIRECTORY --state-dir SERVICE_STATE] [--example on|off] [--port 5173] [--open]';
const base = path.resolve(fileURLToPath(new URL('..', import.meta.url))), cli = path.join(base, 'dist/cli.js');
const refuse = text => { process.stderr.write(text + '\n'); process.exit(1); };
let values;
try { ({ values } = parseArgs({ options: { root: { type: 'string' }, 'state-dir': { type: 'string' }, example: { type: 'string' }, port: { type: 'string' }, open: { type: 'boolean' } } })); }
catch (error) { refuse(error.message + '\n' + usage); }
const port = Number(values.port ?? 5173);
if (!Number.isInteger(port) || port < 0 || port > 65535) refuse('--port takes a port number.\n' + usage);
// vite.config.ts and this command read the built service: its plugin selection and its start.
if (!await fs.access(cli).then(() => true, () => false)) refuse('The service is not built. Run `npm run build:service`, then this again.');
const folders = [...(values.root ? ['--root', path.resolve(values.root)] : []), ...(values['state-dir'] ? ['--state-dir', path.resolve(values['state-dir'])] : [])];

// The service: the one already running for these folders, or one started for this run.
const status = await promisify(execFile)(process.execPath, [cli, '--status', ...folders.slice(values.root ? 2 : 0)]).then(r => JSON.parse(r.stdout).status, error => { try { return JSON.parse(error.stdout).status; } catch { return null; } });
let target, started = null, stateDirectory = status?.state ?? '';
if (status?.running && status.url) target = new URL(status.url).origin;
else {
  started = spawn(process.execPath, [cli, ...folders, ...(values.example ? ['--example', values.example] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
  // The service says where it is on its first whole line; what it prints later is not kept.
  let printed = '';
  const ready = await new Promise(resolve => {
    const read = chunk => {
      printed += chunk;
      const line = printed.slice(0, printed.lastIndexOf('\n') + 1).split('\n').find(l => l.startsWith('{"ready"'));
      if (line) { started.stdout.off('data', read); started.stdout.resume(); resolve(JSON.parse(line).ready); }
    };
    started.stdout.on('data', read);
    started.once('exit', () => resolve(null));
  });
  if (!ready) refuse((printed.trim() ? printed.trim() + '\n' : '') + 'The Rho service did not start, so there is nothing to put the page in front of.');
  target = new URL(ready.url).origin; stateDirectory = ready.startup?.state ?? stateDirectory;
}

// vite.config.ts reads web/, src/ and node_modules/ by paths relative to the checkout.
process.chdir(base);
const { createServer } = await import('vite');
// Plugin packages may be links into another checkout; the page's server reads those files too.
const modules = await fs.realpath(path.join(base, 'node_modules'));
const outside = new Set();
for (const name of await fs.readdir(path.join(modules, '@rho-workspace')).catch(() => [])) {
  let directory = await fs.realpath(path.join(modules, '@rho-workspace', name)).catch(() => null);
  if (!directory || directory.startsWith(modules + path.sep)) continue;
  // The checkout a linked package belongs to holds what the package itself imports.
  for (let up = directory, level = 0; level < 4 && path.dirname(up) !== up; up = path.dirname(up), level++) if (await fs.access(path.join(up, '.git')).then(() => true, () => false)) { directory = up; break; }
  outside.add(directory);
}
// The plugins' shared modules import Node's own modules beside what the browser uses. The build
// drops what is never called; here each such import gets every name the real module has, as a
// function that says so only when it is called.
const builtins = new Set(builtinModules.flatMap(name => [name, 'node:' + name])), stub = '\0rho-dev-node:';
const nodeStubs = { name: 'rho-dev-node-stubs', enforce: 'pre',
  resolveId(id) { if (builtins.has(id)) return stub + id.replace(/^node:/, ''); },
  async load(id) {
    if (!id.startsWith(stub)) return;
    const module = id.slice(stub.length), names = Object.keys(await import('node:' + module)).filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
    return `const absent = name => function () { throw new Error('node:${module}.' + name + ' is not available in the browser.'); };\n`
      + names.map(name => `export const ${name} = absent(${JSON.stringify(name)});`).join('\n') + `\nexport default { ${names.join(', ')} };\n`;
  } };
let own = new Set();
const toService = { target, changeOrigin: true, configure: proxy => proxy.on('proxyReq', (request, incoming) => { if (own.has(incoming.headers.origin)) request.setHeader('origin', target); }) };
const server = await createServer({
  configFile: path.join(base, 'vite.config.ts'), clearScreen: false, plugins: [nodeStubs],
  // The page server's own cache stays in this checkout's ignored work folder.
  cacheDir: path.join(base, 'work/dev/vite'),
  server: { host: '127.0.0.1', port, strictPort: false, fs: { allow: [base, modules, ...outside] },
    proxy: { '/api': toService, '/frame.html': toService, '/extension-frame.html': toService } },
});
await server.listen();
const listening = server.httpServer.address().port, page = `http://127.0.0.1:${listening}`;
own = new Set(['127.0.0.1', 'localhost'].map(host => `http://${host}:${listening}`));
process.stdout.write(`Rho from source: ${page}\n`
  + `  page     web/ in ${base}; saved changes show as they are saved\n`
  + `  service  ${target}, ${started ? 'started here and stopped when this ends' : 'already running and left running when this ends'}${stateDirectory ? ' (state ' + stateDirectory + ')' : ''}\n`);
if (values.open) server.openBrowser();

// Ending this ends the page server, then the service only if this run started it, in order. On
// Windows a signal sent to another process ends it at once, so the service is asked as rho --stop
// asks it (its stop request in its state folder); Ctrl+Break there ends this as Ctrl+C does.
let ending = false;
async function end(code) {
  if (ending) return; ending = true;
  await server.close().catch(() => {});
  if (started && started.exitCode === null && started.signalCode === null) {
    const exited = once(started, 'exit').catch(() => {});
    if (process.platform === 'win32' && stateDirectory) await fs.writeFile(path.join(stateDirectory, 'service.stop'), '').catch(() => started.kill('SIGINT'));
    else started.kill('SIGINT');
    const forced = setTimeout(() => started.kill('SIGKILL'), 15000);
    await exited; clearTimeout(forced);
  }
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(signal, () => void end(0));
// A service that ends first leaves the page nothing to read.
started?.once('exit', () => { if (!ending) { process.stderr.write('The Rho service ended; the page from source ends with it.\n'); void end(1); } });
