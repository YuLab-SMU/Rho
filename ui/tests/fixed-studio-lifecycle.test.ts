import { expect, it, vi } from 'vitest';
const observed = vi.hoisted(() => ({ client: vi.fn(() => ({})), created: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('../src/host-client', () => ({ HostClient: { fromLocation: observed.client } }));
vi.mock('../src/studio', () => ({ Studio: class {
  constructor(client: unknown) { observed.created(client); }
  start() { observed.start(); }
  stop() { observed.stop(); }
} }));

it('loading the default bundle constructs no fixed owner or second client; the reference shell starts explicitly', async () => {
  const { startStudio, stopStudio } = await import('../src/context');
  stopStudio(); expect(observed.client).not.toHaveBeenCalled(); expect(observed.created).not.toHaveBeenCalled();
  startStudio(); startStudio();
  expect(observed.created).toHaveBeenCalledTimes(1); expect(observed.client).toHaveBeenCalledTimes(1); expect(observed.start).toHaveBeenCalledTimes(2);
  stopStudio(); expect(observed.stop).toHaveBeenCalledTimes(1);
});
