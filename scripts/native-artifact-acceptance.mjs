// Explicit synthetic application acceptance recipe, never a plugin/catalog entry.
// Opt in to the two real model runs with RHO_NATIVE_MODEL=1. Credentials are read
// from the existing Claude settings and never copied into the evidence report.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { digest, canonical } from '@rho-workspace/plugin-contracts';
import { ClaudeCodeObserver } from '@rho-workspace/plugin-agent/claude-native';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

if (process.env.RHO_NATIVE_MODEL !== '1') throw Error('Select RHO_NATIVE_MODEL=1 explicitly; run source tests for credential-free checks.');
const output = path.resolve(process.env.RHO_NATIVE_EVIDENCE ?? 'work/phase1-native-artifacts-20261021/real-run');
await fs.mkdir(output, { recursive: false, mode: 0o700 });
const save = async (file, value) => fs.writeFile(path.join(output, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const log = async (file, value) => fs.appendFile(path.join(output, file), JSON.stringify(value) + '\n', { mode: 0o600 });
const clientVersion = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
const model = 'westlakehpc/deepseek-v4.1-flash[1m]';
const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8'));
const caps = { inputMode: 'pull-tool-result', inboxLookup: false, inboxDeduplication: 'none', hookEmissionDeduplication: 'none', modelConsumptionAck: false, nativeExecutionDeduplication: false };
const budget = { maxTurns: 25, wallMs: 900000, stdoutBytes: 16 * 1024 * 1024, stderrBytes: 256 * 1024, maxLineBytes: 1024 * 1024, maxNativeTools: 2048 };
const s = await new RhoService({ root: output, stateDir: path.join(output, 'state'), coreBinary: '/unselected-phase1-core', rscript: '/unselected-phase1-r', plugins: ['files', 'tables', 'agent'] }).start();
const counts = { hostStarts: 0, managedSubmits: 0, apiCalls: 0, filesRegister: 0, tablesPage: 0 };
s.bridge.ensureOwnedHost = async () => { counts.hostStarts++; throw Error('Core execution is not selected.'); };
const coreCall = s.bridge.call.bind(s.bridge);
s.bridge.call = async (...args) => { if (args[1] === 'submit') counts.managedSubmits++; return coreCall(...args); };
const originalProject = s.plugins.project.bind(s.plugins);
s.plugins.project = (...args) => {
  const owners = originalProject(...args);
  for (const [owner, name, counter] of [['files', 'register', 'filesRegister'], ['tables', 'page', 'tablesPage']]) if (owners[owner]) {
    const original = owners[owner][name].bind(owners[owner]);
    owners[owner][name] = async (...parameters) => { counts[counter]++; const started = new Date().toISOString(); try { const result = await original(...parameters); await log('owner-calls.jsonl', { projectId: args[1], owner, method: name, started, outcome: 'returned', resource: result.resource ? { id: result.resource.id, version: result.resource.version } : result.id ? { id: result.id, version: result.version } : null }); return result; } catch (e) { await log('owner-calls.jsonl', { projectId: args[1], owner, method: name, started, outcome: 'rejected', kind: e.kind ?? 'storage' }); throw e; } };
  }
  return owners;
};
const rawAdmin = new RhoClient({ url: s.url, token: s.adminToken });
function client(c, actor) {
  return { call: async (method, input = {}) => { counts.apiCalls++; const at = new Date().toISOString(); try { const value = await c.call(method, input); await log('api-calls.jsonl', { actor, method, projectId: input.projectId ?? c.connection.projectId, at, outcome: 'returned' }); return value; } catch (e) { await log('api-calls.jsonl', { actor, method, projectId: input.projectId ?? c.connection.projectId, at, outcome: 'rejected', error: e.error ?? { kind: 'unknown' } }); throw e; } } };
}
const admin = client(rawAdmin, 'control');
const children = new Set();
const tasks = [];
const tests = [];
const check = (name, pass, detail) => { tests.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) }); };
try {
  const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
  await fs.mkdir(path.join(output, 'native-bin'));
  await fs.writeFile(path.join(output, 'native-bin/python3'), '#!/usr/bin/env node\n' + `import fs from 'node:fs';import cp from 'node:child_process';const args=process.argv.slice(2);fs.appendFileSync(process.env.RHO_NATIVE_ENTRIES,JSON.stringify({task:process.env.RHO_NATIVE_TASK,args,at:new Date().toISOString(),pid:process.pid})+'\\n',{mode:0o600});const r=cp.spawnSync(${JSON.stringify(python)},args,{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`, { mode: 0o700 });
  const preflight = spawnSync(path.join(output, 'native-bin/python3'), ['-c', 'print("native-wrapper-ok")'], { encoding: 'utf8', env: { ...process.env, RHO_NATIVE_TASK: 'preflight', RHO_NATIVE_ENTRIES: path.join(output, 'preflight-entries.jsonl') } });
  await save('wrapper-preflight.json', { status: preflight.status, stdout: preflight.stdout.trim(), stderr: preflight.stderr.trim() });
  assert.equal(preflight.status, 0, 'Verify the native counter before consuming model tokens.');
  for (const spec of [{ key: 'A', scores: [70, 72, 75, 78, 80, 82, 85, 180], corrected: 80 }, { key: 'B', scores: [60, 65, 70, 75, 80, 85, 90, 118], corrected: 18 }]) {
    const project = await admin.call('project.create', { name: 'grades-' + spec.key.toLowerCase() });
    const sessionId = randomUUID(), taskId = 'grades-' + spec.key, registrationId = 'cli-' + spec.key;
    const csv = 'record_no,student_id,score\n' + spec.scores.map((score, i) => `${i + 1},STU-${String(i + 1).padStart(3, '0')},${score}`).join('\n') + '\n';
    await fs.writeFile(path.join(project.root, 'grades-original.csv'), csv);
    const record = '# Teacher record / class ' + spec.key + '\nSynthetic teaching data. Full score 100, pass >=60.\n' + spec.scores.map((score, i) => `STU-${String(i + 1).padStart(3, '0')} ${i === 7 ? spec.corrected : score}`).join('\n');
    await fs.writeFile(path.join(project.root, 'teacher-record.md'), record + '\n');
    const declaration = { path: 'outputs/candidate-v1.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'record_no', type: 'number', nullValues: [] }, { name: 'student_id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }], key: { column: 'student_id', namespace: 'class-' + spec.key } } };
    const policyRef = digest(canonical(declaration));
    await fs.writeFile(path.join(project.root, 'artifact-contract.json'), JSON.stringify({ candidate: declaration, publication: 'Write to a temporary file then os.replace to outputs/candidate-v1.csv. Finally write output-ready.json with {complete:true,path:"outputs/candidate-v1.csv",sha256:ACTUAL_SHA256}. Never overwrite a completed version; no Rho tool calls are needed.' }, null, 2));
    const original = await admin.call('resource.register', { projectId: project.id, expectedDigest: digest(csv), declaration: { ...declaration, path: 'grades-original.csv' } });
    const make = async (name, methods) => { const file = path.join(output, name + '.private.json'); const descriptor = await s.agentConnection(project.id, name, file, methods); return { principal: 'agent:' + digest(project.id + ':' + name).slice(0, 32), api: client(new RhoClient(descriptor), name) }; };
    const business = await make(sessionId, ['binding.open', 'binding.activity']), adapter = await make('observer-' + spec.key, ['binding.activity.append']);
    tasks.push({ ...spec, project, sessionId, taskId, registrationId, declaration, policyRef, csv, original: { id: original.id, version: original.version }, business, adapter, facts: [], cliTools: [], result: null, errors: [] });
  }
  await save('selection.json', { model, provider: 'Westlake HPC', clientVersion, budget, tasks: tasks.map(t => ({ key: t.key, projectId: t.project.id, taskId: t.taskId, nativeSessionId: t.sessionId, namespace: t.declaration.format.key.namespace, policyRef: t.policyRef, original: t.original })), scope: 'Phase 1 native artifact intake only; no P, feedback queue, automatic layout or DOM visibility receipt.' });
  async function run(t) {
    const directory = path.join(output, 'claude-' + t.key); await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, 'empty-mcp.json'), '{"mcpServers":{}}');
    const observed = new Set(); let binding, initialized = false;
    const observer = new ClaudeCodeObserver({ sessionId: t.sessionId,
      onInit: async sessionId => {
        s.registerNativeAdapter({ projectId: t.project.id, taskId: t.taskId, registrationId: t.registrationId, principal: t.business.principal, adapterPrincipal: t.adapter.principal, externalSessionId: sessionId, transportCapabilities: caps, proof: { kind: 'claude-code-init', sessionId, clientVersion } });
        binding = await t.business.api.call('binding.open', { externalSessionId: sessionId, adapter: 'claude-code-mcp', attachment: { taskId: t.taskId, role: 'business', adapterRegistrationId: t.registrationId, transportCapabilities: caps } });
        const route = await admin.call('task.routing.put', { projectId: t.project.id, taskId: t.taskId, compositionId: 'views-' + t.key, expectedVersion: 0, changeId: 'route-' + t.key, participants: [{ bindingId: binding.id, role: 'business' }], feedbackOwnerBindingId: binding.id, presenterBindingId: null, policyRef: t.policyRef });
        t.binding = binding; t.route = route; initialized = true;
      },
      append: async event => {
        const body = { taskId: t.taskId, bindingId: binding.id, adapterId: t.registrationId, adapterEpoch: 'cli-process-1', events: [event] };
        const accepted = await t.adapter.api.call('binding.activity.append', body);
        await log('native-observations.jsonl', { projectId: t.project.id, ...body, receipt: accepted });
        if (event.kind === 'artifact.ready') {
          const started = new Date().toISOString();
          const facts = await s.observeNativeOutput(t.project.id, accepted.accepted[0].eventId);
          t.facts.push({ ...facts, readyObservedAt: event.at, validationStartedAt: started, validatedAt: new Date().toISOString() });
          await log('output-facts.jsonl', { key: t.key, ...t.facts.at(-1) });
          console.log(JSON.stringify({ task: t.key, output: facts.validation.state }));
        }
      },
      outputs: async () => {
        let manifest;
        try { const f = path.join(t.project.root, 'output-ready.json'); if ((await fs.stat(f)).size > 4096) throw Error('output manifest limit'); manifest = JSON.parse(await fs.readFile(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
        if (manifest.complete !== true || manifest.path !== t.declaration.path || !/^[a-f0-9]{64}$/.test(manifest.sha256)) return [];
        const key = digest(canonical(manifest)); if (observed.has(key)) return []; observed.add(key);
        return [{ declaration: t.declaration, expectedDigest: manifest.sha256, role: 'candidate', policyRef: t.policyRef }];
      },
    }, budget.maxNativeTools);
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--strict-mcp-config', '--mcp-config', path.join(directory, 'empty-mcp.json'), '--tools', 'Read,Write,Edit,Glob,Grep,Bash', '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(python3 *)', '--permission-mode', 'dontAsk', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--model', model, '--session-id', t.sessionId, '--max-turns', String(budget.maxTurns)];
    const env = { ...process.env, ...settings.env, ANTHROPIC_MODEL: model, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', RHO_NATIVE_TASK: t.key, RHO_NATIVE_ENTRIES: path.join(output, 'native-process-entries.jsonl'), PATH: path.join(output, 'native-bin') + path.delimiter + process.env.PATH };
    const processChild = spawn('claude', args, { cwd: t.project.root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(processChild);
    let bytes = 0, stderrBytes = 0, pending = Promise.resolve(), reason = null;
    const stop = message => { reason ??= message; try { process.kill(-processChild.pid, 'SIGTERM'); } catch {} };
    const startedAt = new Date().toISOString();
    const timer = setTimeout(() => stop('wall-limit'), budget.wallMs);
    processChild.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > budget.stdoutBytes) stop('stdout-limit'); });
    processChild.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes <= budget.stderrBytes) void fs.appendFile(path.join(directory, 'stderr.private.txt'), chunk, { mode: 0o600 }); else stop('stderr-limit'); });
    const lines = createInterface({ input: processChild.stdout, crlfDelay: Infinity });
    const seenTools = new Set();
    lines.on('line', line => {
      if (Buffer.byteLength(line) > budget.maxLineBytes) return stop('line-limit');
      let record; try { record = JSON.parse(line); } catch { return; }
      pending = pending.then(async () => {
        // Never retain hidden reasoning or raw provider envelopes.
        const content = record.message?.content?.filter?.(b => ['text', 'tool_use', 'tool_result'].includes(b.type));
        if (content || record.type === 'result' || record.type === 'system' && record.subtype === 'init') await log('claude-' + t.key + '/observed-events.jsonl', { at: new Date().toISOString(), type: record.type, subtype: record.subtype, sessionId: record.session_id, messageId: record.message?.id, messageUsage: record.message?.usage, ...(content ? { content } : {}), ...(record.type === 'result' ? { usage: record.usage, modelUsage: record.modelUsage, numTurns: record.num_turns, isError: record.is_error, result: record.result } : {}), ...(record.subtype === 'init' ? { model: record.model } : {}) });
        for (const b of content ?? []) if (b.type === 'tool_use' && !seenTools.has(b.id)) { seenTools.add(b.id); t.cliTools.push({ id: b.id, name: b.name }); console.log(JSON.stringify({ task: t.key, tool: b.name })); }
        await observer.observe(record);
        if (record.type === 'result') t.result = { usage: record.usage, modelUsage: record.modelUsage, numTurns: record.num_turns, isError: record.is_error, result: record.result };
      }).catch(async e => { t.errors.push({ kind: e.error?.kind ?? e.kind ?? 'adapter', message: e.message }); await log('adapter-errors.jsonl', { key: t.key, kind: e.error?.kind ?? e.kind ?? 'adapter', message: e.message }); });
    });
    const prompt = `你是独立班级 ${t.key} 的业务 Agent，任务 ${t.taskId}。用原生工具完成成绩调查：先读取 artifact-contract.json、grades-original.csv 和 teacher-record.md，解释原始均值为何偏高，并按教师登记生成未采用的候选。保留原表和八个 student_id/record_no，不删除 STU-008。生成简短 analysis.py，用 Python 标准库计算原始、按登记纠正、删除 STU-008 三种处理的人数、均值、及格人数和比例；执行一次且只执行一次 python3 analysis.py。脚本按契约原子写 outputs/candidate-v1.csv，写 analysis-result.json、report.md，并在最后写含实际 SHA-256 的 output-ready.json。报告区分统计结果和教师是否采用。禁止网络、安装、Git、其他目录及 Rho/MCP 操作。当前目录完全授权，不重复确认。完成后简短汇报，不等待反馈。`;
    await log('prompts.jsonl', { key: t.key, text: prompt });
    processChild.stdin.end(JSON.stringify({ type: 'user', uuid: randomUUID(), session_id: t.sessionId, parent_tool_use_id: null, message: { role: 'user', content: prompt } }) + '\n');
    const closed = await new Promise(resolve => { processChild.once('error', e => { t.errors.push({ kind: 'spawn', message: e.message }); resolve({ code: null, signal: null }); }); processChild.once('close', (code, signal) => resolve({ code, signal })); });
    clearTimeout(timer); children.delete(processChild); await pending;
    await observer.finish();
    t.run = { ...closed, startedAt, closedAt: new Date().toISOString(), reason, bytes, stderrBytes, initialized, pid: processChild.pid };
    await save('claude-' + t.key + '/run.json', t.run);
  }
  await Promise.all(tasks.map(run));
  for (const t of tasks) {
    check(t.key + ' actual CLI init and session attachment', t.run.initialized);
    check(t.key + ' native client completed', t.run.code === 0 && t.result && !t.result.isError && !t.run.reason);
    check(t.key + ' adapter completed without errors', t.errors.length === 0, t.errors);
    const ready = t.facts.filter(x => x.validation.state === 'typed-ready');
    check(t.key + ' one ready candidate', ready.length === 1, { ready: ready.length, attempts: t.facts.length });
    check(t.key + ' original bytes preserved', digest(await fs.readFile(path.join(t.project.root, 'grades-original.csv'))) === t.original.version);
    if (ready.length) {
      const page = await admin.call('data.page', { projectId: t.project.id, resource: ready[0].resource, offset: 0, limit: 100 });
      check(t.key + ' exact rows/key/namespace/correction', page.total === 8 && page.namespace === t.declaration.format.key.namespace && page.entityKey === 'student_id' && page.rows.find(x => x.student_id === 'STU-008')?.score === t.corrected && page.rows.every((row, i) => row.record_no === i + 1 && row.student_id === 'STU-' + String(i + 1).padStart(3, '0') && (i === 7 || row.score === t.scores[i])));
      const before = counts.filesRegister;
      const repeat = await s.observeNativeOutput(t.project.id, ready[0].source.eventId);
      check(t.key + ' original output re-observation does not republish', canonical(repeat.resource) === canonical(ready[0].resource) && counts.filesRegister === before);
      const resources = await s.plugins.project(t.project.root, t.project.id).files.list();
      check(t.key + ' one candidate resource identity', resources.filter(x => x.path === t.declaration.path).length === 1);
    }
    const history = await admin.call('binding.activity', { projectId: t.project.id, taskId: t.taskId, source: 'native', query: { after: 0, cursor: null, limit: 100, maxBytes: 65536 } });
    check(t.key + ' actual requests/returns observed', history.entries.filter(x => x.event.kind === 'tool.requested').length === t.cliTools.length && history.entries.some(x => x.event.kind === 'tool.returned') && !history.gap);
    const original = (await fs.readFile(path.join(output, 'native-observations.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x)).find(x => x.projectId === t.project.id);
    if (original) {
      const { receipt, projectId, ...body } = original;
      const repeat = await t.adapter.api.call('binding.activity.append', body);
      check(t.key + ' exact native batch retry reuses receipt', canonical(repeat.accepted) === canonical(receipt.accepted));
      const other = tasks.find(x => x !== t);
      try { await t.adapter.api.call('binding.activity.append', { ...body, projectId: other.project.id }); check(t.key + ' cross-project append refused', false); } catch (e) { check(t.key + ' cross-project append refused', e.error?.kind === 'scope'); }
    }
  }
  const entries = (await fs.readFile(path.join(output, 'native-process-entries.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
  for (const t of tasks) check(t.key + ' designated native calculation entered once', entries.filter(x => x.task === t.key && x.args.some(a => path.basename(a) === 'analysis.py')).length === 1);
  check('Core not started or submitted', counts.hostStarts === 0 && counts.managedSubmits === 0);
  const usage = tasks.reduce((sum, t) => { for (const [k, v] of Object.entries(t.result?.usage ?? {})) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v; return sum; }, {});
  const report = { phase: 1, passed: tests.every(x => x.pass), tests, counts, model, provider: 'Westlake HPC', clientVersion, modelToolCalls: tasks.reduce((n, t) => n + t.cliTools.length, 0), usage, tasks: tasks.map(({ business, adapter, csv, ...t }) => t), unfinished: ['Phase 2 automatic side-by-side presentation, actual DOM visibility and receipts', 'Phase 3 deterministic feedback, queue restart and lost enqueue ACK', 'Phase 4 optional presentation Agent and layered discovery', 'Same-project multi-task/native sandbox isolation', 'Native/client restart and exactly-once computation guarantees', 'An installed application composition outside source checkouts; this run selects built source with recorded local overrides'] };
  await save('results.json', report);
  console.log(JSON.stringify({ passed: report.passed, checks: tests.length, counts, modelToolCalls: report.modelToolCalls, usage, output }));
  if (!report.passed) process.exitCode = 1;
} finally {
  for (const child of children) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await s.close();
  await save('service-closed.json', { at: new Date().toISOString(), counts, remainingChildren: children.size });
}
