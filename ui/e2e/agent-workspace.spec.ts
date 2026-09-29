/** Real ordinary Agent + R packages; only the external ACP/model peer is local. */
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { verifyAgentBuild, agentBuildMode } from '../../scripts/agent-plugin-artifact.mjs';

let directory: string, project: string, url: URL, host: ReturnType<typeof spawn>, agent: any, r: any, view: any, session: string;
let completed = false;
const windowId = 'agent-scientific-workspace', binary = resolve('../target/debug/rho');
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function port(method: string, params: unknown) {
  const response = await fetch(new URL('/api/host', url), {
    method: 'POST', headers: { Authorization: `Bearer ${url.hash.slice(7)}`, 'Content-Type': 'application/json', 'X-Rho-Studio-Window': windowId },
    body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }),
  }).then(response => response.json());
  if (!response.ok) throw Error(response.error); return response.result;
}
async function query(id: string, args: unknown) { return (await port('query_snapshot', { capability: { id, version: 1 }, arguments: args })).data; }
async function binding(instance: any, id: string, version = 1) { return query('plugins.resolve', { instance, capability: { id, version } }); }
async function invoke(id: string, args: unknown) {
  const record = await port('invoke', { capability: { id, version: 1 }, arguments: args, preconditions: [], client_request_id: crypto.randomUUID() });
  expect(record.status, JSON.stringify(record.error)).toBe('succeeded'); return record.output;
}
async function nativeQuery(id: string, args: unknown) { return query(id, { binding: await binding(agent, id), arguments: args }); }
async function sessionState() { return query('r.session', { binding: await binding(r, 'r.session'), arguments: {} }); }
async function executions() { return (await query('operation.list_recent', { limit: 100 })).operations.filter((record: any) => record.capability.id === 'r.execute'); }

test.beforeAll(async () => {
  test.setTimeout(180000);
  expect(process.env.RHO_AGENT_PLUGIN_PACKAGE).toBeTruthy(); expect(process.env.RHO_R_PLUGIN_PACKAGE).toBeTruthy();
  expect(process.env.RHO_ARK).toBeTruthy(); expect(process.env.RHO_R_HOME).toBeTruthy();
  const agentPackage = verifyAgentBuild(process.env.RHO_AGENT_PLUGIN_PACKAGE!);
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'rho-agent-window-'))); project = join(directory, 'project'); mkdirSync(project);
  const nativeBin = join(directory, 'native-bin'); mkdirSync(nativeBin);
  writeFileSync(join(nativeBin, 'rho-science-fixture'), 'disposable');
  copyFileSync(resolve('../crates/host/tests/fixtures/agent-science.cjs'), join(nativeBin, 'kimi')); chmodSync(join(nativeBin, 'kimi'), 0o700);
  const database = join(directory, 'state.sqlite');
  const snapshot = (path: string) => JSON.parse(execFileSync(binary, ['--database', database, 'plugins', 'snapshot', path, '--target', 'aarch64-apple-darwin'], { encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL' })).result;
  const sources = { agent: snapshot(agentPackage), r: snapshot(realpathSync(process.env.RHO_R_PLUGIN_PACKAGE!)) };
  host = spawn(binary, ['--database', database, '--project', project, 'workbench'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: nativeBin + delimiter + process.env.PATH },
  });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = '', errors = ''; const timer = setTimeout(() => reject(Error(`Agent Host startup deadline: ${errors}`)), 60000);
    host.stderr!.on('data', bytes => errors += bytes); host.stdout!.on('data', bytes => {
      output += bytes; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);
      if (found) { clearTimeout(timer); done(found[0]); }
    }); host.once('exit', code => { clearTimeout(timer); reject(Error(`Agent Host exited ${code}: ${errors}`)); });
  }));
  const activate = async (name: 'agent' | 'r', configuration: unknown, optional_capabilities: any[] = []) =>
    (await invoke('plugins.activate', { revision: sources[name].revision, artifact: sources[name].artifacts[0], target: 'aarch64-apple-darwin', alias: name, configuration, optional_capabilities })).instance.identity;
  r = await activate('r', { ark: realpathSync(process.env.RHO_ARK!), r_home: realpathSync(process.env.RHO_R_HOME!), execution_timeout_seconds: 120 });
  session = (await invoke('r.create_session', { binding: await binding(r, 'r.create_session'), arguments: {} })).session_id;
  agent = await activate('agent', {}, [
    { id: 'plugins.inspect', version: 1 }, { id: 'r.execute', version: 2 },
    { id: 'operation.get', version: 1 }, { id: 'plugins.delegated_operation', version: 1 },
  ]);
  const rBinding = { ...await binding(r, 'r.execute', 2), target: session };
  writeFileSync(join(project, 'native-science-input.json'), JSON.stringify({ expected_session: session, run: {
    code: 'counter <- if (exists("counter", inherits=FALSE)) counter + 1L else 1L; writeLines(as.character(counter), "counter-value.txt"); while (!file.exists("release-r")) Sys.sleep(0.01); cat("browser-original-r-result\\n"); counter',
  } }));
  const layout = await query('windows.layout', { window: windowId });
  view = (await invoke('windows.open_view', { expected_layout_version: layout.version, group: null,
    view: { instance: agent, contribution: 'agent', window: windowId, configuration: { tools: [{ name: 'execute', target: { type: 'provider', binding: rBinding } }] }, state: {} },
  })).view;
});
test.afterAll(async () => {
  if (project) writeFileSync(join(project, 'release-r'), 'finish disposable test');
  if (host?.exitCode === null && host.signalCode === null) {
    host.kill('SIGINT');
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { host.kill('SIGKILL'); reject(Error('Disposable Agent Host did not confirm shutdown')); }, 60000);
      host.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
  if (directory && completed) rmSync(directory, { recursive: true, force: true });
  else if (directory) console.error(`Agent browser acceptance retained at ${directory}`);
});

