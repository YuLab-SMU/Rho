// Serves the assembled Pages tree under /Rho/ the way GitHub Pages does, walks the demo with
// the same tour that recorded it, and reports every request the recording could not answer,
// every page error and failed asset. Screenshots go to the given folder for reading.
//
//   node scripts/demo-check.mjs [site/.pages] [work/demo-check]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { network, tour } from './demo-tour.mjs';

const root = path.resolve(process.argv[2] ?? 'site/.pages');
const shots = path.resolve(process.argv[3] ?? 'work/demo-check');
fs.mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.md': 'text/markdown', '.txt': 'text/plain', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/Rho/')) { res.writeHead(404).end(); return; }
  let file = path.join(root, decodeURIComponent(url.pathname.slice('/Rho/'.length)));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch();
const errors = [], failed = [];
let misses = [];
try {
  for (const [width, height] of [[1440, 900], ...(process.env.DEMO_NARROW ? [[390, 844]] : [])]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400 && !new URL(r.url()).pathname.startsWith('/api/')) failed.push(r.status() + ' ' + r.url()); });
    const settle = network(page);
    let n = 0;
    const step = async name => { await page.screenshot({ path: path.join(shots, `${width}-${String(n++).padStart(2, '0')}-${name.replace(/[^\w-]+/g, '_')}.png`) }); };
    if (width >= 1100) await tour(page, origin + '/Rho/demo/', { settle, step });
    else {
      // A phone opens the project the front page links to, then moves through its navigation.
      const project = await (await fetch(origin + '/Rho/demo/demo-data/recording.json')).json().then(r => Object.values(r.calls['project.list'])[0].body.value[0].id);
      await page.goto(origin + '/Rho/demo/#project=' + project); await settle(1200); await step('phone-overview');
      for (const name of ['Studio', 'Graph', 'Data']) {
        await page.getByRole('button', { name: /navigation/i }).first().click(); await settle(300);
        await page.getByRole('navigation', { name: 'Project', exact: true }).first().getByRole('button', { name, exact: true }).click(); await settle(); await step('phone-' + name);
      }
    }
    misses = misses.concat(await page.evaluate(() => window.__rhoDemoMisses));
    await page.close();
  }
} finally { await browser.close(); }

// The front page: the install dialog, the Agent switch and folder, copying, the prompt sets, and
// every link that stays on this site.
const front = [];
{
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('front: ' + e.message));
  await page.goto(origin + '/Rho/');
  const dialog = page.locator('#install-dialog');
  await page.locator('header [data-open-install]').click();
  if (!await dialog.isVisible()) front.push('the install dialog did not open');
  await dialog.getByRole('button', { name: 'Codex' }).click();
  await dialog.locator('[data-folder]').fill('~/My Projects');
  const prompt = await dialog.locator('[data-prompt]').textContent();
  if (!prompt.includes('--agent-backend codex-acp') || !prompt.includes('"$HOME/My Projects"')) front.push('the prompt did not follow the Agent and folder: ' + prompt.slice(0, 120));
  await dialog.getByRole('button', { name: 'Copy prompt' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  if (copied !== prompt) front.push('the clipboard does not hold the prompt shown');
  await page.screenshot({ path: path.join(shots, 'front-dialog.png') });
  await dialog.getByRole('button', { name: 'Close' }).click();
  const closing = await page.locator('.closing [data-folder]').inputValue();
  if (closing !== '~/My Projects') front.push('the folder fields are not shared');
  const tab = page.getByRole('tab', { name: /^Tables/ });
  await tab.click();
  if (!await page.locator('#set-tables').isVisible() || await page.locator('#set-example').isVisible()) front.push('the Tables prompt set did not replace the example');
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href], img[src], iframe[src]')].map(e => e.getAttribute('href') ?? e.getAttribute('src')).filter(h => !/^(https?:|#|mailto:)/.test(h)));
  for (const link of [...new Set(links)]) {
    const response = await page.request.get(new URL(link, origin + '/Rho/').href);
    if (!response.ok()) front.push(response.status() + ' ' + link);
  }
  console.log('front page links checked:', new Set(links).size);
  await browser.close();
  server.close();
}

const byMethod = {};
for (const m of misses) byMethod[m.method] = (byMethod[m.method] ?? 0) + 1;
console.log('unanswered:', JSON.stringify(byMethod));
for (const m of misses.slice(0, 12)) console.log('  ', m.method, JSON.stringify(m.input).slice(0, 160));
console.log('page errors:', errors.length); for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ', e.slice(0, 200));
console.log('front page problems:', front.length); for (const f of front) console.log('  ', f);
console.log('failed assets:', failed.length); for (const f of failed.slice(0, 10)) console.log('  ', f);
console.log('screenshots:', path.relative(process.cwd(), shots));
