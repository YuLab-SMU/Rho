import { expect, it, vi } from 'vitest';
import { ConfirmedCloseFailure, PluginWindowClosures } from '../src/plugin-window-close';
import { createPluginWindowClosures } from '../src/plugin-window-client';
import type { PluginViewRecord } from '../../sdk/plugin-protocol/index.js';
import type { Invocation } from '../src/generated/Invocation';
import type { OperationRecord } from '../src/generated/OperationRecord';
const closed = { view: 'view', window: 'window', closed: true } as PluginViewRecord;
it('joins closure and retains the original request after a lost acknowledgement', async () => {
  const submit = vi.fn(async () => closed).mockRejectedValueOnce(new Error('lost acknowledgement'));
  const owner = new PluginWindowClosures(submit), first = owner.close('view');
  expect(owner.close('view')).toBe(first); await expect(first).rejects.toThrow('lost acknowledgement');
  expect(owner.getSnapshot().get('view')).toMatchObject({ busy: false, confirmedFailure: false });
  await owner.close('view'); expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]); expect(owner.getSnapshot().size).toBe(0); owner.stop();
});
it('only a confirmed terminal failure permits a fresh explicit close attempt', async () => {
  const submit = vi.fn(async (_view: string, _request: string) => closed).mockRejectedValueOnce(new ConfirmedCloseFailure('Composition remains active'));
  const owner = new PluginWindowClosures(submit); await expect(owner.close('view')).rejects.toThrow('Composition');
  expect(owner.getSnapshot().get('view')?.confirmedFailure).toBe(true); await owner.close('view');
  expect(submit.mock.calls[0][1]).not.toBe(submit.mock.calls[1][1]); owner.stop();
});
it.each([{ ...closed, view: 'other' }, { ...closed, closed: false }])('never discards a view from an unrelated or still-open receipt', async record => {
  const owner = new PluginWindowClosures(async () => record); await expect(owner.close('view')).rejects.toThrow('confirmed closed');
  expect(owner.getSnapshot().has('view')).toBe(true); owner.stop(); await expect(owner.close('view')).rejects.toThrow('window is closed');
});
it('the containing window requests flush and validates the original Operation and window', async () => {
  const invoke = vi.fn(async (_project: string, input: Invocation) => ({ operation: { client_request_id: input.client_request_id, capability: input.capability }, status: 'succeeded', outcome: 'succeeded', output: closed }) as OperationRecord);
  const owner = createPluginWindowClosures({ windowId: 'window', invoke }, '/project'); await owner.close('view');
  expect(invoke.mock.calls[0][1].arguments).toEqual({ view: 'view', mode: { kind: 'flush' } });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (...args) => ({ ...await original(...args), output: { ...closed, window: 'other' } } as OperationRecord));
  await expect(owner.close('view')).rejects.toThrow('another window');
  invoke.mockImplementation(async (...args) => { const result = await original(...args); result.operation.client_request_id = 'another'; return result; });
  await expect(owner.close('view')).rejects.toThrow('different Operation'); owner.stop();
});
