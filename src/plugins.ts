import * as fs from 'node:fs/promises';
import path from 'node:path';
import { confined, readJson, requireThat, type PluginDescriptor, type Resource } from '@rho-workspace/plugin-contracts';
import type { Documents, documentLimits } from '@rho-workspace/plugin-documents';
import type { Files, fileLimits, DeclarationValidator } from '@rho-workspace/plugin-files';
import type { Tables, tableLimits } from '@rho-workspace/plugin-tables';
import type { Charts, chartLimits } from '@rho-workspace/plugin-charts';
import type { Media } from '@rho-workspace/plugin-media';
import type { Objects } from '@rho-workspace/plugin-r';
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
  agent: () => import('@rho-workspace/plugin-agent')
};
export type PluginId = keyof typeof entries;
export const pluginIds = Object.keys(entries) as PluginId[];
type Modules = { [K in PluginId]: Awaited<ReturnType<typeof entries[K]>> };
export interface PluginConfig {
  plugins?: PluginId[];
  documents?: Partial<typeof documentLimits>;
  resources?: Partial<typeof fileLimits & typeof tableLimits & typeof chartLimits>;
  maxRetainedMetadataBytes?: number;
  maxContexts?: number; maxBindings?: number; maxActivities?: number; maxContextBytes?: number;
}
const only = (defaults: object, values: object = {}) => Object.fromEntries(Object.entries(values).filter(([k, v]) => k in defaults && v !== undefined));
export class Plugins {
  private modules: Partial<Modules> = {};
  private availability: any[] = [];
  constructor(public config: PluginConfig) {}
  async load() {
    const selected = this.config.plugins ?? pluginIds;
    requireThat(Array.isArray(selected) && selected.every(id => pluginIds.includes(id)) && new Set(selected).size === selected.length, 'invalid', 'Select unique, known plugin IDs.');
    for (const id of pluginIds) {
      const status: any = { id, package: '@rho-workspace/plugin-' + id, selected: selected.includes(id), state: 'unavailable', reason: 'Plugin is not selected.' };
      if (status.selected) {
        try {
          const module = await entries[id]();
          requireThat(module.plugin.id === id && module.plugin.package === status.package && module.plugin.version === '0.3.0', 'condition', 'Plugin identity/version does not match this application selection.');
          (this.modules as any)[id] = module;
          status.version = module.plugin.version; status.state = 'available'; delete status.reason;
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
  need<K extends PluginId>(id: K): Modules[K] {
    const module = this.optional(id);
    requireThat(module, 'unavailable', 'The selected plugin is unavailable; retained data and original requests are preserved.', { plugin: id, availability: this.availability.find(x => x.id === id) });
    return module;
  }
  get catalog() {
    const descriptors = Object.values(this.modules).map(m => m.plugin as PluginDescriptor);
    return { version: '0.3.0', plugins: this.availability, actions: descriptors.flatMap(p => p.actions ?? []), components: descriptors.flatMap(p => p.components ?? []), capabilities: descriptors.flatMap(p => p.capabilities), ...(this.modules.agent ? { agent: this.modules.agent.plugin.agent } : {}) };
  }
  supports(method: string) {
    const owner = method.startsWith('document.') ? 'documents' : method.startsWith('requirements.') ? 'requirements' : method === 'action.submit' || method === 'object.read' ? 'r' : method === 'data.plot' ? 'charts' : method.startsWith('data.') || method === 'selection.set' ? 'tables' : method.startsWith('media.') ? 'media' : method.startsWith('context.') || method.startsWith('binding.') || method === 'session.grant' ? 'agent' : method.startsWith('resource.') || method === 'artifact.check' ? 'files' : undefined;
    return !owner || !!this.modules[owner as PluginId];
  }
  validateComponentBindings(id: string, props: Record<string, unknown>, resources: Record<string, Resource>) {
    this.modules.charts?.validateComponentBindings(id, props, resources);
  }
  project(root: string, id: string) { return new ProjectPlugins(this, root, id); }
}
export class ProjectPlugins {
  documents?: Documents; files?: Files; tables?: Tables; charts?: Charts; media?: Media; objects?: Objects; agent?: AgentContext;
  constructor(public assembly: Plugins, public root: string, public projectId: string) {
    const c = assembly.config;
    const documents = assembly.optional('documents'), files = assembly.optional('files'), tables = assembly.optional('tables'), charts = assembly.optional('charts'), media = assembly.optional('media'), r = assembly.optional('r'), agent = assembly.optional('agent');
    if (documents) this.documents = new documents.Documents(root, c.documents);
    if (files) {
      const validators: DeclarationValidator[] = [tables?.declarationValidator, media?.declarationValidator, r?.declarationValidator].filter((v): v is DeclarationValidator => !!v);
      this.files = new files.Files(root, projectId, only(files.fileLimits, c.resources), validators);
    }
    if (tables && this.files) this.tables = new tables.Tables(this.files, only(tables.tableLimits, c.resources));
    if (charts && this.tables) this.charts = new charts.Charts(this.tables, only(charts.chartLimits, c.resources));
    if (media && this.files) this.media = new media.Media(this.files);
    if (r && this.files) this.objects = new r.Objects(this.files);
    if (agent) this.agent = new agent.AgentContext(root, projectId, this, only(agent.agentLimits, c));
  }
  need<K extends 'documents' | 'files' | 'tables' | 'charts' | 'media' | 'objects' | 'agent'>(id: K): NonNullable<ProjectPlugins[K]> {
    const owner = this[id];
    requireThat(owner, 'unavailable', 'The capability plugin is unavailable; existing owner state is retained.', { plugin: id });
    return owner as NonNullable<ProjectPlugins[K]>;
  }
  // Bounded observations of persisted metadata when its provider is absent.
  // No write, parsing of native content, installation or runtime recovery occurs.
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
