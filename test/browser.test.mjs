import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { BrowserClient } from '../dist/browser.js';

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-browser-'));
  const config = { root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: '/missing', ...options };
  const service = await new RhoService(config).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const pair = code => fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code }) });
  return { root, config, service, operator, pair, cleanup: async () => { if (service.server.listening) await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('one-use pairing grants a narrowed root, never operator/native/session authority', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'selected')); await fs.mkdir(path.join(f.root, 'outside'));
    const outside = await f.operator.call('project.open', { path: 'outside' });
    const selected = await f.operator.call('session.browser.pair', { path: 'selected' });
    const replies = await Promise.all([f.pair(selected.code), f.pair(selected.code)]);
    assert.deepEqual(replies.map(r => r.status).sort(), [200, 401]);
    const { value: grant } = await replies.find(r => r.status === 200).json();
    assert.notEqual(grant.token, f.service.adminToken);
    assert.ok(grant.methods.every(m => !m.startsWith('session.') && !m.startsWith('action.') && !m.startsWith('requirements.')));
    const browser = new BrowserClient({ url: f.service.url, ...grant });
    const p = await browser.call('project.create', { name: 'project 中文' });
    const reopened = await browser.call('project.open', { path: 'project 中文' }); assert.equal(reopened.id, p.id);
    // The browser tells an existing folder and a missing one apart from scope refusals.
    await assert.rejects(browser.call('project.create', { name: 'project 中文' }), e => e.error.kind === 'conflict');
    await assert.rejects(browser.call('project.open', { path: 'missing' }), e => e.error.kind === 'not_found');
    assert.equal(grant.rootLabel, grant.root);
    const home = process.env.HOME; process.env.HOME = f.root;
    try {
      const labelled = await f.operator.call('session.browser.pair', { path: 'selected' });
      assert.equal((await (await f.pair(labelled.code)).json()).value.rootLabel, '~/selected');
    } finally { process.env.HOME = home; }
    assert.deepEqual((await browser.call('project.list', {})).map(p => p.id), [p.id]);
    for (const path of ['../outside', '..', '.rho', 'project 中文/.rho']) await assert.rejects(browser.call('project.open', { path }), e => e.error.kind === 'scope');
    await assert.rejects(browser.call('observation.snapshot', { projectId: outside.id }), e => e.error.kind === 'scope');
    const direct = new RhoClient({ url: f.service.url, token: grant.token });
    // U2 grants identity-bearing edits, never saving, global undo or execution.
    assert.ok(grant.principalId.startsWith('browser:'));
    for (const method of ['document.edit', 'document.undoOwn', 'document.revert', 'data.page', 'interaction.selection.set']) assert.ok(grant.methods.includes(method), method);
    for (const method of ['session.grant', 'session.browser.pair', 'session.browser.revoke', 'action.submit', 'capability.configure', 'document.save', 'document.abandonSave', 'document.undo', 'document.open', 'composition.put', 'view.close']) await assert.rejects(direct.call(method, {}), e => e.error.kind === 'unauthorized', method);
    assert.equal((await browser.call('observation.snapshot', { projectId: p.id })).host.exitCode, 3);
    assert.equal(f.service.bridge.owned.size, 0);
    await assert.rejects(fs.stat(path.join(p.root, '.rho/host.sock')), { code: 'ENOENT' });
    await fs.symlink(path.join(f.root, 'outside'), path.join(f.root, 'selected', 'link'));
    await assert.rejects(browser.call('project.open', { path: 'link' }), e => e.error.kind === 'scope');
  } finally { await f.cleanup(); }
});

