import type { PluginViewRecord, PluginViewCloseMode } from '../../sdk/plugin-protocol/index.js';
import { Model, readonlyMap } from './shared/model';

export class ConfirmedCloseFailure extends Error {}
interface CloseState { request: string; busy: boolean; error: string; confirmedFailure: boolean; mode: PluginViewCloseMode }
/** One captured request per view. Lost acknowledgements retry that request;
 * only a confirmed rejection or terminal failure permits another attempt. */
export class PluginWindowClosures extends Model<ReadonlyMap<string, Readonly<CloseState>>> {
  private entries = new Map<string, CloseState>();
  private tasks = new Map<string, Promise<PluginViewRecord>>();
  private stopped = false;
  constructor(private submit: (view: string, request: string, mode: PluginViewCloseMode) => Promise<PluginViewRecord>) { super(); }
  protected readSnapshot() { return readonlyMap(new Map([...this.entries].map(([id, entry]) => [id, Object.freeze({ ...entry, mode: Object.freeze({ ...entry.mode }) })]))); }
  close(view: string, requestedMode?: PluginViewCloseMode): Promise<PluginViewRecord> {
    const before = this.entries.get(view);
    if (requestedMode && before && !before.confirmedFailure && (requestedMode.kind !== before.mode.kind ||
      requestedMode.kind === 'retain_acknowledged' && before.mode.kind === 'retain_acknowledged' && requestedMode.expected_version !== before.mode.expected_version))
      return Promise.reject(new Error('Resolve the original close before changing its saved-state choice.'));
    const prior = this.tasks.get(view); if (prior) return prior;
    if (this.stopped) return Promise.reject(new Error('The window is closed.'));
    const request = before && !before.confirmedFailure ? before.request : crypto.randomUUID();
    const mode: PluginViewCloseMode = Object.freeze(structuredClone(before && !before.confirmedFailure ? before.mode : requestedMode ?? { kind: "flush" as const }));
    this.entries.set(view, { request, mode, busy: true, error: '', confirmedFailure: false }); this.publish();
    const task = Promise.resolve().then(() => this.submit(view, request, structuredClone(mode))).then(record => {
      if (record.view !== view || !record.closed) throw new Error('The original view has not been confirmed closed.');
      if (!this.stopped) { this.entries.delete(view); this.publish(); }
      return record;
    }).catch(error => {
      if (!this.stopped) { this.entries.set(view, { request, mode, busy: false, error: error instanceof Error ? error.message : String(error), confirmedFailure: error instanceof ConfirmedCloseFailure }); this.publish(); }
      throw error;
    }).finally(() => this.tasks.delete(view));
    this.tasks.set(view, task); return task;
  }
  stop() { this.stopped = true; this.dispose(); }
}
