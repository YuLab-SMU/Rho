// `npm run dev`: the page from source in front of a service. A service it starts ends with it; a
// service that was already running is left running. Its page's own requests reach the service,
// and a request from another site is still refused there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile), cli = path.resolve('dist/cli.js'), windows = process.platform === 'win32';
// The person ends it from its terminal: Ctrl+C, which Node takes as SIGINT. On Windows a signal
// sent to another process ends it at once; there the page runs on a console of its own, and
// Ctrl+Break is raised on that console, as the person would press it (Ctrl+C may be turned off for
// a program started in the background). The service it started shares that console.
const ctrlBreak = pid => run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`Add-Type -Namespace RhoTest -Name ConsoleEvent -MemberDefinition @'
public delegate bool Handler(uint ctrl);
static readonly Handler Keep = ctrl => true;
[DllImport("kernel32.dll")] static extern bool FreeConsole();
[DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
[DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ctrl, uint group);
public static bool Break(uint pid) { FreeConsole(); if (!AttachConsole(pid)) return false; SetConsoleCtrlHandler(Keep, true); bool raised = GenerateConsoleCtrlEvent(1, 0); System.Threading.Thread.Sleep(100); FreeConsole(); return raised; }
'@
if (-not [RhoTest.ConsoleEvent]::Break(${pid})) { exit 1 }`, 'utf16le').toString('base64')], { windowsHide: true });
const status = async state => JSON.parse((await run(process.execPath, [cli, '--status', '--state-dir', state])).stdout).status;
// A request with the headers a browser would put on it, which fetch does not let a caller set.
const post = (url, headers) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, response => {
    let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
  });
  request.on('error', reject); request.end('{}');
});
async function dev(folders) {
  const child = spawn(process.execPath, ['scripts/dev.mjs', ...folders, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let printed = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { printed += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The page from source did not start: ' + printed)), 60000);
    child.stdout.on('data', () => { const found = /^Rho from source: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(printed); if (found) { clearTimeout(timer); resolve(found[1]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`npm run dev ended with ${code}: ${printed}`)); });
  });
  return { child, url, printed: () => printed, async end() {
    const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve([child.exitCode]);
    if (windows) await ctrlBreak(child.pid); else child.kill('SIGINT');
    const [code] = await exited; return code;
  } };
}

test('the page from source reaches its service, another site does not, and only a service it started ends with it', { timeout: 180000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(windows ? os.tmpdir() : '/tmp', 'rho-dev-'))), state = path.join(root, 'state'), folders = ['--root', path.join(root, 'projects'), '--state-dir', state, '--example', 'off'];
  await fs.mkdir(path.join(root, 'projects'));
  let page;
  try {
    // No service runs for these folders: one is started, and ends with the page.
    page = await dev(folders);
    assert.match(page.printed(), /started here and stopped when this ends/);
    const html = await (await fetch(page.url + '/')).text();
    assert.match(html, /src="\/main\.tsx"/, 'the page is web/ as it is on disk, not a build');
    const own = await post(page.url + '/api/v2/project.list', { origin: page.url, 'sec-fetch-site': 'same-origin' });
    assert.deepEqual([own.ok, own.value], [true, []]);
    const other = await post(page.url + '/api/v2/project.list', { origin: 'https://example.com', 'sec-fetch-site': 'cross-site' });
    assert.deepEqual([other.ok, other.error.kind], [false, 'origin']);
    assert.equal((await status(state)).running, true);
    assert.equal(await page.end(), 0);
    assert.equal((await status(state)).running, false, 'the service this run started ended with it');

    // A service already runs: the page goes in front of it and leaves it running.
    await run(process.execPath, [cli, ...folders, '--port', '0', '--background']);
    const before = await status(state);
    assert.equal(before.running, true);
    page = await dev(folders);
    assert.match(page.printed(), /already running and left running when this ends/);
    assert.equal((await post(page.url + '/api/v2/project.list', { origin: page.url, 'sec-fetch-site': 'same-origin' })).ok, true);
    assert.equal(await page.end(), 0);
    const after = await status(state);
    assert.deepEqual([after.running, after.pid, after.url], [true, before.pid, before.url], 'the same service still runs');
  } finally {
    if (page?.child.exitCode === null) page.child.kill('SIGKILL');
    await run(process.execPath, [cli, '--stop', '--state-dir', state]).catch(() => {});
    // On Windows the stopped service's log stays open a moment after it has stopped.
    await fs.rm(root, { recursive: true, force: true, maxRetries: windows ? 50 : 0, retryDelay: 100 });
  }
});
