// `npm run dev`: the page from source in front of a service. A service it starts ends with it; a
// service that was already running is left running. Its page's own requests reach the service,
// and a request from another site is still refused there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile), cli = path.resolve('dist/cli.js');
const status = async state => JSON.parse((await run(process.execPath, [cli, '--status', '--state-dir', state])).stdout).status;
// A request with the headers a browser would put on it, which fetch does not let a caller set.
const post = (url, headers) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, response => {
    let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
  });
  request.on('error', reject); request.end('{}');
});
async function dev(folders) {
  const child = spawn(process.execPath, ['scripts/dev.mjs', ...folders, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { printed += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The page from source did not start: ' + printed)), 60000);
    child.stdout.on('data', () => { const found = /^Rho from source: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(printed); if (found) { clearTimeout(timer); resolve(found[1]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`npm run dev ended with ${code}: ${printed}`)); });
  });
  return { child, url, printed: () => printed, async end() { child.kill('SIGINT'); const [code] = child.exitCode === null ? await once(child, 'exit') : [child.exitCode]; return code; } };
}

test('the page from source reaches its service, another site does not, and only a service it started ends with it', { skip: process.platform === 'win32' && 'needs an interrupt a child process can take in order', timeout: 180000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/rho-dev-')), state = path.join(root, 'state'), folders = ['--root', path.join(root, 'projects'), '--state-dir', state, '--example', 'off'];
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
    await fs.rm(root, { recursive: true, force: true });
  }
});
