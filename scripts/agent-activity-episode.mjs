// Actual Claude Code/dsh -> selected collector -> Core -> Rho -> owner views.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { RhoService, RhoClient, native } from './support.mjs';
import { inspectPage } from './browser-checks.mjs';

const evidence = path.resolve(process.env.RHO_ACTIVITY_EVIDENCE ?? 'work/agent-activity/' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-act-');
const collector = fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/activity-collect')).replace(/activity-collect\.js$/, 'activity-cli.js');
const dshPackage = process.env.RHO_DSH_PACKAGE ?? path.join(process.env.HOME, '.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json');
const report = { passed: false, model: 'westlakehpc/deepseek-v4.1-flash', root, checks: [], clients: [] };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceIdentity(directory) {
  const head = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const names = spawnSync('git', ['-C', directory, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(n => /\.(tsx?|mjs|cjs|json|css|rs|toml|lock|R)$/.test(n));
  const inputs = await Promise.all([...new Set(names)].sort().map(async name => [name, sha(await fs.readFile(path.join(directory, name)))]));
  return { head, codeInputsSha256: sha(JSON.stringify(inputs)), localOverride: !!spawnSync('git', ['-C', directory, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() };
}
report.composition = { application: await sourceIdentity(fileURLToPath(new URL('..', import.meta.url))), plugins: await sourceIdentity(path.resolve('..', 'Rho-plugins')),
  core: { source: await sourceIdentity(path.resolve('..', 'Rho-core')), binarySha256: sha(await fs.readFile(native.coreBinary)) }, web: JSON.parse(await fs.readFile(new URL('../dist/web/composition.json', import.meta.url), 'utf8')), node: process.version };
let service, browser, activePage, activeTrial;
const children = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(read, valid, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (valid(value)) return value; await delay(200); }
  throw new Error('Timed out: ' + label);
}
async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await until(() => child.exitCode !== null || child.signalCode !== null, Boolean, 'owned process exit', 12000);
}
const start = (binary, args, options = {}) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.output = ''; child.diagnostics = '';
  child.stdout.on('data', b => { if (child.output.length < 2 * 1024 * 1024) child.output += b; else child.kill(); });
  child.stderr.on('data', b => { if (child.diagnostics.length < 65536) child.diagnostics += b; });
  children.push(child); return child;
};
try {
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...native }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  for (const producer of (process.env.RHO_ACTIVITY_CLIENTS ?? 'claude,dsh').split(',')) {
    const trial = path.join(evidence, producer); await fs.mkdir(trial);
    const project = await admin.call('project.create', { name: producer + '-activity' });
    const call = (method, body = {}) => admin.call(method, { projectId: project.id, ...body });
    await fs.writeFile(path.join(project.root, 'input.csv'), 'group,value\nalpha,1\nalpha,2\nalpha,8\nbeta,-3\nbeta,4\nbeta,7\n');
    await fs.writeFile(path.join(project.root, 'analysis.py'), `import csv,pathlib,time
p=pathlib.Path('.')
rows=list(csv.DictReader((p/'input.csv').open()))
groups={}
for row in rows:groups.setdefault(row['group'],[]).append(float(row['value']))
summary=[(name,len(values),sum(values)//len(values)) for name,values in groups.items()]
with (p/'run-count.txt').open('a') as f:f.write('run\\n')
(p/'started').touch()
end=time.monotonic()+180
while not (p/'release').exists():
    if time.monotonic()>end:raise SystemExit(9)
    time.sleep(.05)
(p/'outputs').mkdir(exist_ok=True)
with (p/'outputs/summary.csv').open('w') as f:
    w=csv.writer(f);w.writerow(['group','n','mean']);w.writerows(summary)
bars=''.join(f'<rect x="{100+i*180}" y="{240-mean*40}" width="80" height="{mean*40}" fill="#24745c"/><text x="{100+i*180}" y="270">{name}</text><text x="{100+i*180}" y="{230-mean*40}">{mean:.2f}</text>' for i,(name,n,mean) in enumerate(summary))
(p/'outputs/plot.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="560" height="320"><rect width="560" height="320" fill="white"/><g font-family="sans-serif" fill="#20352f"><text x="40" y="35" font-size="22">Mean value by group</text>'+bars+'</g></svg>')
print('outputs/summary.csv and outputs/plot.svg written; intentional diagnostic exit 7')
raise SystemExit(7)
`);
    const socket = path.join(project.root, '.rho/host.sock');
    const startHost = async () => {
      const host = start(native.coreBinary, ['serve', '--project', project.root, '--state-dir', path.join(project.root, '.rho')]);
      await until(() => host.output, s => s.includes('"ready"'), 'Core Host ready', 10000); return host;
    };
    let host = await startHost();
    const client = start('python3', [fileURLToPath(new URL('./agent-activity-client.py', import.meta.url)), producer, project.root, trial]);
    const source = await until(async () => { try { return JSON.parse(await fs.readFile(path.join(trial, 'source.json'), 'utf8')); } catch { return null; } }, Boolean, producer + ' native session');
    const args = [collector, 'collect', '--core', native.coreBinary, '--socket', socket, '--caller', 'rho-agent-observe', '--stream', producer + '-analysis', '--producer', producer, '--project', project.root, '--session', source.session, '--source', source.source,
      ...(producer === 'dsh' ? ['--dsh-package', dshPackage] : [])];
    let observer = start(process.execPath, [...args, '--watch-seconds', '240', '--interval-ms', '500']);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); activePage = page; activeTrial = trial;
    const errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(15000);
    await page.goto(service.url); await page.locator('.project-row').filter({ hasText: producer + '-activity' }).click();
    const navigateActivity = async () => {
      if (!await page.locator('.project-nav').isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.locator('.project-nav, dialog.drawer').getByRole('button', { name: 'Activity', exact: true }).click();
    };
    await navigateActivity();
    await until(() => fs.access(path.join(project.root, 'started')).then(() => true, () => false), Boolean, producer + ' analysis gate');
    await page.locator('[data-action-state="pending"]').filter({ hasText: 'analysis.py' }).waitFor();
    await page.screenshot({ path: path.join(trial, '01-pending.png'), fullPage: true });
    const first = await call('agent.activity.read', { streamId: producer + '-analysis', after: 0 });
    // Lose both the observer and only this owned Host while native work continues.
    await stop(observer, 'SIGINT'); await stop(host, 'SIGKILL');
    await page.getByText('Observation disconnected', { exact: true }).waitFor();
    assert.ok(await page.locator('[data-action-state="pending"]').count());
    await page.screenshot({ path: path.join(trial, '02-disconnected.png'), fullPage: true });
    assert.equal(client.exitCode, null);
    await fs.writeFile(path.join(project.root, 'release'), 'continue');
    await until(() => client.exitCode, v => v !== null, producer + ' client completion', 150000);
    assert.equal(client.exitCode, 0, 'native client completed');
    host = await startHost();
    const replay = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(replay.status, 0, replay.stderr);
    await page.getByRole('button', { name: 'Reconnect activity', exact: true }).click();
    await page.locator('[data-action-state="error"]').filter({ hasText: 'Exit 7' }).waitFor();
    await page.getByRole('button', { name: 'Open outputs/summary.csv', exact: true }).waitFor();
    const complete = await call('agent.activity.read', { streamId: producer + '-analysis', after: 0 });
    await fs.writeFile(path.join(trial, 'native-complete.json'), JSON.stringify({ project, source, first, complete }));
    assert.equal(await fs.readFile(path.join(project.root, 'run-count.txt'), 'utf8'), 'run\n');
    const repeat = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(repeat.status, 0); assert.equal(JSON.parse(repeat.stdout).appended, 0);
    await page.screenshot({ path: path.join(trial, '03-errors-outputs.png'), fullPage: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const check = await inspectPage(page); assert.equal(check.overflow, false, JSON.stringify(check));
      await page.screenshot({ path: path.join(trial, `04-activity-${width}.png`) });
      if (width === 390) { await page.getByRole('button', { name: 'Open outputs/summary.csv', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(trial, '04-outputs-390.png') }); }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Open outputs/summary.csv', exact: true }).click();
    await page.locator('.ag-row[row-index="0"]').waitFor();
    assert.match(await page.locator('.ag-root').innerText(), /3\.666/);
    await page.screenshot({ path: path.join(trial, '05-table.png'), fullPage: true });
    await navigateActivity();
    await page.getByRole('button', { name: 'Open outputs/plot.svg', exact: true }).click();
    await page.getByRole('img', { name: 'plot.svg', exact: true }).waitFor();
    await until(() => page.getByRole('img', { name: 'plot.svg', exact: true }).evaluate(e => e.complete && e.naturalWidth > 0), Boolean, 'figure decoded');
    await page.screenshot({ path: path.join(trial, '06-figure.png'), fullPage: true });
    await page.reload(); await page.getByRole('tab', { name: 'plot.svg', exact: true }).click(); await page.getByRole('img', { name: 'plot.svg', exact: true }).waitFor();
    await navigateActivity(); await page.locator('[data-action-state="error"]').filter({ hasText: 'Exit 7' }).waitFor();
    const rows = (await fs.readFile(path.join(project.root, 'outputs/summary.csv'), 'utf8')).trim().split('\n').slice(1).map(row => row.split(','));
    assert.deepEqual(rows.map(r => r.slice(0, 2)), [['alpha', '3'], ['beta', '3']]);
    assert.ok(Math.abs(Number(rows[0][2]) - 11 / 3) < 1e-12 && Math.abs(Number(rows[1][2]) - 8 / 3) < 1e-12);
    assert.deepEqual(errors, []);
    report.clients.push({ producer, projectId: project.id, nativeSession: source.session, firstEvents: first.page.entries.length, finalEvents: complete.page.entries.length, replayAdded: 0, nativeInvocations: 1, exitShown: 7, outputHashes: (await call('agent.activity.outputs', { directory: 'outputs' })).files.map(f => ({ path: f.path, sha256: f.sha256 })), browserErrors: errors });
    report.checks.push(producer + ': live pending, Host loss, retained cache, original-session recovery, exit 7, exact table/figure, responsive activity, reload, independent means');
    await page.close(); await stop(host);
    process.stdout.write('Passed real ' + producer + ' activity episode\n');
  }
  report.passed = true;
} catch (e) { report.failure = e.stack; if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: path.join(activeTrial, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(activeTrial, 'failure-ui.txt'), await activePage.locator('body').innerText()).catch(() => {}); } throw e; }
finally {
  for (const child of children.reverse()) await stop(child).catch(() => {});
  await browser?.close(); await service?.close();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('Evidence: ' + evidence + '\n');
}
