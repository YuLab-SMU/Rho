import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, canonical, confined, digest, now, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import type { Project } from './state.js';
import type { Workspace } from './workspace.js';
export const presentationWitnessLimits = { maxRecords: 256, maxBytes: 4194304, maxConfigurations: 32 };
export const visibilityLimits = { maxRecords: 256, maxRecordBytes: 16384, maxBytes: 4194304, maxIndexEntries: 512, maxIndexBytes: 2097152 };
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v) + '\n');
const receiptFields = ({ changeId, requestDigest, author, version, at }: any) => ({ changeId, requestDigest, author, version, at });

// Application metadata only. All callers hold the existing project serializer
// and kernel writer lease. Tables/Files remain the data and identity owners.
export class Presentation {
  witnessLimits: typeof presentationWitnessLimits;
  limits: typeof visibilityLimits;
  constructor(public project: Project, public workspace: Workspace, witnessLimits = {}, limits = {}) {
    this.witnessLimits = { ...presentationWitnessLimits, ...witnessLimits };
    this.limits = { ...visibilityLimits, ...limits };
  }
  private async file(name: string) { await stateDirectory(this.project.root, '.rho/rho'); return confined(this.project.root, '.rho/rho/' + name + '.json', true); }
  private async load(name: string, maximum: number, fallback: any) {
    const file = await this.file(name);
    try { requireThat((await fs.stat(file)).size <= maximum, 'limit', name + ' exceeds its configured byte limit.'); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const state = await readJson<any>(file, fallback);
    requireThat(state?.format === 1, 'storage', 'Unsupported presentation state; preserve the original file.');
    return state;
  }
  private async save(name: string, state: any, maximum: number) {
    requireThat(bytes(state) <= maximum, 'limit', name + ' storage is full; keep composition and previous observations.');
    await atomicJson(await this.file(name), state);
  }
  async state() {
    const state = await this.load('presentation', this.witnessLimits.maxBytes, { format: 1, policy: null, intents: [] });
    requireThat(Array.isArray(state.intents) && Array.isArray(state.layoutWitnesses ?? []) && state.intents.length + (state.layoutWitnesses?.length ?? 0) <= this.witnessLimits.maxRecords, 'storage', 'Binding witnesses are unreadable or over their retention limit.');
    state.enhancements ??= [];
    requireThat(Array.isArray(state.enhancements) && state.enhancements.length + state.intents.length + (state.layoutWitnesses?.length ?? 0) <= this.witnessLimits.maxRecords, 'storage', 'Presentation intent retention is unreadable or full.');
    state.configurations ??= state.policy ? [state.policy] : [];
    requireThat(Array.isArray(state.configurations) && state.configurations.length <= this.witnessLimits.maxConfigurations && (!state.policy || state.configurations.some((p: any) => canonical(p) === canonical(state.policy))), 'storage', 'Presentation configuration history is unreadable; preserve its original selections.');
    return state;
  }
  async policyFor(ref: string) { return (await this.state()).configurations.find((p: any) => digest(canonical(p)) === ref) ?? null; }
  async retainedSource(ref: string, sourceEvent: any) { return (await this.state()).intents.some((i: any) => i.input.policyRef === ref && canonical(i.input.sourceEvent) === canonical(sourceEvent)); }
  async configure(policy: any, route: any) {
    requireThat(route && route.compositionId === policy.compositionId && route.policyRef === digest(canonical(policy)), 'condition', 'Presentation policy does not match the selected task route.');
    requireThat(policy.sourceViewId !== policy.candidateViewId, 'invalid', 'Source and candidate need distinct views.');
    const source = await this.workspace.owners.need('tables').page(policy.sourceResource, 0, 1);
    requireThat(source.entityKey === policy.comparison.entityKey && source.namespace === policy.comparison.namespace && canonical(policy.candidateDeclaration.format.key) === canonical({ column: source.entityKey, namespace: source.namespace }), 'condition', 'Comparison policy needs explicit matching source/candidate keys and namespaces.');
    const state = await this.state();
    const retained = state.configurations.find((p: any) => p.policyId === policy.policyId);
    requireThat(!retained || canonical(retained) === canonical(policy), 'conflict', 'Each policy ID is immutable; select a new configuration ID through conditional task routing.');
    if (!retained) {
      requireThat(state.configurations.length < this.witnessLimits.maxConfigurations, 'limit', 'Presentation maxConfigurations reached; preserve configurations, artifacts and layout.');
      state.configurations.push(policy);
    }
    if (!state.policy) {
      try {
        await fs.access(await this.file('visibility'));
        const retained = await this.observations();
        requireThat(retained.cursor === 0 && !retained.records.length && !Object.keys(retained.indexes).length, 'storage', 'Unpaired display history must be reconciled; never reset its first facts.');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        await this.save('visibility', { format: 1, cursor: 0, records: [], indexes: {} }, this.limits.maxBytes);
      }
    } else await this.observations();
    state.policy = policy;
    await this.save('presentation', state, this.witnessLimits.maxBytes);
    return { configurationId: policy.policyId, policyRef: route.policyRef };
  }
  async pending(input: any, error: any) {
    const state = await this.state();
    state.pending = { resource: input.resource, sourceEventId: input.eventId, reason: error.kind ?? 'storage', at: now() };
    await this.save('presentation', state, this.witnessLimits.maxBytes);
  }
  async ensureBasic(input: any, route: any) {
    const state = await this.state();
    const policy = state.configurations.find((p: any) => digest(canonical(p)) === input.policyRef);
    const { expectedVersion: ignoredVersion, ...identity } = input;
    const key = digest(canonical(identity));
    let intent = state.intents.find((x: any) => x.key === key);
    requireThat(policy && route.taskId === input.taskId && route.compositionId === policy.compositionId && policy.policyId === input.configurationId && (intent || route.policyRef === input.policyRef && canonical(state.policy) === canonical(policy)), 'scope', 'New presentation must use the selected policy; historical events may only recover their original transaction.');
    const source = await this.workspace.owners.need('tables').page(policy.sourceResource, 0, 1);
    const candidate = await this.workspace.owners.need('tables').page(input.candidate, 0, 1);
    requireThat(candidate.entityKey === policy.comparison.entityKey && source.entityKey === candidate.entityKey && source.namespace === policy.comparison.namespace && source.namespace === candidate.namespace, 'condition', 'Table comparison keys or namespaces changed.');
    let current = await this.workspace.read(route.compositionId).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
    if (!intent) {
      requireThat(state.intents.length + (state.layoutWitnesses?.length ?? 0) + state.enhancements.length < this.witnessLimits.maxRecords, 'limit', 'Binding witness maxRecords reached; artifact stays available.');
      const view = (id: string, resource: any, title: string) => ({ id, kind: 'view', component: policy.tableComponent.id, version: policy.tableComponent.version, props: { title }, bindings: { data: resource } });
      const nodes = [{ id: 'basic-root', kind: 'group', children: [policy.sourceViewId, policy.candidateViewId], presentation: policy.groupPresentation }, view(policy.sourceViewId, policy.sourceResource, 'Original'), view(policy.candidateViewId, input.candidate, 'Candidate')];
      // Do not replace an unrelated, edited or protected arrangement. Reconcile
      // placement explicitly instead of stealing a person's workspace.
      const basis = [...state.intents.flatMap((i: any) => i.witness ? [i.witness] : []), ...(state.layoutWitnesses ?? [])].findLast((w: any) => w.compositionId === route.compositionId && [policy.sourceViewId, policy.candidateViewId].every(id => {
        const old = w.views.find((v: any) => v.viewId === id), live = current?.views.find((v: any) => v.id === id);
        return old && live && live.component === policy.tableComponent.id && live.version === policy.tableComponent.version && canonical(live.bindings.data) === canonical(old.resource);
      }));
      requireThat(!current || basis && canonical(current.views.find((v: any) => v.id === policy.sourceViewId).bindings.data) === canonical(policy.sourceResource) || current.format === 'rho.composition/1' && current.rootId === 'basic-root' && current.nodes.length === 3 && canonical(current.nodes[0]) === canonical(nodes[0]) && current.views.every((v: any) => [policy.sourceViewId, policy.candidateViewId].includes(v.id)), 'condition', 'Artifact ready; this layout needs an explicit placement before automatic presentation.');
      const operations = basis ? [{ op: 'bind', id: policy.candidateViewId, bindings: { data: input.candidate } }] : [{ op: 'replace', rootId: 'basic-root', nodes }];
      const body = { compositionId: route.compositionId, expectedVersion: input.expectedVersion, changeId: 'basic:' + key, operations };
      intent = { key, input, body, witness: null };
      // Write the original conditional transaction before layout commit. A lost
      // reply retries exactly this body, never a newer layout/version.
      state.intents.push(intent);
      await this.save('presentation', state, this.witnessLimits.maxBytes);
    }
    const result = await this.workspace.apply(intent.body, 'rho:presentation');
    current = result;
    if (!intent.witness) {
      const snapshot = result.version === result.receipt.version ? result : result.history.find((h: any) => h.version === result.receipt.version)?.snapshot;
      if (!snapshot) return { compositionId: result.compositionId, commitVersion: result.receipt.version, currentVersion: result.version, receipt: receiptFields(result.receipt), witness: null, witnessState: 'expired', visibility: 'not-observed-by-this-write' };
      const witness = { projectId: this.project.id, taskId: route.taskId, compositionId: result.compositionId, compositionVersion: result.receipt.version, sourceEvent: intent.input.sourceEvent, policyRef: input.policyRef, views: snapshot.nodes.filter((n: any) => n.kind === 'view' && [policy.sourceViewId, policy.candidateViewId].includes(n.id)).map((v: any) => ({ viewId: v.id, component: v.component, componentVersion: v.version, resource: v.bindings.data })), dataValidation: { integrity: 'hash-verified', shape: 'typed-table-read', domain: 'not-judged' }, at: result.receipt.at };
      intent.witness = { witnessId: digest(canonical(witness)), ...witness };
      try { await this.save('presentation', state, this.witnessLimits.maxBytes); }
      catch (e) { return { compositionId: result.compositionId, commitVersion: result.receipt.version, currentVersion: result.version, receipt: receiptFields(result.receipt), witness: null, witnessState: 'pending', visibility: 'not-observed-by-this-write' }; }
    }
    if (state.pending && canonical(state.pending.resource) === canonical(input.candidate)) { state.pending = null; await this.save('presentation', state, this.witnessLimits.maxBytes); }
    return { compositionId: current.compositionId, commitVersion: result.receipt.version, currentVersion: current.version, receipt: receiptFields(result.receipt), witness: intent.witness, witnessState: 'retained', visibility: 'not-observed-by-this-write' };
  }
  async witnesses() { const state = await this.state(); return [...state.intents.flatMap((x: any) => x.witness ? [x.witness] : []), ...(state.layoutWitnesses ?? [])]; }
  async captureLayout(result: any, route: any) {
    const state = await this.state(), witnesses = await this.witnesses();
    if (!state.policy || route?.compositionId !== result.compositionId) return null;
    const retained = witnesses.find((w: any) => w.compositionVersion === result.version && w.compositionId === result.compositionId);
    if (retained) return retained;
    const basis = witnesses.findLast((w: any) => w.compositionId === result.compositionId && w.views.every((v: any) => result.views.some((n: any) => n.id === v.viewId && n.component === v.component && n.version === v.componentVersion && canonical(n.bindings.data) === canonical(v.resource))));
    if (!basis) return null;
    for (const view of basis.views) await this.workspace.owners.need('tables').page(view.resource, 0, 1);
    const { witnessId: ignoredId, ...metadata } = basis;
    const next = { ...metadata, compositionVersion: result.version, at: result.acknowledgedAt };
    const witness = { witnessId: digest(canonical(next)), ...next };
    requireThat(state.intents.length + (state.layoutWitnesses?.length ?? 0) + state.enhancements.length < this.witnessLimits.maxRecords, 'limit', 'Layout witness maxRecords reached; layout remains committed.');
    state.layoutWitnesses = [...(state.layoutWitnesses ?? []), witness];
    await this.save('presentation', state, this.witnessLimits.maxBytes);
    return witness;
  }
  async projection(input: any, route: any, principal: string) {
    const composition = await this.workspace.read(input.compositionId);
    const witness = (await this.witnesses()).findLast((w: any) => w.compositionId === composition.compositionId && w.compositionVersion === composition.version) ?? null;
    const visibility = await this.observations();
    const latest = visibility.records.findLast((r: any) => r.request.compositionId === input.compositionId && r.request.compositionVersion === composition.version && r.request.witnessId === witness?.witnessId);
    let ownerSummary = null;
    if (witness) {
      const resource = witness.views.at(-1).resource, page = await this.workspace.owners.need('tables').page(resource, 0, 1);
      ownerSummary = { resource, totalRows: page.total, entityKey: page.entityKey, namespace: page.namespace };
    }
    const complete = { taskVersion: route.version, presenterGeneration: route.presenter.generation, composition: { compositionId: composition.compositionId, version: composition.version }, basisWitness: witness, latestVisibility: latest ? { observationId: latest.request.observationId, compositionVersion: composition.version, evidence: latest.request.evidence, clientId: latest.request.clientId } : null, ownerSummary, next: null, complete: true, gap: !witness || !latest };
    const q = input.query, pin = digest(canonical([principal, complete, { ...input, query: { ...q, cursor: null } }]));
    let offset = q.after;
    if (q.cursor) { const [position, identity] = q.cursor.split(':'); requireThat(identity === pin, 'stale', 'Presentation snapshot, scope or query changed.'); offset = Number(position); }
    const fields = ['basisWitness', 'latestVisibility', 'ownerSummary'] as const;
    requireThat(Number.isSafeInteger(offset) && offset >= q.after && offset <= fields.length, 'invalid', 'Presentation page offset is invalid.');
    const result: any = { ...complete, basisWitness: null, latestVisibility: null, ownerSummary: null };
    let count = 0;
    for (const field of fields.slice(offset)) {
      const trial = { ...result, [field]: complete[field], next: (offset + count + 1) + ':' + pin, complete: false };
      if (count >= q.limit || bytes(trial) > q.maxBytes) break;
      result[field] = complete[field]; count++;
    }
    result.complete = offset + count === fields.length;
    if (!result.complete) result.next = (offset + count) + ':' + pin;
    requireThat(bytes(result) <= q.maxBytes && (count > 0 || result.complete), 'limit', 'One complete presentation object does not fit the selected page.', { requiredBytes: bytes({ ...result, [fields[offset]!]: complete[fields[offset]!], next: '0:' + pin, complete: false }) });
    return result;
  }
  async enhance(input: any, route: any, principal: string) {
    const state = await this.state();
    let intent = state.enhancements.find((i: any) => i.input.changeId === input.changeId);
    if (intent) requireThat(intent.author === principal && canonical(intent.input) === canonical(input), 'conflict', 'Enhancement changeId already names different content or author.');
    if (!intent) {
      const current = await this.workspace.read(input.compositionId);
      requireThat(route.presenter.generation === input.presenterGeneration && route.presenter.bindingId === input.presenterBindingId && current.version === input.expectedVersion, 'stale', 'Presenter assignment or composition advanced. Retain the original intent.');
      const witness = (await this.witnesses()).find((w: any) => w.witnessId === input.basisWitnessId);
      const observation = (await this.observations()).records.find((r: any) => r.request.observationId === input.basisObservationId);
      requireThat(witness?.compositionId === current.compositionId && witness.compositionVersion === current.version && witness.taskId === input.taskId && observation?.request.witnessId === witness.witnessId && observation.request.compositionVersion === current.version && observation.request.evidence === 'dom-visible', 'condition', 'Enhancement requires an exact current binding witness and real visible observation.');
      const nodes = structuredClone(current.nodes), target = nodes.find((n: any) => n.id === input.enhancement.emphasisViewId);
      requireThat(target?.kind === 'view' && !target.protected && witness.views.some((v: any) => v.viewId === target.id), 'scope', 'Enhance an unprotected view in the assigned binding witness.');
      target.presentation = { emphasis: 'highlight' };
      if (input.enhancement.title) target.props = { ...target.props, title: input.enhancement.title };
      if (input.enhancement.note) {
        const id = 'agent-note:' + input.presenterBindingId.slice(0, 24), old = nodes.find((n: any) => n.id === id);
        const props = { text: input.enhancement.note, label: 'Agent note', authorBindingId: input.presenterBindingId, basisWitnessId: witness.witnessId };
        requireThat(!old || old.component === 'rho.agent-note' && old.props.authorBindingId === input.presenterBindingId && !old.protected, 'conflict', 'The retained note identity belongs to another view or author.');
        if (old) old.props = props;
        else {
          const parent = nodes.find((n: any) => n.kind === 'group' && n.children.includes(target.id)), groupId = id + ':group';
          requireThat(parent && !nodes.some((n: any) => n.id === groupId), 'condition', 'The selected note needs an available placement.');
          parent.children = parent.children.map((child: string) => child === target.id ? groupId : child);
          nodes.push({ id: groupId, kind: 'group', children: [target.id, id], presentation: { mode: 'split', axis: 'vertical', weights: [3, 1] } }, { id, kind: 'view', component: 'rho.agent-note', version: '0.2.0', props, bindings: {} });
        }
      }
      requireThat(state.enhancements.length + state.intents.length + (state.layoutWitnesses?.length ?? 0) + state.enhancements.length < this.witnessLimits.maxRecords, 'limit', 'Presentation intent retention is full; existing layout and original identities remain.');
      intent = { input: structuredClone(input), author: principal, body: { compositionId: input.compositionId, expectedVersion: input.expectedVersion, changeId: input.changeId, operations: [{ op: 'replace', rootId: current.rootId, nodes }] } };
      state.enhancements.push(intent); await this.save('presentation', state, this.witnessLimits.maxBytes);
    }
    const result = await this.workspace.apply(intent.body, principal, 'apply', { authorBindingId: intent.input.presenterBindingId, basisWitnessId: intent.input.basisWitnessId });
    let witness = null, witnessState = 'pending';
    try { witness = (await this.witnesses()).find((w: any) => w.compositionId === result.compositionId && w.compositionVersion === result.receipt.version) ?? (result.version === result.receipt.version ? await this.captureLayout(result, route) : null); witnessState = witness ? 'retained' : 'expired'; } catch { /* committed layout and original transaction remain observable */ }
    return { compositionId: result.compositionId, commitVersion: result.receipt.version, currentVersion: result.version, receipt: receiptFields(result.receipt), witness, witnessState, visibility: 'not-observed-by-this-write' };
  }
  private async observations() {
    let state: any;
    try { state = await this.load('visibility', this.limits.maxBytes, null); }
    catch (e: any) { if (e.code === 'ENOENT') requireThat(false, 'storage', 'Configured visibility history is missing; never reset first observations.'); throw e; }
    requireThat(Array.isArray(state.records) && state.records.length <= this.limits.maxRecords && Number.isSafeInteger(state.cursor) && state.cursor >= 0 && state.indexes && typeof state.indexes === 'object', 'storage', 'Visibility history is unreadable; preserve it.');
    return state;
  }
  async observe(input: any, principal: string, route: any) {
    requireThat(input.clientId === principal && route?.taskId === input.taskId && route.compositionId === input.compositionId, 'scope', 'Renderer identity or task assignment does not match.');
    requireThat(bytes(input) <= this.limits.maxRecordBytes, 'limit', 'DOM observation exceeds maxRecordBytes.');
    const state = await this.observations(), requestDigest = digest(canonical(input));
    const old = state.records.find((r: any) => r.request.observationId === input.observationId);
    if (old) { requireThat(old.receipt.requestDigest === requestDigest, 'conflict', 'Observation identity names changed evidence.'); return old.receipt; }
    const witness = (await this.witnesses()).find((w: any) => w.witnessId === input.witnessId);
    const view = witness?.views.find((v: any) => v.viewId === input.viewId);
    requireThat(witness?.taskId === route.taskId && witness.compositionId === input.compositionId && witness.compositionVersion === input.compositionVersion && view, 'stale', 'Exact layout binding witness is unavailable.');
    const coverage = input.coverage;
    if (input.evidence === 'dom-visible') {
      requireThat(coverage?.kind === 'table-dom' && coverage.documentVisible && coverage.panelWithinViewport && coverage.keyCellsWithinViewport && coverage.visibleRows.length > 0 && canonical(coverage.resource) === canonical(view.resource), 'condition', 'Visible evidence needs exact, visible table cells.');
      const q = coverage.query;
      const page = await this.workspace.owners.need('tables').page(view.resource, q.offset, q.limit, q.sort ?? undefined, q.filter ?? undefined);
      requireThat(page.namespace === coverage.namespace && coverage.loadedRows >= coverage.visibleRows.length && coverage.loadedRows <= page.rows.length && new Set(coverage.visibleRows.map((r: any) => r.entityKey)).size === coverage.visibleRows.length, 'condition', 'Visible rows exceed the declared owner page or duplicate identities.');
      const values = coverage.visibleRows.map((r: any) => {
        const row = page.rows.find((v: any) => v[page.entityKey!] === r.entityKey);
        requireThat(row && r.columns.includes(page.entityKey) && new Set(r.columns).size === r.columns.length && r.columns.every((c: string) => page.columns.some(p => p.name === c)), 'condition', 'DOM evidence names rows or columns outside the exact table query.');
        return [r.entityKey, r.columns.map((c: string) => [c, row[c]])];
      });
      requireThat(coverage.rowValuesDigest === digest(canonical([view.resource, page.namespace, q, values])), 'condition', 'Visible typed values do not match their owner page.');
    } else requireThat(coverage === null, 'condition', 'Nonvisible observations carry no visible coverage.');
    const current = await this.workspace.read(input.compositionId);
    const historicalAtReceipt = current.version !== input.compositionVersion;
    const resourceKey = digest(canonical([route.taskId, input.compositionId, input.viewId, view.resource, principal]));
    const layoutKey = digest(canonical([resourceKey, input.compositionVersion]));
    const first = (key: string) => state.indexes[key]?.first ?? null;
    if (!historicalAtReceipt) {
      for (const key of [resourceKey, layoutKey]) state.indexes[key] = { first: first(key) ?? (input.evidence === 'dom-visible' ? input.observationId : null), latest: input.observationId };
    }
    requireThat(Object.keys(state.indexes).length <= this.limits.maxIndexEntries && bytes(state.indexes) <= this.limits.maxIndexBytes, 'limit', 'Visibility first/latest indexes are full; previous first observations are preserved.');
    const receipt = { observationId: input.observationId, requestDigest, serverReceivedAt: now(), cursor: ++state.cursor, historicalAtReceipt, firstResourceObservationId: first(resourceKey), firstLayoutObservationId: first(layoutKey) };
    requireThat(bytes({ request: input, receipt }) <= this.limits.maxRecordBytes, 'limit', 'Retained DOM observation exceeds maxRecordBytes.');
    requireThat(state.records.length < this.limits.maxRecords, 'limit', 'Visibility maxRecords reached; rendered output and previous receipts are kept.');
    state.records.push({ request: input, receipt });
    await this.save('visibility', state, this.limits.maxBytes);
    return receipt;
  }
  async read(input: any, principal: string) {
    const state = await this.observations(), q = input.query;
    const pin = digest(canonical([principal, { ...input, query: { ...q, cursor: null } }])).slice(0, 32);
    let after = q.after;
    if (q.cursor) {
      const [version, offset, scope] = q.cursor.split(':');
      requireThat(Number(version) === state.cursor && scope === pin, 'stale', 'Visibility cursor scope or snapshot changed.'); after = Number(offset);
    }
    requireThat(Number.isSafeInteger(after) && after >= q.after && after <= state.cursor, 'invalid', 'Visibility page offset is invalid.');
    const rows = state.records.filter((r: any) => r.receipt.cursor > after && r.request.taskId === input.taskId && r.request.compositionId === input.compositionId && r.request.viewId === input.viewId && r.request.clientId === input.clientId);
    const result: any = { observations: [], next: null, complete: true, retainedFromCursor: state.records[0]?.receipt.cursor ?? state.cursor + 1, gap: q.after < (state.records[0]?.receipt.cursor ?? 1) - 1 };
    for (const row of rows) {
      const next = state.cursor + ':' + row.receipt.cursor + ':' + pin;
      if (result.observations.length >= q.limit || bytes({ ...result, observations: [...result.observations, row], next, complete: false }) > q.maxBytes) break;
      result.observations.push(row);
    }
    requireThat(!rows.length || result.observations.length, 'limit', 'Complete DOM evidence exceeds maxBytes; increase the page budget.', { requiredBytes: rows[0] ? bytes({ ...result, observations: [rows[0]] }) + 128 : 0 });
    result.complete = result.observations.length === rows.length;
    if (!result.complete) result.next = state.cursor + ':' + result.observations.at(-1).receipt.cursor + ':' + pin;
    return result;
  }
}
