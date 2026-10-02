import type { PluginViewRecord, PluginViewPresence, PluginInstanceObservation, ResumePlugin, ReconnectPluginView } from '../../sdk/plugin-protocol/index.js';
import type { ApplicationState } from '../../sdk/host-client/ApplicationState';
import type { Invocation } from '../../sdk/host-client/Invocation';
import type { OperationRecord } from '../../sdk/host-client/OperationRecord';
import { HostPortError, json, type HostClient } from './host-client';
import { Model, readonlyMap } from './shared/model';

type Client = Pick<HostClient, 'windowId' | 'query' | 'invoke' | 'getOperation' | 'readState' | 'writeState'>;
type Scope = Pick<PluginViewRecord, 'view' | 'window' | 'project' | 'principal' | 'instance' | 'contribution'>;
interface Intent { scope: Scope; pending: Invocation; operation: string | null; }
interface RecoveryState { busy: boolean; pending: boolean; error: string; message: string; }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const scope = (view: PluginViewRecord): Scope => ({ view: view.view, window: view.window, project: view.project, principal: view.principal,
  instance: view.instance, contribution: view.contribution });
const terminal = (record: OperationRecord) => ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status);

/** Explicit recovery of original identities. Each native request is retained
 * before dispatch. Reload/inspection never starts a provider or advances to the
 * next step; retry submits only the original request. No credentials are stored. */
