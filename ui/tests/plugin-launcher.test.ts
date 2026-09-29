import { expect, it, vi } from 'vitest';
import { PluginLauncher } from '../src/plugin-launcher';
import type { HostClient } from '../src/host-client';

function fixture() {
  const manifest = { id: 'example.workspace', name: 'Workspace', version: '1', description: 'A workspace', backend: null, dependencies: {},
    default_configuration: {}, views: [{ id: 'workspace', title: 'Workspace', configuration_schema: { type: 'object' } }] };
  const inspection = { summary: { revision: 'revision', plugin: manifest.id }, manifest, artifacts: [{ id: 'artifact', target: 'ui-web' }] };
  const instance = { instance: 'original-instance', plugin: manifest.id, revision: 'revision', artifact: 'artifact' };
  let saved: any = null, failure = '', saveLost = 0;
  const records: any[] = [], calls: any[] = [];
  const client = { windowId: 'window',
    readState: vi.fn(async (_project, key) => saved ?? { key, version: null, value: null }),
    writeState: vi.fn(async (_project, state) => {
      expect(state.version).toBe(saved?.version ?? null);
      saved = structuredClone({ ...state, version: String(Number(state.version ?? 0) + 1) });
      if (saveLost && --saveLost === 0) throw Error('Lost state acknowledgement');
      return structuredClone(saved);
    }),
    query: vi.fn(async (_project, id, args) => ({ status: 'ready', notices: [], data:
      id === 'plugins.list' ? { items: [inspection.summary], next: null } : id === 'plugins.inspect' ? inspection :
      id === 'plugins.instance' ? { instance: { identity: instance, state: 'active' }, observed_in_this_host: true } :
      id === 'windows.layout' ? { window: 'window', version: 0, layout: { kind: 'empty' } } :
      id === 'operation.list_recent' ? { operations: records.filter(r => r.operation.client_request_id === args.client_request_id).map(r => ({ operation_id: r.operation.operation_id })) } : null })),
    invoke: vi.fn(async (_project, input) => {
      expect(saved.value.pending).toEqual(input); calls.push(structuredClone(input));
      let record = records.find(r => r.operation.client_request_id === input.client_request_id);
      if (!record) {
        const output = input.capability.id === 'plugins.activate' ? { instance: { identity: instance, state: 'active' }, observed_in_this_host: true } :
          { view: { instance, view: 'original-view', window: 'window', contribution: 'workspace', closed: false } };
        record = { operation: { operation_id: `operation-${records.length}`, client_request_id: input.client_request_id, capability: input.capability, normalized_arguments: input.arguments, preconditions: [] }, status: 'succeeded', outcome: 'succeeded', output };
        records.push(record);
      }
      if (failure === input.capability.id) { failure = ''; throw Error('Lost operation reply'); }
      return structuredClone(record);
    }),
    getOperation: vi.fn(async (_project, id) => structuredClone(records.find(r => r.operation.operation_id === id))),
  } as unknown as HostClient;
  const open = async () => { const model = new PluginLauncher(client, '/project'); await model.load(); return model; };
  return { client, calls, records, manifest, instance, open, lose: (id: string) => failure = id, loseSave: (after = 1) => saveLost = after };
}
it('observes standalone installed contributions without choosing a privileged plugin or creating instances', async () => {
  const f = fixture(), model = await f.open();
  expect(model.choices.map(item => item.title)).toEqual(['Workspace']); expect(f.calls).toEqual([]);
  await model.choose(model.choices[0].id);
  expect(f.calls.map(call => call.capability.id)).toEqual(['plugins.activate', 'windows.open_view']);
  expect(f.calls[1].arguments.view.instance).toEqual(f.instance); expect(model.launch).toBeNull();
  expect((await f.open()).launch).toBeNull(); expect(f.calls).toHaveLength(2);
});
it('retains a lost activation across reload and inspection does not advance to opening a view', async () => {
  const f = fixture(); let model = await f.open(); f.lose('plugins.activate');
  await expect(model.choose(model.choices[0].id)).rejects.toThrow('Lost operation reply');
  await expect(model.reset()).rejects.toThrow('Inspect the original request');
  model = await f.open(); expect(f.calls).toHaveLength(1);
  await model.inspect(); expect(f.calls).toHaveLength(1); expect(model.launch?.instance).toEqual(f.instance);
  await model.continue(); expect(f.calls.map(call => call.capability.id)).toEqual(['plugins.activate', 'windows.open_view']);
});
it('setting aside a recovered preparation keeps its instance and original records', async () => {
  const f = fixture(), model = await f.open(); f.lose('plugins.activate');
  await expect(model.choose(model.choices[0].id)).rejects.toThrow('Lost operation reply');
  await model.inspect(); await model.reset(); expect(model.launch).toBeNull(); expect(f.records).toHaveLength(1); expect(f.calls).toHaveLength(1);
});
it('retry of a lost view opening retains its request and creates no replacement instance', async () => {
  const f = fixture(); let model = await f.open(); f.lose('windows.open_view');
  await expect(model.choose(model.choices[0].id)).rejects.toThrow('Lost operation reply');
  model = await f.open(); await model.dispatch();
  expect(f.calls[1]).toEqual(f.calls[2]); expect(f.records).toHaveLength(2); expect(model.launch).toBeNull();
});
it('a lost intent-save acknowledgement stops all operations until authoritative reload', async () => {
  const f = fixture(); let model = await f.open(); f.loseSave();
  await expect(model.choose(model.choices[0].id)).rejects.toThrow('Lost state acknowledgement'); expect(f.calls).toHaveLength(0);
  model = await f.open(); await model.continue(); expect(f.records).toHaveLength(2);
});
it('never bootstraps views needing provider configuration or native backend dependencies', async () => {
  const f = fixture(); (f.manifest.views[0].configuration_schema as any).required = ['source'];
  expect((await f.open()).choices).toEqual([]); expect(f.calls).toHaveLength(0);
  delete (f.manifest.views[0].configuration_schema as any).required;
  (f.manifest as any).backend = { executable: 'native' }; expect((await f.open()).choices).toEqual([]);
});
it('an unacknowledged persisted intent is submitted only under its saved request identity', async () => {
  const f = fixture(); let model = await f.open(); f.loseSave(2);
  await expect(model.choose(model.choices[0].id)).rejects.toThrow('Lost state acknowledgement');
  expect(f.calls).toHaveLength(0); model = await f.open();
  const original = structuredClone(model.launch!.pending);
  await expect(model.inspect()).rejects.toThrow('No unique original'); expect(f.calls).toHaveLength(0);
  await model.dispatch(); expect(f.calls[0]).toEqual(original);
  await model.continue(); expect(f.calls).toHaveLength(2);
});
it('rejects a different original operation without discarding the retained request', async () => {
  const f = fixture(); const model = await f.open(); f.lose('plugins.activate');
  await expect(model.choose(model.choices[0].id)).rejects.toThrow('Lost operation reply');
  f.records[0].operation.normalized_arguments.artifact = 'different';
  await expect(model.inspect()).rejects.toThrow('does not match'); expect(model.launch?.pending).toBeTruthy(); expect(f.calls).toHaveLength(1);
});
