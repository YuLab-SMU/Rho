import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function checkScientificWorkspace({ Manager, scientificWorkspace, scientificScenario, operationRequestId }) {
  const keys = ['r', 'files', 'editor', 'console', 'objects', 'plots', 'viewer', 'packages', 'help'];
  const hash = n => 'sha256:' + n.toString(16).padStart(64, '0');
  const makeChoices = selected => Object.fromEntries(selected.map((key, i) => {
    const manifest = JSON.parse(fs.readFileSync(new URL(`../../plugins/${key}/plugin.json`, import.meta.url)));
    const revision = hash(i + 1), artifact = hash(i + 101);
    return [key, { artifact, inspection: { manifest, summary: { plugin: manifest.id, revision }, artifacts: [{ id: artifact, target: manifest.backend ? 'aarch64-apple-darwin' : 'ui-web' }] } }];
  }));
  const choices = makeChoices(keys);
  const runtime = { ark: '/tools/ark', r_home: '/tools/R' };
  const setup = () => scientificWorkspace(choices, 'aarch64-apple-darwin', runtime, 7, 'scientific', 'Scientific workspace');
  const viewerReads = [{ id: 'operation.get', version: 1 }, { id: 'operation.list_recent', version: 1 }, { id: 'resources.read', version: 1 }];
  assert.deepEqual(setup().packages.r.optional_capabilities, viewerReads, 'the selected Viewer context receives its original-record/resource reads');
  for (const capability of viewerReads) {
    const missingRead = structuredClone(choices);
    missingRead.r.inspection.manifest.optional_requires = missingRead.r.inspection.manifest.optional_requires.filter(grant => grant.capability.id !== capability.id);
    assert.throws(() => scientificWorkspace(missingRead, 'aarch64-apple-darwin', runtime, 7, 'science'), /R revision.*Viewer context read contracts/);
  }
  const noViewerContext = structuredClone(choices);
  noViewerContext.r.inspection.manifest.contexts = noViewerContext.r.inspection.manifest.contexts.filter(context => context.id !== 'viewer');
  assert.equal(scientificWorkspace(noViewerContext, 'aarch64-apple-darwin', runtime, 7, 'science').packages.r.optional_capabilities, undefined, 'context grants are selected only for a declared contribution');
  const managerIdentity = { instance: 'manager-instance', plugin: 'org.rho.manager', revision: hash(99), artifact: hash(199) };
  const managerView = { view: 'manager-view', contribution: 'manager', instance: managerIdentity, configuration: {}, state: {}, window: 'window', project: 'project', principal: 'principal', closed: false };
  assert.throws(() => scientificWorkspace({ ...choices, help: undefined }, 'aarch64-apple-darwin', runtime, 7, 'science'), /installed help/);
  assert.throws(() => scientificWorkspace(choices, 'another-target', runtime, 7, 'science'), /unavailable/);
  assert.throws(() => scientificWorkspace(choices, 'aarch64-apple-darwin', { ...runtime, ark: 'relative' }, 7, 'science'), /absolute paths/);
  const noRuntime = structuredClone(choices); delete noRuntime.files.inspection.manifest.views[0].configuration_schema.properties.runtime;
  assert.throws(() => scientificWorkspace(noRuntime, 'aarch64-apple-darwin', runtime, 7, 'science'), /passes its R provider/);
  const noExecute = structuredClone(choices); noExecute.editor.inspection.manifest.optional_requires = [];
  assert.throws(() => scientificWorkspace(noExecute, 'aarch64-apple-darwin', runtime, 7, 'science'), /Editor revision/);
  assert.throws(() => scientificScenario(setup(), managerView), /exact r instance/);
  const visits = node => node.kind === 'tabs' ? node.views : node.kind === 'split' ? node.children.flatMap(visits) : [];
  function fixture(selected = choices) {
    const selectedKeys = Object.keys(selected);
    let saved, fault = null, unavailable = null, definitions = new Map(), records = [], instances = new Map(), calls = [];
    const inspections = new Map(Object.values(selected).map(value => [value.inspection.summary.revision, value.inspection]));
    inspections.set(managerIdentity.revision, { summary: { plugin: managerIdentity.plugin }, artifacts: [{ id: managerIdentity.artifact, target: 'ui-web' }] });
    const client = { view: structuredClone(managerView), setState: async value => { saved = structuredClone(value); }, operation: async id => records.find(record => record.operation.operation_id === id),
      query: async (cap, args) => {
        if (cap.id === 'plugins.inspect') return { status: 'ready', data: inspections.get(args.revision) };
        if (cap.id === 'plugins.instance') return { status: 'ready', data: { ...instances.get(args.instance.instance), observed_in_this_host: args.instance.instance !== unavailable } };
        if (cap.id === 'operation.list_recent') return { status: 'ready', data: { operations: records.filter(record => record.operation.client_request_id === args.client_request_id).map(record => ({ operation_id: record.operation.operation_id })) } };
        if (cap.id === 'operation.get') return { status: 'ready', data: { record: records.find(record => record.operation.operation_id === args.operation_id) } };
        if (cap.id === 'scenarios.prepare') {
          assert.equal(args.expected_layout_version, 7);
          assert.equal(Object.keys(args.instances).length, selectedKeys.length + 1);
          assert.equal(Object.keys(args.views).length, 1 + Object.values(selected).filter(c => c.inspection.manifest.views.length).length);
          assert.equal(args.views.manager, managerView.view);
          return { status: 'ready', data: {} };
        }
        throw Error(cap.id);
      }, invoke: async (cap, args, options) => {
        assert.equal(saved.pending.intent.request, options.requestId, 'each action is retained before submission');
        calls.push(cap.id);
        const request = await operationRequestId(client.view.view, options.requestId);
        let record = records.find(record => record.operation.client_request_id === request);
        if (!record) {
          let output;
          if (cap.id === 'plugins.activate') {
            const key = selectedKeys.find(key => selected[key].inspection.summary.revision === args.revision);
            const identity = { instance: `${key}-instance`, plugin: `org.rho.${key}`, revision: args.revision, artifact: args.artifact };
            output = { instance: { identity, alias: args.alias, configuration: args.configuration, state: 'active', purpose: 'runtime' }, observed_in_this_host: true };
            instances.set(identity.instance, output);
          } else if (cap.id === 'scenarios.checkpoint') {
            const { expected_head, ...body } = args;
            output = { ...body, id: hash(900), parent: expected_head, project: 'project' }; definitions.set(output.id, output);
          } else if (cap.id === 'views.open') output = { ...args, view: `view-${records.length}`, closed: false };
          else if (cap.id === 'scenarios.apply') output = {};
          else throw Error(cap.id);
          record = { operation: { operation_id: `operation-${records.length}`, client_request_id: request, caller: { kind: 'plugin', id: client.view.view }, capability: cap, normalized_arguments: args, preconditions: [] }, status: 'succeeded', outcome: 'succeeded', output, error: null };
          records.push(record);
        }
        if (fault === cap.id) { fault = null; throw Error('Lost original reply'); }
        return structuredClone(record);
      } };
    return { client, calls, records, instances, definitions, inspections, get saved() { return structuredClone(saved); },
      lose: id => { fault = id; }, unavailable: id => { unavailable = id; } };
  }
  const f = fixture(); let manager = new Manager(f.client);
  await manager.startWorkspace(setup()); assert.equal(f.calls.length, 0, 'choice capture starts no provider');
  f.lose('plugins.activate'); await assert.rejects(manager.prepareWorkspace(), /Lost original reply/);
  await assert.rejects(manager.resetWorkspace(), /Inspect the original request/);
  const first = f.records[0]; manager = new Manager(f.client, f.saved);
  assert.deepEqual(first.operation.normalized_arguments.optional_capabilities, viewerReads);
  assert.deepEqual(manager.state.workspace.packages.r.optional_capabilities, viewerReads, 'lost activation recovery retains the captured grants');
  assert.equal(f.calls.length, 1, 'opening retained setup performs no work');
  await manager.recover(); assert.equal(f.calls.length, 1, 'recovery only inspects the original activation');
  assert.equal(manager.state.workspace.instances.r.instance, first.output.instance.identity.instance);
  f.lose('scenarios.checkpoint'); await assert.rejects(manager.prepareWorkspace(), /Lost original reply/);
  assert.equal(f.calls.filter(id => id === 'plugins.activate').length, 9);
  assert.equal(f.calls.filter(id => id === 'views.open').length, 0, 'a lost checkpoint prevents later view creation');
  manager = new Manager(f.client, f.saved); await manager.recover();
  assert.equal(manager.state.workspace.checkpoint, hash(900));
  const definition = f.definitions.get(hash(900)), views = Object.fromEntries(visits(definition.layout).map(view => [view.id, view]));
  const r = manager.state.workspace.instances.r, editor = manager.state.workspace.instances.editor;
  assert.deepEqual(views.files.configuration, { editor, editor_group: 'documents', runtime: r });
  assert.deepEqual(views.editor.configuration.runtime, r);
  for (const key of ['objects', 'plots', 'console', 'viewer', 'packages', 'help']) assert.deepEqual(views[key].configuration.source, r);
  assert.deepEqual(definition.instances.editor.optional_capabilities, [{ id: 'r.session', version: 1 }, { id: 'r.execute', version: 2 }, { id: 'r.format', version: 1 }, { id: 'resources.read', version: 1 }]);
  assert.deepEqual(definition.instances.r.optional_capabilities, viewerReads, 'the saved scenario carries the same Viewer read grants');
  f.lose('views.open'); await assert.rejects(manager.prepareWorkspace(), /Lost original reply/);
  manager = new Manager(f.client, f.saved); const count = f.calls.length; await manager.recover(); assert.equal(f.calls.length, count);
  await manager.prepareWorkspace();
  assert.equal(manager.state.workspace, null); assert.equal(manager.state.preparation.ready, true);
  assert.equal(f.calls.filter(id => id === 'views.open').length, 8, 'one original view per scientific contribution, manager reused');
  assert.equal(f.calls.filter(id => id === 'scenarios.apply').length, 0, 'preparation never switches the window');
  assert.ok(!f.calls.some(id => id.startsWith('r.')), 'preparation never starts R or executes science');
  await manager.apply(); assert.equal(f.calls.at(-1), 'scenarios.apply');
  const missing = fixture(), recoverable = new Manager(missing.client); await recoverable.startWorkspace(setup());
  missing.lose('scenarios.checkpoint'); await assert.rejects(recoverable.prepareWorkspace(), /Lost original reply/); await recoverable.recover();
  missing.unavailable('r-instance'); const before = missing.calls.length;
  await assert.rejects(recoverable.prepareWorkspace(), /r instance is unavailable/); assert.equal(missing.calls.length, before, 'unavailable prepared instances never get silent replacements');
  const retained = recoverable.state.workspace;
  await recoverable.begin(missing.definitions.get(retained.checkpoint), 8);
  assert.equal(recoverable.state.workspace, null, 'explicit review hands the saved checkpoint to the normal scenario flow');
  assert.deepEqual(recoverable.state.preparation.request.instances.r, retained.instances.r);
  assert.equal(recoverable.state.preparation.request.expected_layout_version, 8);
  const restart = fixture(), fresh = new Manager(restart.client); await fresh.startWorkspace(setup());
  restart.lose('scenarios.checkpoint'); await assert.rejects(fresh.prepareWorkspace(), /Lost original reply/); await fresh.recover();
  const created = restart.calls.length; await fresh.resetWorkspace();
  assert.equal(restart.calls.length, created, 'setting aside setup cannot release existing instances or rewind native work');
  assert.equal(restart.instances.size, 9); assert.ok(fresh.state.preparation);
  await fresh.startWorkspace({ ...setup(), scenario: 'corrected-setup' });
  const complete = makeChoices([...keys, 'process', 'remote', 'environment', 'annotations', 'agent', 'studio']);
  const fullSetup = scientificWorkspace(complete, 'aarch64-apple-darwin', runtime, 7, 'full-workspace');
  assert.equal(Object.keys(fullSetup.packages).length, 15);
  const full = fixture(complete); let fullManager = new Manager(full.client);
  await fullManager.startWorkspace(fullSetup); full.lose('plugins.activate');
  await assert.rejects(fullManager.prepareWorkspace(), /Lost original reply/);
  const persisted = full.saved;
  persisted.workspace.packages = Object.fromEntries(Object.entries(persisted.workspace.packages).sort(([a],[b]) => a.localeCompare(b)));
  fullManager = new Manager(full.client, persisted); await fullManager.recover();
  full.lose('scenarios.checkpoint');
  await assert.rejects(fullManager.prepareWorkspace(), /Lost original reply/); await fullManager.recover();
  const fullScene = full.definitions.get(hash(900)), fullViews = visits(fullScene.layout);
  assert.equal(Object.keys(fullScene.instances).length, 16);
  assert.deepEqual(full.records.filter(r => r.operation.capability.id === 'plugins.activate').map(r => r.operation.normalized_arguments.alias), Object.keys(complete), 'restored JSON key order cannot activate consumers before their providers');
  const agent = fullViews.find(v => v.id === 'agent');
  assert.ok(fullViews.some(v => v.id === 'studio'));
  assert.equal(agent.configuration.tools.length, 14);
  for (const tool of agent.configuration.tools) {
    const instance = fullManager.state.workspace.instances[tool.target.binding.provider.plugin.slice(8)];
    assert.deepEqual(tool.target.binding.provider, instance);
    assert.equal(tool.target.binding.project, 'project');
    assert.ok(fullScene.instances.agent.optional_capabilities.some(cap => JSON.stringify(cap) === JSON.stringify(tool.target.binding.capability)));
  }
  assert.deepEqual(agent.state, {}, 'offered tools are not selected automatically');
  assert.ok(fullScene.instances.annotations.optional_capabilities.some(cap => cap.id === 'files.context.preview'));
  assert.ok(fullScene.instances.agent.optional_capabilities.some(cap => cap.id === 'plugins.checkpoint'), 'Studio assistance has its declared management contracts');
  await fullManager.prepareWorkspace();
  assert.equal(full.calls.filter(id => id === 'plugins.activate').length, 15, 'checkpoint recovery never reactivates the complete set');
  assert.equal(full.calls.filter(id => id === 'views.open').length, 10);
  assert.ok(!full.calls.some(id => id.startsWith('r.') || id.startsWith('agent.') || id.startsWith('process.')));
  const changed = structuredClone(complete); changed.agent.inspection.artifacts[0].target = 'another-target';
  assert.throws(() => scientificWorkspace(changed, 'aarch64-apple-darwin', runtime, 7, 'full'), /agent artifact is unavailable/);
  console.log('Scientific workspace recipe passes exact provider composition, explicit switching, missing-input checks and original-request recovery without replay.');
}
