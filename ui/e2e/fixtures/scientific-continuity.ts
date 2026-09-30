import {expect, type Page, type Route, type TestInfo} from '@playwright/test';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

/** One actual R operation outlives scenario presentation and view closure. All
 * mutations use public ports; the gate only controls this disposable R script. */
export async function scientificContinuity({page, info, query, port, mapping, editorView, project, directory, windowId, nativeSession}: {
  page: Page; info: TestInfo; query(id: string, args: any): Promise<any>; port(method: string, args: any): Promise<any>;
  mapping: any; editorView: any; project: string; directory: string; windowId: string; nativeSession: string;
}) {
  const invoke = async (id: string, arguments_: any) => {
    const record = await port('invoke', {capability: {id, version: 1}, arguments: arguments_, preconditions: [], client_request_id: crypto.randomUUID()});
    expect(record.status, JSON.stringify(record.error)).toBe('succeeded'); return record.output;
  };
  const frame = (view: string) => page.locator(`[data-plugin-frame="${view}"]`).frameLocator('iframe');
  const definitions = await query('scenarios.get', {revision: mapping.revision});
  const layout = await query('windows.layout', {window: windowId});
  const declared: Record<string, any> = {}, views: Record<string, string> = {};
  const describe = async (node: any): Promise<any> => {
    if (node.kind === 'split') return {...node, children: await Promise.all(node.children.map(describe))};
    if (node.kind !== 'tabs') return node;
    return {...node, views: await Promise.all(node.views.map(async (id: string) => {
      const saved = await query('views.inspect', {view: id});
      const alias = Object.keys(mapping.instances).find(alias => mapping.instances[alias].instance === saved.instance.instance);
      expect(alias).toBeTruthy(); views[id] = id;
      return declared[id] = {id, instance: alias, contribution: saved.contribution, configuration: saved.configuration,
        state: saved.state, state_revision: saved.instance.revision, resource: saved.resource ?? null};
    }))};
  };
  const workingLayout = await describe(layout.layout);
  const checkpoint = (scenario: string, name: string, layout: any) => invoke('scenarios.checkpoint', {
    scenario, name, expected_head: null, instances: definitions.instances, providers: definitions.providers, layout,
  });
  const working = await checkpoint('continuity-working', 'Working scientific scene', workingLayout);
  const inspection = await checkpoint('continuity-inspection', 'Inspect running instances', {
    kind: 'tabs', id: 'inspection-only', selected: mapping.views.manager, views: [declared[mapping.views.manager]],
  });
  const apply = async (revision: string, selected: Record<string, string>) => {
    const current = await query('windows.layout', {window: windowId});
    const request = {window: windowId, revision, expected_layout_version: current.version, instances: mapping.instances, views: selected};
    await query('scenarios.prepare', request); await invoke('scenarios.apply', request);
    expect((await query('windows.scenario', {window: windowId})).scenario.revision).toBe(revision);
  };
  // Credentials are deliberately created after the historical checkpoint. A
  // later restore must not erase them or roll back the Agent owner's settings.
  const secret = 'disposable-scenario-history-key';
  const agent = frame(mapping.views.agent);
  await page.getByRole('tab', {name: 'Agent', exact: true}).click();
  await agent.getByRole('button', {name: 'Task actions', exact: true}).click();
  await agent.getByRole('button', {name: 'Settings', exact: true}).click();
  const settingsDialog = agent.getByRole('dialog', {name: 'Agent settings'});
  await settingsDialog.getByRole('combobox', {name: 'API format'}).selectOption('openai_completions');
  await settingsDialog.getByRole('textbox', {name: 'Base URL'}).fill('http://127.0.0.1:9/v1');
  await settingsDialog.getByRole('textbox', {name: 'Model ID'}).fill('scenario-history-fixture');
  await settingsDialog.getByRole('textbox', {name: 'API key', exact: true}).fill(secret);
  await settingsDialog.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(settingsDialog.locator('#settings-key-status')).toContainText('Saved on this computer');
  await settingsDialog.getByRole('button', {name: 'Close settings'}).click();
  const agentQuery = async (id: string, args: any) => query(id, {
    binding: await query('plugins.resolve', {instance: mapping.instances.agent, capability: {id, version: 1}}), arguments: args,
  });
  const settingsBefore = await agentQuery('agent.model.settings', {});
  const keyBefore = await agentQuery('agent.model.key.status', {settings_version: settingsBefore.version});
  expect(keyBefore.available).toBe(true); expect(settingsBefore.enabled).toBe(false);
  // Inspect only this test's owned directory, never user credential locations.
  const credentialFiles = (root: string): string[] => readdirSync(root, {withFileTypes: true}).flatMap(entry => {
    const file = join(root, entry.name);
    return entry.isDirectory() ? credentialFiles(file) : entry.isFile() && entry.name === 'model-credentials-v1.json' ? [file] : [];
  });
  const credentials = credentialFiles(directory); expect(credentials).toHaveLength(1);
  const credentialDigest = () => createHash('sha256').update(readFileSync(credentials[0])).digest('hex');
  const retainedCredential = credentialDigest();
  expect(JSON.stringify(working)).not.toContain(secret);
  await page.locator(`[role="tab"][aria-controls="flexlayout-tab-${editorView.view}"]`).click();
  const original = frame(editorView.view), code = original.getByRole('textbox', {name: 'Code Editor', exact: true});
  const editorDraft = '# unsaved across running scene 中文 Ω\nanswer <- 999L\n';
  await code.click(); await code.press('Meta+a'); await page.keyboard.insertText(editorDraft);
  await expect(original.locator('#file-state')).toHaveText('Unsaved');
  const diskBefore = readFileSync(join(project, editorView.configuration.file.path), 'utf8');
  await page.getByRole('tab', {name: 'Console', exact: true}).click();
  const console = frame(mapping.views.console), input = console.getByRole('textbox', {name: 'Console Input', exact: true});
  const gate = join(project, 'release-continuity'), effect = join(project, 'continuity-effects.txt'), entered = join(project, 'continuity-entered');
  const script = `local({ cat("entered", file = ${JSON.stringify(entered)}); deadline <- Sys.time() + 90; while (!file.exists(${JSON.stringify(gate)})) { if (Sys.time() > deadline) stop("continuity gate deadline"); Sys.sleep(0.05) }; scene_continuity <<- 73L; cat("once\\n", file = ${JSON.stringify(effect)}, append = TRUE); cat("scene-continuity-result\\n") })`;
  const executions = async () => (await query('operation.list_recent', {limit: 100})).operations.filter((record: any) => record.capability.id === 'r.execute');
  const before = await executions();
  let operation: any, reopenedEditor: any, reopenedConsole: any;
  const originalRecord = async () => (await query('operation.get', {operation_id: operation.operation_id})).record;
  try {
    await input.fill(script); await console.getByRole('button', {name: 'Run', exact: true}).click();
    await expect.poll(async () => (await executions()).length).toBe(before.length + 1);
    operation = (await executions()).find((entry: any) => !before.some((old: any) => old.operation_id === entry.operation_id));
    await expect.poll(async () => (await originalRecord()).status).toBe('running');
    await expect.poll(() => existsSync(entered)).toBe(true);
    const nextInput = '# next unsent Console draft 中文';
    await expect(input).toHaveText(''); await input.fill(nextInput);
    await apply(inspection.id, {[mapping.views.manager]: mapping.views.manager});
    await expect(page.getByRole('tab', {name: 'Console', exact: true})).toHaveCount(0);
    expect((await originalRecord()).status).toBe('running');
    expect((await query('plugins.instance', {instance: mapping.instances.r})).instance.state).toBe('active');
    await page.screenshot({path: info.outputPath('science-running-other-scene.png')});
    await apply(working.id, views);
    await expect(code).toContainText('unsaved across running scene 中文 Ω');
    // Hold the actual layout acknowledgement to expose the saving state. Its
    // indicator must not shift the close target underneath the next click.
    let releaseSave!: () => void, saveObserved!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const observed = new Promise<void>(resolve => { saveObserved = resolve; });
    const holdLayout = async (route: Route) => {
      const request = route.request().postDataJSON()?.frame?.request;
      if (request?.method !== 'invoke' || request.params?.capability?.id !== 'windows.update_layout') return route.fallback();
      const response = await route.fetch(); saveObserved(); await saveGate;
      await route.fulfill({response});
    };
    const consoleTab = page.getByRole('tab', {name: 'Console', exact: true});
    const closeButton = consoleTab.locator('[data-layout-path$="/button/close"]');
    let whileSaving: Awaited<ReturnType<typeof closeButton.boundingBox>> = null;
    await page.route('**/api/host', holdLayout);
    try {
      await consoleTab.click();
      await observed;
      await expect(page.getByRole('status').filter({hasText: 'Saving layout…'})).toBeVisible();
      whileSaving = await closeButton.boundingBox(); expect(whileSaving).not.toBeNull();
    } finally { releaseSave(); await page.unroute('**/api/host', holdLayout); }
    await expect(page.getByRole('status').filter({hasText: 'Saving layout…'})).toHaveCount(0);
    // Compare the same selected tab on both sides of the acknowledgement;
    // selection itself can change the docking library's border geometry.
    expect(await closeButton.boundingBox()).toEqual(whileSaving);
    await expect(input).toHaveText(nextInput);
    // Closing the Console and Editor captures drafts, without stopping R.
    await page.getByRole('tab', {name: 'Console', exact: true}).locator('[data-layout-path$="/button/close"]').click();
    await expect(page.locator(`[data-plugin-frame="${mapping.views.console}"]`)).toHaveCount(0);
    // Target the known file tab through its close control, independent of title.
    await page.locator(`[role="tab"][aria-controls="flexlayout-tab-${editorView.view}"]`).locator('[data-layout-path$="/button/close"]').click();
    await expect(page.locator(`[data-plugin-frame="${editorView.view}"]`)).toHaveCount(0);
    expect((await originalRecord()).status).toBe('running');
    const reopen = async (id: string, group: string) => {
      const saved = await query('views.inspect', {view: id}); expect(saved.closed).toBe(true);
      const current = await query('windows.layout', {window: windowId});
      return (await invoke('windows.open_view', {expected_layout_version: current.version, group,
        view: {instance: saved.instance, contribution: saved.contribution, window: windowId, configuration: saved.configuration, state: saved.state}})).view;
    };
    reopenedEditor = await reopen(editorView.view, 'documents'); reopenedConsole = await reopen(mapping.views.console, 'execution');
    await expect(frame(reopenedEditor.view).getByRole('textbox', {name: 'Code Editor', exact: true})).toContainText('unsaved across running scene 中文 Ω');
    await expect(frame(reopenedEditor.view).locator('#file-state')).toHaveText('Unsaved');
    await expect(frame(reopenedConsole.view).getByRole('textbox', {name: 'Console Input', exact: true})).toHaveText(nextInput);
    expect((await originalRecord()).status).toBe('running');
  } finally {writeFileSync(gate, 'release\n');}
  await expect.poll(async () => (await originalRecord()).status, {timeout: 60000}).toBe('succeeded');
  const record = await originalRecord();
  expect(record.operation.normalized_arguments.binding.provider).toEqual(mapping.instances.r);
  expect(record.operation.normalized_arguments.arguments.expected_session).toBe(nativeSession);
  expect(record.operation.normalized_arguments.arguments.run.source.view_id).toBe(mapping.views.console);
  expect(readFileSync(effect, 'utf8')).toBe('once\n');
  expect(readFileSync(join(project, editorView.configuration.file.path), 'utf8')).toBe(diskBefore);
  await expect(frame(reopenedConsole.view).getByRole('textbox', {name: 'Console Transcript', exact: true})).toContainText('scene-continuity-result');
  await page.reload();
  await expect(frame(reopenedEditor.view).getByRole('textbox', {name: 'Code Editor', exact: true})).toContainText('unsaved across running scene 中文 Ω');
  await expect(frame(reopenedConsole.view).getByRole('textbox', {name: 'Console Input', exact: true})).toHaveText('# next unsent Console draft 中文');
  await expect(frame(reopenedConsole.view).getByRole('textbox', {name: 'Console Transcript', exact: true})).toContainText('scene-continuity-result');
  const binding = await query('plugins.resolve', {instance: mapping.instances.r, capability: {id: 'r.session', version: 1}});
  expect((await query('r.session', {binding, arguments: {}})).session_id).toBe(nativeSession);
  expect(await executions()).toHaveLength(before.length + 1);
  expect(readFileSync(effect, 'utf8')).toBe('once\n');
  await page.screenshot({path: info.outputPath('science-continuity-restored.png')});
  // Restore old definitions as a new checkpoint, just as Studio does. Neither
  // historical checkpoint creation nor application may rewind owner data.
  const advanced = await invoke('scenarios.checkpoint', {scenario: working.scenario, expected_head: working.id,
    name: 'Later inspection scene', instances: definitions.instances, providers: definitions.providers, layout: inspection.layout});
  await apply(advanced.id, {[mapping.views.manager]: mapping.views.manager});
  const historical = await query('scenarios.get', {revision: working.id});
  expect(historical).toEqual(working);
  const restored = await invoke('scenarios.checkpoint', {scenario: historical.scenario, expected_head: advanced.id,
    name: historical.name, instances: historical.instances, providers: historical.providers, layout: historical.layout});
  expect(restored.parent).toBe(advanced.id); expect(restored.id).not.toBe(working.id);
  await apply(restored.id, {...views, [editorView.view]: reopenedEditor.view, [mapping.views.console]: reopenedConsole.view});
  expect(await query('scenarios.get', {revision: working.id})).toEqual(working);
  expect(await query('scenarios.get', {revision: advanced.id})).toEqual(advanced);
  expect((await query('windows.scenario', {window: windowId})).scenario.instances).toEqual(mapping.instances);
  expect((await query('r.session', {binding, arguments: {}})).session_id).toBe(nativeSession);
  expect(await originalRecord()).toEqual(record);
  expect(await executions()).toHaveLength(before.length + 1);
  expect(readFileSync(effect, 'utf8')).toBe('once\n');
  expect(readFileSync(join(project, editorView.configuration.file.path), 'utf8')).toBe(diskBefore);
  expect(await agentQuery('agent.model.settings', {})).toEqual(settingsBefore);
  expect(await agentQuery('agent.model.key.status', {settings_version: settingsBefore.version})).toEqual(keyBefore);
  expect(credentialDigest()).toBe(retainedCredential);
  expect(JSON.stringify([historical, advanced, restored])).not.toContain(secret);
  await page.getByRole('tab', {name: 'Objects', exact: true}).click();
  const objects = frame(mapping.views.objects);
  const value = objects.locator('.object-entry').filter({has: objects.locator('.object-name code').getByText('scene_continuity', {exact: true})});
  await expect(value.locator('.directory-content:visible, .directory-compact-summary:visible').getByText('73', {exact: true})).toBeVisible();
  // Scenario switching reattaches the retained iframe. Its DOM can be visible
  // before the child surface has been composited into the parent screenshot.
  await objects.locator('body').evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({path: info.outputPath('science-history-current-memory.png')});

  return {operation: operation.operation_id, native_session: nativeSession, working_scene: working.id, inspection_scene: inspection.id,
    history_restore: {historical: working.id, previous_head: advanced.id, restored: restored.id, same_instances: true, native_value: 73, credential_bytes_unchanged: true, owner_settings_unchanged: true},
    original_editor: editorView.view, reopened_editor: reopenedEditor.view, original_console: mapping.views.console, reopened_console: reopenedConsole.view,
    running_across_switch_and_close: true, editor_and_console_drafts_restored: true, file_unchanged: true, same_session_and_result_after_reload: true, effect_count_after_reload: 1};
}
