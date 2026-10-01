/** Real ordinary Agent + R packages; only the external ACP/model peer is local. */
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { verifyAgentBuild, agentBuildMode } from '../../scripts/agent-plugin-artifact.mjs';
import { buildManagerPlugin } from '../../scripts/build-manager-plugin.mjs';
import { installPluginSet } from '../../scripts/plugin-set.mjs';
import { startRhoModelPeer, exerciseRhoInput, inspectRhoAfterRestart } from './fixtures/agent-rho-workspace';
import { prepareRetainedHandoff, inspectRetainedHandoff } from './fixtures/agent-handoff-workspace';
import { observeHelp, setAgentViewport, viewerText } from './fixtures/agent-scientific-context';

let directory: string, project: string, url: URL, host: ReturnType<typeof spawn>, agent: any, r: any, view: any, session: string;
let completed = false, database: string, hostEnvironment: NodeJS.ProcessEnv, managerView: any, editor: any, sourceDraft: any;
let buildMode: string, deliveredSet: {directory: string; sha256: string} | null = null;
let modelPeer: Awaited<ReturnType<typeof startRhoModelPeer>>;
const sourceText = 'context_value <- 42L # 中文 Ω\n';
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
async function executions() {
  const records: any[] = []; let before_cursor: number | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await query('operation.list_recent', { limit: 100, before_cursor });
    records.push(...page.operations.filter((record: any) => record.capability.id === 'r.execute'));
    if (page.next_cursor === null) return records;
    before_cursor = page.next_cursor;
  }
  throw Error('Agent acceptance exceeded its bounded Operation history.');
}

// Seed the real public document owner; the actual Editor backend resolves this
// synchronized capture during picker preview and Native Send.
async function saveContextSource(text: string) {
  const draft = sourceDraft?.draft ?? crypto.randomUUID(), upload = crypto.randomUUID();
  const version = crypto.randomUUID(), name = '上下文 Ω.R';
  const bytes = Buffer.from(JSON.stringify({schema:1,document:{path:name,raw:text,version,anchor:0,head:text.length,readonly:null}}));
  const digest = 'sha256:' + hash(bytes);
  await port('control', {capability:{id:'documents.stage',version:1},arguments:{window:windowId,draft,upload,digest,base64:bytes.toString('base64')}});
  sourceDraft = await invoke('documents.save', {window:windowId,draft,upload,source:{revision:editor.revision,contribution:'editor'},expected_version:sourceDraft?.version ?? null,
    content:{digest,bytes:bytes.length,chunks:[{digest,bytes:bytes.length}]},metadata:{encoding:'org.rho.editor.document.v1',path:name,name,document_version:version,selection:{anchor:0,head:text.length},read_only:false}});
}

async function startHost() {
  const started = spawn(binary, ['--database', database, '--project', project, 'workbench'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: hostEnvironment,
  });
  host = started; // Retain ownership even if startup fails before returning a URL.
  const address = new URL(await new Promise<string>((done, reject) => {
    let output = '', errors = ''; const timer = setTimeout(() => reject(Error(`Agent Host startup deadline: ${errors}`)), 60000);
    started.stderr!.on('data', bytes => errors += bytes); started.stdout!.on('data', bytes => {
      output += bytes; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);
      if (found) { clearTimeout(timer); done(found[0]); }
    }); started.once('exit', code => { clearTimeout(timer); reject(Error(`Agent Host exited ${code}: ${errors}`)); });
  }));
  return { process: started, address };
}
async function stopHost(process_: ReturnType<typeof spawn>) {
  if (process_.exitCode !== null || process_.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { process_.kill('SIGKILL'); reject(Error('Disposable Agent Host did not confirm shutdown')); }, 60000);
    process_.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) reject(Error(`Disposable Agent Host shutdown was not clean: ${code}/${signal}`));
      else done();
    });
    process_.kill('SIGINT');
  });
}