test('static serving and pairing reject foreign origins, URL credentials, wrong codes and invalid bodies', async () => {
  const f = await fixture();
  try {
    const pairing = await f.service.browser.createPairing();
    const hostile = await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) }); assert.equal(hostile.status, 403);
    const hostileHost = await new Promise((resolve, reject) => {
      const req = request(f.service.url + '/', { headers: { host: 'foreign.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    }); assert.equal(hostileHost, 403);
    const missingOrigin = await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) }); assert.equal(missingOrigin.status, 403);
    assert.equal((await f.pair('x'.repeat(32))).status, 401);
    const invalid = await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { origin: f.service.url, 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, methods: ['session.grant'] }) }); assert.equal(invalid.status, 400);
    const oversized = await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { origin: f.service.url, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x'.repeat(1100) }) }); assert.equal(oversized.status, 413);
    assert.equal((await f.pair(pairing.code)).status, 200);
    for (const route of ['/../connection.json', '/.service/connection.json', '/assets/../connection.json', '/?token=secret', '/assets/no.js', '/composition.json']) assert.equal((await fetch(f.service.url + route)).status, 404);
    const html = await fetch(f.service.url + '/'); assert.equal(html.status, 200);
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(html.headers.get('cross-origin-resource-policy'), 'same-origin');
    const text = await html.text(); assert.ok(!text.includes(f.service.adminToken));
    assert.equal((await fetch(f.service.url + '/', { headers: { origin: 'https://foreign.invalid' } })).status, 403);
    const asset = text.match(/src="([^"]+\.js)"/)[1];
    const js = await fetch(f.service.url + asset); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
    const bytes = await js.text(); assert.ok(!bytes.includes(f.service.adminToken)); assert.ok(!bytes.includes(pairing.code));
    const badClient = new BrowserClient({ url: f.service.url, token: '0'.repeat(64), methods: [], expiresAt: new Date(Date.now() + 1000).toISOString() });
    await assert.rejects(badClient.call('project.list', {}), e => e.error.kind === 'unauthorized');
    const fakeAssets = path.join(f.root, 'static'); await fs.mkdir(path.join(fakeAssets, 'assets'), { recursive: true });
    const outside = path.join(f.root, 'not-an-asset.js'); await fs.writeFile(outside, 'private-bytes');
    await fs.symlink(outside, path.join(fakeAssets, 'assets/leak.js')); f.service.config.webRoot = fakeAssets;
    assert.equal((await fetch(f.service.url + '/assets/leak.js')).status, 403);
  } finally { await f.cleanup(); }
});

