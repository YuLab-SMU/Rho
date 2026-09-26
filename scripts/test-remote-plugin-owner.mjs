// Independent native ownership acceptance. Fake SSH/Slurm only; no remote target.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRemoteFixture } from './fixtures/ssh-slurm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], { cwd: root, encoding: 'utf8' }).trim());
const cargo = installed('cargo');
const env = { ...process.env, RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'), CARGO_BUILD_JOBS: '1', CARGO_TARGET_DIR: path.join(root, 'target') };
const target = execFileSync(env.RUSTC, ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
assert.ok(target);
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-independent-remote-')));
let complete = false;
try {
  const parts = ['plugins/remote/api', 'plugins/remote/backend/owner', 'plugins/process/api', 'plugins/process/backend/engine', 'crates/plugin-protocol'];
  for (const part of parts) fs.cpSync(path.join(root, part), path.join(temporary, part), {
    recursive: true, filter: file => !/[\\/](?:target|node_modules|dist)(?:[\\/]|$)/.test(file),
  });
  fs.writeFileSync(path.join(temporary, 'Cargo.toml'), `[workspace]\nresolver = "3"\nmembers = ${JSON.stringify(parts)}\n`);
  fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(temporary, 'Cargo.lock'));
  const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], { cwd: temporary, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const members = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(members.map(pkg => pkg.name).sort(), ['rho-plugin-protocol', 'rho-process-api', 'rho-process-engine', 'rho-remote-api', 'rho-remote-owner']);
  for (const pkg of members) for (const dep of pkg.dependencies) if (dep.path) {
    assert.ok(dep.path.startsWith(temporary + path.sep), `${pkg.name}: dependency leaves standalone source`);
  }
  execFileSync(cargo, ['test', '-p', 'rho-remote-api', '-p', 'rho-remote-owner', '--lib', '--locked', '--offline'], { cwd: temporary, env, stdio: 'inherit' });
  execFileSync(cargo, ['build', '-p', 'rho-remote-owner', '--example', 'protocol-fixture', '--locked', '--offline'], { cwd: temporary, env, stdio: 'inherit' });
  const fixtureRoot = path.join(temporary, 'native');
  fs.mkdirSync(fixtureRoot);
  const fixture = createRemoteFixture(fixtureRoot);
  const binary = path.join(env.CARGO_TARGET_DIR, 'debug/examples/protocol-fixture');
  const child = spawn(binary, [], { env: { ...fixture.env, RHO_TEST_DROP_SUBMIT: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const ended = once(child, 'exit');
  const lines = readline.createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const watchdog = setTimeout(() => child.kill(), 180_000);
  const request = async (method, operation_id, extra = {}) => {
    child.stdin.write(JSON.stringify({ method, operation_id, root: fixture.project, target: { host_alias: 'fixture', project_root: fs.realpathSync(fixture.remote), slurm_cluster: 'fixture_cluster' }, ...extra }) + '\n');
    const line = await iterator.next();
    assert.equal(line.done, false, 'Independent native fixture exited before replying');
    return JSON.parse(line.value);
  };
  const state = () => JSON.parse(fs.readFileSync(fixture.state, 'utf8'));
  const save = value => fs.writeFileSync(fixture.state, JSON.stringify(value));
  try {
    assert.equal((await request('inspect', 'inspect')).ok, true);
    assert.equal(fs.existsSync(fixture.log), false, 'Construction started SSH');
    const literal = "Unicode 科学 ' ; $(touch escaped)";
    const run = await request('execute', 'literal', { arguments: { program: 'printf', args: ['%s', literal] } });
    assert.equal(run.data.outcome, 'succeeded', JSON.stringify(run));
    assert.equal(Buffer.from(run.data.transport.stdout.bytes).toString(), literal);
    assert.equal(fs.existsSync(path.join(fixture.remote, 'escaped')), false);
    for (const [exit, outcome] of [[9, 'failed'], [255, 'uncertain']]) {
      const reply = await request('execute', `exit-${exit}`, { arguments: { program: '/bin/sh', args: ['-c', `exit ${exit}`] } });
      assert.equal(reply.data.outcome, outcome, JSON.stringify(reply));
    }
    const timed = await request('execute', 'timeout', { arguments: { program: '/bin/sh', args: ['-c', 'sleep 5'], timeout_ms: 50 } });
    assert.equal(timed.data.transport.termination, 'timed_out');
    assert.equal(timed.data.outcome, 'uncertain', 'Local timeout invented remote termination');
    assert.equal(timed.data.remote_exit_code, null);
    const calls = fs.readFileSync(fixture.log, 'utf8');
    const cancelled = await request('execute', 'not-started', { cancelled: true, arguments: { program: 'touch', args: ['must-not-run'] } });
    assert.equal(cancelled.data.outcome, 'cancelled', JSON.stringify(cancelled));
    assert.equal(cancelled.data.transport.pid, null);
    const invalid = await request('execute', 'invalid', { arguments: { program: '-option' } });
    assert.equal(invalid.possible_effect, false);
    assert.equal(fs.readFileSync(fixture.log, 'utf8'), calls);
    assert.equal(fs.existsSync(path.join(fixture.remote, 'must-not-run')), false);
    const submit = await request('submit', 'lost-receipt', { arguments: { body: '#SBATCH --array=1-100\nprintf scientific-body' } });
    assert.equal(submit.ok, false);
    assert.equal(submit.possible_effect, true);
    assert.equal(submit.recovery.source_operation_id, 'lost-receipt');
    assert.match(submit.recovery.operation_marker, /^rho-[a-f0-9]{64}$/);
    assert.equal(state().submissions, 1);
    const lookup = await request('find', 'lost-receipt');
    assert.equal(lookup.data.jobs.length, 1);
    assert.equal(lookup.data.jobs[0].job.job_id, '4201');
    const observed = lookup.data.jobs[0];
    const rejected = await request('cancel', 'lost-receipt', { observed: { ...observed, job: { ...observed.job, cluster: 'other' } } });
    assert.equal(rejected.possible_effect, false);
    assert.equal(state().cancel_requests, 0);
    const cancellation = await request('cancel', 'lost-receipt', { observed });
    assert.equal(cancellation.data.request_sent, true);
    assert.equal(cancellation.data.after.state, 'RUNNING');
    assert.equal(state().cancel_requests, 1);
    let native = state(); native.jobs[0].state = 'CANCELLED'; save(native);
    const terminal = await request('find', 'lost-receipt');
    assert.equal(terminal.data.jobs[0].source, 'sacct');
    const repeated = await request('cancel', 'lost-receipt', { observed: terminal.data.jobs[0] });
    assert.equal(repeated.data.request_sent, false);
    assert.equal(state().cancel_requests, 1);
    native = state(); native.jobs.push({ ...native.jobs[0], id: '4202' }); save(native);
    assert.equal((await request('find', 'lost-receipt')).data.jobs.length, 2);
    native.jobs = []; save(native);
    assert.equal((await request('find', 'lost-receipt')).data.jobs.length, 0);
    assert.equal(state().submissions, 1, 'Read/cancel resubmitted work');
  } finally {
    child.stdin.end();
    const [code, signal] = await ended;
    lines.close(); clearTimeout(watchdog);
    assert.equal(code, 0, `native fixture ended with ${signal}`);
  }
  complete = true;
  console.log('Independent SSH/Slurm owner and local transcript passed using only five public/plugin crates. No real remote acceptance performed.');
} finally {
  if (complete) fs.rmSync(temporary, { recursive: true, force: true });
  else console.error(`Independent remote source/evidence retained at ${temporary}`);
}
