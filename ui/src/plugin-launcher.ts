import type { InstanceRef, PluginCatalogPage, PluginInspection, PluginInstanceObservation, PluginWindowLayout, OpenedPluginWindowView } from '../../sdk/plugin-protocol/index.js';
import type { ApplicationState } from '../../sdk/host-client/ApplicationState';
import type { Invocation } from '../../sdk/host-client/Invocation';
import type { OperationRecord } from '../../sdk/host-client/OperationRecord';
import { HostPortError, json, type HostClient } from './host-client';

export interface LaunchChoice { id: string; title: string; description: string; inspection: PluginInspection; artifact: string; contribution: string; }
interface Launch { choice: LaunchChoice; instance: InstanceRef | null; pending: Invocation | null; operation: string | null; }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const terminal = (record: OperationRecord) => ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status);
type Client = Pick<HostClient, 'windowId' | 'query' | 'invoke' | 'getOperation' | 'readState' | 'writeState'>;

/** Minimal startup/recovery entry, not a privileged plugin manager. Only
 * standalone UI contributions can start here; all management stays in plugins.
 * Persist each original request before dispatch and never auto-run on refresh. */
export class PluginLauncher {
  choices: LaunchChoice[] = [];
  saved: ApplicationState | null = null;
  launch: Launch | null = null;
  constructor(private client: Client, private project: string) {}
  private async read<T>(id: string, args: unknown): Promise<T> {
    const result = await this.client.query(this.project, id, json(args));
    if (result.status !== 'ready' || !result.data) throw Error(result.notices.join('\n') || 'The workspace observation is unavailable.');
    return result.data as unknown as T;
  }
  async load() {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.client.windowId));
    const key = 'plugin-launcher.' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    this.saved = await this.client.readState(this.project, key);
    this.launch = this.saved.value as unknown as Launch | null;
    const choices: LaunchChoice[] = []; let after: string | null = null;
    for (let count = 0; count < 10; count++) {
      const page: PluginCatalogPage = await this.read('plugins.list', { after, limit: 100 });
      for (const item of page.items) {
        const inspection = await this.read<PluginInspection>('plugins.inspect', { revision: item.revision });
        if (inspection.summary.revision !== item.revision || inspection.manifest.id !== item.plugin) throw Error('An installed view changed its package identity.');
        const manifest = inspection.manifest;
        if (manifest.backend || Object.keys(manifest.dependencies).length) continue;
        for (const view of manifest.views) {
          const schema = view.configuration_schema as { type?: string; required?: string[] };
          if (schema?.type !== 'object' || schema.required?.length) continue;
          for (const artifact of inspection.artifacts.filter(artifact => artifact.target === 'ui-web')) choices.push({
            id: `${item.revision}/${artifact.id}/${view.id}`, title: view.title, description: manifest.description,
            inspection, artifact: artifact.id, contribution: view.id,
          });
        }
      }
      after = page.next; if (!after) break;
    }
    if (after) throw Error('Too many installed revisions for the startup selector. Open an exact view through the recovery CLI.');
    this.choices = choices;
  }
  private async save(value: Launch | null) {
    if (!this.saved) throw Error('Read the saved startup request first.');
    // A lost state acknowledgement stops dispatch. Reload reads the accepted
    // version before any original request can be submitted.
    const state = await this.client.writeState(this.project, { ...this.saved, value: json(value) });
    if (state.key !== this.saved.key || !same(state.value, value)) throw Error('The saved startup request was not confirmed.');
    this.saved = state; this.launch = structuredClone(value);
  }
  async choose(id: string) {
    if (this.launch) throw Error('Continue or inspect the retained startup request first.');
    const choice = this.choices.find(choice => choice.id === id);
    if (!choice) throw Error('Select an installed workspace view.');
    await this.save({ choice: structuredClone(choice), instance: null, pending: null, operation: null });
    await this.continue();
  }
  async reset() {
    if (this.launch?.pending) throw Error('Inspect the original request before choosing another view.');
    // Setting aside the form does not release a created instance or erase its
    // original Operation; the ordinary plugin catalog remains authoritative.
    await this.save(null);
  }
  async continue() {
    if (!this.launch || this.launch.pending) throw Error('Inspect the original request before continuing.');
    const { choice } = this.launch;
    const current = await this.read<PluginInspection>('plugins.inspect', { revision: choice.inspection.summary.revision });
    if (!same(current.manifest, choice.inspection.manifest) || !current.artifacts.some(a => a.id === choice.artifact && a.target === 'ui-web'))
      throw Error('The selected workspace artifact is unavailable. Import its exact revision through the recovery CLI.');
    if (!this.launch.instance) await this.submit('plugins.activate', { revision: current.summary.revision, artifact: choice.artifact, target: 'ui-web',
      alias: 'workspace', configuration: current.manifest.default_configuration });
    const launch = this.launch!;
    const observed = await this.read<PluginInstanceObservation>('plugins.instance', { instance: launch.instance });
    if (!observed.observed_in_this_host || observed.instance.state !== 'active' || !same(observed.instance.identity, launch.instance))
      throw Error('The retained workspace instance is unavailable. Its original records remain available through the recovery CLI.');
    const layout = await this.read<PluginWindowLayout>('windows.layout', { window: this.client.windowId });
    if (layout.layout.kind !== 'empty') throw Error('This window already has a layout. Refresh it before opening another view.');
    await this.submit('windows.open_view', { expected_layout_version: layout.version, group: null,
      view: { instance: launch.instance, window: this.client.windowId, contribution: choice.contribution, configuration: {}, state: {} } });
  }
  private async submit(id: string, args: unknown) {
    await this.save({ ...this.launch!, operation: null, pending: { capability: { id, version: 1 }, client_request_id: crypto.randomUUID(), arguments: json(args), preconditions: [] } });
    await this.dispatch(true);
  }
  async dispatch(fresh = false) {
    const pending = this.launch?.pending;
    if (!pending) throw Error('There is no original startup request to retry.');
    let record: OperationRecord;
    try { record = await this.client.invoke(this.project, structuredClone(pending)); }
    catch (error) {
      if (fresh && error instanceof HostPortError && error.request.method === 'invoke' && same(error.request.params, pending) &&
        ['invalid_input', 'content_changed', 'not_found', 'access_denied'].includes(error.diagnostic.code))
        await this.save({ ...this.launch!, pending: null, operation: null });
      throw error;
    }
    await this.accept(await this.observe(record));
  }
  private verify(record: OperationRecord | null): OperationRecord {
    const launch = this.launch, pending = launch?.pending, operation = record?.operation;
    if (!pending || !record || !operation || operation.client_request_id !== pending.client_request_id ||
      !same(operation.capability, pending.capability) || !same(operation.normalized_arguments, pending.arguments) ||
      !same(operation.preconditions, []) || launch.operation && launch.operation !== operation.operation_id ||
      (terminal(record) ? record.outcome !== record.status : record.outcome !== null)) throw Error('The result does not match the original startup request.');
    return record;
  }
  private async observe(record: OperationRecord) {
    this.verify(record);
    await this.save({ ...this.launch!, operation: record.operation.operation_id });
    const deadline = Date.now() + 8000;
    while (!terminal(record) && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 200));
      record = this.verify(await this.client.getOperation(this.project, record.operation.operation_id));
    }
    return record;
  }
  async inspect() {
    if (!this.launch?.pending) throw Error('There is no retained request.');
    let operation = this.launch.operation;
    if (!operation) {
      const page = await this.read<{ operations: { operation_id: string }[] }>('operation.list_recent', { client_request_id: this.launch.pending.client_request_id, limit: 10 });
      if (page.operations.length !== 1) throw Error('No unique original request was found. Retain this request or retry it with the same identity.');
      operation = page.operations[0].operation_id;
    }
    await this.accept(await this.observe(this.verify(await this.client.getOperation(this.project, operation))));
  }
  private async accept(record: OperationRecord) {
    const launch = this.launch!;
    if (record.status !== 'succeeded' || record.outcome !== 'succeeded' || !record.output) {
      if (record.status === 'failed' || record.status === 'cancelled') await this.save({ ...launch, pending: null, operation: null });
      throw Error(record.error || `The original request is ${record.status}. Inspect it before continuing.`);
    }
    if (launch.pending!.capability.id === 'plugins.activate') {
      const output = record.output as unknown as PluginInstanceObservation, selected = launch.choice;
      if (!output.observed_in_this_host || output.instance.state !== 'active' || output.instance.identity.plugin !== selected.inspection.manifest.id ||
        output.instance.identity.revision !== selected.inspection.summary.revision || output.instance.identity.artifact !== selected.artifact)
        throw Error('The startup activation returned a different instance.');
      await this.save({ ...launch, pending: null, operation: null, instance: output.instance.identity });
    } else {
      const output = record.output as unknown as OpenedPluginWindowView;
      if (!same(output.view.instance, launch.instance) || output.view.window !== this.client.windowId || output.view.contribution !== launch.choice.contribution || output.view.closed)
        throw Error('The startup request opened a different view.');
      await this.save(null);
    }
  }
}
