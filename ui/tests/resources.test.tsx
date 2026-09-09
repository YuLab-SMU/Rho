import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ObjectViewer } from '../src/panels/resource-panels';
const { state } = vi.hoisted(() => ({ state: { inspectors: new Map(), registerDemand: vi.fn(), inspect: vi.fn(), metadata: vi.fn(), readPage: vi.fn(), viewValue: (_key: string, initial: unknown) => initial, setViewValue: vi.fn(), runtime: { state: 'idle' } } }));
vi.mock('../src/context', () => ({ useObjects: () => state, useSession: () => state, useNavigation: () => ({ openObject: vi.fn() }), useConsole: () => ({ run: vi.fn() }) }));
afterEach(() => { cleanup(); state.inspectors.clear(); vi.clearAllMocks(); state.runtime.state = 'idle'; });
it('renders hostile object text literally and keeps native queries disabled while busy', async () => {
  const text = '<img src=x onerror=alert(1)><script>column</script>';
  const metadata = { kind: 'value', object_type: 'character', classes: [], length: 2, dimensions: [], supported_reads: ['values', 'text'], attributes: [], notice: null };
  const page = { object_ref: 'ref', root_name: 'frame', observed_path: [], path: [], kind: 'values', metadata,
    values: [{ kind: 'value', object_type: 'character', text, logical: null, number: null, imaginary: null, label: null, text_characters: text.length, next_text_start: null }],
    columns: [], children: [], start: 1, next_start: 2, column_start: 1, next_column_start: null, observed_at_ms: 1, complete: false };
  state.metadata.mockReturnValue(metadata); state.readPage.mockResolvedValue(page);
  state.inspectors.set('frame', { binding: { name: 'frame' }, page, observedAt: 1, stale: false });
  const { container, rerender } = render(<ObjectViewer name="frame" />);
  expect(container.querySelector('.object-text-detail')).toBeNull();
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect value 1' }));
  await screen.findByText(text, { selector: 'pre' });
  expect(container.querySelector('img,script')).toBeNull();
  state.runtime.state = 'busy'; rerender(<ObjectViewer name="frame" />);
  await userEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
  expect(state.inspect).not.toHaveBeenCalled();
  expect(screen.getByText(/1–1 of 2 values/)).toBeTruthy();
});

it('defers a page opened while R is busy and resumes that same observation when idle', async () => {
  const metadata = { kind: 'value', object_type: 'character', classes: [], length: 1, dimensions: [], supported_reads: ['values', 'text'], attributes: [], notice: null };
  const value = { kind: 'value', object_type: 'character', text: 'resumed', logical: null, number: null, imaginary: null, label: null, text_characters: 7, next_text_start: null };
  const page = { object_ref: 'same-ref', root_name: 'frame', observed_path: [], path: [], kind: 'values', metadata, values: [value], columns: [], children: [], start: 1, next_start: null, column_start: 1, next_column_start: null, observed_at_ms: 1, complete: true };
  state.metadata.mockReturnValue(metadata); state.readPage.mockResolvedValue(page);
  state.inspectors.set('frame', { binding: { name: 'frame' }, page, observedAt: 1, stale: false });
  state.runtime.state = 'busy';
  const { rerender } = render(<ObjectViewer name="frame" />);
  expect(state.readPage).not.toHaveBeenCalled();
  state.runtime.state = 'idle'; rerender(<ObjectViewer name="frame" />);
  await screen.findByRole('button', { name: 'Inspect value 1' });
  expect(state.readPage).toHaveBeenCalledWith('frame', expect.objectContaining({ kind: 'values' }));
  expect(state.inspect).not.toHaveBeenCalled();
});
