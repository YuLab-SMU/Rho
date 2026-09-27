import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostClient } from '../src/host-client';
import type { PluginWindowLayout } from '../../sdk/plugin-protocol/index.js';
import { PluginWorkspace } from '../src/plugin-workspace-window';
const mounted = vi.hoisted(() => ({ starts: [] as string[], stops: [] as string[], refreshers: new Map<string, () => Promise<void>>() }));
vi.mock('../src/plugin-layout-host', () => ({ PluginLayoutHost: ({ frames, close }: any) => <div>
  {frames.map((frame: any) => <div key={frame.id}>{frame.content}<button onClick={() => close(frame.id)}>Close {frame.id}</button></div>)}
</div> }));
vi.mock('../src/plugin-frame', () => ({ mountPluginFrame: (container: HTMLElement, _client: unknown, _project: string, connection: any, _failed: unknown, refresh: () => Promise<void>) => {
  const id = connection.view.view; mounted.starts.push(id); mounted.refreshers.set(id, refresh);
  const input = document.createElement('input'); input.setAttribute('aria-label', `Draft ${id}`); container.append(input);
  return () => { mounted.stops.push(id); input.remove(); };
} }));
afterEach(() => { cleanup(); vi.useRealTimers(); mounted.starts = []; mounted.stops = []; mounted.refreshers.clear(); });
function fixture() {
  const identity = { instance: 'instance', plugin: 'example', revision: 'revision', artifact: 'artifact' };
  const record = (id: string) => ({ view: id, instance: identity, project: 'project', principal: 'principal', window: 'window', contribution: id, closed: false, state: {}, configuration: {}, state_version: 0 });
  let layout: PluginWindowLayout = { window: 'window', project: 'project', principal: 'principal', version: 1, layout: { kind: 'tabs', id: 'main', views: ['one'], selected: 'one' } };
  const query = vi.fn(async (_project: string, capability: string, args: any) => {
    const data = capability === 'windows.layout' ? structuredClone(layout) : capability === 'views.connection' ? { view: record(args.view), connection: args.view, call_token: 'private', asset_token: 'asset', entrypoint: 'index.html', grants: [], next_sequence: 1 } : capability === 'views.inspect' ? record(args.view) : { summary: { revision: 'revision' }, manifest: { id: 'example', views: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] } };
    return { status: 'ready', data, notices: [] };
  });
  const invoke = vi.fn(async (_project: string, input: any) => {
    expect(input.capability.id).toBe('views.close'); expect(input.arguments.mode).toEqual({ kind: 'flush' });
    layout = { ...layout, version: layout.version + 1, layout: { kind: 'empty' } };
    return { operation: { client_request_id: input.client_request_id, capability: input.capability, operation_id: 'close' }, status: 'succeeded', outcome: 'succeeded', output: { ...record(input.arguments.view), closed: true } };
  });
  const client = { windowId: 'window', query, invoke } as unknown as HostClient;
  return { client, query, invoke, change: (value: PluginWindowLayout['layout']) => { layout = { ...layout, layout: value, version: layout.version + 1 }; } };
}
it('mounts new contributed views without replacing the existing document and retains hidden views', async () => {
  vi.useFakeTimers(); const f = fixture();
  await act(async () => { render(<PluginWorkspace client={f.client} project="/project" />); });
  const input = screen.getByLabelText('Draft one'); fireEvent.change(input, { target: { value: 'Unsaved 中文' } });
  f.change({ kind: 'tabs', id: 'main', views: ['one', 'two'], selected: 'two' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByLabelText('Draft one')).toBe(input); expect((input as HTMLInputElement).value).toBe('Unsaved 中文'); expect(screen.getByLabelText('Draft two').isConnected).toBe(true);
  f.change({ kind: 'tabs', id: 'main', views: ['two'], selected: 'two' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByLabelText('Draft one')).toBe(input); expect(mounted.starts).toEqual(['one', 'two']); expect(mounted.stops).toEqual([]);
});
it('disposes a frame only after the original close is confirmed and preserves its request across acknowledgement loss', async () => {
  const f = fixture(); f.invoke.mockRejectedValueOnce(new Error('Acknowledgement lost'));
  render(<PluginWorkspace client={f.client} project="/project" />);
  const input = await screen.findByLabelText('Draft one'); fireEvent.change(input, { target: { value: 'Retained draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close one', exact: true }));
  await screen.findByRole('button', { name: 'Retry original close', exact: true });
  expect(mounted.stops).toEqual([]); expect((input as HTMLInputElement).value).toBe('Retained draft');
  fireEvent.click(screen.getByRole('button', { name: 'Retry original close', exact: true }));
  await waitFor(() => expect(screen.queryByLabelText('Draft one')).toBeNull());
  expect(mounted.stops).toEqual(['one']); expect(f.invoke.mock.calls[0][1].client_request_id).toBe(f.invoke.mock.calls[1][1].client_request_id);
  expect(screen.getByText('No views are open in this window.').isConnected).toBe(true);
});

it('refreshes a committed scenario immediately while keeping the original live document', async () => {
  const f = fixture(); render(<PluginWorkspace client={f.client} project="/project" />);
  const input = await screen.findByLabelText('Draft one'); fireEvent.change(input, {target: {value: 'Current unsaved state'}});
  f.change({kind: 'tabs', id: 'next', views: ['two'], selected: 'two'});
  await act(async () => { await mounted.refreshers.get('one')!(); });
  expect(screen.getByLabelText('Draft two').isConnected).toBe(true);
  expect(screen.getByLabelText('Draft one')).toBe(input); expect((input as HTMLInputElement).value).toBe('Current unsaved state'); expect(mounted.stops).toEqual([]);
});
