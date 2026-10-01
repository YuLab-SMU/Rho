import type { ComponentModelSettings, ComponentCredentialRef, ComponentCredentialStatus, ComponentModelDiagnostic, ComponentModelTestKind } from '../sdk/index.js';
import { type Client, type Intent, json, same, terminal, inspectOriginal, verifyOriginal } from './operations.js';

type KeyIntent = { view: string; instance: Client['view']['instance']; request: string } &
  ({ kind: 'store' } | { kind: 'remove'; settings_version: number; key_id: string });
interface Pending { intent: Intent; status: string | null; }
export interface ModelSettingsState {
  draft: ComponentModelSettings | null; key: KeyIntent | null; pending: Pending[]; tests: string[];
}
const capabilities = ['agent.model.configure', 'agent.model.test', 'agent.model.test.stop'];

/** Shares the view's CAS writer. Secrets are ephemeral Control arguments; saved
 * state contains only references and original requests. Reads never dispatch. */
export class ModelSettings {
  readonly state: ModelSettingsState;
  current: ComponentModelSettings | null = null;
  credential: ComponentCredentialStatus | null = null;
  diagnostics = new Map<string, ComponentModelDiagnostic>();
  busy = false;
  private refreshing = false;
  private stopped = false;
  constructor(private client: Client, owner: { settings?: ModelSettingsState }, private persist: () => Promise<unknown>, private changed = () => {}) {
    this.state = owner.settings ??= { draft: null, key: null, pending: [], tests: [] };
    const key = this.state.key;
    if (key && (key.view !== client.view.view || !same(key.instance, client.view.instance) || !['store', 'remove'].includes(key.kind)))
      throw Error('The retained key request belongs to another Agent view or instance.');
    for (const { intent } of this.state.pending) {
      const args = intent.arguments as unknown as { binding: unknown; preconditions: unknown };
      if (intent.view !== client.view.view || intent.capability.version !== 1 || !capabilities.includes(intent.capability.id) ||
        !same(args.binding, this.binding(intent.capability.id)) || args.preconditions !== null)
        throw Error('The retained settings request belongs to another Agent view or instance.');
    }
  }
  private live() { if (this.stopped) throw Error('The Agent view is closed. Original settings requests are retained.'); }
  private binding(id: string) { return { provider: this.client.view.instance, project: this.client.view.project, capability: { id, version: 1 }, target: null }; }
  private args(id: string, args: unknown) { return json({ binding: this.binding(id), arguments: args, preconditions: null }); }
  private async save() { this.live(); await this.persist(); this.live(); }
  private async read<T>(id: string, args: unknown): Promise<T> {
    this.live();
    const result = await this.client.query<{ status: string; completeness?: string; data?: T }>({ id, version: 1 }, this.args(id, args));
    this.live();
    if (result.status !== 'ready' || result.completeness !== 'complete' || !result.data) throw Error('The model settings observation is incomplete. Retain the original request.');
    return result.data;
  }
  private async exclusive<T>(work: () => Promise<T>) {
    this.live(); if (this.busy) throw Error('Wait for the current settings request.');
    this.busy = true; this.changed();
    try { return await work(); } finally { this.busy = false; if (!this.stopped) this.changed(); }
  }
  get locked() { return this.busy || !!this.state.key || this.state.pending.some(p => p.intent.capability.id === 'agent.model.configure'); }
  get dirty() { return !same(this.state.draft, this.current); }
  async edit(draft: ComponentModelSettings) {
    this.live(); if (this.locked) throw Error('Inspect the original settings request before editing.');
    this.state.draft = structuredClone(draft); await this.save(); this.changed();
  }
  async refresh() {
    if (this.busy || this.refreshing) return;
    this.refreshing = true;
    try {
      const current = await this.read<ComponentModelSettings>('agent.model.settings', {});
      const status = await this.read<ComponentCredentialStatus>('agent.model.key.status', { settings_version: current.version });
      if (!same(status.credential, current.connection?.credential ?? null)) throw Error('The key status belongs to different model settings.');
      if (this.busy || current.version < (this.current?.version ?? 0)) return;
      this.current = current; this.credential = status;
      if (!this.state.draft) { this.state.draft = structuredClone(current); await this.save(); }
      for (const pending of [...this.state.pending]) if (pending.intent.operation && pending.status !== 'uncertain')
        await this.accept(pending, await inspectOriginal(this.client, pending.intent));
      for (const request of this.state.tests) {
        const diagnostic = await this.read<ComponentModelDiagnostic>('agent.model.diagnostic', { request_id: request });
        if (diagnostic.request_id !== request) throw Error('The diagnostic belongs to another test.');
        this.diagnostics.set(request, diagnostic);
      }
    } finally { this.refreshing = false; if (!this.stopped) this.changed(); }
  }
  async useCurrent() {
    if (this.locked || !this.current) throw Error('Inspect pending settings requests first.');
    this.state.draft = structuredClone(this.current); await this.save(); this.changed();
  }
  async configure(secret = '') {
    return this.exclusive(async () => {
      if (this.state.key || this.state.pending.some(p => p.intent.capability.id === 'agent.model.configure')) throw Error('Inspect the original settings request first.');
      const draft = this.state.draft;
      if (!draft) throw Error('Read model settings first.');
      if (secret) {
        if (!draft.connection || draft.connection.credential.kind !== 'local_file') throw Error('Choose Saved API key before saving a key.');
        this.state.key = { kind: 'store', view: this.client.view.view, instance: structuredClone(this.client.view.instance), request: crypto.randomUUID() };
        await this.save(); await this.storeKey(secret);
      }
      await this.issue('agent.model.configure', structuredClone(this.state.draft));
    });
  }
  private async storeKey(secret: string) {
    const pending = this.state.key;
    if (!pending || pending.kind !== 'store' || !secret) throw Error('Re-enter the original key to retry its saved request.');
    const credential = await this.client.control<ComponentCredentialRef>({ id: 'agent.model.key.store', version: 1 },
      this.args('agent.model.key.store', { request_id: pending.request, value: secret }));
    this.live(); await this.acceptKey(credential, true);
  }
  private async acceptKey(credential: ComponentCredentialRef | null, available: boolean) {
    if (!credential || credential.kind !== 'local_file' || !credential.key_id || !this.state.draft?.connection)
      throw Error('The original saved key reference is incomplete.');
    this.state.draft.connection.credential = structuredClone(credential);
    this.state.key = null; await this.save();
    if (!available) throw Error('The original key was removed. Enter a new key before saving settings.');
  }
  async removeKey() {
    return this.exclusive(async () => {
      const current = this.current;
      if (this.state.key || this.dirty || !current || current.connection?.credential.kind !== 'local_file') throw Error('Save or reload the current settings before removing their key.');
      this.state.key = { kind: 'remove', view: this.client.view.view, instance: structuredClone(this.client.view.instance), request: crypto.randomUUID(),
        settings_version: current.version, key_id: current.connection.credential.key_id };
      await this.save(); await this.dispatchRemoval();
    });
  }
  private async dispatchRemoval() {
    const pending = this.state.key;
    if (pending?.kind !== 'remove') throw Error('No original key removal is pending.');
    const result = await this.client.control<ComponentCredentialStatus>({ id: 'agent.model.key.remove', version: 1 },
      this.args('agent.model.key.remove', { settings_version: pending.settings_version, key_id: pending.key_id }));
    this.live(); await this.acceptRemoval(result);
  }
  private async acceptRemoval(status: ComponentCredentialStatus) {
    const pending = this.state.key;
    if (pending?.kind !== 'remove' || !same(status.credential, { kind: 'local_file', key_id: pending.key_id }) || status.available)
      throw Error('The original key removal is not confirmed.');
    this.state.key = null; this.credential = status; await this.save();
  }
  async inspectKey() {
    return this.exclusive(async () => {
      const pending = this.state.key; if (!pending) throw Error('No original key request is pending.');
      if (pending.kind === 'store') {
        const result = await this.read<ComponentCredentialStatus>('agent.model.key.receipt', { request_id: pending.request });
        await this.acceptKey(result.credential, result.available);
      } else {
        const current = await this.read<ComponentModelSettings>('agent.model.settings', {});
        if (current.version !== pending.settings_version) {
          this.current = current; this.credential = null; this.state.key = null; await this.save();
          throw Error('Settings changed. The old removal can no longer change the current key. Read the current settings before continuing.');
        }
        await this.acceptRemoval(await this.read<ComponentCredentialStatus>('agent.model.key.status', { settings_version: pending.settings_version }));
      }
    });
  }
  async retryKey(secret = '') {
    return this.exclusive(async () => { await this.save(); if (this.state.key?.kind === 'store') await this.storeKey(secret); else await this.dispatchRemoval(); });
  }
  async test(kind: ComponentModelTestKind) {
    return this.exclusive(async () => {
      if (this.dirty || this.state.key || !this.current?.enabled || !this.credential?.available) throw Error('Save enabled model settings and an available key before testing.');
      if (this.state.pending.some(p => p.intent.capability.id === 'agent.model.test')) throw Error('Inspect the original model test first.');
      const request = crypto.randomUUID();
      await this.issue('agent.model.test', { request_id: request, model_settings_version: this.current.version, kind }, request);
    });
  }
  async stopTest(request: string) {
    return this.exclusive(async () => {
      const diagnostic = this.diagnostics.get(request);
      if (!diagnostic || !['queued', 'running'].includes(diagnostic.state) || this.state.pending.some(p => p.intent.capability.id === 'agent.model.test.stop'))
        throw Error('Read the original active diagnostic before requesting Stop.');
      await this.issue('agent.model.test.stop', { request_id: request, expected_version: diagnostic.version });
    });
  }
  private async issue(id: string, args: unknown, request = crypto.randomUUID()) {
    const pending: Pending = { status: null, intent: { view: this.client.view.view, request, capability: { id, version: 1 }, arguments: this.args(id, args), operation: null } };
    this.state.pending.push(pending); await this.save();
    await this.accept(pending, await this.client.invoke(pending.intent.capability, pending.intent.arguments, { requestId: request }));
  }
  async inspect(request: string) {
    return this.exclusive(async () => { const pending = this.original(request); await this.accept(pending, await inspectOriginal(this.client, pending.intent)); });
  }
  async retry(request: string) {
    return this.exclusive(async () => {
      const pending = this.original(request); if (pending.intent.operation) throw Error('Inspect the already accepted request.');
      await this.save(); await this.accept(pending, await this.client.invoke(pending.intent.capability, pending.intent.arguments, { requestId: request }));
    });
  }
  private original(request: string) { const pending = this.state.pending.find(p => p.intent.request === request); if (!pending) throw Error('The original request is no longer pending.'); return pending; }
  private async accept(pending: Pending, result: unknown) {
    const record = await verifyOriginal(result, pending.intent); this.live();
    if (!this.state.pending.includes(pending)) return;
    const changed = pending.status !== record.status || pending.intent.operation !== record.operation.operation_id;
    pending.status = record.status; pending.intent.operation = record.operation.operation_id;
    const id = pending.intent.capability.id, args = (pending.intent.arguments as unknown as { arguments: ComponentModelSettings & { request_id: string; model_settings_version: number; kind: ComponentModelTestKind } }).arguments;
    if (id === 'agent.model.test' && !['failed', 'cancelled'].includes(record.status))
      this.state.tests = [args.request_id, ...this.state.tests.filter(r => r !== args.request_id)].slice(0, 6);
    if (record.status === 'succeeded') {
      if (id === 'agent.model.configure') {
        const output = record.output as ComponentModelSettings;
        if (!output || !same(output, { ...args, version: args.version + 1 })) throw Error('The saved settings do not match the original request.');
        this.state.draft = structuredClone(output);
        if (!this.current || output.version >= this.current.version) this.current = structuredClone(output);
        this.credential = null;
      } else {
        const output = record.output as ComponentModelDiagnostic;
        if (output?.request_id !== args.request_id || id === 'agent.model.test' && (output.kind !== args.kind || output.model_settings_version !== args.model_settings_version))
          throw Error('The diagnostic result does not match the original request.');
        this.diagnostics.set(output.request_id, output);
      }
    }
    if (terminal(record.status) && record.status !== 'uncertain') this.state.pending = this.state.pending.filter(p => p !== pending);
    if (changed || terminal(record.status)) await this.save();
    if (record.status === 'failed' || record.status === 'cancelled') throw Error(record.error || 'The original settings request did not succeed.');
  }
  dispose() { this.stopped = true; }
}