test('ordinary Agent attachments and one original Send reach real R; reload preserves the task, next draft and original result', async ({ page }, info) => {
  test.setTimeout(240000);
  const address = new URL(url); address.searchParams.set('window', windowId); await page.goto(address.href);
  const frame = page.locator(`[data-plugin-frame="${view.view}"]`).frameLocator('iframe');
  await frame.getByRole('button', { name: 'New task', exact: true }).click();
  await frame.getByRole('button', { name: 'Kimi Code', exact: true }).click();
  const composer = frame.getByRole('textbox', { name: 'Agent message', exact: true });
  await expect(composer).toBeEnabled({ timeout: 45000 });
  expect(existsSync(join(project, 'native-science-evidence.json'))).toBe(false);
  const task = await frame.getByLabel('Select task', { exact: true }).inputValue();
  const detail = () => nativeQuery('agent.native.task', { task_id: task });
  const prompt = 'Run the authorized R counter once, using the selected attachments 中文';
  await composer.fill(prompt);
  const large = Buffer.alloc(8 * 1024 * 1024, 'R'), small = Buffer.from('原始附件 Ω\n');
  writeFileSync(join(project, 'native-science-attachments.json'), JSON.stringify([large, small].map(bytes => ({ mime_type: 'text/plain', bytes: bytes.length, sha256: hash(bytes) }))));
  await frame.locator('#attachment-file').setInputFiles({ name: '完整数据.txt', mimeType: 'text/plain', buffer: large });
  await expect.poll(async () => (await detail()).draft.content.assets.length, { timeout: 60000 }).toBe(1);
  let lost = false, finishes = 0;
  await page.route('**/api/plugin-view', async route => {
    const body = route.request().postDataJSON()?.message?.body;
    if (body?.type === 'control' && body.capability.id === 'agent.native.assets.finish') {
      finishes++; if (!lost) { lost = true; await route.fetch(); await route.abort(); return; }
    }
    await route.continue();
  });
  await frame.locator('#attachment-file').setInputFiles({ name: '补充说明.txt', mimeType: 'text/plain', buffer: small });
  await expect.poll(async () => (await detail()).assets.length).toBe(2);
  await expect(frame.getByRole('button', { name: 'Reselect original file', exact: true })).toBeEnabled();
  await page.reload();
  await frame.locator('#uploads').getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Add to draft', exact: true })).toBeEnabled();
  expect((await detail()).draft.content.assets).toHaveLength(1);
  await frame.getByRole('button', { name: 'Add to draft', exact: true }).click();
  await expect.poll(async () => (await detail()).draft.content.assets.length).toBe(2);
  expect(finishes).toBe(1); expect((await detail()).draft.content.text).toBe(prompt);
  for (const width of [1440, 390, 220]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await composer.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`agent-native-attachments-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame.getByRole('button', { name: 'Tools', exact: true }).click();
  await frame.getByRole('checkbox', { name: 'execute', exact: true }).check();
  await frame.getByRole('button', { name: 'Tools', exact: true }).click();
  await frame.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => existsSync(join(project, 'counter-value.txt')), { timeout: 60000 }).toBe(true);
  expect(readFileSync(join(project, 'counter-value.txt'), 'utf8')).toBe('1\n');
  await expect.poll(async () => (await executions()).length).toBe(1);
  const childId = (await executions())[0].operation_id;
  const original = (await query('operation.get', { operation_id: childId })).record;
  const nativeSession = (await detail()).summary.task.native_session_id;
  expect(original.operation.normalized_arguments.binding.provider).toEqual(r);
  expect(original.operation.normalized_arguments.binding.target).toBe(session);
  const next = 'Next draft remains unsent 中文'; await composer.fill(next);
  await expect.poll(async () => (await detail()).draft.content.text).toBe(next);
  await page.reload(); await expect(composer).toHaveValue(next);
  expect((await detail()).summary.task.native_session_id).toBe(nativeSession);
  expect(readFileSync(join(project, 'counter-value.txt'), 'utf8')).toBe('1\n');
  writeFileSync(join(project, 'release-r'), 'continue original');
  await expect.poll(async () => (await query('operation.get', { operation_id: childId })).record.status, { timeout: 60000 }).toBe('succeeded');
  await expect(frame.getByRole('log', { name: 'Agent conversation' })).toContainText('Original scientific result observed 中文');
  await expect.poll(async () => (await query('operation.get', { operation_id: original.operation.causation_id })).record.status).toBe('succeeded');
  const saved = await detail(), evidence = JSON.parse(readFileSync(join(project, 'native-science-evidence.json'), 'utf8'));
  expect(saved.assets).toHaveLength(2); expect(saved.receipts.filter((r: any) => r.input_assets.length === 2)).toHaveLength(1);
  expect(evidence.prompts).toBe(1); expect(evidence.attachments).toHaveLength(2);
  expect((await sessionState()).session_id).toBe(session); expect(await executions()).toHaveLength(1);
  await expect(composer).toHaveValue(next);
  await page.screenshot({ path: info.outputPath('agent-native-result.png') });
  writeFileSync(info.outputPath('agent-native-result.json'), JSON.stringify({ status: 'passed', build_mode: agentBuildMode(process.env.RHO_AGENT_PLUGIN_PACKAGE!), original_send: evidence.invocation.send_request,
    child: childId, native_session: nativeSession, r_session: session, assets: saved.assets.map((a: any) => ({ name: a.name, bytes: a.bytes, sha256: a.sha256 })),
    limits: ['Local ACP fixture, no external model', 'Browser reload, not Host restart', 'No installation or publication'],
  }, null, 2));
  completed = true;
});
