// Real ordinary Editor → Annotations → contributed context → same-instance
// Host restart. Reuse explicit packages and a frozen Host; never build here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyRBuild} from './r-plugin-artifact.mjs';
import {annotationFiles} from './fixtures/annotation-files.mjs';
import {annotationScientific} from './fixtures/annotation-scientific.mjs';
import {verifyAgentBuild} from './agent-plugin-artifact.mjs';
import {annotationAgent} from './fixtures/annotation-agent.mjs';
import {annotationImageAgent} from './fixtures/annotation-image-agent.mjs';
import {annotationNativeAgent} from './fixtures/annotation-native-agent.mjs';
import {buildCaptureSource, annotationCaptures} from './fixtures/annotation-captures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
assert.ok(new Set(flags).size === flags.length && flags.every(arg => ['--agent', '--browser', '--captures', '--scientific', '--files'].includes(arg)), 'Usage: node scripts/test-annotation-plugin.mjs [--agent [--browser]] [--captures] [--scientific] [--files]');
const withAgent = process.argv.includes('--agent');
const withBrowser = process.argv.includes('--browser');
const withCaptures = process.argv.includes('--captures');
const withFiles = process.argv.includes('--files');
const withScientific = process.argv.includes('--scientific');
assert.ok(!withScientific || (process.env.RHO_ARK && process.env.RHO_R_HOME), '--scientific requires existing RHO_ARK and RHO_R_HOME');
assert.ok(!withBrowser || withAgent, '--browser requires --agent');
const binary = process.env.RHO_TEST_BINARY ?? path.join(root, 'target/debug/rho');
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hostHash = hash(fs.readFileSync(binary));
const packages = Object.fromEntries(['annotation', 'editor', 'files', ...(withAgent ? ['agent'] : []), ...(withScientific ? ['r'] : [])].map(name => {
  const value = process.env[`RHO_${name.toUpperCase()}_PLUGIN_PACKAGE`];
  assert.ok(value, `Supply RHO_${name.toUpperCase()}_PLUGIN_PACKAGE; this check never builds`);
  const directory = fs.realpathSync(value);
  assert.ok(!directory.startsWith(root + path.sep), 'Use an assembled external package');
  return [name, directory];
}));
if (withAgent) verifyAgentBuild(packages.agent);
if (withScientific) verifyRBuild(packages.r);
// Refuse stale Rust source in either owner and in the annotation package's public SDK.
function rustFiles(directory, prefix = '') {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    if (['target', 'dist', 'node_modules'].includes(entry.name)) return [];
    assert.ok(!entry.isSymbolicLink(), 'Source tree cannot contain symlinks');
    const file = path.join(directory, entry.name), relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? rustFiles(file, relative) : entry.name.endsWith('.rs') ? [relative] : [];
  }).sort();
}
for (const [source, packaged] of [
  ['plugins/annotations/api', path.join(packages.annotation, 'api')],
  ['plugins/annotations/backend', path.join(packages.annotation, 'backend')],
  ['plugins/editor/backend', path.join(packages.editor, 'backend')],
  ...(withFiles ? [['plugins/files/backend', path.join(packages.files, 'backend')]] : []),
  ['crates/plugin-protocol', path.join(packages.annotation, 'public/native/plugin-protocol')],
  ['crates/plugin-sdk', path.join(packages.annotation, 'public/native/plugin-sdk')],
]) {
  const current = path.join(root, source), files = rustFiles(current);
  assert.deepEqual(rustFiles(packaged), files, `Stale ${source} file set`);
  for (const file of files) assert.equal(hash(fs.readFileSync(path.join(packaged, file))),
    hash(fs.readFileSync(path.join(current, file))), `Stale ${source}/${file}`);
}

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-annotation-host-')));
if (withCaptures) packages.capture = buildCaptureSource(directory);
const project = path.join(directory, 'project'), database = path.join(directory, 'host.sqlite');
fs.mkdirSync(project);
execFileSync('git', ['init', '-q', project]);
const hostEnvironment = {...process.env};
const nativeHome = path.join(directory, 'native-home');
if (withAgent) {
  const nativeBin = path.join(directory, 'native-bin');
  fs.mkdirSync(nativeBin); fs.mkdirSync(nativeHome);
  fs.writeFileSync(path.join(nativeBin, 'rho-science-fixture'), 'disposable');
  fs.copyFileSync(path.join(root, 'crates/host/tests/fixtures/agent-science.cjs'), path.join(nativeBin, 'kimi'));
  fs.copyFileSync(path.join(root, 'scripts/fixtures/agent-annotation-tools.cjs'), path.join(nativeBin, 'agent-annotation-tools.cjs'));
  fs.chmodSync(path.join(nativeBin, 'kimi'), 0o700);
  hostEnvironment.PATH = nativeBin + path.delimiter + process.env.PATH;
}
const window = 'annotation-acceptance-window';
const result = {host_sha256: hostHash, packages, directory, stages: [], completed: false,
  manifests: Object.fromEntries(Object.entries(packages).map(([name, source]) => [name, hash(fs.readFileSync(path.join(source, 'plugin.json')))])),
  backends: Object.fromEntries(Object.entries(packages).map(([name, source]) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json')));
    const bytes = fs.readFileSync(path.join(source, manifest.backend.executable));
    return [name, {sha256: hash(bytes), bytes: bytes.length}];
  })), started_at: new Date().toISOString()};
