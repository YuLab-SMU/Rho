import {expect, type Page, type TestInfo} from '@playwright/test';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** One actual R operation outlives scenario presentation and view closure. All
 * mutations use public ports; the gate only controls this disposable R script. */
export async function scientificContinuity({page, info, query, port, mapping, editorView, project, windowId, nativeSession}: {
  page: Page; info: TestInfo; query(id: string, args: any): Promise<any>; port(method: string, args: any): Promise<any>;
  mapping: any; editorView: any; project: string; windowId: string; nativeSession: string;
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
    await page.getByRole('tab', {name: 'Console', exact: true}).click();
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
  return {operation: operation.operation_id, native_session: nativeSession, working_scene: working.id, inspection_scene: inspection.id,
    original_editor: editorView.view, reopened_editor: reopenedEditor.view, original_console: mapping.views.console, reopened_console: reopenedConsole.view,
    running_across_switch_and_close: true, editor_and_console_drafts_restored: true, file_unchanged: true, same_session_and_result_after_reload: true, effect_count_after_reload: 1};
}
