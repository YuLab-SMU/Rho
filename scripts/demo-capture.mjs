// Records the website demo: starts this checkout's service on a new state, which copies
// the shipped PA14 project once, walks it in a browser (demo-tour.mjs) and keeps every
// API answer the walk received. The demo replays these answers; it never runs work.
//
//   npm run build && node scripts/demo-capture.mjs
//
// Writes site/demo/recording.json. Machine paths are replaced by a neutral root, and the
// capture fails if any of them, or anything shaped like a credential, survives.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { network, tour } from './demo-tour.mjs';

const output = path.resolve('site/demo/recording.json');
const shown = '/home/researcher/rho';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-demo-'));
const real = fs.realpathSync(base);
for (const dir of ['projects', 'state']) fs.mkdirSync(path.join(base, dir));

const service = spawn(process.execPath, ['dist/cli.js', '--root', path.join(base, 'projects'), '--state-dir', path.join(base, 'state'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const ready = await new Promise((resolve, reject) => {
  let text = '';
  service.stdout.on('data', chunk => {
    text += chunk;
    const line = text.split('\n').find(l => l.startsWith('{"ready"'));
    if (line) resolve(JSON.parse(line).ready);
  });
  service.on('exit', code => reject(new Error('Service exited with ' + code + ' before it was ready.')));
  setTimeout(() => reject(new Error('Service was not ready in 30 s.')), 30000);
});

const calls = {};
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(u => { const p = new URL(u).pathname; return p.startsWith('/api/v2/') && p !== '/api/v2/events'; }, async route => {
    const request = route.request();
    const response = await route.fetch();
    const body = await response.text();
    const method = new URL(request.url()).pathname.slice('/api/v2/'.length);
    const input = request.postData() ? JSON.parse(request.postData()) : {};
    // The last answer wins: later reads reflect what the walk opened and captured.
    (calls[method] ??= {})[canonical(input)] = { status: response.status(), body: JSON.parse(body) };
    await route.fulfill({ response, body });
  });
  const settle = network(page);
  await tour(page, ready.url, { settle, step: name => process.stdout.write(name + ' ') });
  process.stdout.write('\n');
} finally {
  await browser.close();
  service.kill('SIGINT');
  await new Promise(resolve => service.once('exit', resolve));
}

let text = JSON.stringify({ capturedAt: new Date().toISOString(), root: shown, calls });
for (const prefix of [real, base].sort((a, b) => b.length - a.length)) text = text.split(prefix).join(shown);
const leaks = [os.homedir(), os.userInfo().username, real, base].filter(s => s && s.length > 3 && text.includes(s));
const secrets = text.match(/"(token|secret|password|authorization)"\s*:\s*"[^"]{8,}"/gi);
if (leaks.length || secrets) { console.error('Refusing to write the recording: it still contains', leaks.length ? leaks : secrets); process.exit(1); }
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, text + '\n');
fs.rmSync(base, { recursive: true, force: true });
const methods = Object.entries(calls).map(([m, v]) => m + '×' + Object.keys(v).length).join(', ');
console.log(`${path.relative(process.cwd(), output)}: ${(text.length / 1e6).toFixed(2)} MB; ${methods}`);
