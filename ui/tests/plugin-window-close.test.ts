import { expect, it, vi } from 'vitest';
import { ConfirmedCloseFailure, PluginWindowClosures } from '../src/plugin-window-close';
import { createPluginWindowClosures } from '../src/plugin-window-client';
import { HostPortError } from '../src/host-client';
import type { PluginViewRecord } from '../../sdk/plugin-protocol/index.js';
import type { Invocation } from '../../sdk/host-client/Invocation';
import type { OperationRecord } from '../../sdk/host-client/OperationRecord';
const closed = { view: 'view', window: 'window', closed: true } as PluginViewRecord;
it.each(['invalid_input', 'outcome_uncertain', 'idempotency_conflict'] as const)(
  'distinguishes an original %s rejection without treating uncertain work as failed', async code => {
    const invoke = vi.fn(async (_project: string, input: Invocation): Promise<OperationRecord> => {
      throw new HostPortError({ code, message: 'Original close rejected', continuation: code === 'invalid_input' ? 'correct_input' : 'inspect_original', next_reads: [] },
        { method: 'invoke', params: input });
    });
    const owner = createPluginWindowClosures({ windowId: 'window', invoke }, '/project');
    await expect(owner.close('view')).rejects.toThrow('Original close rejected');
    expect(owner.getSnapshot().get('view')?.confirmedFailure).toBe(code === 'invalid_input');
    if (code !== 'invalid_input') await expect(owner.close('view', { kind: 'retain_acknowledged', expected_version: 0 })).rejects.toThrow('original close');
    owner.stop();
  },
);
it('does not classify an unrelated admission rejection as the original close outcome', async () => {
  const invoke = vi.fn(async (_project: string, input: Invocation): Promise<OperationRecord> => {
    throw new HostPortError({ code: 'invalid_input', message: 'Other request rejected', continuation: 'correct_input', next_reads: [] },
      { method: 'invoke', params: { ...input, client_request_id: 'another-request' } });
  });
  const owner = createPluginWindowClosures({ windowId: 'window', invoke }, '/project');
  await expect(owner.close('view')).rejects.toThrow('Other request'); expect(owner.getSnapshot().get('view')?.confirmedFailure).toBe(false); owner.stop();
});
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
it('captures an explicit saved version after a confirmed refusal and keeps that choice across lost acknowledgements', async () => {
 const submit=vi.fn(async(_view:string,_request:string,_mode:unknown)=>closed).mockRejectedValueOnce(new ConfirmedCloseFailure('Cannot flush')).mockRejectedValueOnce(new Error('Lost recovery acknowledgement'));
 const owner=new PluginWindowClosures(submit);await expect(owner.close('view')).rejects.toThrow('Cannot flush');
 await expect(owner.close('view',{kind:'retain_acknowledged',expected_version:4})).rejects.toThrow('Lost recovery');
 await expect(owner.close('view',{kind:'retain_acknowledged',expected_version:5})).rejects.toThrow('original close');
 expect(submit).toHaveBeenCalledTimes(2);await owner.close('view');
 expect(submit.mock.calls[2]).toEqual(submit.mock.calls[1]);expect(submit.mock.calls[2][2]).toEqual({kind:'retain_acknowledged',expected_version:4});owner.stop();
});
