// Black-box acceptance: exact core binary + independent Files artifact + app assets.
// No core/plugin source imports, Cargo, implicit builds, user catalog or live R.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {root, coreArtifact, readJson, hash, treeFiles, saveJson} from './components.mjs';

const core = coreArtifact({local: process.argv.includes('--local')});
const packages = readJson(path.join(root, 'target/packages.json'));
const receipt = packages.files;
assert.ok(receipt, 'Build a Files package first');
const annotations = packages.annotations;
assert.ok(annotations, 'Files declares annotations.read; build its Annotations provider first');
const packagePath = path.join(root, receipt.directory);
assert.equal(hash(JSON.stringify(treeFiles(packagePath))), receipt.sha256);
assert.equal(hash(JSON.stringify(treeFiles(path.join(root, annotations.directory)))), annotations.sha256);
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-composition-')));
const project = path.join(directory, 'project'); fs.mkdirSync(project);
const database = path.join(directory, 'catalog.sqlite'), cases = [];
const children = new Set();
let passed = false;
const report = path.join(root, `target/composition-test-${Date.now()}.json`);
function child(args) {
  const process = spawn(core.absolute, ['--database', database, '--project', project, ...args], {stdio: ['pipe', 'pipe', 'pipe']});
  children.add(process); process.once('exit', () => children.delete(process));
  let stderr = ''; process.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-12000); });
  process.diagnostic = () => stderr;
  return process;
}
function bounded(promise, label, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
async function stop(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit'); process.kill('SIGINT');
  await bounded(exited, 'child cleanup');
}
async function session() {
  const process = child(['session']), pending = new Map(); let serial = 0, readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const lines = createInterface({input: process.stdout});
  lines.on('line', line => {
    const value = JSON.parse(line);
    if (value.type === 'ready') readyResolve(value);
    else { pending.get(value.id)?.(value); pending.delete(value.id); }
  });
  await bounded(ready, 'session startup');
  async function request(method, params) {
    const id = `frame-${++serial}`, result = new Promise(resolve => pending.set(id, resolve));
    process.stdin.write(JSON.stringify({id, request: {method, params}}) + '\n');
    return bounded(result, `${method}: ${process.diagnostic()}`);
  }
  async function query(id, arguments_) {
    const reply = await request('query_snapshot', {capability: {id, version: 1}, arguments: arguments_});
    assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.result.data;
  }
  async function invoke(client_request_id, id, arguments_) {
    const reply = await request('invoke', {client_request_id, capability: {id, version: 1}, arguments: arguments_, preconditions: []});
    assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.result;
  }
  return {process, request, query, invoke};
}
async function web(assets) {
  const process = child(['workbench', ...(assets ? ['--assets', assets] : []), '--default-project', project]);
  const lines = createInterface({input: process.stdout});
  const line = await bounded(once(lines, 'line'), 'HTTP startup');
  const url = new URL(line[0]), token = new URLSearchParams(url.hash.slice(1)).get('token');
  return {process, origin: url.origin, token};
}
try {
  const empty = await session();
  assert.equal((await empty.query('plugins.list', {after: null, limit: 100})).total, 0);
  await stop(empty.process); cases.push('empty core has no installed scientific packages');
  const packed = JSON.parse(execFileSync(core.absolute, ['--database', database, 'plugins', 'snapshot', packagePath, '--target', receipt.target], {encoding: 'utf8'})).result;
  const annotationPackage = JSON.parse(execFileSync(core.absolute, ['--database', database, 'plugins', 'snapshot', path.join(root, annotations.directory), '--target', annotations.target], {encoding: 'utf8'})).result;
  fs.writeFileSync(path.join(project, 'analysis.R'), 'x <- 1\n');
  const live = await session();
  const annotationProvider = await live.invoke('activate-annotations', 'plugins.activate', {revision: annotationPackage.revision,
    artifact: annotationPackage.artifacts[0], target: annotations.target, alias: 'annotations', configuration: {}});
  assert.equal(annotationProvider.status, 'succeeded', JSON.stringify(annotationProvider));
  const activated = await live.invoke('activate-files', 'plugins.activate', {revision: packed.revision, artifact: packed.artifacts[0],
    target: receipt.target, alias: 'files', configuration: {}});
  assert.equal(activated.status, 'succeeded', JSON.stringify(activated));
  const instance = activated.output.instance.identity;
  const resolve = id => live.query('plugins.resolve', {instance, capability: {id, version: 1}});
  const snapshot = await live.query('files.snapshot', {binding: await resolve('files.snapshot'), arguments: {paths: ['analysis.R']}});
  const readBinding = await resolve('files.read_text');
  const escaped = await live.request('query_snapshot', {capability: {id: 'files.read_text', version: 1}, arguments: {binding: readBinding, arguments: {path: '../outside'}}});
  assert.equal(escaped.ok, false); cases.push('Files refuses project escape');
  const arguments_ = {binding: await resolve('files.apply_patch'), arguments: {
    patch: 'diff --git a/analysis.R b/analysis.R\n--- a/analysis.R\n+++ b/analysis.R\n@@ -1 +1 @@\n-x <- 1\n+x <- 2\n'},
    preconditions: [{kind: 'file.sha256', subject: 'analysis.R', expected: snapshot.files[0].sha256}]};
  const original = await live.invoke('patch-once', 'files.apply_patch', arguments_);
  assert.equal(original.status, 'succeeded', JSON.stringify(original));
  assert.equal(fs.readFileSync(path.join(project, 'analysis.R'), 'utf8'), 'x <- 2\n');
  const repeated = await live.invoke('patch-once', 'files.apply_patch', arguments_);
  assert.equal(repeated.operation.operation_id, original.operation.operation_id);
  const stale = await live.invoke('stale-patch', 'files.apply_patch', arguments_);
  assert.equal(stale.status, 'failed');
  assert.equal(fs.readFileSync(path.join(project, 'analysis.R'), 'utf8'), 'x <- 2\n');
  cases.push('real file patch, original-operation retry, stale-write refusal');
  await stop(live.process);
  const restarted = await session();
  const retained = await restarted.request('get_operation', {operation_id: original.operation.operation_id});
  assert.equal(retained.ok, true); assert.equal(retained.result.status, 'succeeded');
  const replay = await restarted.invoke('patch-once', 'files.apply_patch', arguments_);
  assert.equal(replay.operation.operation_id, original.operation.operation_id);
  assert.equal(fs.readFileSync(path.join(project, 'analysis.R'), 'utf8'), 'x <- 2\n');
  await stop(restarted.process); cases.push('restart retains original result without re-executing the file patch');
  const bare = await web();
  const landing = await fetch(bare.origin).then(r => r.text());
  assert.ok(landing.includes('No application assets were selected'));
  assert.equal((await fetch(`${bare.origin}/app.js`)).status, 404);
  await stop(bare.process);
  const assets = path.join(directory, 'assets'); fs.mkdirSync(assets);
  for (const file of ['index.html', 'app.js', 'style.css']) fs.copyFileSync(path.join(root, 'target/app-assets', file), path.join(assets, file));
  const app = await web(assets);
  const html = await fetch(app.origin).then(r => r.text());
  assert.ok(html.includes('/app.js') && !html.includes('__RHO_CSP_NONCE__'));
  assert.equal(await fetch(`${app.origin}/app.js`).then(r => r.text()), fs.readFileSync(path.join(assets, 'app.js'), 'utf8'));
  fs.appendFileSync(path.join(assets, 'index.html'), '\n<!-- application changed -->');
  assert.ok((await fetch(app.origin).then(r => r.text())).includes('application changed'));
  fs.unlinkSync(path.join(assets, 'app.js')); fs.symlinkSync(path.join(project, 'analysis.R'), path.join(assets, 'app.js'));
  assert.equal((await fetch(`${app.origin}/app.js`)).status, 404);
  assert.equal((await fetch(`${app.origin}/api/info`)).status, 401);
  await stop(app.process);
  assert.equal(hash(fs.readFileSync(core.absolute)), core.sha256);
  cases.push('external application HTML/JS, live asset refresh, containment, authentication and unchanged core bytes');
  const evidence = {status: 'passed', core_sha256: core.sha256, files_package_sha256: receipt.sha256,
    annotations_package_sha256: annotations.sha256, cases};
  saveJson(report, evidence); saveJson(path.join(root, 'target/composition-test.json'), {...evidence, report});
  passed = true;
  console.log(JSON.stringify({status: 'passed', cases}, null, 2));
} catch (error) {
  saveJson(report, {status: 'failed', cases, error: String(error), directory});
  throw error;
} finally {
  for (const process of children) {
    try { await stop(process); } catch { process.kill('SIGKILL'); }
  }
  if (passed) fs.rmSync(directory, {recursive: true, force: true});
}
