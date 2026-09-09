import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ObjectViewer } from '../src/panels/resource-panels';
const { state } = vi.hoisted(() => ({ state: { inspectors: new Map(), registerDemand: vi.fn(), inspect: vi.fn(), metadata: vi.fn(), readPage: vi.fn(), viewValue: (_key: string, initial: unknown) => initial, setViewValue: vi.fn(), runtime: { state: 'busy' } } }));
vi.mock('../src/context', () => ({ useObjects: () => state, useSession: () => state, useNavigation: () => ({ openObject: vi.fn() }), useConsole: () => ({ run: vi.fn() }) }));
afterEach(() => { cleanup(); state.inspectors.clear(); vi.clearAllMocks(); });
it('renders hostile object text literally and keeps native queries disabled while busy', async () => {
  const text = '<img src=x onerror=alert(1)><script>column</script>';
  const metadata = { kind: 'value', object_type: 'character', classes: [], length: 2, dimensions: [], supported_reads: ['values', 'text'], attributes: [], notice: null };
  const page = { object_ref: 'ref', root_name: 'frame', observed_path: [], path: [], kind: 'values', metadata,
    values: [{ kind: 'value', object_type: 'character', text, logical: null, number: null, imaginary: null, label: null, text_characters: text.length, next_text_start: null }],
    columns: [], children: [], start: 1, next_start: 2, column_start: 1, next_column_start: null, observed_at_ms: 1, complete: false };
  state.metadata.mockReturnValue(metadata); state.readPage.mockResolvedValue(page);
  state.inspectors.set('frame', { binding: { name: 'frame' }, page, observedAt: 1, stale: false });
  const { container } = render(<ObjectViewer name="frame" />);
  await screen.findByText(text, { selector: 'pre' });
  expect(container.querySelector('img,script')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
  expect(state.inspect).not.toHaveBeenCalled();
  expect(screen.getByText(/Partial preview/)).toBeTruthy();
});
