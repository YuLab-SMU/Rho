import { ObservationClient, httpObservation, type observationLimits } from './observation.js';

// This entry deliberately imports neither Node, the DOM nor optional owners.
export interface BrowserConnection { url: string; token: string; expiresAt: string; methods: string[] }
export interface ProjectSummary { id: string; root: string; openedAt: string }
export interface EntryPresentation { displayName?: string; readOnly?: boolean; runsCode?: boolean }
export interface PluginPresentation extends EntryPresentation { tagline?: string; category?: string; examplePrompts?: string[]; viewNote?: string }
export interface CapabilityPlugin {
  id: string; package: string; version?: string; state: string; reason?: string; selected: boolean;
  packagePresent: boolean; projectEnabled: boolean; dependenciesSatisfied: boolean; uiRenderable?: boolean;
  requires?: string[]; presentation?: PluginPresentation;
}
export interface CapabilityOperation { method: string; owner?: string; state: string; authorized: boolean; packagePresent: boolean; projectEnabled: boolean; dependenciesSatisfied: boolean; presentation?: EntryPresentation }
export interface CapabilityAction { id: string; version: string; pluginId?: string; owner: string; presentation?: EntryPresentation }
export interface ComponentDescriptor { id: string; version: string; owner: string; pluginId?: string; ui: string; bindings: Record<string, string>; presentation?: EntryPresentation }
export interface CapabilityCatalog {
  plugins: CapabilityPlugin[];
  actions?: CapabilityAction[];
  unavailableActions?: (CapabilityAction & { state: string; missing: string[] })[];
  components: ComponentDescriptor[];
  operations: CapabilityOperation[];
  configuration: { version: number; enabled: string[] };
}
export interface DocumentSummary { id: string; path: string; version: number; content: string; dirty: boolean; diskDigest: string | null; acknowledgedAt: string }
export interface ResourceSummary { id: string; version: string; kind: string; path: string; bytes: number; owner: string; availability: string; provenance: Record<string, unknown> }
export interface ViewDescription { id: string; component: string; version: string; props: Record<string, unknown>; bindings: Record<string, unknown>; protected?: boolean }
export interface CompositionSummary { compositionId: string; version: number; views: ViewDescription[]; availability: Record<string, unknown>; rootId?: string; nodes?: ({ id: string; kind: 'group'; children: string[] } | (ViewDescription & { kind: 'view' }))[] }
export interface WorkspaceSnapshot {
  project: ProjectSummary; catalog: CapabilityCatalog; cursor: number;
  documents: DocumentSummary[]; resources: ResourceSummary[]; compositions: CompositionSummary[];
  operations: { operationId: string; [key: string]: unknown }[];
  bindings: unknown[]; contexts: unknown[]; annotations: unknown[];
  host: { exitCode: number; [key: string]: unknown }; limits: Record<string, unknown>;
}
export interface BrowserApi {
  'project.list': { input: Record<string, never>; output: ProjectSummary[] };
  'project.open': { input: { path: string }; output: ProjectSummary };
  'project.create': { input: { name: string }; output: ProjectSummary };
  'capability.list': { input: { projectId: string }; output: CapabilityCatalog };
  'observation.snapshot': { input: { projectId: string }; output: WorkspaceSnapshot };
  'composition.read': { input: { projectId: string; compositionId: string }; output: CompositionSummary };
}
export interface ApiFailure { kind: string; message: string; details?: Record<string, unknown>; continuation?: string }
export class BrowserApiError extends Error {
  readonly fatal: boolean;
  constructor(public error: ApiFailure) { super(error.message); this.fatal = ['unauthorized', 'scope', 'origin'].includes(error.kind); }
}
export class BrowserClient {
  constructor(private readonly connection: BrowserConnection, private readonly fetcher: typeof fetch = fetch) {}
  static async pair(url: string, code: string, fetcher: typeof fetch = fetch): Promise<BrowserConnection> {
    const response = await fetcher(new URL('/api/browser/pair', url), { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!result.ok) throw new BrowserApiError(result.error);
    return { url: new URL(url).origin, ...result.value };
  }
  async call<M extends keyof BrowserApi>(method: M, input: BrowserApi[M]['input'], signal?: AbortSignal): Promise<BrowserApi[M]['output']> {
    // Native browser fetch must not receive this client as its receiver.
    const fetcher = this.fetcher;
    const response = await fetcher(new URL('/api/v2/' + method, this.connection.url), {
      method: 'POST', credentials: 'omit', headers: { authorization: 'Bearer ' + this.connection.token, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: signal ?? AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!result.ok) throw new BrowserApiError(result.error);
    return result.value;
  }
  observe(projectId: string, limits: Partial<typeof observationLimits> = {}) {
    return new ObservationClient<WorkspaceSnapshot>(httpObservation(this.connection.url, this.connection.token, projectId, limits.maxBufferedEventBytes, this.fetcher), limits);
  }
}
