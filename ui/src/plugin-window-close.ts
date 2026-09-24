import type { PluginViewRecord } from '../../sdk/plugin-protocol/index.js';
import { Model, readonlyMap } from './shared/model';

export class ConfirmedCloseFailure extends Error {}
interface CloseState { request: string; busy: boolean; error: string; confirmedFailure: boolean }
/** One captured request per view. Lost acknowledgements retry that request;
 * only a verified terminal failure permits another close attempt. */
export class PluginWindowClosures extends Model<ReadonlyMap<string, Readonly<CloseState>>> {
  private entries = new Map<string, CloseState>();
  private tasks = new Map<string, Promise<PluginViewRecord>>();
  private stopped = false;
  constructor(private submit: (view: string, request: string) => Promise<PluginViewRecord>) { super(); }
  protected readSnapshot() { return readonlyMap(new Map([...this.entries].map(([id, entry]) => [id, Object.freeze({ ...entry })]))); }
  close(view: string): Promise<PluginViewRecord> {
    const prior = this.tasks.get(view); if (prior) return prior;
    if (this.stopped) return Promise.reject(new Error('The window is closed.'));
    const before = this.entries.get(view), request = before && !before.confirmedFailure ? before.request : crypto.randomUUID();
    this.entries.set(view, { request, busy: true, error: '', confirmedFailure: false }); this.publish();
    const task = Promise.resolve().then(() => this.submit(view, request)).then(record => {
      if (record.view !== view || !record.closed) throw new Error('The original view has not been confirmed closed.');
      if (!this.stopped) { this.entries.delete(view); this.publish(); }
      return record;
    }).catch(error => {
      if (!this.stopped) { this.entries.set(view, { request, busy: false, error: error instanceof Error ? error.message : String(error), confirmedFailure: error instanceof ConfirmedCloseFailure }); this.publish(); }
      throw error;
    }).finally(() => this.tasks.delete(view));
    this.tasks.set(view, task); return task;
  }
  stop() { this.stopped = true; this.dispose(); }
}