test('browser session resumes on service restart, revocation ends observation, and close never starts a Host', async () => {
  const f = await fixture(); let restarted;
  try {
    const p = await f.operator.call('project.create', { name: 'project' });
    const pairing = await f.service.browser.createPairing(); const { value } = await (await f.pair(pairing.code)).json();
    const oldUrl = f.service.url; await f.service.close();
    restarted = await new RhoService({ ...f.config, port: Number(new URL(oldUrl).port) }).start();
    const c = new BrowserClient({ url: oldUrl, ...value });
    assert.equal((await c.call('observation.snapshot', { projectId: p.id })).project.id, p.id);
    const observer = c.observe(p.id).observe(); await observer.next();
    // Establish the SSE reader before revocation, rather than only reading a snapshot.
    const next = observer.next();
    for (let n = 0; n < 50 && !restarted.subscribers.size; n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(restarted.subscribers.size, 1);
    const admin = new RhoClient({ url: restarted.url, token: restarted.adminToken });
    const principal = restarted.state.principals.find(p => p.kind === 'browser');
    await admin.call('session.browser.revoke', { sessionId: principal.id });
    await assert.rejects(next, /credential/);
    await assert.rejects(c.call('project.list', {}), e => e.error.kind === 'unauthorized');
    assert.equal(restarted.bridge.owned.size, 0);
  } finally { await restarted?.close(); await f.cleanup(); }
});

test('browser pairing/session budgets reject new work and retain existing grants', async () => {
  const f = await fixture({ browser: { maxSessions: 1, maxPairings: 1, maxPairAttempts: 8, pairingTtlMs: 100, sessionTtlMs: 1000 } });
  try {
    const p = await f.service.browser.createPairing();
    await assert.rejects(f.service.browser.createPairing(), e => e.kind === 'limit');
    const { value } = await (await f.pair(p.code)).json();
    const second = await f.service.browser.createPairing(); assert.equal((await f.pair(second.code)).status, 413);
    const c = new BrowserClient({ url: f.service.url, ...value }); assert.deepEqual(await c.call('project.list', {}), []);
    await new Promise(r => setTimeout(r, 120)); assert.equal((await f.pair(second.code)).status, 401);
  } finally { await f.cleanup(); }
});

test('browser SDK imports without Node/DOM or optional renderer packages', async () => {
  for (const file of ['browser.js', 'observation.js', 'task-frame.js']) {
    const source = await fs.readFile(new URL('../dist/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"](?:node:|react|dockview|@rho-workspace\/plugin)/);
    assert.doesNotMatch(source, /\b(?:window|document|sessionStorage|localStorage)\./);
  }
  assert.equal(typeof BrowserClient, 'function');
});

test('browser SDK calls Fetch without a client receiver and reuses it for observation', async () => {
  const calls = [];
  const fetcher = function(url) {
    assert.equal(this, undefined);
    calls.push(new URL(url).pathname);
    return Promise.resolve(new Response(JSON.stringify({ ok: true, value: calls.length === 1 ? [] : { cursor: 1 } }), { headers: { 'content-type': 'application/json' } }));
  };
  const client = new BrowserClient({ url: 'http://127.0.0.1:1000', token: 'private', expiresAt: new Date(Date.now() + 10000).toISOString(), methods: [] }, fetcher);
  assert.deepEqual(await client.call('project.list', {}), []);
  const observer = client.observe('project').observe();
  assert.deepEqual((await observer.next()).value, { cursor: 1 }); await observer.return();
  assert.deepEqual(calls, ['/api/v2/project.list', '/api/v2/observation.snapshot']);
});

test('expired live subscriptions cannot receive a later project event', async () => {
  const f = await fixture({ browser: { sessionTtlMs: 1000 } });
  try {
    const project = await f.operator.call('project.create', { name: 'project' });
    const pairing = await f.service.browser.createPairing(), { value } = await (await f.pair(pairing.code)).json();
    const client = new BrowserClient({ url: f.service.url, ...value });
    const observer = client.observe(project.id).observe(); await observer.next(); const next = observer.next();
    for (let n = 0; n < 50 && !f.service.subscribers.size; n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(f.service.subscribers.size, 1);
    await new Promise(r => setTimeout(r, Math.max(0, Date.parse(value.expiresAt) - Date.now() + 10)));
    await f.service.emit(project, 'document.changed', 'must-not-be-delivered');
    await assert.rejects(next, /expired/); assert.equal(f.service.subscribers.size, 0);
  } finally { await f.cleanup(); }
});

test('concurrent Agent grants and browser pairing persist the same principal list', async () => {
  const f = await fixture();
  try {
    const project = await f.operator.call('project.create', { name: 'project' });
    const pairings = await Promise.all(Array.from({ length: 8 }, () => f.service.browser.createPairing()));
    await Promise.all(pairings.flatMap((p, index) => [
      f.pair(p.code).then(response => assert.equal(response.status, 200)),
      f.operator.call('session.grant', { projectId: project.id, externalSessionId: 'concurrent-' + index, methods: ['document.read'] }),
    ]));
    const persisted = JSON.parse(await fs.readFile(path.join(f.config.stateDir, 'principals.json'), 'utf8'));
    assert.deepEqual(persisted, f.service.state.principals);
    assert.equal(persisted.filter(p => p.kind === 'browser').length, 8);
    assert.equal(persisted.filter(p => p.id.startsWith('agent:')).length, 8);
  } finally { await f.cleanup(); }
});

test('revocation is rechecked after receiving a request body, before a scoped operation', async () => {
  const f = await fixture(); let release = () => {};
  try {
    await fs.mkdir(path.join(f.root, 'project'));
    const pairing = await f.service.browser.createPairing(), { value } = await (await f.pair(pairing.code)).json();
    let reached; const reading = new Promise(resolve => { reached = resolve; });
    const body = f.service.readBody.bind(f.service), gate = new Promise(resolve => { release = resolve; });
    f.service.readBody = async (req, max) => { const input = await body(req, max); if (req.url.endsWith('/project.open')) { reached(); await gate; } return input; };
    const client = new BrowserClient({ url: f.service.url, ...value });
    const pending = client.call('project.open', { path: 'project' });
    const rejected = assert.rejects(pending, e => e.error.kind === 'unauthorized');
    await reading;
    await f.operator.call('session.browser.revoke', { sessionId: f.service.state.principals.find(p => p.kind === 'browser').id });
    release(); await rejected;
    assert.deepEqual(await f.operator.call('project.list', {}), []);
  } finally { release(); await f.cleanup(); }
});

test('native folder selection grants only the selected project to that browser and survives restart', async () => {
  const f = await fixture({ nativeFolders: { maxProjects: 1 } });
  const outside = await fs.mkdtemp('/private/tmp/rho-native-');
  let restarted;
  try {
    const chosen = path.join(outside, 'project 中文 🧬'); await fs.mkdir(chosen);
    const sibling = path.join(outside, 'sibling'); await fs.mkdir(sibling);
    const nested = path.join(chosen, 'nested'); await fs.mkdir(nested);
    let calls = 0; f.service.folderPicker.choose = async () => { calls++; return chosen; };
    async function tab() { const pairing = await f.service.browser.createPairing(); return (await (await f.pair(pairing.code)).json()).value; }
    const grant = await tab(), other = await tab();
    const client = new BrowserClient({ url: f.service.url, ...grant });
    const stranger = new BrowserClient({ url: f.service.url, ...other });
    await assert.rejects(f.operator.call('project.pick', {}), e => e.error.kind === 'unauthorized');
    await assert.rejects(client.call('project.pick', { path: chosen }), e => e.error.kind === 'invalid');
    assert.equal(calls, 0);
    const result = await client.call('project.pick', {});
    assert.equal(result.cancelled, false); assert.equal(result.project.root, await fs.realpath(chosen));
    assert.equal((await client.call('observation.snapshot', { projectId: result.project.id })).project.id, result.project.id);
    assert.deepEqual((await client.call('project.list', {})).map(p => p.id), [result.project.id]);
    assert.deepEqual(await stranger.call('project.list', {}), []);
    await assert.rejects(stranger.call('observation.snapshot', { projectId: result.project.id }), e => e.error.kind === 'scope');
    for (const target of [chosen, sibling, nested]) await assert.rejects(client.call('project.open', { path: target }), e => e.error.kind === 'scope');
    f.service.folderPicker.choose = async () => sibling;
    await assert.rejects(client.call('project.pick', {}), e => e.error.kind === 'limit');
    await assert.rejects(fs.stat(path.join(sibling, '.rho')), { code: 'ENOENT' });
    f.service.folderPicker.choose = async () => chosen;
    assert.equal((await client.call('project.pick', {})).project.id, result.project.id);
    f.service.folderPicker.choose = async () => null;
    assert.deepEqual(await client.call('project.pick', {}), { cancelled: true, project: null });
    assert.equal(f.service.bridge.owned.size, 0);
    const port = Number(new URL(f.service.url).port); await f.service.close();
    restarted = await new RhoService({ ...f.config, port }).start();
    assert.equal((await client.call('observation.snapshot', { projectId: result.project.id })).project.id, result.project.id);
    assert.deepEqual(await stranger.call('project.list', {}), []);
  } finally { await restarted?.close(); await f.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});

test('native selection cancellation, concurrent windows, revocation and internal-state refusal grant nothing', async () => {
  const f = await fixture();
  const outside = await fs.mkdtemp('/private/tmp/rho-native-revoke-');
  let finish = () => {};
  try {
    const pairing = await f.service.browser.createPairing(), { value } = await (await f.pair(pairing.code)).json();
    const client = new BrowserClient({ url: f.service.url, ...value });
    f.service.folderPicker.choose = async () => null;
    assert.deepEqual(await client.call('project.pick', {}), { cancelled: true, project: null });
    for (const selected of [f.config.stateDir, f.root]) {
      f.service.folderPicker.choose = async () => selected;
      await assert.rejects(client.call('project.pick', {}), e => e.error.kind === 'scope');
    }
    let reached; const started = new Promise(r => { reached = r; });
    f.service.folderPicker.choose = () => { reached(); return new Promise(r => { finish = r; }); };
    const pending = client.call('project.pick', {}), refused = assert.rejects(pending, e => e.error.kind === 'unauthorized');
    await started;
    await assert.rejects(client.call('project.pick', {}), e => e.error.kind === 'conflict');
    await f.operator.call('session.browser.revoke', { sessionId: value.principalId });
    finish(outside); await refused;
    assert.deepEqual(await f.operator.call('project.list', {}), []);
    await assert.rejects(fs.stat(path.join(outside, '.rho')), { code: 'ENOENT' });
    assert.equal(f.service.bridge.owned.size, 0);
  } finally { finish(null); await f.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});

test('named projects combine source folders, allow duplicate display names and add sources without creating user directories', async () => {
  const f = await fixture(); const source = await fs.mkdtemp('/private/tmp/rho-project-sources-'); let restarted;
  try {
    const a = path.join(source, 'a'), b = path.join(source, 'b'), c = path.join(source, 'c');
    for (const root of [a, b, c]) { await fs.mkdir(root); await fs.writeFile(path.join(root, 'same.txt'), root.at(-1)); }
    const pairing = await f.service.browser.createPairing(), { value } = await (await f.pair(pairing.code)).json();
    const client = new BrowserClient({ url: f.service.url, ...value });
    const select = async root => { f.service.folderPicker.choose = async () => root; return (await client.call('project.source.pick', {})).selection.selectionId; };
    const input = { name: 'Project / 中文', selectionIds: [await select(a), await select(b)], changeId: 'create-1' };
    const project = await client.call('project.createWorkspace', input);
    assert.equal(project.name, input.name); assert.equal(project.sources.length, 2);
    assert.equal((await client.call('project.createWorkspace', input)).id, project.id);
    assert.equal((await client.call('observation.snapshot', { projectId: project.id })).project.sources.length, 2);
    const docA = await f.operator.call('document.open', { projectId: project.id, path: '@' + project.sources[0].id + '/same.txt' });
    const docB = await f.operator.call('document.open', { projectId: project.id, path: '@' + project.sources[1].id + '/same.txt' });
    assert.equal(docA.content, 'a'); assert.equal(docB.content, 'b'); assert.notEqual(docA.id, docB.id);
    const observer = client.observe(project.id).observe(); await observer.next(); const changed = observer.next();
    f.service.folderPicker.choose = async () => c;
    const added = await client.call('project.source.add', { projectId: project.id });
    assert.equal((await changed).value.project.sources.length, 3); await observer.return();
    assert.equal(added.project.id, project.id); assert.equal(added.project.sources.length, 3);
    assert.equal((await client.call('project.source.add', { projectId: project.id })).project.sources.length, 3);
    const second = await client.call('project.createWorkspace', { name: input.name, selectionIds: [await select(a)], changeId: 'create-2' });
    assert.notEqual(second.id, project.id);
    for (const root of [a, b, c]) assert.deepEqual(await fs.readdir(root), ['same.txt']);
    const port = Number(new URL(f.service.url).port); await f.service.close();
    restarted = await new RhoService({ ...f.config, port }).start();
    const operator = new RhoClient({ url: restarted.url, token: restarted.adminToken });
    assert.equal((await client.call('observation.snapshot', { projectId: project.id })).project.sources.length, 3);
    assert.equal((await operator.call('document.open', { projectId: project.id, path: '@' + project.sources[0].id + '/same.txt' })).id, docA.id);
    const fresh = await restarted.browser.createPairing();
    const grant = await (await fetch(restarted.url + '/api/browser/pair', { method: 'POST', headers: { origin: restarted.url, 'content-type': 'application/json' }, body: JSON.stringify({ code: fresh.code }) })).json();
    assert.ok((await new BrowserClient({ url: restarted.url, ...grant.value }).call('project.list', {})).some(p => p.id === project.id));
    assert.equal(restarted.bridge.owned.size, 0);
  } finally { await restarted?.close(); await f.cleanup(); await fs.rm(source, { recursive: true, force: true }); }
});

test('project display helpers read owner paths with either separator', async () => {
  const { lastSegment, beneath } = await import('../dist/browser.js');
  // A name with no explicit project.name falls back to the final path segment.
  assert.equal(lastSegment('/Users/me/projects/tumor-io'), 'tumor-io');
  assert.equal(lastSegment('C:\\work\\atlas'), 'atlas');
  assert.equal(lastSegment('/Users/me/projects/notes 中文'), 'notes 中文');
  assert.equal(lastSegment('/'), '');
  // Trailing separators and repeated separators do not produce an empty name.
  assert.equal(lastSegment('/Users/me/projects/atlas/'), 'atlas');
  assert.equal(lastSegment('C:\\work\\\\atlas\\'), 'atlas');
  // Containment compares whole segments on both platforms.
  assert.equal(beneath('/home/me/projects/atlas/data', '/home/me/projects'), true);
  assert.equal(beneath('C:\\work\\atlas\\data', 'C:\\work'), true);
  assert.equal(beneath('C:\\work\\atlas', 'C:\\work\\'), true);
  // A sibling that merely shares a prefix is not contained.
  assert.equal(beneath('/home/me/projects/atlas-old', '/home/me/projects/atlas'), false);
  assert.equal(beneath('C:\\work\\atlas-old', 'C:\\work\\atlas'), false);
  // A project equal to the tab root is not shown as sitting beneath itself.
  assert.equal(beneath('/home/me/projects', '/home/me/projects'), false);
  assert.equal(beneath('/home/me/projects/atlas', ''), false);
});

test('platformKind reads both the deprecated and replacement spellings', async () => {
  const { platformKind } = await import('../dist/browser.js');
  // userAgentData.platform values.
  assert.equal(platformKind('macOS'), 'macos');
  assert.equal(platformKind('iOS'), 'ios');
  assert.equal(platformKind('Windows'), 'other');
  assert.equal(platformKind('Linux'), 'other');
  assert.equal(platformKind('Chrome OS'), 'other');
  assert.equal(platformKind('Android'), 'other');
  // navigator.platform values, including iPadOS reporting MacIntel.
  assert.equal(platformKind('MacIntel'), 'macos');
  assert.equal(platformKind('iPad'), 'ios');
  assert.equal(platformKind('iPhone'), 'ios');
  assert.equal(platformKind('iPod'), 'ios');
  assert.equal(platformKind('Win32'), 'other');
  assert.equal(platformKind('Linux x86_64'), 'other');
  // A missing or empty report falls back to the neutral interface.
  assert.equal(platformKind(undefined), 'other');
  assert.equal(platformKind(''), 'other');
});