export class PluginWindowRecovery extends Model<ReadonlyMap<string, Readonly<RecoveryState>>> {
  private entries = new Map<string, RecoveryState>();
  private states = new Map<string, ApplicationState>();
  private intents = new Map<string, Intent | null>();
  private work = new Map<string, Promise<boolean>>();
  private stopped = false;
  constructor(private client: Client, private project: string) { super(); }
  protected readSnapshot() { return readonlyMap(new Map([...this.entries].map(([id, value]) => [id, Object.freeze({ ...value })]))); }
  private alive() { if (this.stopped) throw Error('The window is closed.'); }
  private update(id: string, fields: Partial<RecoveryState>) {
    if (!this.stopped) { this.entries.set(id, { busy: false, pending: false, error: '', message: '', ...this.entries.get(id), ...fields }); this.publish(); }
  }
  private async read<T>(id: string, arguments_: unknown): Promise<T> {
    this.alive(); const result = await this.client.query(this.project, id, json(arguments_)); this.alive();
    if (result.status !== 'ready' || !result.data) throw Error(result.notices.join('\n') || 'The recovery observation is unavailable.');
    return result.data as unknown as T;
  }
  private validate(view: PluginViewRecord) {
    if (view.window !== this.client.windowId || view.closed || (view.purpose ?? 'runtime') !== 'runtime')
      throw Error('Only an open runtime view in this window can be restored.');
  }
  private async load(view: PluginViewRecord) {
    this.validate(view); this.alive();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.client.windowId}\0${view.view}`)); this.alive();
    const key = 'plugin-recovery.' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const saved = await this.client.readState(this.project, key); this.alive();
    if (saved.key !== key) throw Error('The saved recovery belongs to another window.');
    const intent = saved.value as unknown as Intent | null;
    if (intent !== null) {
      if (typeof intent !== 'object' || Array.isArray(intent)) throw Error('The saved recovery is invalid.');
      const pending = intent.pending;
      if (!same(intent.scope, scope(view)) || !pending || pending.capability?.version !== 1 || !same(pending.preconditions, []) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pending.client_request_id) ||
        intent.operation !== null && typeof intent.operation !== 'string') throw Error('The saved recovery changed its original identity.');
      const args = pending.arguments as unknown as ResumePlugin & ReconnectPluginView;
      if (pending.capability.id === 'plugins.resume') {
        if (!args || !same(args.instance, view.instance) || typeof args.suspension !== 'string' || !args.suspension ||
          !same(args, { instance: view.instance, suspension: args.suspension })) throw Error('The saved instance recovery is invalid.');
      } else if (pending.capability.id === 'views.reconnect') {
        if (!args || args.view !== view.view || !Number.isSafeInteger(args.expected_version) || args.expected_version < 0 || args.expected_version > 0xffffffff ||
          !same(args, { view: view.view, expected_version: args.expected_version })) throw Error('The saved view recovery is invalid.');
      } else throw Error('The saved request is not a view recovery action.');
    }
    this.states.set(view.view, saved); this.intents.set(view.view, structuredClone(intent));
    this.update(view.view, { pending: Boolean(intent) });
  }
  private async save(view: PluginViewRecord, intent: Intent | null) {
    this.alive(); const before = this.states.get(view.view);
    if (!before) throw Error('Read the original recovery state first.');
    const saved = await this.client.writeState(this.project, { ...before, value: json(intent) }); this.alive();
    if (saved.key !== before.key || !same(saved.value, intent)) throw Error('The original recovery request was not confirmed saved.');
    this.states.set(view.view, saved); this.intents.set(view.view, structuredClone(intent));
    this.update(view.view, { pending: Boolean(intent) });
  }
  private verify(view: PluginViewRecord, record: OperationRecord | null): OperationRecord {
    const intent = this.intents.get(view.view), pending = intent?.pending, operation = record?.operation;
    if (!intent || !pending || !record || !operation || !same(intent.scope, scope(view)) ||
      operation.client_request_id !== pending.client_request_id || !same(operation.capability, pending.capability) ||
      !same(operation.normalized_arguments, pending.arguments) || !same(operation.preconditions, []) ||
      intent.operation && intent.operation !== operation.operation_id ||
      (terminal(record) ? record.outcome !== record.status : record.outcome !== null))
      throw Error('The result does not match the original recovery request.');
    return record;
  }
  private async accept(view: PluginViewRecord, result: OperationRecord | null): Promise<boolean> {
    this.alive(); const record = this.verify(view, result), intent = this.intents.get(view.view)!;
    await this.save(view, { ...intent, operation: record.operation.operation_id });
    if (record.status !== 'succeeded' || record.outcome !== 'succeeded' || !record.output) {
      if (record.status === 'failed' || record.status === 'cancelled') await this.save(view, null);
      throw Error(record.error || `Recovery is ${record.status}. Check its original status before continuing.`);
    }
    const reconnected = intent.pending.capability.id === 'views.reconnect';
    if (reconnected) {
      const output = record.output as unknown as PluginViewRecord;
      this.validate(output);
      if (!same(scope(output), scope(view)) || output.state_version !== (intent.pending.arguments as unknown as ReconnectPluginView).expected_version)
        throw Error('The recovery returned a different view or saved version.');
    } else {
      const output = record.output as unknown as PluginInstanceObservation;
      if (!output.observed_in_this_host || output.instance.state !== 'active' || !same(output.instance.identity, view.instance) ||
        output.instance.project !== view.project || output.instance.principal !== view.principal)
        throw Error('The recovery returned a different instance.');
    }
    await this.save(view, null);
    this.update(view.view, { message: reconnected ? 'Saved view restored.' : 'Instance restored. Continue to reconnect this view.' });
    return reconnected;
  }
  private async dispatch(view: PluginViewRecord, fresh = false) {
    this.alive(); const intent = this.intents.get(view.view);
    if (!intent) throw Error('There is no original recovery request to retry.');
    let record: OperationRecord;
    try { record = await this.client.invoke(this.project, structuredClone(intent.pending)); }
    catch (error) {
      this.alive();
      if (fresh && error instanceof HostPortError && error.request.method === 'invoke' && same(error.request.params, intent.pending) &&
        ['invalid_input', 'content_changed', 'not_found', 'access_denied'].includes(error.diagnostic.code)) await this.save(view, null);
      throw error;
    }
    return this.accept(view, record);
  }
  private async submit(view: PluginViewRecord, id: 'plugins.resume' | 'views.reconnect', arguments_: ResumePlugin | ReconnectPluginView) {
    await this.save(view, { scope: scope(view), pending: { client_request_id: crypto.randomUUID(), capability: { id, version: 1 },
      arguments: json(arguments_), preconditions: [] }, operation: null });
    return this.dispatch(view, true);
  }
  private async inspect(view: PluginViewRecord) {
    const intent = this.intents.get(view.view)!;
    let operation = intent.operation;
    if (!operation) {
      const page = await this.read<{ operations: { operation_id: string }[]; next_cursor?: number | null }>('operation.list_recent',
        { client_request_id: intent.pending.client_request_id, limit: 10 });
      if (page.operations.length !== 1 || page.next_cursor != null)
        throw Error('No unique original recovery was found. Check again or retry the original request.');
      operation = page.operations[0].operation_id;
    }
    return this.accept(view, await this.client.getOperation(this.project, operation));
  }
  private run(view: PluginViewRecord, retry: boolean): Promise<boolean> {
    const previous = this.work.get(view.view); if (previous) return previous;
    if (this.stopped) return Promise.reject(Error('The window is closed.'));
    this.update(view.view, { busy: true, error: '', message: '' });
    const task = Promise.resolve().then(async () => {
      await this.load(view);
      if (this.intents.get(view.view)) return retry ? this.dispatch(view) : this.inspect(view);
      if (retry) throw Error('There is no original recovery request to retry.');
      const observation = await this.read<PluginInstanceObservation>('plugins.instance', { instance: view.instance });
      const instance = observation.instance;
      if (!same(instance.identity, view.instance) || instance.project !== view.project || instance.principal !== view.principal ||
        (instance.purpose ?? 'runtime') !== 'runtime') throw Error('The instance observation belongs to another view owner.');
      if (instance.state === 'suspended' && instance.suspension) {
        await this.submit(view, 'plugins.resume', { instance: view.instance, suspension: instance.suspension });
      } else if (!observation.observed_in_this_host || instance.state !== 'active') {
        throw Error('The original instance is unavailable. Only a confirmed Host suspension can be restored.');
      }
      this.alive();
      const current = await this.read<PluginViewRecord>('views.inspect', { view: view.view }); this.validate(current);
      if (!same(scope(current), scope(view))) throw Error('The retained view changed its original identity.');
      const presence = await this.read<PluginViewPresence>('views.presence', { view: view.view });
      if (presence.view !== view.view || presence.window !== view.window || !same(presence.instance, view.instance))
        throw Error('The view presence belongs to another identity.');
      if (presence.state === 'attached') return true;
      if (presence.state !== 'detached') throw Error('The original view is closing or closed.');
      return this.submit(current, 'views.reconnect', { view: view.view, expected_version: current.state_version });
    }).catch(error => { this.update(view.view, { error: error instanceof Error ? error.message : String(error) }); throw error; })
      .finally(() => { this.work.delete(view.view); this.update(view.view, { busy: false }); });
    this.work.set(view.view, task); return task;
  }
  restore(view: PluginViewRecord) { return this.run(view, false); }
  retryOriginal(view: PluginViewRecord) { return this.run(view, true); }
  stop() { this.stopped = true; this.dispose(); }
}