const evidence = process.env.RHO_ANNOTATION_EVIDENCE ?? path.join(directory, 'result.json');
let host, exited, url, editor, notes, agent, agentCase, nativeCase, captureSource, captureCase, imageCase, r, scientificCase, scientificAgentCase, files, filesCase;
const key = id => ({id, version: 1});
const save = () => fs.writeFileSync(evidence, JSON.stringify(result, null, 2) + '\n');
const safe = text => String(text).replace(/token=[a-z0-9]+/g, 'token=[redacted]');
function deadline(promise, label, ms = 30000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);
  })]).finally(() => clearTimeout(timer));
}
async function start() {
  host = spawn(binary, ['--database', database, '--project', project, '--plugins-only', 'workbench'], {stdio: ['ignore', 'pipe', 'pipe'], env:hostEnvironment});
  exited = new Promise(resolve => host.once('exit', (code, signal) => resolve({code, signal})));
  let output = '', errors = '';
  url = new URL(await deadline(new Promise((resolve, reject) => {
    host.on('error', reject);
    host.stderr.on('data', bytes => { const text = safe(bytes); errors += text; fs.appendFileSync(path.join(directory, 'host-stderr.log'), text); });
    host.stdout.on('data', bytes => {
      output += bytes;
      const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);
      if (found) resolve(found[0]);
    });
    exited.then(status => reject(Error(`Owned Host exited ${JSON.stringify(status)}: ${errors}`)));
  }), 'Owned Host startup', 60000));
}
async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  host.kill('SIGINT');
  const ended = await deadline(exited, 'Owned Host drain', 30000);
  assert.equal(ended.code, 0, JSON.stringify(ended));
}
async function port(method, params) {
  const response = await fetch(new URL('/api/host', url), {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: {Authorization: `Bearer ${url.hash.slice(7)}`, 'Content-Type': 'application/json', 'X-Rho-Studio-Window': window},
    body: JSON.stringify({project_root: project, frame: {id: randomUUID(), request: {method, params}}}),
  });
  const reply = await response.json();
  assert.equal(reply.ok, true, safe(JSON.stringify(reply)));
  return reply.result;
}
async function query(id, args) {
  const observation = await port('query_snapshot', {capability: key(id), arguments: args});
  assert.equal(observation.status, 'ready', JSON.stringify(observation));
  assert.equal(observation.completeness, 'complete', JSON.stringify(observation));
  return observation.data;
}
async function invoke(id, args, request = randomUUID(), expected = 'succeeded') {
  let record = await port('invoke', {capability: key(id), arguments: args, preconditions: [], client_request_id: request});
  const until = Date.now() + 15000;
  while (!['succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status)) {
    assert.ok(Date.now() < until, `Original ${id} did not settle`);
    record = await port('get_operation', {operation_id: record.operation.operation_id});
    if (!['succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status))
      await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(record.status, expected, JSON.stringify({id, status: record.status, error: record.error}));
  return record;
}
const binding = (instance, id) => query('plugins.resolve', {instance, capability: key(id)});
const pluginQuery = async (instance, id, arguments_) => query(id, {binding: await binding(instance, id), arguments: arguments_});
const write = async (request_id, command, request = randomUUID(), expected = 'succeeded') =>
  invoke('annotations.write', {binding: await binding(notes, 'annotations.write'), arguments: {request_id, command}}, request, expected);
async function draft(raw, expected_version = null) {
  const upload = randomUUID(), draft = 'retained-editor-draft';
  const bytes = Buffer.from(JSON.stringify({schema: 1, document: {raw, path: '研究.R', version: 'document-v1', anchor: 1, head: 4, readonly: null}}));
  const chunk = {digest: hash(bytes), bytes: bytes.length};
  await port('control', {capability: key('documents.stage'), arguments: {window, draft, upload, digest: chunk.digest, base64: bytes.toString('base64')}});
  return (await invoke('documents.save', {window, draft, upload, source: {revision: editor.revision, contribution: 'editor'}, expected_version,
    content: {...chunk, chunks: [chunk]}, metadata: {encoding: 'org.rho.editor.document.v1', path: '研究.R', name: '研究.R', document_version: 'document-v1', selection: {anchor: 1, head: 4}, read_only: false}})).output;
}
async function selected() {
  const page = await pluginQuery(editor, 'editor.context.search', {window, text: '研究', after: null, limit: 20});
  assert.equal(page.items.length, 1);
  const reference = page.items[0].reference;
  const preview = await pluginQuery(editor, 'editor.context.preview', {reference, inclusion: {kind: 'document'}, max_bytes: 16384});
  return {reference, identity: preview.data.annotation_source};
}
try {
  const snapshots = {};
  for (const [name, source] of Object.entries(packages)) {
    snapshots[name] = JSON.parse(execFileSync(binary, ['--database', database, 'plugins', 'snapshot', source, '--target', 'aarch64-apple-darwin'], {encoding: 'utf8', timeout: 60000})).result;
  }
  result.snapshots = snapshots;
  await start();
  for (const name of ['files', 'editor', ...(withScientific ? ['r'] : []), 'annotation', ...(withAgent ? ['agent'] : []), ...(withCaptures ? ['capture'] : [])]) {
    const snapshot = snapshots[name];
    const active = (await invoke('plugins.activate', {revision: snapshot.revision, artifact: snapshot.artifacts[0], target: 'aarch64-apple-darwin', alias: name, configuration: name === 'agent' ? {kimi_home:nativeHome} : name === 'r' ? {ark:fs.realpathSync(process.env.RHO_ARK),r_home:fs.realpathSync(process.env.RHO_R_HOME),execution_timeout_seconds:120} : {},
      optional_capabilities: name === 'annotation' ? [key('editor.context.preview'), ...(withFiles ? [key('files.context.preview')] : []), ...(withScientific ? ['r.context.help.preview','r.context.viewer.preview','r.context.console.preview','r.context.plots.preview','r.context.objects.preview','r.context.packages.preview'].map(key) : []), ...(withCaptures ? [key('resources.read')] : [])] : name === 'agent'
        ? ['plugins.instances', 'plugins.inspect', 'annotations.read', 'annotations.write', 'annotations.context.search', 'annotations.context.preview', 'operation.get', 'plugins.delegated_operation', ...(withCaptures ? ['resources.read'] : [])].map(key) : name === 'r' ? ['operation.get','operation.list_recent','resources.read'].map(key) : []})).output.instance.identity;
    if (name === 'editor') editor = active;
    if (name === 'files') files = active;
    if (name === 'annotation') notes = active;
    if (name === 'agent') agent = active;
    if (name === 'capture') captureSource = active;
    if (name === 'r') r = active;
  }
  const initial = await draft('a🧬中z\n');
  const first = await selected();
  const freeze = {kind: 'freeze', reference: first.reference, inclusion: {kind: 'document'}, anchor: {kind: 'text_quote', quote: '🧬中', start: 1, end: 4, unit: 'utf16'}};
  const frozen = await write('capture-original', freeze, 'host-freeze-original');
  const create = {kind: 'create', evidence_id: frozen.output.outcome.evidence_id, note: 'Check the original 🧬 result', labels: [], marks: [], continued_from: null};
  const saved = await write('note-original', create);
  const original = saved.output.outcome.annotation;
  const read = await pluginQuery(notes, 'annotations.read', {kind: 'read', annotation: original});
  assert.equal(read.evidence.fragment.text, '🧬中');
  assert.equal(read.evidence.source.source_version, first.identity.source_version);
  assert.equal(read.revision.author.kind, 'principal');
  const page = await pluginQuery(notes, 'annotations.context.search', {window, text: '🧬', after: null, limit: 20});
  assert.equal(page.items.length, 1);
  const notePreview = {reference: page.items[0].reference, inclusion: {kind: 'note_and_evidence'}, max_bytes: 16384};
  const context = await pluginQuery(notes, 'annotations.context.preview', notePreview);
  assert.ok(context.text.includes(create.note));
  assert.equal(context.data.source_status, 'unknown');
  result.stages.push('real Editor freeze → note → contributed context'); save();
  if (withFiles) {
    filesCase = await annotationFiles({files,notes,window,project,binding,invoke,pluginQuery,query,port});
    result.files = filesCase.report;
    result.stages.push('real Files source → frozen quoted evidence; content identity, stale source refusal and retained history'); save();
  }
  if (withCaptures) {
    captureCase = await annotationCaptures({notes,captureSource,reference:first.reference,pluginQuery,invoke,binding,query});
    result.captures = captureCase.report;
    result.stages.push('public PNG resource → validated capture → frozen Editor evidence and marks → bounded image reads; damaged image refused'); save();
  }
  if (withScientific) {
    scientificCase = await annotationScientific({r,notes,window,binding,invoke,pluginQuery,query,port});
    result.scientific = scientificCase.report;
    result.stages.push('real R Help, saved HTML, Console, Plots, Objects and Packages → frozen annotation evidence; stable identity and immutable provenance'); save();
  }
  if (withAgent) {
    agentCase = await annotationAgent({agent, notes, context, notePreview, port, query, invoke, binding, pluginQuery});
    result.agent = agentCase.report;
    result.stages.push('real Agent Rho Send captures the exact annotation and delivers it through Rig to a local model peer'); save();
    if (withBrowser) {
      const {annotationAgentBrowser} = await import('./fixtures/annotation-agent-browser.mjs');
      result.browser = await annotationAgentBrowser({url, window, agent, query, invoke, pluginQuery, notePreview, image:captureCase?.image, directory});
      result.stages.push('ordinary Agent picker previews and adds the exact note to an editable draft, retained after reload without Send'); save();
    }
    nativeCase = await annotationNativeAgent({agent, notes, original, evidenceId:frozen.output.outcome.evidence_id, image:captureCase?.image, project, invoke, binding, pluginQuery, query, port});
    if (captureCase) {
      imageCase=await annotationImageAgent({agent,notes,image:captureCase.image,port,query,invoke,binding,pluginQuery});
      result.image_agent=imageCase.report;
      result.stages.push('explicit captured image reaches Rho model; subsequent text-only Send does not resend it');save();
    }
    if (scientificCase) {
      scientificAgentCase = await annotationAgent({agent,notes,port,query,invoke,binding,pluginQuery,cases:scientificCase.cases,id:'scientific-annotation-reader'});
      result.scientific_agent = scientificAgentCase.report;
      result.stages.push('Help, Viewer, Console, Plots, Objects and Packages annotation evidence reaches real Agent/Rig through exact note contexts'); save();
    }
    result.native_agent = nativeCase.report;
    result.stages.push('Native Agent exact Send tools: read-only write refusal, authenticated create/update, CAS and original child Operations'); save();
  }


  await draft('a🧬中z changed\n', initial.version);
  const second = await selected();
  assert.equal(first.identity.source_id, second.identity.source_id);
  assert.notEqual(first.identity.source_version, second.identity.source_version);
  await write('stale-source', freeze, randomUUID(), 'failed');
  assert.equal((await pluginQuery(notes, 'annotations.read', {kind: 'receipt', request_id: 'stale-source'})).receipt, null);
  const nextFreeze = await write('capture-next', {...freeze, reference: second.reference});
  const continued = await write('continue-note', {...create, evidence_id: nextFreeze.output.outcome.evidence_id, continued_from: original, note: 'Continue on the new version'});
  const changed = await write('update-note', {kind: 'update', expected: original, note: 'Revised original note', labels: [], marks: []});
  await write('stale-update', {kind: 'update', expected: original, note: 'Must not overwrite', labels: [], marks: []}, randomUUID(), 'failed');
  await write('delete-note', {kind: 'delete', expected: changed.output.outcome.annotation});
  assert.deepEqual(await pluginQuery(notes, 'annotations.context.preview', notePreview), context, 'Historical preview is immutable after edits and tombstone');
  result.stages.push('source change refusal, explicit continuation, CAS, tombstone and historical preview'); save();

  await stop(); await start();
  const suspended = await query('plugins.instance', {instance: notes});
  assert.equal(suspended.instance.state, 'suspended');
  assert.equal((await query('plugins.instance', {instance: editor})).instance.state, 'suspended');
  if (agentCase) {
    await agentCase.afterRestart();
    await nativeCase.afterRestart();
    if (imageCase) await imageCase.afterRestart();
    if (scientificAgentCase) await scientificAgentCase.afterRestart();
    result.stages.push('same Agent instance retains Send context and receipt while its annotation source stays suspended'); save();
  }
  const resumed = (await invoke('plugins.resume', {instance: notes, suspension: suspended.instance.suspension})).output.instance;
  assert.deepEqual(resumed.identity, notes);
  if (nativeCase) await nativeCase.afterSourceResume();
  if (captureCase) await captureCase.afterRestart();
  if (scientificCase) await scientificCase.afterRestart();
  if (filesCase) await filesCase.afterRestart();
  assert.deepEqual((await write('capture-original', freeze)).output, frozen.output, 'Native replay must not reread the suspended Editor');
  assert.deepEqual((await write('note-original', create)).output, saved.output);
  const originalHostReceipt = await write('capture-original', freeze, 'host-freeze-original');
  assert.equal(originalHostReceipt.operation.operation_id, frozen.operation.operation_id);
  assert.deepEqual(await pluginQuery(notes, 'annotations.context.preview', notePreview), context);
  const current = await pluginQuery(notes, 'annotations.read', {kind: 'read', annotation: continued.output.outcome.annotation});
  assert.equal(current.revision.note, 'Continue on the new version');
  assert.equal((await query('plugins.instance', {instance: editor})).instance.state, 'suspended', 'Reads/replays must not resume the source');
  result.stages.push('actual graceful Host restart, same annotation instance, original native and Host receipts without source replay');
  result.completed = true;
} catch (error) {
  result.error = safe(error.stack ?? error); throw error;
} finally {
  try { await stop(); }
  catch (error) {
    result.completed = false; result.cleanup_error = safe(error.message);
    if (host?.exitCode === null && host?.signalCode === null) {
      host.kill('SIGKILL');
      try { await deadline(exited, 'Owned Host forced cleanup', 5000); }
      catch (forced) { result.cleanup_error += `; ${safe(forced.message)}`; }
    }
  }
  if (agentCase) await agentCase.close();
  if (imageCase) await imageCase.close();
  if (scientificAgentCase) await scientificAgentCase.close();
  assert.equal(hash(fs.readFileSync(binary)), hostHash, 'Acceptance must not replace the Host');
  result.finished_at = new Date().toISOString();
  save(); console.log(JSON.stringify({completed: result.completed, evidence, directory, stages: result.stages}));
  if (!result.completed) process.exitCode = 1;
}