test.beforeAll(async () => {
  test.setTimeout(180000);
  const delivery = process.env.RHO_PLUGIN_SET_PACKAGE;
  if (!delivery) {
    for (const name of ['RHO_AGENT_PLUGIN_PACKAGE', 'RHO_R_PLUGIN_PACKAGE', 'RHO_EDITOR_PLUGIN_PACKAGE', 'RHO_FILES_PLUGIN_PACKAGE']) expect(process.env[name], name).toBeTruthy();
  }
  expect(process.env.RHO_ARK).toBeTruthy(); expect(process.env.RHO_R_HOME).toBeTruthy();
  const agentPackage = delivery ? null : verifyAgentBuild(process.env.RHO_AGENT_PLUGIN_PACKAGE!);
  buildMode = delivery ? 'retained-archives' : agentBuildMode(agentPackage!);
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'rho-agent-window-'))); project = join(directory, 'project'); mkdirSync(project);
  modelPeer = await startRhoModelPeer();
  const nativeBin = join(directory, 'native-bin'); mkdirSync(nativeBin);
  const nativeHome = join(directory, 'native-home'); mkdirSync(nativeHome);
  writeFileSync(join(nativeBin, 'rho-science-fixture'), 'disposable');
  copyFileSync(resolve('../crates/host/tests/fixtures/agent-science.cjs'), join(nativeBin, 'kimi')); chmodSync(join(nativeBin, 'kimi'), 0o700);
  database = join(directory, 'state.sqlite');
  const snapshot = (path: string, target = 'aarch64-apple-darwin') => JSON.parse(execFileSync(binary, ['--database', database, 'plugins', 'snapshot', path, '--target', target], { encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL' })).result;
  let sources: Record<string, {revision: string; artifacts: string[]}>, managerPackage: {revision: string; artifacts: string[]};
  if (delivery) {
    const selected = realpathSync(delivery), bytes = readFileSync(join(selected, 'plugin-set.json'));
    const index = JSON.parse(bytes.toString('utf8'));
    expect(index.profile).toBe('rho-default');
    expect(installPluginSet({rho: binary, directory: selected, database}).imported).toHaveLength(16);
    const select = (name: string, target = 'aarch64-apple-darwin') => {
      const entry = index.packages.find((item: any) => item.plugin === `org.rho.${name}`);
      const artifact = entry?.artifacts.find((item: any) => item.target === target);
      expect(artifact, `Delivered ${name} for ${target}`).toBeTruthy();
      return {revision: entry.revision, artifacts: [artifact.id]};
    };
    sources = Object.fromEntries(['agent', 'r', 'editor', 'files'].map(name => [name, select(name)]));
    managerPackage = select('manager', 'ui-web');
    deliveredSet = {directory: selected, sha256: hash(bytes)};
  } else {
    sources = {agent: snapshot(agentPackage!), r: snapshot(realpathSync(process.env.RHO_R_PLUGIN_PACKAGE!)), editor: snapshot(realpathSync(process.env.RHO_EDITOR_PLUGIN_PACKAGE!)), files: snapshot(realpathSync(process.env.RHO_FILES_PLUGIN_PACKAGE!))};
    managerPackage = snapshot(buildManagerPlugin(join(directory, 'manager')), 'ui-web');
  }
  hostEnvironment = { ...process.env, PATH: nativeBin + delimiter + process.env.PATH };
  const started = await startHost(); host = started.process; url = started.address;
  const info = await fetch(new URL('/api/info', url), { headers: { Authorization: `Bearer ${url.hash.slice(7)}` } }).then(response => response.json());
  for (const id of ['plugins.resume', 'views.reconnect']) expect(info.capabilities.some((item: any) => item.capability.id === id), `Build the current Host before ${id} acceptance`).toBe(true);
  const activate = async (name: 'agent' | 'r' | 'editor' | 'files', configuration: unknown, optional_capabilities: any[] = []) =>
    (await invoke('plugins.activate', { revision: sources[name].revision, artifact: sources[name].artifacts[0], target: 'aarch64-apple-darwin', alias: name, configuration, optional_capabilities })).instance.identity;
  r = await activate('r', { ark: realpathSync(process.env.RHO_ARK!), r_home: realpathSync(process.env.RHO_R_HOME!), execution_timeout_seconds: 120 },
    ['operation.get','operation.list_recent','resources.read'].map(id => ({id,version:1})));
  session = (await invoke('r.create_session', { binding: await binding(r, 'r.create_session'), arguments: {} })).session_id;
  await activate('files', {});
  editor = await activate('editor', {}); await saveContextSource(sourceText);
  agent = await activate('agent', { kimi_home: nativeHome }, [
    { id: 'plugins.instances', version: 1 }, { id: 'editor.context.search', version: 1 }, { id: 'editor.context.preview', version: 1 },
    { id: 'plugins.inspect', version: 1 }, { id: 'r.execute', version: 2 },
    ...['r.context.help.search','r.context.help.preview','r.context.viewer.search','r.context.viewer.preview'].map(id => ({id,version:1})),
    { id: 'operation.get', version: 1 }, { id: 'plugins.delegated_operation', version: 1 },
  ]);
  const rBinding = { ...await binding(r, 'r.execute', 2), target: session };
  writeFileSync(join(project, 'native-science-input.json'), JSON.stringify({ expected_session: session, run: {
    code: `counter <- if (exists("counter", inherits=FALSE)) counter + 1L else 1L; writeLines(as.character(counter), "counter-value.txt"); while (!file.exists("release-r")) Sys.sleep(0.01); writeLines(${JSON.stringify(viewerText)}, "agent-viewer.html"); getOption("viewer")("agent-viewer.html"); cat("browser-original-r-result\\n"); counter`,
  } }));
  const manager = (await invoke('plugins.activate', { revision: managerPackage.revision, artifact: managerPackage.artifacts[0],
    target: 'ui-web', alias: 'manager', configuration: {} })).instance.identity;
  const initialLayout = await query('windows.layout', { window: windowId });
  managerView = (await invoke('windows.open_view', { expected_layout_version: initialLayout.version, group: null,
    view: { instance: manager, contribution: 'manager', window: windowId, configuration: {}, state: {} },
  })).view;
  const layout = await query('windows.layout', { window: windowId });
  view = (await invoke('windows.open_view', { expected_layout_version: layout.version, group: layout.layout.id,
    view: { instance: agent, contribution: 'agent', window: windowId, configuration: { tools: [{ name: 'execute', target: { type: 'provider', binding: rBinding } }], component_request: { request_id: crypto.randomUUID(), title: 'Ask about 上下文 Ω.R', sources: [{ source: 'plugin', label: 'Editor input · 上下文 Ω.R', reference: { provider: editor, contribution: 'documents', window: windowId, selector: { draft: sourceDraft.draft, version: sourceDraft.version, digest: sourceDraft.content.digest } }, inclusion: JSON.stringify({kind:'document'}) }] } }, state: {} },
  })).view;
});
test.afterAll(async () => {
  modelPeer?.release();
  if (project) writeFileSync(join(project, 'release-r'), 'finish disposable test');
  try { if (host) await stopHost(host); } finally { await modelPeer?.close(); }
  if (directory && completed) rmSync(directory, { recursive: true, force: true });
  else if (directory) console.error(`Agent browser acceptance retained at ${directory}`);
});

test('ordinary native and Rho tasks retain Editor input, real R results and explicit continuation through reload and Host restart', async ({ page }, info) => {
  test.setTimeout(480000);
  const address = new URL(url); address.searchParams.set('window', windowId); await page.goto(address.href);
  const frame = page.locator(`[data-plugin-frame="${view.view}"]`).frameLocator('iframe');
  await frame.getByRole('button', { name: 'New task', exact: true }).click();
  await frame.getByRole('button', { name: 'Kimi Code', exact: true }).click();
  const composer = frame.getByRole('textbox', { name: 'Agent message', exact: true });
  await expect(composer).toBeEnabled({ timeout: 45000 });
  expect(existsSync(join(project, 'native-science-evidence.json'))).toBe(false);
  const selection = await frame.getByLabel('Select task', { exact: true }).inputValue();
  expect(selection).toMatch(/^native:/);
  const task = selection.slice(7);
  const detail = () => nativeQuery('agent.native.task', { task_id: task });
  await frame.locator('#component-request summary').click();
  await frame.getByRole('button', {name:'Preview Editor input · 上下文 Ω.R',exact:true}).click();
  const picker = frame.getByRole('dialog', {name:'Choose context'});
  await expect(picker.locator('#context-preview')).toHaveText(sourceText.trim());
  await picker.getByRole('button', {name:'Close context'}).click();
  await frame.getByRole('button', {name:'Add context to draft',exact:true}).click();
  await expect(frame.getByRole('button', {name:'Add context to draft',exact:true})).toBeDisabled();
  await expect.poll(async () => (await detail()).draft.content.context.length).toBe(1);
  const contextSelection = (await detail()).draft.content.context[0], capturedDraft = structuredClone(sourceDraft);
  expect(contextSelection.reference.provider).toEqual(editor);
  expect(contextSelection.reference.selector.version).toBe(capturedDraft.version);
  writeFileSync(join(project,'native-science-context.json'),JSON.stringify({selection:contextSelection,text:sourceText}));
  const prompt = 'Run the authorized R counter once, using the selected attachments 中文';
  writeFileSync(join(project, 'native-science-history.json'), JSON.stringify({ messages: 120 }));
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
  // Losing the HTTP connection fences the containing renderer. Reopen the
  // acknowledged view before inspecting its saved upload; no finish is replayed.
  await expect(page.getByRole('button', { name: 'Reconnect this view', exact: true })).toBeVisible();
  await page.reload();
  await frame.locator('#uploads').getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Add to draft', exact: true })).toBeEnabled();
  expect((await detail()).draft.content.assets).toHaveLength(1);
  await frame.getByRole('button', { name: 'Add to draft', exact: true }).click();
  await expect.poll(async () => (await detail()).draft.content.assets.length).toBe(2);
  expect(finishes).toBe(1); expect((await detail()).draft.content.text).toBe(prompt);
  for (const width of [1440, 390, 220]) {
    await setAgentViewport(page,frame,width);
    await expect.poll(() => composer.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
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
  await saveContextSource('changed_after_send <- TRUE\n');
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
  expect(evidence.contexts).toHaveLength(1); expect(evidence.contexts[0].selection).toEqual(contextSelection); expect(evidence.contexts[0].text).toBe(sourceText);
  const originalContext = await nativeQuery('agent.native.context', {request_id:evidence.invocation.send_request});
  expect(originalContext.contexts).toEqual(evidence.contexts);
  expect(originalContext.contexts[0].data.draft_version).toBe(capturedDraft.version);
  await frame.getByRole('button', {name:'Sent context',exact:true}).click();
  await expect(picker.locator('#context-captures')).toContainText(sourceText.trim());
  await expect(picker.locator('#context-captures')).not.toContainText('changed_after_send');
  await picker.getByRole('button', {name:'Close context',exact:true}).click();

  expect((await sessionState()).session_id).toBe(session); expect(await executions()).toHaveLength(1);
  await expect(composer).toHaveValue(next);
  await page.screenshot({ path: info.outputPath('agent-native-result.png') });
  // Query the real Agent store after reopening; the first page must be bounded.
  await page.reload();
  const transcript = frame.getByRole('log', { name: 'Agent conversation' });
  await expect(transcript).toContainText('Original scientific result observed 中文');
  await expect(transcript).not.toContainText('History sample 001 中文');
  await frame.getByRole('button', { name: 'Earlier messages', exact: true }).click();
  await frame.getByRole('button', { name: 'Earlier messages', exact: true }).click();
  await expect(transcript).toContainText('History sample 001 中文');
  const first = transcript.locator('[data-event]').filter({ hasText: 'History sample 001 中文' });
  await first.scrollIntoViewIfNeeded();
  const position = await first.evaluate(element => element.getBoundingClientRect().top);
  // Observe two actual background task refreshes before checking the anchor.
  for (let i = 0; i < 2; i++) await page.waitForResponse(response => {
    if (!response.url().endsWith('/api/plugin-view')) return false;
    const body = response.request().postDataJSON()?.message?.body;
    return body?.type === 'query' && body.capability?.id === 'agent.native.task';
  });
  expect(Math.abs(await first.evaluate(element => element.getBoundingClientRect().top) - position)).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath('agent-native-history.png') });
  await frame.getByRole('button', { name: 'Latest messages', exact: true }).click();
  await expect(transcript).toContainText('Original scientific result observed 中文');
  await expect(transcript).not.toContainText('History sample 001 中文');
  await expect(composer).toHaveValue(next);
  expect(await executions()).toHaveLength(1);
  const help = await observeHelp(async (id,args) => query(id,{binding:await binding(r,id),arguments:args}),session);
  expect(await executions()).toHaveLength(1);
  await saveContextSource(sourceText);
  const rhoInput = await exerciseRhoInput(page,frame,info,modelPeer,nativeQuery,sourceText,
    () => saveContextSource('changed_after_rho_send <- TRUE\n'),childId);
  expect(rhoInput.original.context.sources[1].selection.reference.provider).toEqual(r);
  expect(rhoInput.original.context.sources[1].selection.reference.selector.help_files).toEqual(help.help_files);
  expect(rhoInput.original.context.sources[2].selection.reference.provider).toEqual(r);
  expect(rhoInput.original.context.sources[2].selection.reference.selector.operation).toBe(childId);
  const handoff = await prepareRetainedHandoff(page,frame,info,nativeQuery,task,rhoInput.task,rhoInput.draft);
  rhoInput.draft = handoff.targetDraft;
  expect(modelPeer.bodies).toHaveLength(rhoInput.requests);
  await frame.getByLabel('Select task',{exact:true}).selectOption(`native:${task}`);
  await expect(composer).toHaveValue(next);expect(await executions()).toHaveLength(1);
  // Normal Host exit suspends the same instances; acknowledged view/task data
  // remains available without restarting R or dispatching the old Send again.
  const retainedView = await query('views.inspect', { view: view.view });
  const priorConnection = await query('views.connection', { view: view.view });
  const priorLayout = await query('windows.layout', { window: windowId });
  const stoppedPid = host.pid; await stopHost(host);
  const restarted = await startHost(); host = restarted.process; url = restarted.address;
  expect(host.pid).not.toBe(stoppedPid);
  const suspended = await query('plugins.instance', { instance: agent });
  expect(suspended.observed_in_this_host).toBe(false); expect(suspended.instance.state).toBe('suspended');
  expect((await query('plugins.instance', { instance: r })).instance.state).toBe('suspended');
  expect(await query('views.inspect', { view: view.view })).toEqual(retainedView);
  expect(await query('windows.layout', { window: windowId })).toEqual(priorLayout);
  let resumeRequest = '', resumeCalls = 0, reconnectCalls = 0, loseResume = true, resumeReplyLost = false;
  await page.route('**/api/host', async route => {
    const request = route.request().postDataJSON()?.frame?.request;
    if (request?.method === 'invoke') {
      if (request.params.capability.id === 'plugins.resume' && request.params.arguments.instance.instance === agent.instance) {
        resumeCalls++; resumeRequest ||= request.params.client_request_id;
        if (loseResume) {
          loseResume = false;
          const reply = await (await route.fetch({ timeout: 60000 })).json();
          expect(reply.ok).toBe(true); expect(reply.result.status).toBe('succeeded');
          await route.abort(); resumeReplyLost = true; return;
        }
      }
      if (request.params.capability.id === 'views.reconnect' && request.params.arguments.view === view.view) reconnectCalls++;
    }
    await route.continue();
  });
  const restoredAddress = new URL(url); restoredAddress.searchParams.set('window', windowId);
  await page.goto(restoredAddress.href);
  await expect(page.getByRole('button', { name: 'Restore saved view', exact: true })).toBeVisible();
  expect(resumeCalls).toBe(0); expect(reconnectCalls).toBe(0);
  await page.getByRole('button', { name: 'Restore saved view', exact: true }).click();
  await expect.poll(() => resumeReplyLost, { timeout: 60000 }).toBe(true);
  await expect(page.getByRole('button', { name: 'Check recovery status', exact: true })).toBeVisible();
  expect(resumeCalls).toBe(1); expect(reconnectCalls).toBe(0);
  await page.reload();
  await page.getByRole('button', { name: 'Restore saved view', exact: true }).click();
  await expect(page.getByText('Instance restored. Continue to reconnect this view.', { exact: true })).toBeVisible();
  expect(resumeCalls).toBe(1); expect(reconnectCalls).toBe(0);
  for (const width of [1440, 390, 220]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`agent-host-recovery-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Restore saved view', exact: true }).click();
  await expect(composer).toHaveValue(next);
  await expect(frame.getByLabel('Select task', { exact: true })).toHaveValue(`native:${task}`);
  await expect(transcript).toContainText('Original scientific result observed 中文');
  expect(resumeCalls).toBe(1); expect(reconnectCalls).toBe(1);
  const currentConnection = await query('views.connection', { view: view.view });
  expect(currentConnection.view.view).toBe(retainedView.view); expect(currentConnection.view.instance).toEqual(agent);
  expect(currentConnection.connection).not.toBe(priorConnection.connection);
  expect(currentConnection.call_token).not.toBe(priorConnection.call_token);
  const afterRestart = await detail();
  expect((await query('plugins.instance',{instance:editor})).instance.state).toBe('suspended');
  expect(await nativeQuery('agent.native.context',{request_id:evidence.invocation.send_request})).toEqual(originalContext);
  expect((await query('plugins.instance',{instance:editor})).instance.state).toBe('suspended');
  await inspectRhoAfterRestart(frame,nativeQuery,modelPeer,rhoInput);
  await inspectRetainedHandoff(page,frame,info,nativeQuery,task,handoff);
  expect(modelPeer.bodies).toHaveLength(rhoInput.requests);
  expect((await query('plugins.instance',{instance:editor})).instance.state).toBe('suspended');
  await frame.getByLabel('Select task',{exact:true}).selectOption(`native:${task}`);
  await expect(composer).toHaveValue(next);

  expect(afterRestart.summary.task.task_id).toBe(task); expect(afterRestart.summary.task.native_session_id).toBe(nativeSession);
  expect(afterRestart.draft.content.text).toBe(next); expect(afterRestart.assets).toEqual(saved.assets);
  expect(afterRestart.summary.attachment.state).toBe('disconnected');
  expect((await query('operation.get', { operation_id: childId })).record.status).toBe('succeeded');
  expect(await executions()).toHaveLength(1); expect(readFileSync(join(project, 'counter-value.txt'), 'utf8')).toBe('1\n');
  expect((await query('plugins.instance', { instance: r })).instance.state).toBe('suspended');
  await frame.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(async () => (await detail()).summary.attachment.state, { timeout: 45000 }).toBe('ready');
  expect((await detail()).summary.task.native_session_id).toBe(nativeSession);
  expect(JSON.parse(readFileSync(join(project, 'native-science-resumes.json'), 'utf8'))).toEqual({ session: nativeSession, resumes: 1, prompts: 0 });
  expect(JSON.parse(readFileSync(join(project, 'native-science-evidence.json'), 'utf8')).prompts).toBe(1);
  await expect(composer).toHaveValue(next); expect(await executions()).toHaveLength(1);
  await expect(frame.locator('#task-state')).toHaveText('Kimi Code · ready');
  await expect(frame.locator('#recovery')).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(composer).toBeVisible();
  await setAgentViewport(page,frame,1440);
  await expect(transcript).toContainText('Original scientific result observed 中文');
  await page.screenshot({ path: info.outputPath('agent-host-restored.png') });
  expect((await query('operation.list_recent', { client_request_id: resumeRequest, limit: 10 })).operations).toHaveLength(1);
  // A backend without its own view is restored explicitly in the ordinary
  // Manager. Restoring the R owner must not start a new R session or replay work.
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
  await page.getByRole('button', { name: 'Restore saved view', exact: true }).click();
  const managerFrame = page.locator(`[data-plugin-frame="${managerView.view}"]`).frameLocator('iframe');
  await managerFrame.getByRole('button', { name: 'Instances', exact: true }).click();
  await managerFrame.getByRole('button', { name: /^r org\.rho\.r / }).click();
  await expect(managerFrame.getByRole('button', { name: 'Open view', exact: true })).toBeDisabled();
  for (const width of [1440, 390, 220]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => managerFrame.locator('body').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`manager-restore-instance-${width}.png`) });
  }
  let rResumes = 0, rResumeRequest = '';
  await page.route('**/api/plugin-view', async route => {
    const body = route.request().postDataJSON()?.message?.body;
    if (body?.type === 'invoke' && body.capability.id === 'plugins.resume') {
      rResumes++; rResumeRequest = body.request_id;
      const response = await route.fetch({ timeout: 60000 }), reply = await response.json(); expect(reply.ok).toBe(true);
      await route.fulfill({response,json:{id:reply.id,ok:false,error:'Fixture lost original instance recovery reply'}}); return;
    }
    await route.continue();
  });
  await managerFrame.getByRole('button', { name: 'Restore instance', exact: true }).click();
  await expect(managerFrame.getByRole('button', { name: 'Inspect original request', exact: true })).toBeEnabled({ timeout: 60000 });
  await page.reload();
  await managerFrame.getByRole('button', { name: 'Inspect original request', exact: true }).click();
  await expect(managerFrame.locator('#recovery')).toBeHidden();
  expect(rResumes).toBe(1); expect(rResumeRequest).toBeTruthy();
  const restoredR = await query('plugins.instance', { instance: r });
  expect(restoredR.instance.identity).toEqual(r); expect(restoredR.instance.state).toBe('active');
  expect(await sessionState()).toMatchObject({ state: 'unstarted', session_id: null });
  expect(await executions()).toHaveLength(1); expect(readFileSync(join(project, 'counter-value.txt'), 'utf8')).toBe('1\n');
  expect((await detail()).summary.task.native_session_id).toBe(nativeSession);
  writeFileSync(info.outputPath('agent-native-result.json'), JSON.stringify({ status: 'passed', build_mode: buildMode, delivered_set: deliveredSet, host_sha256: hash(readFileSync(binary)), original_send: evidence.invocation.send_request,
    child: childId, native_session: nativeSession, r_session: session, cached_history_messages: 120,
    host_restart: { instance: agent, task, view: view.view, resume_request: resumeRequest, resume_calls: resumeCalls, reconnect_calls: reconnectCalls, native_resume_without_prompt: true },
    manager_restore: { instance: r, resume_calls: rResumes, native_r_remains_unstarted: true },
    handoff: {request:handoff.request,source:handoff.receipt.source,target:handoff.receipt.target,append_calls:handoff.calls(),receipt_preserved_across_host_restart:true,send_calls:0},
    context: {provider:editor,reference:contextSelection.reference,sha256:hash(sourceText),preserved_after_source_change_and_host_restart:true},
    rho: {task:rhoInput.task,original:rhoInput.original.run_id,continued:rhoInput.continued.run_id,model_requests:modelPeer.bodies.length,
      source_preserved:true,next_draft_preserved:true,reload_and_host_restart_without_replay:true,
      sources:rhoInput.original.context.sources.map((source:any)=>({title:source.title,selection:source.selection,sha256:hash(source.text)}))},
    assets: saved.assets.map((a: any) => ({ name: a.name, bytes: a.bytes, sha256: a.sha256 })),
    limits: ['Local ACP and streaming model peers, no external model', 'Rho continuation is read-only; real R execution is through the native Agent task', 'Graceful Host restart after the original turn settled; no abrupt crash recovery', 'No installation or publication'],
  }, null, 2));
  completed = true;
});
