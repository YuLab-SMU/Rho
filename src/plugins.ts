import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confined, readJson, requireThat, type PluginDescriptor, type Resource } from '@rho-workspace/plugin-contracts';
import type { Documents, documentLimits } from '@rho-workspace/plugin-documents';
import type { Files, fileLimits, DeclarationValidator } from '@rho-workspace/plugin-files';
import type { Tables, tableLimits } from '@rho-workspace/plugin-tables';
import type { Charts, chartLimits } from '@rho-workspace/plugin-charts';
import type { Media } from '@rho-workspace/plugin-media';
import { ownerContracts } from './contracts/owners.generated.js';
import { validateUiExtension, uiExtensionLimits, type InstalledUiEntry } from './ui-extension.js';
const executionInputSchema = ownerContracts.selected.execution.input as Record<string, unknown>;
import type { executionLimits, Objects } from '@rho-workspace/plugin-r';
import type { Annotations, annotationLimits } from '@rho-workspace/plugin-annotations';
import type { AgentContext } from '@rho-workspace/plugin-agent';

// A finite application selection, not a discovery service or an arbitrary code
// loader. Only these reviewed package names can be loaded by this application.
const entries = {
  documents: () => import('@rho-workspace/plugin-documents'),
  files: () => import('@rho-workspace/plugin-files'),
  r: () => import('@rho-workspace/plugin-r'),
  requirements: () => import('@rho-workspace/plugin-requirements'),
  tables: () => import('@rho-workspace/plugin-tables'),
  media: () => import('@rho-workspace/plugin-media'),
  charts: () => import('@rho-workspace/plugin-charts'),
  annotations: () => import('@rho-workspace/plugin-annotations'),
  agent: () => import('@rho-workspace/plugin-agent')
};
export type PluginId = keyof typeof entries;
export const selectedPluginVersions: Record<keyof typeof entries, string> = { documents: '0.4.3', files: '0.4.1', r: '0.4.1', requirements: '0.4.0', tables: '0.4.3', media: '0.4.0', charts: '0.4.0', annotations: '0.4.4', agent: '0.4.13' };
export const pluginIds = Object.keys(entries) as PluginId[];
type Modules = { [K in PluginId]: Awaited<ReturnType<typeof entries[K]>> };
export interface PluginConfig {
  plugins?: PluginId[];
  documents?: Partial<typeof documentLimits>;
  resources?: Partial<typeof fileLimits & typeof tableLimits & typeof chartLimits>;
  maxRetainedMetadataBytes?: number;
  r?: Partial<typeof executionLimits>;
  annotations?: Partial<typeof annotationLimits>;
  capabilityLimits?: { maxReceipts?: number };
  maxContexts?: number; maxBindings?: number; maxActivities?: number; maxContextBytes?: number;
}
const only = (defaults: object, values: object = {}) => Object.fromEntries(Object.entries(values).filter(([k, v]) => k in defaults && v !== undefined));
export class Plugins {
  installedUi: InstalledUiEntry[] = [];
  private modules: Partial<Modules> = {};
  private availability: any[] = [];
  constructor(public config: PluginConfig) {}
  installUi(entries: InstalledUiEntry[], methods: string[]) {
    const extensions = entries.filter(e => e.extension);
    requireThat(extensions.length <= uiExtensionLimits.maxEntries, 'limit', 'UI extension count exceeds maxEntries.', { maximum: uiExtensionLimits.maxEntries });
    const components = new Set(this.descriptors().flatMap(p => (p.components ?? []).map(c => c.id)));
    for (const entry of extensions) {
      const m = entry.extension!;
      validateUiExtension(m);
      requireThat(pluginIds.includes(m.plugin as PluginId) && !components.has(m.component), 'condition', 'UI extension must name an existing capability and a unique component.');
      requireThat(m.requiredOperations.every(method => methods.includes(method)), 'condition', 'UI extension requires an unknown operation.');
      components.add(m.component);
    }
    this.installedUi = entries;
  }
  async load() {
    const inventory = await readJson<{ plugins: any[] }>(fileURLToPath(new URL('./plugin-inventory.json', import.meta.url)));
    const selected = this.config.plugins ?? pluginIds;
    requireThat(Array.isArray(selected) && selected.every(id => pluginIds.includes(id)) && new Set(selected).size === selected.length, 'invalid', 'Select unique, known plugin IDs.');
    for (const id of pluginIds) {
      const status: any = {
        ...inventory.plugins.find(p => p.id === id),
        id,
        package: '@rho-workspace/plugin-' + id,
        selected: selected.includes(id),
        packagePresent: false,
        state: 'unavailable',
        reason: 'Plugin is not selected.'
      };
      try { await fs.stat(fileURLToPath(import.meta.resolve(status.package))); status.packagePresent = true; } catch {}
      if (status.selected) {
        try {
          const module = await entries[id]();
          requireThat(module.plugin.id === id && module.plugin.package === status.package && module.plugin.version === selectedPluginVersions[id], 'condition', 'Plugin identity/version does not match this application selection.');
          (this.modules as any)[id] = module;
          status.version = module.plugin.version;
          status.presentation = module.plugin.presentation;
          status.requires = [...module.plugin.requires];
          status.listing = {
            skills: module.plugin.skills.map(({ content, ...skill }) => skill),
          };
          status.packagePresent = true;
          status.state = 'available'; delete status.reason;
        } catch { status.reason = 'Selected plugin package is missing, incompatible or cannot be loaded.'; }
      }
      this.availability.push(status);
    }
    // Dependencies are selected services, not transitive installation side
    // effects. Removing a provider makes only its dependent entries unavailable.
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of pluginIds) {
        const module = this.modules[id];
        const missing = module?.plugin.requires.filter(dep => !this.modules[dep as PluginId]);
        if (missing?.length) {
          delete this.modules[id]; changed = true;
          Object.assign(this.availability.find(x => x.id === id), { state: 'unavailable', reason: 'Required plugins are unavailable.', missing });
        }
      }
    }
    return this;
  }
  optional<K extends PluginId>(id: K): Modules[K] | undefined { return this.modules[id] as Modules[K] | undefined; }
  ids() { return [...pluginIds]; }
  isKnown(id: string): id is PluginId { return pluginIds.includes(id as PluginId); }
  availabilityFor(id: PluginId) { return this.availability.find(entry => entry.id === id); }
  need<K extends PluginId>(id: K): Modules[K] {
    const module = this.optional(id);
    requireThat(module, 'unavailable', 'The selected plugin is unavailable; retained data and original requests are preserved.', { plugin: id, availability: this.availability.find(x => x.id === id) });
    return module;
  }
  get catalog() {
    const descriptors = Object.values(this.modules).map(m => m.plugin as PluginDescriptor);
    const declared = descriptors.flatMap(p => (p.actions ?? []).map(action => ({ ...action, pluginId: p.id })));
    const actions = declared.filter(a => (a.requires ?? []).every(id => this.modules[id as PluginId])).map(a => a.id === 'r.execute' ? { ...a, inputSchema: executionInputSchema } : a);
    const unavailableActions = declared.filter(a => !actions.some(b => b.id === a.id)).map(a => ({ ...a, state: 'unavailable', missing: a.requires.filter(id => !this.modules[id as PluginId]) }));
    return { version: '0.4.0', plugins: this.availability.map(p => ({
      ...p,
      packagePresent: p.packagePresent === true,
      dependenciesSatisfied: p.packagePresent === true && p.state === 'available' && !(p.missing?.length),
      uiRenderable: p.state === 'available' && this.installedUi.some(entry => entry.plugin === p.id && (entry.extension || entry.packageVersion === p.version))
    })), operations: this.operationDeclarations(), actions, unavailableActions, components: [...descriptors.flatMap(p => (p.components ?? []).map(component => ({ ...component, pluginId: p.id }))),
      ...this.installedUi.filter(e => e.extension && this.modules[e.plugin as PluginId]).map(e => ({ id: e.component, version: e.version, owner: e.package!, pluginId: e.plugin, ui: e.entrySha256!, bindings: e.extension!.bindings, propsSchema: e.extension!.propsSchema,
        presentation: { displayName: e.extension!.displayName, description: e.extension!.description }, uiPackage: e.package, uiPackageVersion: e.packageVersion }))], capabilities: [...descriptors.flatMap(p => p.capabilities), ...actions.flatMap(a => a.capabilities ?? [])], skills: descriptors.flatMap(p => p.skills ?? []), ...(this.modules.agent ? { agent: this.modules.agent.plugin.agent } : {}) };
  }
  viewAvailability(component: string, version: string) {
    const declared = this.catalog.components.find(c => c.id === component && c.version === version);
    if (!declared) return { state: 'unavailable', reason: 'Component or requested version is not registered.' };
    const installed = this.installedUi.some(entry => entry.component === component && entry.version === version && (entry.extension || entry.packageVersion === this.descriptor(declared.pluginId)?.version));
    return installed ? { state: 'entry-installed', visibility: 'unobserved' } : { state: 'unavailable', reason: 'UI entry is not installed in this browser build.' };
  }
  descriptors() { return Object.values(this.modules).map(m => m.plugin as PluginDescriptor); }
  availableIds() { return this.descriptors().map(p => p.id as PluginId); }
  descriptor(id: string) { return this.descriptors().find(p => p.id === id); }
  async nativeAvailability(rscript: string) {
    return Object.fromEntries(await Promise.all((['r', 'requirements'] as const).map(async id => [id, await this.modules[id]?.observeNativeAvailability(rscript)])));
  }
  operationOwner(method: string) {
    const descriptor = this.descriptors().find(p => p.operations?.some(o => o.method === method));
    if (descriptor) return descriptor.id as PluginId;
    const owner = method.startsWith('annotation.') ? 'annotations' : method.startsWith('document.') ? 'documents' : method.startsWith('requirements.') ? 'requirements' : method === 'action.submit' || method === 'object.read' ? 'r' : method === 'data.plot' ? 'charts' : method.startsWith('data.') || method === 'selection.set' ? 'tables' : method.startsWith('media.') ? 'media' : method.startsWith('feedback.') || method.startsWith('context.') || method.startsWith('binding.') || method === 'session.grant' ? 'agent' : method.startsWith('resource.') || method === 'artifact.check' || method === 'action.export' ? 'files' : undefined;
    return owner as PluginId | undefined;
  }
  operationDeclarations() { return this.descriptors().flatMap(p => (p.operations ?? []).map(operation => ({ ...operation, owner: p.id }))); }
  skillOwner(id: string) { return this.descriptors().find(p => p.skills?.some(skill => skill.id === id))?.id ?? 'agent'; }
  supports(method: string) {
    if (method === 'action.submit') return this.catalog.actions.some(a => a.id === 'r.execute');
    const owner = this.operationOwner(method);
    return !owner || !!this.modules[owner as PluginId];
  }
  validateComponentBindings(id: string, props: Record<string, unknown>, resources: Record<string, Resource>) {
    this.modules.charts?.validateComponentBindings(id, props, resources);
  }
  sourceFolders = new Map<string, import('./state.js').SourceFolder[]>();
  project(root: string, id: string) { return new ProjectPlugins(this, root, id); }
}
export class ProjectPlugins {
  documents?: Documents; files?: Files; tables?: Tables; charts?: Charts; media?: Media; objects?: Objects; agent?: AgentContext; annotations?: Annotations;
  constructor(public assembly: Plugins, public root: string, public projectId: string) {
    const c = assembly.config;
    const documents = assembly.optional('documents'), files = assembly.optional('files'), tables = assembly.optional('tables'), charts = assembly.optional('charts'), media = assembly.optional('media'), r = assembly.optional('r'), agent = assembly.optional('agent'), annotations = assembly.optional('annotations');
    const sources = assembly.sourceFolders.get(projectId), paths = sources?.length && files ? new files.ProjectPaths(root, sources) : undefined;
    if (documents) this.documents = new documents.Documents(root, c.documents, paths);
    if (files) {
      const validators: DeclarationValidator[] = [tables?.declarationValidator, media?.declarationValidator, r?.declarationValidator].filter((v): v is DeclarationValidator => !!v);
      this.files = new files.Files(root, projectId, only(files.fileLimits, c.resources), validators, paths);
    }
    if (tables && this.files) this.tables = new tables.Tables(this.files, only(tables.tableLimits, c.resources));
    if (charts && this.tables) this.charts = new charts.Charts(this.tables, only(charts.chartLimits, c.resources));
    if (media && this.files) this.media = new media.Media(this.files);
    if (r && this.files) this.objects = new r.Objects(this.files);
    if (annotations) this.annotations = new annotations.Annotations(root, this, c.annotations);
    if (agent) this.agent = new agent.AgentContext(root, projectId, this, only(agent.agentLimits, c));
  }
  need<K extends 'documents' | 'files' | 'tables' | 'charts' | 'media' | 'objects' | 'agent' | 'annotations'>(id: K): NonNullable<ProjectPlugins[K]> {
    const owner = this[id];
    requireThat(owner, 'unavailable', 'The capability plugin is unavailable; existing owner state is retained.', { plugin: id });
    return owner as NonNullable<ProjectPlugins[K]>;
  }
  // Bounded observations of persisted metadata when its provider is absent.
  // No write, parsing of native content, installation or runtime recovery occurs.
  async documentSummaries() {
    if (this.documents) return this.documents.summaries();
    return (await this.retainedDocuments()).map(({ id, path, version, revision, diskDigest, dirty, author, acknowledgedAt, content }) => ({ id, path, version, revision, diskDigest, dirty, author, acknowledgedAt, bytes: Buffer.byteLength(content) }));
  }
  async retainedDocuments() {
    if (this.documents) return this.documents.list();
    const dir = await confined(this.root, '.rho/plugins/documents', true);
    let names: string[];
    try { names = (await fs.readdir(dir)).filter(n => /^[a-f0-9]{64}\.json$/.test(n)); }
    catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
    const maximum = this.assembly.config.maxRetainedMetadataBytes ?? 32 * 1024 * 1024;
    const maxDocuments = this.assembly.config.documents?.maxDocuments ?? 64;
    requireThat(names.length <= maxDocuments, 'limit', 'Retained document metadata exceeds the observation limit.', { limit: 'maxDocuments', maximum: maxDocuments });
    let total = 0;
    return Promise.all(names.map(async n => {
      const file = await confined(this.root, '.rho/plugins/documents/' + n);
      total += (await fs.stat(file)).size;
      requireThat(total <= maximum, 'limit', 'Retained document metadata is too large; owner records are preserved.', { limit: 'maxRetainedMetadataBytes', maximum });
      return readJson<any>(file);
    }));
  }
  async retainedAnnotations() {
    if (this.annotations) return this.annotations.list();
    const file = await confined(this.root, '.rho/plugins/annotations/state.json', true);
    try { requireThat((await fs.stat(file)).size <= (this.assembly.config.annotations?.maxAnnotationBytes ?? 32 * 1024 * 1024), 'limit', 'Retained annotation metadata exceeds the byte budget.'); }
    catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
    return (await readJson<any[]>(file)).map(thread => ({ ...thread, sourceStatus: { state: 'owner-unavailable', snapshot: 'retained' } }));
  }
  async retainedResources(): Promise<Resource[]> {
    if (this.files) return this.files.list();
    const maximum = this.assembly.config.maxRetainedMetadataBytes ?? 32 * 1024 * 1024;
    const file = await confined(this.root, '.rho/plugins/resources.json', true);
    try { requireThat((await fs.stat(file)).size <= maximum, 'limit', 'Retained resource metadata is too large.', { limit: 'maxRetainedMetadataBytes', maximum }); }
    catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
    const resources = await readJson<Resource[]>(file);
    const maximumResources = this.assembly.config.resources?.maxResources ?? 1024;
    requireThat(resources.length <= maximumResources, 'limit', 'Retained resource metadata exceeds the observation count limit.', { limit: 'maxResources', maximum: maximumResources });
    return resources;
  }
}
