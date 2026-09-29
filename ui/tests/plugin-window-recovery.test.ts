import { expect, it, vi } from 'vitest';
import { PluginWindowRecovery } from '../src/plugin-window-recovery';
import { HostPortError, type HostClient } from '../src/host-client';
import type { PluginViewRecord } from '../../sdk/plugin-protocol/index.js';
const view: PluginViewRecord = { view: 'view', window: 'window', project: 'project', principal: 'principal',
  instance: { instance: 'original-instance', plugin: 'plugin', revision: 'revision', artifact: 'artifact' },
  contribution: 'workspace', configuration: {}, state: { draft: '未发送' }, state_version: 7, closed: false };
function fixture() {
  let saved: any = null, instance: any = { identity: view.instance, project: view.project, principal: view.principal, state: 'suspended', suspension: 'epoch-one' };
  let current = structuredClone(view), presence = 'detached', lose = '', lostSave = 0;
  const records: any[] = [], calls: any[] = [];
  const client = { windowId: 'window',
    readState: vi.fn(async (_project, key) => structuredClone(saved ?? { key, version: null, value: null })),
    writeState: vi.fn(async (_project, state) => {
      expect(state.version).toBe(saved?.version ?? null);
      saved = structuredClone({ ...state, version: String(Number(state.version ?? 0) + 1) });
      if (lostSave && --lostSave === 0) throw Error('Lost state acknowledgement');
      return structuredClone(saved);
    }),
    query: vi.fn(async (_project, id, args) => ({ status: 'ready', notices: [], data:
      id === 'plugins.instance' ? { instance: structuredClone(instance), observed_in_this_host: instance.state === 'active' } :
      id === 'views.inspect' ? structuredClone(current) :
      id === 'views.presence' ? { view: view.view, window: view.window, instance: view.instance, state: presence } :
      id === 'operation.list_recent' ? { operations: records.filter(r => r.operation.client_request_id === args.client_request_id).map(r => ({ operation_id: r.operation.operation_id })), next_cursor: null } : null })),
    invoke: vi.fn(async (_project, input) => {
      expect(saved.value.pending).toEqual(input); calls.push(structuredClone(input));
      let record = records.find(r => r.operation.client_request_id === input.client_request_id);
      if (!record) {
        let output;
        if (input.capability.id === 'plugins.resume') {
          expect(input.arguments).toEqual({ instance: view.instance, suspension: instance.suspension });
          instance = { ...instance, state: 'active' }; delete instance.suspension;
          output = { instance: structuredClone(instance), observed_in_this_host: true };
        } else {
          expect(input.capability.id).toBe('views.reconnect'); expect(input.arguments).toEqual({ view: view.view, expected_version: current.state_version });
          presence = 'attached'; output = structuredClone(current);
        }
        record = { operation: { operation_id: `operation-${records.length}`, client_request_id: input.client_request_id,
          capability: input.capability, normalized_arguments: input.arguments, preconditions: [] }, status: 'succeeded', outcome: 'succeeded', output };
        records.push(record);
      }
      if (lose === input.capability.id) { lose = ''; throw Error('Lost operation reply'); }
      return structuredClone(record);
    }),
    getOperation: vi.fn(async (_project, id) => structuredClone(records.find(record => record.operation.operation_id === id))),
  } as unknown as HostClient;
  const owner = () => new PluginWindowRecovery(client, '/selected-project');
  return { owner, client, records, calls, lose: (id: string) => lose = id, loseSave: (count = 1) => lostSave = count,
    saved: () => saved, instance: () => instance, changeView: (value: PluginViewRecord) => current = value,
    changeInstance: (fields: object) => Object.assign(instance, fields), presence: (value: string) => presence = value };
}
it('restores only the original confirmed suspension and reconnects its retained view', async () => {
  const f = fixture(), owner = f.owner(); expect(f.calls).toEqual([]);
  await expect(owner.restore(view)).resolves.toBe(true);
  expect(f.calls.map(call => call.capability.id)).toEqual(['plugins.resume', 'views.reconnect']);
  expect(f.calls[1].arguments).toEqual({ view: 'view', expected_version: 7 }); expect(f.saved().value).toBeNull();
  expect(JSON.stringify([...owner.getSnapshot()])).not.toContain('epoch-one');
  expect(f.records[1].output.state.draft).toBe('未发送');
  await owner.restore(view); expect(f.calls).toHaveLength(2);
});
it('inspection after a lost resume reply never dispatches the next step across reload', async () => {
  const f = fixture(); f.lose('plugins.resume');
  await expect(f.owner().restore(view)).rejects.toThrow('Lost operation reply');
  const pending = structuredClone(f.saved().value.pending), next = f.owner();
  await expect(next.restore(view)).resolves.toBe(false);
  expect(f.calls).toEqual([pending]); expect(f.saved().value).toBeNull();
  expect(next.getSnapshot().get(view.view)?.message).toContain('Continue');
  await expect(next.restore(view)).resolves.toBe(true); expect(f.calls).toHaveLength(2);
});
it('a lost reconnect reply is inspected without another resume or reconnect', async () => {
  const f = fixture(); f.lose('views.reconnect');
  await expect(f.owner().restore(view)).rejects.toThrow('Lost operation reply');
  const next = f.owner(); await expect(next.restore(view)).resolves.toBe(true);
  expect(f.calls).toHaveLength(2); expect(f.records).toHaveLength(2); expect(f.saved().value).toBeNull();
});
it('explicit retry uses the retained request even after a later Host suspension', async () => {
  const f = fixture(); f.lose('plugins.resume');
  await expect(f.owner().restore(view)).rejects.toThrow('Lost operation reply');
  const original = structuredClone(f.saved().value.pending);
  f.changeInstance({ state: 'suspended', suspension: 'epoch-two' });
  const next = f.owner(); await expect(next.retryOriginal(view)).resolves.toBe(false);
  expect(f.calls).toEqual([original, original]); expect(f.instance().state).toBe('suspended'); expect(f.records).toHaveLength(1);
});
it('a lost intent-save receipt stops dispatch and preserves its request for explicit retry', async () => {
  const f = fixture(); f.loseSave();
  await expect(f.owner().restore(view)).rejects.toThrow('Lost state acknowledgement'); expect(f.calls).toEqual([]);
  const pending = structuredClone(f.saved().value.pending), next = f.owner();
  await expect(next.restore(view)).rejects.toThrow('No unique original'); expect(f.calls).toEqual([]);
  await expect(next.retryOriginal(view)).resolves.toBe(false); expect(f.calls).toEqual([pending]);
  await next.restore(view); expect(f.calls).toHaveLength(2);
});
it('lost result-state acknowledgement retains the original and never advances recovery', async () => {
  const f = fixture(); f.loseSave(2);
  await expect(f.owner().restore(view)).rejects.toThrow('Lost state acknowledgement'); expect(f.calls).toHaveLength(1);
  await expect(f.owner().restore(view)).resolves.toBe(false); expect(f.calls).toHaveLength(1);
});
it.each(['released', 'failed', 'disconnected', 'cleanup_failed', 'suspending', 'preparing', 'draining'])('does not restore %s or create a replacement', async state => {
  const f = fixture(); f.changeInstance({ state, suspension: undefined });
  await expect(f.owner().restore(view)).rejects.toThrow('Only a confirmed Host suspension'); expect(f.calls).toEqual([]);
});
it.each(['identity', 'principal', 'project', 'purpose'])('rejects a changed instance %s', async field => {
  const f = fixture(); f.changeInstance({ [field]: field === 'identity' ? { ...view.instance, artifact: 'different' } : field === 'purpose' ? 'fixture_preview' : 'foreign' });
  await expect(f.owner().restore(view)).rejects.toThrow('another view owner'); expect(f.calls).toEqual([]);
});
it('refuses a retargeted saved request and keeps it available for inspection', async () => {
  const f = fixture(); f.lose('plugins.resume'); await expect(f.owner().restore(view)).rejects.toThrow();
  f.saved().value.pending.arguments.instance.artifact = 'foreign';
  await expect(f.owner().restore(view)).rejects.toThrow('saved instance recovery is invalid'); expect(f.calls).toHaveLength(1);
});
it('rejects an unrelated result without clearing or reparenting the original request', async () => {
  const f = fixture(); f.lose('plugins.resume'); await expect(f.owner().restore(view)).rejects.toThrow();
  f.records[0].operation.normalized_arguments.suspension = 'foreign';
  await expect(f.owner().restore(view)).rejects.toThrow('does not match'); expect(f.saved().value.pending).toBeTruthy(); expect(f.calls).toHaveLength(1);
});
it.each(['running', 'uncertain'])('keeps the original %s recovery for inspection', async status => {
  const f = fixture(); f.lose('plugins.resume'); await expect(f.owner().restore(view)).rejects.toThrow();
  Object.assign(f.records[0], { status, outcome: status === 'running' ? null : status, output: null });
  await expect(f.owner().restore(view)).rejects.toThrow(`Recovery is ${status}`); expect(f.saved().value.pending).toBeTruthy(); expect(f.calls).toHaveLength(1);
});
it('joins repeated clicks and does not continue after the window stops', async () => {
  const f = fixture(); let done!: (value: any) => void;
  vi.mocked(f.client.invoke).mockImplementationOnce(() => new Promise(resolve => done = resolve));
  const owner = f.owner(), pending = owner.restore(view); expect(owner.restore(view)).toBe(pending);
  await vi.waitFor(() => expect(done).toBeTypeOf('function')); owner.stop();
  done({ operation: {} }); await expect(pending).rejects.toThrow('window is closed');
  expect(f.client.invoke).toHaveBeenCalledOnce(); expect(f.saved().value.pending).toBeTruthy();
});
it('does not rotate a live connection or perform an operation to retry its renderer', async () => {
  const f = fixture(); f.changeInstance({ state: 'active', suspension: undefined }); f.presence('attached');
  await expect(f.owner().restore(view)).resolves.toBe(true); expect(f.calls).toEqual([]);
});
it('captures the latest acknowledged view version after restoring its owner', async () => {
  const f = fixture(); f.changeView({ ...view, state_version: 8, state: { draft: 'Updated' } });
  await f.owner().restore(view); expect(f.calls[1].arguments.expected_version).toBe(8); expect(f.records[1].output.state.draft).toBe('Updated');
});
it('a correlated pre-admission rejection permits a new explicitly requested attempt', async () => {
  const f = fixture();
  vi.mocked(f.client.invoke).mockImplementationOnce(async (_project, input) => { throw new HostPortError({
    code: 'invalid_input', message: 'Suspension changed', continuation: 'correct_input',
  } as any, { method: 'invoke', params: input } as any); });
  await expect(f.owner().restore(view)).rejects.toThrow(); expect(f.saved().value).toBeNull(); expect(f.calls).toEqual([]);
});
