// This acceptance never compiles the Host. Build the current binary explicitly
// before running it; the independently built package must use the same bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildProcessPlugin} from './build-process-plugin.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-process-native-')));
const project = path.join(temporary, 'project'), database = path.join(temporary, 'host.sqlite');
fs.mkdirSync(project);
const binary = process.env.RHO_TEST_BINARY ?? path.join(root, 'target/debug/rho');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHost = digest(fs.readFileSync(binary));
const source = process.env.RHO_PROCESS_PLUGIN_PACKAGE ? fs.realpathSync(process.env.RHO_PROCESS_PLUGIN_PACKAGE) : buildProcessPlugin(path.join(temporary, 'package'));
assert.ok(!source.startsWith(root + path.sep), 'Use an independently assembled package');
assert.equal(digest(fs.readFileSync(binary)), originalHost);
let host, ready, exited, complete = false, counter = 0;
const pending = new Map(), sockets = new Set();
const trace = (kind, value) => fs.appendFileSync(path.join(temporary, 'session.jsonl'), JSON.stringify({kind, value}) + '\n');
function deadline(promise, label, ms = 180000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
});
async function call(method, params) {
  const id = `request-${++counter}`;
  const reply = new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
  host.stdin.write(JSON.stringify({id, request: {method, params}}) + '\n');
  const packet = await deadline(reply, `${method} ${id}`);
  assert.equal(packet.ok, true, JSON.stringify(packet));
  return packet.result;
}
async function query(id, arguments_, version = 1) {
  const result = await call('query_snapshot', {capability: {id, version}, arguments: arguments_});
  assert.equal(result.status, 'ready', JSON.stringify(result));
  return result.data;
}
const invoke = (id, cap, args, version = 1, accepted = false) => call('invoke', {
  client_request_id: id, capability: {id: cap, version}, arguments: args, preconditions: [], return_after_acceptance: accepted,
});
const succeeded = record => { assert.equal(record.status, 'succeeded', JSON.stringify({operation: record.operation.operation_id, status: record.status, error: record.error, recovery: record.recovery})); return record; };
async function until(read, predicate, label) {
  const start = Date.now();
  for (;;) {
    const result = await read();
    if (predicate(result)) return result;
    assert.ok(Date.now() - start < 15000, `${label}: ${JSON.stringify(result)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function resource(reference) {
  const chunks = []; let offset = 0;
  for (;;) {
    const chunk = await query('resources.read', {reference, offset, limit: 65536});
    assert.deepEqual(chunk.reference, reference); assert.equal(chunk.offset, offset);
    chunks.push(Buffer.from(chunk.base64, 'base64'));
    if (chunk.next == null) break;
    assert.ok(chunk.next > offset); offset = chunk.next;
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, reference.bytes); assert.equal(`sha256:${digest(bytes)}`, reference.digest);
  return JSON.parse(bytes);
}
try {
  execFileSync('python3', [path.join(source, 'tests/protocol.py'), path.join(source, 'dist/rho-process-backend')], {cwd: source, stdio: 'inherit', timeout: 180000});
  const snapshot = JSON.parse(execFileSync(binary, ['--database', database, '--project', project, 'plugins', 'snapshot', source, '--target', 'aarch64-apple-darwin'], {encoding: 'utf8', timeout: 180000})).result;
  assert.ok(snapshot.revision && snapshot.artifacts[0], JSON.stringify(snapshot));
  trace('snapshot', snapshot);
  host = spawn(binary, ['--database', database, '--project', project, 'session'], {stdio: ['pipe', 'pipe', 'pipe']});
  const handshake = new Promise((resolve, reject) => { ready = {resolve, reject}; });
  exited = new Promise(resolve => host.once('close', (code, signal) => resolve({code, signal})));
  host.on('error', error => { ready.reject(error); for (const request of pending.values()) request.reject(error); });
  host.on('exit', (code, signal) => {
    const error = new Error(`Owned Host exited ${code}/${signal}`);
    ready.reject(error); for (const request of pending.values()) request.reject(error);
  });
  host.stderr.on('data', bytes => fs.appendFileSync(path.join(temporary, 'host.stderr'), bytes));
  readline.createInterface({input: host.stdout}).on('line', line => {
    try {
      const packet = JSON.parse(line); trace('reply', packet);
      if (packet.type === 'ready') ready.resolve(packet);
      else { assert.ok(pending.has(packet.id), 'Uncorrelated Host reply'); pending.get(packet.id).resolve(packet); pending.delete(packet.id); }
    } catch (error) { ready.reject(error); for (const request of pending.values()) request.reject(error); }
  });
  assert.equal((await deadline(handshake, 'Host ready')).protocol_version, 1);
  const active = succeeded(await invoke('activate-process', 'plugins.activate', {revision: snapshot.revision, artifact: snapshot.artifacts[0], target: 'aarch64-apple-darwin', alias: 'process', configuration: {}}));
  const identity = active.output.instance.identity;
  const binding = await query('plugins.resolve', {instance: identity, capability: {id: 'process.run_local', version: 2}});
  const statusBinding = await query('plugins.resolve', {instance: identity, capability: {id: 'process.status', version: 1}});
  const status = () => query('process.status', {binding: statusBinding, arguments: {}});
  assert.deepEqual((await status()).activities, []);
  const payload = '\0中文🧪\n'.repeat(7000), once = path.join(project, 'once.txt');
  const args = {program: process.execPath, args: ['-e', "require('fs').appendFileSync('once.txt','once\\n');process.stdin.pipe(process.stdout);process.stderr.write('stderr 中文');"], stdin: payload, timeout_ms: 15000, output_limit_bytes: 131072};
  const runArgs = {binding, arguments: args};
  const first = succeeded(await invoke('original-run', 'process.run_local', runArgs, 2));
  const report = await resource(first.output.report);
  assert.deepEqual(first.output.report.owner, identity);
  assert.equal(first.output.operation, first.operation.operation_id);
  assert.deepEqual(Buffer.from(report.stdout.bytes), Buffer.from(payload));
  assert.equal(report.stdout.total_bytes, Buffer.byteLength(payload));
  assert.equal(Buffer.from(report.stderr.bytes).toString(), 'stderr 中文');
  assert.equal(report.stdout.eof, true); assert.equal(report.stdout.truncated, false);
  assert.equal(report.termination, 'exited'); assert.equal(report.exit_code, 0);
  const replay = succeeded(await invoke('original-run', 'process.run_local', runArgs, 2));
  assert.equal(replay.operation.operation_id, first.operation.operation_id); assert.deepEqual(replay.output, first.output);
  assert.equal(fs.readFileSync(once, 'utf8'), 'once\n');
  await assert.rejects(() => invoke('wrong-target', 'process.run_local', {binding: {...binding, target: temporary}, arguments: args}, 2), /target|project/i);
  assert.equal(fs.readFileSync(once, 'utf8'), 'once\n');
  await until(status, value => value.activities.length === 0, 'Original settlement');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connected = new Promise(resolve => server.once('connection', socket => {
    let bytes = ''; socket.on('data', chunk => { bytes += chunk; if (bytes.includes('\n')) resolve({socket, operation: bytes.trim()}); });
  }));
  const cancelArgs = {binding, arguments: {program: process.execPath, args: ['-e', `const socket=require('net').connect(${server.address().port},'127.0.0.1',()=>socket.write(process.env.RHO_OPERATION_ID+'\\n'));setInterval(()=>{},1000);`], timeout_ms: 30000}};
  const accepted = await invoke('cancel-running', 'process.run_local', cancelArgs, 2, true);
  const native = await deadline(connected, 'Native operation readiness', 20000);
  assert.equal(native.operation, accepted.operation.operation_id);
  const closed = new Promise(resolve => native.socket.once('close', resolve));
  const requested = await call('request_cancellation', {operation_id: accepted.operation.operation_id});
  assert.equal(requested.accepted, true);
  const cancelled = await until(() => call('get_operation', {operation_id: accepted.operation.operation_id}), value => ['succeeded','failed','cancelled','uncertain'].includes(value.status), 'Native cancellation');
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  assert.equal(cancelled.cancellation_requested, true);
  assert.equal((await resource(cancelled.output.report)).termination, 'cancelled');
  await deadline(closed, 'Owned native socket closed', 10000);
  await until(status, value => value.activities.length === 0, 'Cancellation settlement');
  const reconcileBinding = await query('plugins.resolve', {instance: identity, capability: {id: 'process.reconcile', version: 2}});
  await assert.rejects(() => invoke('reject-non-process-source', 'process.reconcile', {binding: reconcileBinding, arguments: {operation_id: active.operation.operation_id}}, 2), /original|binding|reconciliation/i);
  const detachedReady = new Promise(resolve => server.once('connection', socket => {
    let bytes = ''; socket.on('data', chunk => { bytes += chunk; if (bytes.includes('\n')) resolve({socket, ...JSON.parse(bytes.trim())}); });
  }));
  // The explicit recovery scenario deliberately leaves a separately grouped,
  // tagged child. Its own test socket closes it on every failure path.
  const childCode = `const socket=require('net').connect(${server.address().port},'127.0.0.1',()=>socket.write(JSON.stringify({pid:process.pid,operation:process.env.RHO_OPERATION_ID})+'\\n'));socket.on('close',()=>process.exit(0));socket.on('error',()=>process.exit(1));`;
  const parentCode = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});child.unref();require('fs').appendFileSync('detached-once.txt','once\\n');`;
  const detachedArgs = {binding, arguments: {program: process.execPath, args: ['-e', parentCode], timeout_ms: 15000}};
  const detached = succeeded(await invoke('detached-original', 'process.run_local', detachedArgs, 2));
  const originalChild = await deadline(detachedReady, 'Original detached process readiness', 15000);
  assert.equal(originalChild.operation, detached.operation.operation_id);
  await until(status, value => value.activities.length === 0, 'Detached source settlement');
  const childClosed = new Promise(resolve => originalChild.socket.once('close', resolve));
  const reconcileArgs = {binding: reconcileBinding, arguments: {operation_id: detached.operation.operation_id}};
  const reconciled = succeeded(await invoke('reconcile-original', 'process.reconcile', reconcileArgs, 2));
  assert.equal(reconciled.output.source_operation_id, detached.operation.operation_id);
  assert.equal(reconciled.output.completeness, 'partial');
  assert.ok(reconciled.output.signalled.some(native => native.pid === originalChild.pid && native.started_at_seconds > 0));
  assert.deepEqual(reconciled.output.remaining, []);
  await deadline(childClosed, 'Explicit recovery confirmed native closure', 10000);
  const originalAfterRecovery = await call('get_operation', {operation_id: detached.operation.operation_id});
  assert.equal(originalAfterRecovery.status, detached.status); assert.deepEqual(originalAfterRecovery.output, detached.output);
  const recoveryReplay = succeeded(await invoke('reconcile-original', 'process.reconcile', reconcileArgs, 2));
  assert.equal(recoveryReplay.operation.operation_id, reconciled.operation.operation_id);
  const sourceReplay = succeeded(await invoke('detached-original', 'process.run_local', detachedArgs, 2));
  assert.equal(sourceReplay.operation.operation_id, detached.operation.operation_id);
  assert.equal(fs.readFileSync(path.join(project, 'detached-once.txt'), 'utf8'), 'once\n');
  await until(status, value => value.activities.length === 0, 'Reconciliation settlement');
  const crashReady = new Promise(resolve => server.once('connection', socket => {
    let bytes = ''; socket.on('data', chunk => { bytes += chunk; if (bytes.includes('\n')) resolve({socket, ...JSON.parse(bytes.trim())}); });
  }));
  const crashCode = `require('fs').appendFileSync('crash-once.txt','once\\n');const socket=require('net').connect(${server.address().port},'127.0.0.1',()=>socket.write(JSON.stringify({pid:process.pid,operation:process.env.RHO_OPERATION_ID})+'\\n'));socket.on('close',()=>process.exit(0));socket.on('error',()=>process.exit(1));`;
  const crashArgs = {binding, arguments: {program: process.execPath, args: ['-e', crashCode], timeout_ms: 60000}};
  const crashAccepted = await invoke('crash-original', 'process.run_local', crashArgs, 2, true);
  const crashNative = await deadline(crashReady, 'Original process started before backend failure', 15000);
  assert.equal(crashNative.operation, crashAccepted.operation.operation_id);
  const originalBackend = await query('plugins.instance', {instance: identity});
  assert.equal(originalBackend.instance.state, 'active');
  assert.equal(originalBackend.observed_in_this_host, true);
  assert.equal(originalBackend.process_id, active.output.process_id);
  assert.ok(Number.isSafeInteger(originalBackend.process_id) && originalBackend.process_id > 1
    && originalBackend.process_id !== host.pid && originalBackend.process_id !== process.pid);
  // Signal only the fresh, exact backend observation created by this fixture.
  process.kill(originalBackend.process_id, 'SIGKILL');
  const interrupted = await until(() => call('get_operation', {operation_id: crashAccepted.operation.operation_id}), value => ['succeeded','failed','cancelled','uncertain'].includes(value.status), 'Original backend disconnect');
  assert.equal(interrupted.status, 'uncertain', JSON.stringify({status: interrupted.status, error: interrupted.error}));
  assert.equal(crashNative.socket.destroyed, false, 'Original native work survives the killed owner until explicit recovery');
  const replacement = succeeded(await invoke('activate-recovery-process', 'plugins.activate', {revision: snapshot.revision, artifact: snapshot.artifacts[0], target: 'aarch64-apple-darwin', alias: 'process-recovery', configuration: {}}));
  const replacementIdentity = replacement.output.instance.identity;
  assert.notEqual(replacementIdentity.instance, identity.instance);
  const replacementBinding = await query('plugins.resolve', {instance: replacementIdentity, capability: {id: 'process.reconcile', version: 2}});
  const replacementStatus = await query('plugins.resolve', {instance: replacementIdentity, capability: {id: 'process.status', version: 1}});
  const originalClosed = new Promise(resolve => crashNative.socket.once('close', resolve));
  const replacementArgs = {binding: replacementBinding, arguments: {operation_id: interrupted.operation.operation_id}};
  const recovered = succeeded(await invoke('recover-old-instance', 'process.reconcile', replacementArgs, 2));
  assert.equal(recovered.output.source_operation_id, interrupted.operation.operation_id);
  assert.ok(recovered.output.signalled.some(native => native.pid === crashNative.pid));
  assert.deepEqual(recovered.output.remaining, []);
  await deadline(originalClosed, 'Replacement recovery confirmed original native closure', 10000);
  const originalRecord = await call('get_operation', {operation_id: interrupted.operation.operation_id});
  assert.equal(originalRecord.status, 'uncertain'); assert.deepEqual(originalRecord.recovery, interrupted.recovery);
  const recoveredReplay = succeeded(await invoke('recover-old-instance', 'process.reconcile', replacementArgs, 2));
  assert.equal(recoveredReplay.operation.operation_id, recovered.operation.operation_id);
  assert.deepEqual(recoveredReplay.output, recovered.output);
  const interruptedReplay = await invoke('crash-original', 'process.run_local', crashArgs, 2);
  assert.equal(interruptedReplay.operation.operation_id, interrupted.operation.operation_id);
  assert.equal(interruptedReplay.status, 'uncertain');
  assert.equal(fs.readFileSync(path.join(project, 'crash-once.txt'), 'utf8'), 'once\n');
  await until(() => query('process.status', {binding: replacementStatus, arguments: {}}), value => value.activities.length === 0, 'Replacement settlement');
  succeeded(await invoke('release-replacement', 'plugins.release', {instance: replacementIdentity}));
  assert.deepEqual(await resource(first.output.report), report, 'Original report survives provider loss and replacement release');
  const retained = succeeded(await invoke('original-run', 'process.run_local', runArgs, 2));
  assert.equal(retained.operation.operation_id, first.operation.operation_id); assert.deepEqual(retained.output, first.output);
  assert.equal(fs.readFileSync(once, 'utf8'), 'once\n');
  host.stdin.end(); assert.equal((await deadline(exited, 'Host shutdown', 15000)).code, 0);
  assert.equal(digest(fs.readFileSync(binary)), originalHost);
  complete = true;
  console.log(`Independent Process package passed native bytes/resources, target refusal, original idempotency, cancellation, tagged reconciliation, backend-crash replacement recovery with immutable original uncertainty, settlement and replay. Unchanged Host SHA256 ${originalHost}`);
} finally {
  for (const socket of sockets) socket.destroy();
  server.close();
  if (host && host.exitCode === null && host.signalCode === null) { host.stdin.end(); host.kill('SIGTERM'); await deadline(exited, 'Owned Host cleanup', 15000); }
  if (complete) fs.rmSync(temporary, {recursive: true, force: true});
  else console.error(`Native Process acceptance evidence retained at ${temporary}`);
}
