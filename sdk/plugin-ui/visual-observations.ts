import type { VisualRuntimeOptions } from './visual-runtime.js';
import type { ResourceReader } from './resources.js';
/** Explicit polling adapter for snapshot capabilities, not a native event stream.
 * Each subscription captures its exact capability/arguments, never resolves a
 * replacement provider, and starts after the interval (the renderer reads once
 * at mount). All subscriptions from this adapter share eight in-flight reads. */
export function createPollingVisualSubscription(reader: ResourceReader, options: { intervalMs?: number } = {}): NonNullable<VisualRuntimeOptions['subscribe']> {
  const interval = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000) throw Error('Observation interval must be between 100 and 60000 ms.');
  interface Job { stopped: boolean; timer?: ReturnType<typeof setTimeout>; run(): Promise<void>; }
  const queued: Job[] = []; let active = 0;
  const schedule = (job: Job) => { if (!job.stopped) job.timer = setTimeout(() => { queued.push(job); drain(); }, interval); };
  const drain = () => {
    while (active < 8 && queued.length) {
      const job = queued.shift()!; if (job.stopped) continue; active++;
      void job.run().finally(() => { active--; schedule(job); drain(); });
    }
  };
  return (source, receive, fail) => {
    const captured = structuredClone(source);
    const job: Job = { stopped: false, run: async () => {
      try {
        if (job.stopped) return;
        const value = await reader.query(structuredClone(captured.capability), structuredClone(captured.arguments));
        if (!job.stopped) receive(value as Parameters<typeof receive>[0]);
      } catch (error) { if (!job.stopped) { try { fail(error); } catch { /* Observer failure cannot keep its read slot. */ } } }
    } };
    schedule(job);
    return () => { job.stopped = true; clearTimeout(job.timer); const index = queued.indexOf(job); if (index >= 0) queued.splice(index, 1); };
  };
}
