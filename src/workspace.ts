import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Ajv } from 'ajv';
import { atomicBytes, atomicJson, canonical, components, confined, digest, Documents, now, readJson, requireThat, Resources, stateDirectory, type DocumentState, type Resource } from '@rho-workspace/headless';
import type { Project } from './state.js';
import { protocol } from './protocol.js';
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
const validateWorkspace = ajv.compile({ type: 'object', additionalProperties: false, required: ['schemaVersion', 'sourceProjectId', 'acknowledgedAt', 'documents', 'resources', 'compositions', 'selection'], properties: {
  schemaVersion: { const: 1 }, sourceProjectId: { type: 'string' }, acknowledgedAt: { type: 'string' },
  documents: { type: 'array', maxItems: 64, items: protocol.definitions.document },
  resources: { type: 'array', maxItems: 1024, items: { ...protocol.definitions.resource, properties: { ...protocol.definitions.resource.properties, format: { const: 'comparison' } } } },
  compositions: { type: 'array', maxItems: 32, items: protocol.definitions.composition },
  selection: { anyOf: [protocol.definitions.selection, { type: 'null' }] }
} });
export const workspaceLimits = { maxCompositions: 32, maxMetadataBytes: 32 * 1024 * 1024 };
export class Workspace {
  limits: typeof workspaceLimits;
  constructor(public project: Project, public documents = new Documents(project.root), public resources = new Resources(project.root, project.id), limits: Partial<typeof workspaceLimits> = {}) { this.limits = { ...workspaceLimits, ...limits }; }
  private async directory() { return stateDirectory(this.project.root, '.rho/rho/compositions'); }
  private async file(id: string) { return path.join(await this.directory(), digest(id) + '.json'); }
  async compositions() {
    const d = await this.directory();
    return Promise.all((await fs.readdir(d)).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => readJson<any>(path.join(d, f))));
  }
  async read(id: string) { return readJson<any>(await this.file(id)); }
  async put(body: any) {
    const file = await this.file(body.compositionId);
    const current = await readJson<any>(file, null);
    requireThat((current?.version ?? 0) === body.expectedVersion, 'stale', 'Composition version changed.', { actualVersion: current?.version ?? 0 });
    requireThat(new Set(body.views.map((v: any) => v.id)).size === body.views.length, 'invalid', 'View identities must be unique in a composition.');
    requireThat(current || (await this.compositions()).length < this.limits.maxCompositions, 'limit', 'Composition retention limit reached.', { limit: 'maxCompositions', maximum: this.limits.maxCompositions });
    const availability: Record<string, unknown> = {};
    for (const view of body.views) {
      const component = components.find(c => c.id === view.component && c.version === view.version);
      for (const [key, binding] of Object.entries<any>(view.bindings)) {
        if (binding.documentId) {
          await this.documents.snapshot(binding.documentId, binding.version);
          requireThat(!component || (component.bindings as any)[key] === 'document', 'invalid', 'Component binding expects a scientific resource.');
        } else {
          const resource = await this.resources.resolve(binding);
          requireThat(!component || (component.bindings as any)[key] === resource.kind, 'invalid', 'Resource kind does not match the registered component binding.', { component: view.component, binding: key, actualKind: resource.kind });
          if (view.selection?.length) {
            const data = await this.resources.rows(binding);
            requireThat(data.entityKey === 'gene_id' && view.selection.every((id: string) => data.rows.some(r => r.gene_id === id)), 'stale', 'View selection requires unique stable entities present in the bound resource.');
          }
        }
      }
      if (component) {
        const validate = ajv.compile(component.propsSchema);
        requireThat(validate(view.props), 'invalid', 'Component properties do not match the registered catalog.', { fields: validate.errors ?? [] });
        requireThat(Object.keys(component.bindings).every(k => k in view.bindings) && Object.keys(view.bindings).every(k => k in component.bindings), 'invalid', 'Component resource bindings do not match its registration.');
        if (component.id === 'rho.comparison') {
          const b = await this.resources.resolve(view.bindings.shrinkage);
          requireThat(canonical(b.provenance.baseline) === canonical(view.bindings.baseline), 'condition', 'Comparison view inputs do not share the selected baseline version.');
        }
      }
      availability[view.id] = { state: 'unavailable', reason: component ? 'UI entry is not installed in this headless composition.' : 'Component or requested version is not registered.' };
    }
    const result = { compositionId: body.compositionId, version: (current?.version ?? 0) + 1, views: body.views, layout: body.layout, availability, acknowledgedAt: now() };
    await atomicJson(file, result); return result;
  }
  async closeView(compositionId: string, viewId: string, expectedVersion: number) {
    const c = await this.read(compositionId);
    requireThat(c.version === expectedVersion, 'stale', 'Composition version changed.', { actualVersion: c.version });
    requireThat(c.views.some((v: any) => v.id === viewId), 'not_found', 'View is not present in this composition.');
    const result = { ...c, version: c.version + 1, views: c.views.filter((v: any) => v.id !== viewId), availability: { ...c.availability }, acknowledgedAt: now() };
    delete result.availability[viewId];
    await atomicJson(await this.file(compositionId), result); return result;
  }
  async save() {
    const workspace = { schemaVersion: 1, sourceProjectId: this.project.id, acknowledgedAt: now(), documents: await this.documents.list(), resources: (await this.resources.list()).map(({ storage, ...r }) => r), compositions: await this.compositions(), selection: await readJson(path.join(await stateDirectory(this.project.root, '.rho/rho'), 'selection.json'), null) };
    requireThat(Buffer.byteLength(JSON.stringify(workspace)) <= this.limits.maxMetadataBytes, 'limit', 'Workspace metadata exceeds the export byte budget; acknowledged owner state is retained.', { limit: 'maxMetadataBytes', maximum: this.limits.maxMetadataBytes });
    await atomicJson(path.join(await stateDirectory(this.project.root, '.rho/rho'), 'workspace.json'), workspace);
    return workspace;
  }
  async export(destination: string) {
    requireThat(!destination.split('/').some(p => ['.rho', '.git'].includes(p)), 'scope', 'Choose an export directory outside internal state.');
    const target = await confined(this.project.root, destination, true);
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true });
    await confined(this.project.root, path.relative(this.project.root, parent) || '.');
    await fs.mkdir(target, { mode: 0o700 }); // exclusive new directory is the write condition
    await fs.mkdir(path.join(target, 'artifacts'));
    const workspace = await this.save();
    const inventory: { path: string; bytes: number; sha256: string; resource?: string }[] = [];
    await atomicJson(path.join(target, 'workspace.json'), workspace);
    const wb = await fs.readFile(path.join(target, 'workspace.json'));
    inventory.push({ path: 'workspace.json', bytes: wb.length, sha256: digest(wb) });
    for (const resource of workspace.resources) {
      const { data } = await this.resources.bytes(resource);
      const relative = 'artifacts/' + resource.id + '-' + resource.version;
      await atomicBytes(path.join(target, relative), data);
      inventory.push({ path: relative, bytes: data.length, sha256: digest(data), resource: resource.id });
    }
    await atomicJson(path.join(target, 'manifest.json'), { schemaVersion: 1, complete: true, exportedAt: now(), sourceProjectId: this.project.id, inventory, scope: 'Acknowledged drafts, resource bytes/provenance, selections and composition intent. No native execution is replayed.' });
    return { destination, state: 'complete', files: inventory.length, writeCondition: 'new-directory', manifestDigest: digest(await fs.readFile(path.join(target, 'manifest.json'))) };
  }
  async restore(source: string, author: string) {
    requireThat(!source.split('/').some(p => ['.rho', '.git'].includes(p)), 'scope', 'Select an import outside internal owner state.');
    const directory = await confined(this.project.root, source);
    const manifestFile = await confined(directory, 'manifest.json');
    requireThat((await fs.stat(manifestFile)).size <= 1024 * 1024, 'limit', 'Export manifest exceeds byte limit.', { limit: 'maxRequestBytes' });
    const manifest = await readJson<any>(manifestFile);
    requireThat(manifest.schemaVersion === 1 && manifest.complete === true && Array.isArray(manifest.inventory) && manifest.inventory.length <= this.resources.limits.maxResources + 1, 'invalid', 'Unsupported or incomplete export manifest.');
    requireThat(manifest.inventory.every((f: any) => typeof f.path === 'string' && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && /^[a-f0-9]{64}$/.test(f.sha256) && (!f.resource || /^[a-f0-9]{64}$/.test(f.resource))) && new Set(manifest.inventory.map((f: any) => f.path)).size === manifest.inventory.length, 'invalid', 'Invalid or duplicate export inventory entries.');
    requireThat(manifest.inventory.filter((f: any) => f.path === 'workspace.json' && !f.resource).length === 1, 'condition', 'Workspace metadata must be covered by the verified manifest.');
    const missing = new Set<string>();
    let total = 0;
    for (const file of manifest.inventory) {
      const location = await confined(directory, file.path, true);
      let stat;
      try { stat = await fs.stat(location); } catch (e: any) { if (e.code !== 'ENOENT' || file.path === 'workspace.json') throw e; missing.add(file.path); continue; }
      total += stat.size;
      requireThat(stat.isFile() && stat.size <= (file.path === 'workspace.json' ? this.limits.maxMetadataBytes : this.resources.limits.maxFileBytes) && total <= this.resources.limits.maxArtifactBytes + this.limits.maxMetadataBytes, 'limit', 'Restore bytes exceed artifact budgets.', { limit: 'maxArtifactBytes' });
      const bytes = await fs.readFile(location);
      requireThat(bytes.length === file.bytes && digest(bytes) === file.sha256, 'condition', 'An exported file failed byte verification.', { file: file.path });
    }
    const workspace = await readJson<any>(await confined(directory, 'workspace.json'));
    requireThat(validateWorkspace(workspace), 'invalid', 'Workspace metadata does not match the versioned schemas.', { fields: validateWorkspace.errors ?? [] });
    const report: any = { sourceProjectId: workspace.sourceProjectId, documents: [], resources: [], compositions: [], execution: 'not-replayed' };
    for (const doc of workspace.documents as DocumentState[]) report.documents.push(await this.documents.restore(doc, author));
    for (const resource of workspace.resources as Resource[]) {
      const entry = manifest.inventory.find((f: any) => f.resource === resource.id && f.sha256 === resource.version);
      if (!entry || missing.has(entry.path)) { report.resources.push({ resource: { id: resource.id, version: resource.version }, state: 'missing' }); continue; }
      report.resources.push(await this.resources.restore(resource, await fs.readFile(await confined(directory, entry.path))));
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
          const table = await this.resources.rows(workspace.selection.resource);
          requireThat(table.entityKey === 'gene_id' && workspace.selection.entities.every((id: string) => table.rows.some(r => r.gene_id === id)), 'stale', 'Restored selection references absent entities.');
          await atomicJson(file, workspace.selection); report.selection = { state: 'available' };
        } catch { report.selection = { state: 'unavailable', reference: workspace.selection, reason: 'Referenced resource or entities are unavailable; intent is retained in this report.' }; }
      }
    }
    await atomicJson(path.join(await stateDirectory(this.project.root, '.rho/rho'), 'restore-report.json'), report);
    return report;
  }
}
