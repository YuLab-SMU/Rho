import { canonical, digest, requireThat } from '@rho-workspace/plugin-contracts';
import { Capabilities, rhoWorkspaceSkill } from './capabilities.js';
import { protocol } from './protocol.js';
import { schemaClosure } from './protocol-discovery.js';
import type { Principal, Project } from './state.js';
import type { Plugins } from './plugins.js';
const size = (v: any) => Buffer.byteLength(JSON.stringify(v)) + 64;
const applicationEffects: Record<string, string> = Object.fromEntries([
  ...['protocol.describe', 'protocol.validate', 'capability.list', 'skill.list', 'skill.read', 'action.lookup', 'action.observe', 'action.output', 'action.list', 'composition.read', 'observation.snapshot', 'interaction.selection.read', 'workspace.observe', 'task.map.read'].map(m => [m, 'read']),
  ...['composition.put', 'view.close', 'capability.configure', 'composition.apply', 'composition.undo', 'view.protection.set', 'interaction.selection.set', 'selection.set', 'workspace.enhance', 'task.map.declare', 'task.map.present', 'task.map.respond'].map(m => [m, 'metadata']),
  ...['workspace.save', 'workspace.export', 'workspace.restore'].map(m => [m, 'file']),
  ...['action.retry', 'action.cancel'].map(m => [m, 'native']),
]);
const metadata = new Set(['capability.index', 'capability.resolve', 'binding.activity.append', 'task.routing.put', 'feedback.submit', 'view.observe', 'view.observations.read']);
// A projection of the existing selected descriptors and public contracts. No
// second capability registry, persisted cache or invalidation daemon is created.
export class Discovery {
  constructor(public plugins: Plugins, public project: Project, public principal: Principal, public route: any, public bindings: any[]) {}
  role() { return this.principal.kind === 'browser' ? 'browser' : this.principal.profile === 'layered-presentation' ? 'presentation' : this.principal.methods.includes('binding.activity.append') ? 'adapter' : 'business'; }
  async snapshot() {
    const capabilities = new Capabilities(this.plugins, this.project), state = await capabilities.state(), role = this.role();
    const caller = this.bindings.find(b => b.principal === this.principal.id && b.attachment?.taskId === this.route?.taskId && b.attachment?.role === role);
    if (role === 'presentation') requireThat(caller && this.route?.presenter?.bindingId === caller.id, 'scope', 'Only the currently assigned presenter may observe its capability projection.');
    const authorizationRef = digest(canonical({ principal: this.principal.id, methods: [...this.principal.methods].sort(), profile: this.principal.profile ?? null, pluginFilter: this.principal.pluginFilter ?? null, project: this.project.id, configuration: state, route: this.route, callerBindingId: caller?.id ?? null }));
    const scopeHint = { projectId: this.project.id, taskId: this.route?.taskId ?? null, compositionId: this.route?.compositionId ?? null, callerBindingId: caller?.id ?? null };
    const objects = new Map<string, any>(), entries: any[] = [];
    const make = (kind: string, content: any) => { const ref = digest(canonical(content)); objects.set(ref, { ref, kind, content }); return ref; };
    for (const operation of await capabilities.operationStatus(this.principal, state)) {
      if (operation.method.startsWith('session.') || operation.method.startsWith('project.')) continue;
      if (!operation.authorized || operation.state !== 'available' || metadata.has(operation.method)) continue;
      if (role === 'presentation' && !['workspace.observe', 'workspace.enhance'].includes(operation.method)) continue;
      if (role !== 'presentation' && ['workspace.observe', 'workspace.enhance'].includes(operation.method)) continue;
      const owner = operation.owner ?? 'rho', descriptor = this.plugins.descriptor(owner);
      let skills = descriptor?.skills ?? [rhoWorkspaceSkill];
      if (role === 'presentation') skills = this.plugins.descriptor('agent')?.skills.filter(s => s.id === 'agent.presentation') ?? [];
      else if (owner === 'agent') skills = skills.filter(s => s.id === (operation.method.startsWith('feedback.') ? 'agent.feedback' : 'agent.workspace'));
      if (role !== 'presentation' && !skills.some(s => s.id === rhoWorkspaceSkill.id)) skills = [rhoWorkspaceSkill, ...skills];
      const skillRefs = skills.slice(0, 8).map(s => make('skill', { id: s.id, version: s.version, digest: s.digest, content: s.content, requires: s.requires, example: s.example, failureRecipes: s.failureRecipes }));
      const inputSchema = structuredClone(protocol.operations[operation.method]);
      delete inputSchema.properties.projectId; inputSchema.required = inputSchema.required.filter((k: string) => k !== 'projectId');
      if (operation.method === 'resource.read') inputSchema.properties.maxBytes = { ...inputSchema.properties.maxBytes, maximum: this.plugins.config.resources?.maxReadBytes ?? this.plugins.need('files').fileLimits.maxReadBytes };
      const outputSchema = structuredClone(protocol.responses[operation.method]), definitions = schemaClosure([inputSchema, outputSchema], protocol.definitions);
      const effect = operation.effect ?? applicationEffects[operation.method];
      requireThat(effect, 'condition', 'The selected application operation needs an explicit effect contract.');
      const content = { method: operation.method, owner, contractVersion: operation.version ?? '2.0', providerVersion: descriptor?.version ?? '0.4.0', consumer: 'layered-mcp', injectedFields: { projectId: 'authenticated private connection descriptor' }, inputSchema, outputSchema, definitions, requiredSkillRefs: skillRefs, effect, conditions: [protocol.descriptions[operation.method as keyof typeof protocol.descriptions] ?? operation.method] };
      const contractRef = make('contract', content);
      entries.push({ id: operation.method, owner, summary: Array.from(protocol.descriptions[operation.method as keyof typeof protocol.descriptions] ?? operation.method).slice(0, 240).join(''), contractRef, skillRefs });
    }
    const catalogRef = digest(canonical({ authorizationRef, scopeHint, entries }));
    return { catalogRef, authorizationRef, scopeHint, entries, objects };
  }
  async index(input: any) {
    requireThat(input.role === this.role(), 'scope', 'Requested role cannot expand the authenticated role.');
    const catalog = await this.snapshot(), q = input.query;
    const entries = catalog.entries.filter(e => (!q.owner || e.owner === q.owner) && (!q.search || (e.id + ' ' + e.summary).toLowerCase().includes(q.search.toLowerCase())));
    if (!q.owner && !q.search) {
      const groups = [...new Set<string>(entries.map(e => e.owner))].sort().map(owner => ({ owner, operations: entries.filter(e => e.owner === owner).length }));
      const result = { catalogRef: catalog.catalogRef, authorizationRef: catalog.authorizationRef, scopeHint: catalog.scopeHint, groups, entries: [], next: null, complete: true };
      requireThat(!q.cursor && q.after === 0, 'invalid', 'Owner discovery has no continuation. Select an owner.');
      requireThat(size(result) <= q.maxBytes, 'limit', 'Owner index exceeds this page budget.', { requiredBytes: size(result) });
      return result;
    }
    const pin = digest(canonical([catalog.catalogRef, { ...input, query: { ...q, cursor: null } }]));
    let offset = q.after;
    if (q.cursor) { const [position, identity] = q.cursor.split(':'); requireThat(identity === pin, 'stale', 'Catalog, authorization, scope or query changed.'); offset = Number(position); }
    requireThat(Number.isSafeInteger(offset) && offset >= q.after && offset <= entries.length, 'invalid', 'Catalog page position is invalid.');
    const result: any = { catalogRef: catalog.catalogRef, authorizationRef: catalog.authorizationRef, scopeHint: catalog.scopeHint, entries: [], next: null, complete: true };
    for (const entry of entries.slice(offset)) {
      const trial = { ...result, entries: [...result.entries, entry], next: (offset + result.entries.length + 1) + ':' + pin, complete: false };
      if (result.entries.length >= q.limit || size(trial) > q.maxBytes) break;
      result.entries.push(entry);
    }
    result.complete = offset + result.entries.length === entries.length;
    if (!result.complete) result.next = (offset + result.entries.length) + ':' + pin;
    requireThat(size(result) <= q.maxBytes && (result.complete || result.entries.length), 'limit', 'A complete catalog entry does not fit this page.', { requiredBytes: size({ ...result, entries: entries.slice(offset, offset + 1) }) });
    return result;
  }
  async resolve(input: any) {
    const catalog = await this.snapshot();
    requireThat(input.catalogRef === catalog.catalogRef, 'stale', 'Catalog or authorization changed. Read the current small index; immutable available bodies can still be reused.');
    const selected = [...new Set<string>(input.selected)], references: string[] = [];
    for (const id of selected) {
      const entry = catalog.entries.find(e => e.id === id); requireThat(entry, 'scope', 'Selected operation is not currently available to this role.');
      for (const ref of [...entry.skillRefs, entry.contractRef]) if (!references.includes(ref)) references.push(ref);
    }
    const known = new Set(input.knownRefs), omittedKnownRefs = references.filter(ref => known.has(ref)), remaining = references.filter(ref => !known.has(ref));
    const bundleRef = digest(canonical([catalog.catalogRef, selected, references])), pin = digest(canonical([this.principal.id, bundleRef, input.knownRefs, input.maxBytes]));
    let offset = 0;
    if (input.cursor) { const [position, identity] = input.cursor.split(':'); requireThat(identity === pin, 'stale', 'Resolved bundle, authorization or query changed.'); offset = Number(position); }
    requireThat(Number.isSafeInteger(offset) && offset >= 0 && offset <= remaining.length, 'invalid', 'Resolved page position is invalid.');
    const result: any = { bundleRef, items: [], omittedKnownRefs, next: null, complete: true, requiredBytes: null };
    for (const ref of remaining.slice(offset)) {
      const item = catalog.objects.get(ref), trial = { ...result, items: [...result.items, item], next: (offset + result.items.length + 1) + ':' + pin, complete: false };
      if (result.items.length >= 32 || size(trial) > input.maxBytes) break;
      result.items.push(item);
    }
    result.complete = offset + result.items.length === remaining.length;
    if (!result.complete) {
      result.next = (offset + result.items.length) + ':' + pin;
      if (!result.items.length) {
        result.requiredBytes = size({ ...result, items: [catalog.objects.get(remaining[offset]!)], next: (offset + 1) + ':' + pin });
        requireThat(result.requiredBytes <= 65536, 'limit', 'One complete contract exceeds the selected 64 KiB profile. Preserve it; execution is unavailable.', { requiredBytes: result.requiredBytes });
      }
    }
    requireThat(size(result) <= input.maxBytes, 'limit', 'Resolved page metadata exceeds maxBytes.');
    return result;
  }
  async assertContract(method: string, ref: string) {
    const entry = (await this.snapshot()).entries.find(e => e.id === method);
    requireThat(entry && entry.contractRef === ref, 'stale', 'Selected contract or authorization changed. Resolve the currently available complete contract before execution.');
  }
}
