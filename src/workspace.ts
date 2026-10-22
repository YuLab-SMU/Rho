import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Ajv } from 'ajv';
import { atomicBytes, atomicJson, canonical, confined, digest, now, readJson, requireThat, stateDirectory, type Resource } from '@rho-workspace/plugin-contracts';
import type { ProjectPlugins } from './plugins.js';
import type { DocumentState } from '@rho-workspace/plugin-documents';
import type { Project } from './state.js';
import { protocol } from './protocol.js';
import { Capabilities } from './capabilities.js';
import { Interactions, interactionLimits } from './interactions.js';
import { Compositions, compositionLimits } from './composition.js';
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
const workspaceSchema = { type: 'object', additionalProperties: false, required: ['schemaVersion', 'sourceProjectId', 'acknowledgedAt', 'documents', 'resources', 'compositions', 'selection'], properties: {
  schemaVersion: { enum: [1, 2] }, sourceProjectId: { type: 'string' }, acknowledgedAt: { type: 'string' },
  documents: { type: 'array', maxItems: 64, items: protocol.definitions.document },
  resources: { type: 'array', maxItems: 1024, items: protocol.definitions.resource },
  compositions: { type: 'array', maxItems: 32, items: protocol.definitions.composition },
  selection: { anyOf: [protocol.definitions.selection, { type: 'null' }] }
} };
const validateWorkspace = ajv.compile<any>(workspaceSchema);
const validateWorkspace3 = ajv.compile<any>({ ...workspaceSchema, properties: { ...workspaceSchema.properties, schemaVersion: { const: 3 }, compositions: { type: 'array', maxItems: 32, items: protocol.responses['composition.read'] }, capabilities: { type: 'object' }, interactions: { type: 'array', maxItems: 128 }, annotations: { type: 'array', maxItems: 128 }, contexts: { type: 'array', maxItems: 128 } }, required: [...workspaceSchema.required, 'capabilities', 'interactions', 'annotations', 'contexts'] });
export const workspaceLimits = { ...compositionLimits, maxCompositions: 32, maxMetadataBytes: 32 * 1024 * 1024 };
export class Workspace {
  limits: typeof workspaceLimits;
  constructor(public project: Project, public owners: ProjectPlugins, limits: Partial<typeof workspaceLimits> = {}, public interactions: Partial<typeof interactionLimits> = {}) { this.limits = { ...workspaceLimits, ...limits }; }
  private async directory() { return stateDirectory(this.project.root, '.rho/rho/compositions'); }
  private async file(id: string) { return path.join(await this.directory(), digest(id) + '.json'); }
  async compositions() {
    const d = await this.directory();
    return Promise.all((await fs.readdir(d)).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => readJson<any>(path.join(d, f))));
  }
  async read(id: string) { return readJson<any>(await this.file(id)); }
  structured(trustedPresentation?: { authorBindingId: string; basisWitnessId: string }, retainedNotes: any[] = []) { return new Compositions(this.project, (views, retained) => this.validateViews(views, retained, trustedPresentation, retainedNotes), this.limits); }
  async apply(body: any, author: string, kind: 'apply' | 'undo' | 'protect' = 'apply', trustedPresentation?: { authorBindingId: string; basisWitnessId: string }) {
    // Existing receipt must remain readable even at the composition count limit.
    const current = await readJson<any>(await this.file(body.compositionId), null);
    requireThat(current || (await this.compositions()).length < this.limits.maxCompositions, 'limit', 'Composition retention limit reached.');
    const retainedNotes = kind === 'undo' ? (current?.history ?? []).flatMap((h: any) => h.snapshot.nodes.filter((n: any) => n.kind === 'view' && n.component === 'rho.agent-note')) : [];
    return this.structured(trustedPresentation, retainedNotes).transact(body, author, kind);
  }
  async validateViews(views: any[], retained: any[] = [], trustedPresentation?: { authorBindingId: string; basisWitnessId: string }, retainedNotes: any[] = []) {
    const availability: Record<string, unknown> = {};
    for (const view of views) {
      if (view.component === 'rho.agent-note' && ![...retained, ...retainedNotes].some(v => v.id === view.id && v.component === view.component && canonical(v.props) === canonical(view.props) && canonical(v.bindings) === canonical(view.bindings))) requireThat(trustedPresentation && view.props.authorBindingId === trustedPresentation.authorBindingId && view.props.basisWitnessId === trustedPresentation.basisWitnessId, 'scope', 'Agent note authorship and basis are written only by the assigned presentation path.');
      const component = this.owners.assembly.catalog.components.find(c => c.id === view.component && c.version === view.version);
      const boundResources: Record<string, Resource> = {};
      for (const [key, binding] of Object.entries<any>(view.bindings)) {
        const retainedBinding = retained.some(v => v.id === view.id && canonical(v.bindings?.[key]) === canonical(binding));
        if (binding.documentId) {
          if (!retainedBinding) {
            if (binding.kind === 'live-document') await this.owners.need('documents').read(binding.documentId);
            else await this.owners.need('documents').snapshot(binding.documentId, binding.version);
          }
          requireThat(binding.kind !== 'live-document' || retainedBinding || !!component, 'invalid', 'Live document bindings require a registered document component.');
          requireThat(!component || (component.bindings as any)[key] === 'document', 'invalid', 'Component binding expects a scientific resource.');
        } else {
          if (!this.owners.files && retainedBinding) continue;
          this.owners.need('files');
          const resource = await this.owners.need('files').resolve(binding);
          boundResources[key] = resource;
          requireThat(!component || (component.bindings as any)[key] === resource.kind, 'invalid', 'Resource kind does not match the registered component binding.', { component: view.component, binding: key, actualKind: resource.kind });
          if (component && view.selection?.length) {
            const data = await this.owners.need('tables').rows(binding);
            requireThat(data.entityKey && view.selection.every((id: string) => data.rows.some(r => r[data.entityKey!] === id)), 'stale', 'View selection requires unique stable entities present in the bound resource.');
          }
        }
      }
      if (component) {
        const validate = ajv.compile(component.propsSchema);
        requireThat(validate(view.props), 'invalid', 'Component properties do not match the registered catalog.', { fields: validate.errors ?? [] });
        requireThat(Object.keys(component.bindings).every(k => k in view.bindings) && Object.keys(view.bindings).every(k => k in component.bindings), 'invalid', 'Component resource bindings do not match its registration.');
        this.owners.assembly.validateComponentBindings(component.id, view.props, boundResources);
      }
      availability[view.id] = { state: 'unavailable', reason: component ? 'UI entry is not installed in this headless composition.' : 'Component or requested version is not registered.' };
    }
    return availability;
  }
  async put(body: any) {
    const file = await this.file(body.compositionId);
    const current = await readJson<any>(file, null);
    requireThat((current?.version ?? 0) === body.expectedVersion, 'stale', 'Composition version changed.', { actualVersion: current?.version ?? 0 });
    requireThat(new Set(body.views.map((v: any) => v.id)).size === body.views.length, 'invalid', 'View identities must be unique in a composition.');
    requireThat(current || (await this.compositions()).length < this.limits.maxCompositions, 'limit', 'Composition retention limit reached.', { limit: 'maxCompositions', maximum: this.limits.maxCompositions });
    requireThat(current?.format !== 'rho.composition/1', 'condition', 'Structured compositions require composition.apply; legacy put cannot bypass protection.');
    const availability = await this.validateViews(body.views, current?.views ?? []);
    const result = { compositionId: body.compositionId, version: (current?.version ?? 0) + 1, views: body.views, layout: body.layout, availability, acknowledgedAt: now() };
    await atomicJson(file, result); return result;
  }
  async closeView(compositionId: string, viewId: string, expectedVersion: number, changeId?: string, author = 'operator') {
    const c = await this.read(compositionId);
    if (c.format === 'rho.composition/1') return this.structured().transact({ compositionId, expectedVersion, changeId, operations: [{ op: 'remove', id: viewId }] }, author);
    requireThat(c.version === expectedVersion, 'stale', 'Composition version changed.', { actualVersion: c.version });
    requireThat(c.views.some((v: any) => v.id === viewId), 'not_found', 'View is not present in this composition.');
    const result = { ...c, version: c.version + 1, views: c.views.filter((v: any) => v.id !== viewId), availability: { ...c.availability }, acknowledgedAt: now() };
    delete result.availability[viewId];
    await atomicJson(await this.file(compositionId), result); return result;
  }
  async collaborationState() {
    const directory = await stateDirectory(this.project.root, '.rho/rho');
    const capabilityFile = await readJson<any>(path.join(directory, 'capabilities.json'), null);
    const annotations = (await this.owners.retainedAnnotations()).map(({ sourceStatus, ...thread }: any) => thread);
    const contextDir = await confined(this.project.root, '.rho/rho/contexts', true);
    const names = await fs.readdir(contextDir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    requireThat(names.length <= (this.owners.assembly.config.maxContexts ?? 128), 'limit', 'Context retention budget exceeded.');
    let bytes = 0;
    const contexts = [];
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const file = await confined(contextDir, name);
      bytes += (await fs.stat(file)).size;
      requireThat(bytes <= this.limits.maxMetadataBytes, 'limit', 'Context export byte budget exceeded.');
      contexts.push({ contextId: name.slice(0, -5), context: await readJson(file) });
    }
    return { capabilities: capabilityFile ?? await new Capabilities(this.owners.assembly, this.project).state(), interactions: await new Interactions(this.project, this.owners).list('', true), annotations, contexts, configured: !!capabilityFile };
  }
  async save(format = 2) {
    requireThat([1, 2, 3].includes(format), 'invalid', 'Select archive format 1, 2 or 3.');
    const collaboration = await this.collaborationState();
    const compositions = await this.compositions();
    requireThat(format === 3 || !(collaboration.configured || collaboration.interactions.length || collaboration.annotations.length || collaboration.contexts.length || compositions.some(c => c.format)), 'condition', 'Archive format 3 is required to preserve collaboration state; older formats would be lossy.');
    const workspace = { ...(format === 3 ? { capabilities: collaboration.capabilities, interactions: collaboration.interactions, annotations: collaboration.annotations, contexts: collaboration.contexts } : {}), schemaVersion: format, sourceProjectId: this.project.id, acknowledgedAt: now(), documents: await this.owners.retainedDocuments(), resources: (await this.owners.retainedResources()).map(({ storage, ...r }) => r), compositions: await this.compositions(), selection: await readJson(path.join(await stateDirectory(this.project.root, '.rho/rho'), 'selection.json'), null) };
    requireThat(Buffer.byteLength(JSON.stringify(workspace)) <= this.limits.maxMetadataBytes, 'limit', 'Workspace metadata exceeds the export byte budget; acknowledged owner state is retained.', { limit: 'maxMetadataBytes', maximum: this.limits.maxMetadataBytes });
    await atomicJson(path.join(await stateDirectory(this.project.root, '.rho/rho'), 'workspace.json'), workspace);
    return workspace;
  }
  async export(destination: string, format = 2) {
    const workspace = await this.save(format);
    this.owners.need('files');
    requireThat(!destination.split('/').some(p => ['.rho', '.git'].includes(p)), 'scope', 'Choose an export directory outside internal state.');
    const target = await confined(this.project.root, destination, true);
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true });
    await confined(this.project.root, path.relative(this.project.root, parent) || '.');
    await fs.mkdir(target, { mode: 0o700 }); // exclusive new directory is the write condition
    await fs.mkdir(path.join(target, 'artifacts'));
    const inventory: { path: string; bytes: number; sha256: string; resource?: string }[] = [];
    await atomicJson(path.join(target, 'workspace.json'), workspace);
    const wb = await fs.readFile(path.join(target, 'workspace.json'));
    inventory.push({ path: 'workspace.json', bytes: wb.length, sha256: digest(wb) });
    for (const resource of workspace.resources) {
      const { data } = await this.owners.need('files').bytes(resource);
      const relative = 'artifacts/' + resource.id + '-' + resource.version;
      await atomicBytes(path.join(target, relative), data);
      inventory.push({ path: relative, bytes: data.length, sha256: digest(data), resource: resource.id });
    }
    await atomicJson(path.join(target, 'manifest.json'), { schemaVersion: format, complete: true, exportedAt: now(), sourceProjectId: this.project.id, inventory, scope: 'Acknowledged drafts, resource bytes/provenance, selections and composition intent. No native execution is replayed.' });
    return { destination, state: 'complete', files: inventory.length, writeCondition: 'new-directory', manifestDigest: digest(await fs.readFile(path.join(target, 'manifest.json'))) };
  }
  async restore(source: string, author: string) {
    // Verify the archive before applying imports; absent owners retain their
    // recoverable source content and are reported instead of installed.
    const fileLimits = this.owners.files?.limits ?? { maxResources: 1024, maxFileBytes: 64 * 1024 * 1024, maxArtifactBytes: 512 * 1024 * 1024 };
    requireThat(!source.split('/').some(p => ['.rho', '.git'].includes(p)), 'scope', 'Select an import outside internal owner state.');
    const directory = await confined(this.project.root, source);
    const manifestFile = await confined(directory, 'manifest.json');
    requireThat((await fs.stat(manifestFile)).size <= 1024 * 1024, 'limit', 'Export manifest exceeds byte limit.', { limit: 'maxRequestBytes' });
    const manifest = await readJson<any>(manifestFile);
    requireThat([1, 2, 3].includes(manifest.schemaVersion) && manifest.complete === true && Array.isArray(manifest.inventory) && manifest.inventory.length <= fileLimits.maxResources + 1, 'invalid', 'Unsupported or incomplete export manifest.');
    requireThat(manifest.inventory.every((f: any) => typeof f.path === 'string' && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && /^[a-f0-9]{64}$/.test(f.sha256) && (!f.resource || /^[a-f0-9]{64}$/.test(f.resource))) && new Set(manifest.inventory.map((f: any) => f.path)).size === manifest.inventory.length, 'invalid', 'Invalid or duplicate export inventory entries.');
    requireThat(manifest.inventory.filter((f: any) => f.path === 'workspace.json' && !f.resource).length === 1, 'condition', 'Workspace metadata must be covered by the verified manifest.');
    const missing = new Set<string>();
    let total = 0;
    for (const file of manifest.inventory) {
      const location = await confined(directory, file.path, true);
      let stat;
      try { stat = await fs.stat(location); } catch (e: any) { if (e.code !== 'ENOENT' || file.path === 'workspace.json') throw e; missing.add(file.path); continue; }
      total += stat.size;
      requireThat(stat.isFile() && stat.size <= (file.path === 'workspace.json' ? this.limits.maxMetadataBytes : fileLimits.maxFileBytes) && total <= fileLimits.maxArtifactBytes + this.limits.maxMetadataBytes, 'limit', 'Restore bytes exceed artifact budgets.', { limit: 'maxArtifactBytes' });
      const bytes = await fs.readFile(location);
      requireThat(bytes.length === file.bytes && digest(bytes) === file.sha256, 'condition', 'An exported file failed byte verification.', { file: file.path });
    }
    const workspace = await readJson<any>(await confined(directory, 'workspace.json'));
    const validate = manifest.schemaVersion === 3 ? validateWorkspace3 : validateWorkspace;
    requireThat(workspace.schemaVersion === manifest.schemaVersion && validate(workspace), 'invalid', 'Workspace metadata does not match the versioned schemas.', { fields: validate.errors ?? [] });
    if (workspace.schemaVersion === 3) {
      const imported = workspace.capabilities;
      requireThat(imported?.schemaVersion === 1 && Number.isSafeInteger(imported.version) && imported.version >= 0 && Array.isArray(imported.enabled) && new Set(imported.enabled).size === imported.enabled.length && imported.enabled.every((id: string) => this.owners.assembly.isKnown(id)) && Array.isArray(imported.receipts) && imported.receipts.length <= new Capabilities(this.owners.assembly, this.project).limits.maxReceipts, 'invalid', 'Invalid archived capability state.');
      for (const c of workspace.compositions) if (c.format) {
        this.structured().validate(c);
        requireThat(c.history.length <= this.limits.maxUndo && c.receipts.length <= this.limits.maxReceipts, 'limit', 'Archived composition history exceeds configured retention.');
        for (const history of c.history) this.structured().validate({ ...history.snapshot, format: c.format });
      }
      await this.owners.annotations?.prepareRestore(workspace.annotations);
      await new Interactions(this.project, this.owners, this.interactions).prepareRestore(workspace.interactions);
      requireThat(new Set(workspace.contexts.map((item: any) => item?.contextId)).size === workspace.contexts.length, 'invalid', 'Archived contexts must have unique identities.');
      for (const item of workspace.contexts) requireThat(/^[a-f0-9]{64}$/.test(item?.contextId) && item.context && typeof item.context.principal === 'string' && typeof item.context.projectId === 'string' && ['not-fetched', 'tool-fetched'].includes(item.context.delivery) && Buffer.byteLength(JSON.stringify(item.context)) <= (this.owners.assembly.config.maxContextBytes ?? 1024 * 1024), 'invalid', 'Invalid archived context.');
    }
    const report: any = { sourceProjectId: workspace.sourceProjectId, documents: [], resources: [], compositions: [], execution: 'not-replayed', retainedArchive: source };
    for (const doc of workspace.documents as DocumentState[]) report.documents.push(this.owners.documents ? await this.owners.documents.restore(doc, author) : { documentId: doc.id, state: 'unavailable', owner: 'documents' });
    for (const resource of workspace.resources as Resource[]) {
      const entry = manifest.inventory.find((f: any) => f.resource === resource.id && f.sha256 === resource.version);
      if (!entry || missing.has(entry.path)) { report.resources.push({ resource: { id: resource.id, version: resource.version }, state: 'missing' }); continue; }
      report.resources.push(this.owners.files ? await this.owners.files.restore(resource, await fs.readFile(await confined(directory, entry.path))) : { resource: { id: resource.id, version: resource.version }, state: 'unavailable', owner: 'files' });
    }
    for (const composition of workspace.compositions) {
      const current = await readJson<any>(await this.file(composition.compositionId), null);
      if (current && canonical(current) !== canonical(composition)) { report.compositions.push({ compositionId: composition.compositionId, state: 'conflict' }); continue; }
      requireThat(current || (await this.compositions()).length < this.limits.maxCompositions, 'limit', 'Composition retention limit reached during restore.', { limit: 'maxCompositions' });
      // Restore references even if a UI entry is missing. Reading or restoring
      // this intent never submits scientific work.
      const availability = Object.fromEntries(composition.views.map((v: any) => [v.id, { state: 'unavailable', reason: 'UI entry requires independent installation and browser acceptance.' }]));
      await atomicJson(await this.file(composition.compositionId), { ...composition, availability });
      report.compositions.push({ compositionId: composition.compositionId, state: 'unavailable', views: composition.views.length });
    }
    if (workspace.selection) {
      const file = path.join(await stateDirectory(this.project.root, '.rho/rho'), 'selection.json');
      const current = await readJson<any>(file, null);
      if (current && canonical(current) !== canonical(workspace.selection)) report.selection = { state: 'conflict' };
      else {
        try {
          const table = await this.owners.need('tables').rows(workspace.selection.resource);
          requireThat(table.entityKey && workspace.selection.entities.every((id: string) => table.rows.some(r => r[table.entityKey!] === id)), 'stale', 'Restored selection references absent entities.');
          await atomicJson(file, workspace.selection); report.selection = { state: 'available' };
        } catch { report.selection = { state: 'unavailable', reference: workspace.selection, reason: 'Referenced resource or entities are unavailable; intent is retained in this report.' }; }
      }
    }
    if (workspace.schemaVersion === 3) {
      const directory = await stateDirectory(this.project.root, '.rho/rho');
      const imported = workspace.capabilities;
      requireThat(imported.schemaVersion === 1 && Number.isSafeInteger(imported.version) && Array.isArray(imported.enabled) && new Set(imported.enabled).size === imported.enabled.length && imported.enabled.every((id: string) => this.owners.assembly.isKnown(id)), 'invalid', 'Invalid archived capability selection.');
      const existing = await readJson<any>(path.join(directory, 'capabilities.json'), null);
      report.capabilities = { state: existing && canonical(existing) !== canonical(imported) ? 'conflict' : 'available', missing: imported.enabled.filter((id: string) => !this.owners.assembly.descriptor(id)) };
      if (report.capabilities.state === 'available') await atomicJson(path.join(directory, 'capabilities.json'), imported);
      // Importing selection never imports credentials, grants, bindings or tasks.
      // Private caller selections are deliberately absent from format 3.
      const selections = await new Interactions(this.project, this.owners, this.interactions).prepareRestore(workspace.interactions);
      report.interactions = selections.report;
      await atomicJson(path.join(directory, 'interactions.json'), selections.state);
      report.annotations = this.owners.annotations ? await this.owners.annotations.restore(workspace.annotations) : workspace.annotations.map((t: any) => ({ annotationId: t.annotationId, state: 'unavailable', owner: 'annotations' }));
      report.contexts = [];
      const contextDir = await stateDirectory(this.project.root, '.rho/rho/contexts');
      for (const item of workspace.contexts) {
        requireThat(/^[a-f0-9]{64}$/.test(item.contextId) && item.context && Buffer.byteLength(JSON.stringify(item.context)) <= (this.owners.assembly.config.maxContextBytes ?? 1024 * 1024), 'invalid', 'Invalid archived context.');
        const file = path.join(contextDir, item.contextId + '.json'), old = await readJson<any>(file, null);
        const state = !this.owners.agent ? 'unavailable' : old && canonical(old) !== canonical(item.context) ? 'conflict' : 'available';
        if (state === 'available' && !old) {
          requireThat((await fs.readdir(contextDir)).length < (this.owners.assembly.config.maxContexts ?? 128), 'limit', 'Context restore retention limit reached.');
          await atomicJson(file, item.context);
        }
        report.contexts.push({ contextId: item.contextId, state });
      }
    }
    await atomicJson(path.join(await stateDirectory(this.project.root, '.rho/rho'), 'restore-report.json'), report);
    return report;
  }
}
