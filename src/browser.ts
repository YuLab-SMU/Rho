import { ObservationClient, httpObservation, type observationLimits } from './observation.js';

// This entry deliberately imports neither Node, the DOM nor optional owners.
export interface BrowserConnection { url: string; token: string; expiresAt: string; methods: string[]; principalId?: string; root?: string; rootLabel?: string }
export interface ProjectSummary { id: string; root: string; openedAt: string }
import type { EntryPresentation, PluginPresentation } from '@rho-workspace/plugin-contracts';
export type { EntryPresentation, PluginPresentation } from '@rho-workspace/plugin-contracts';
export interface NativeAvailability { state: 'present' | 'missing' | 'unknown'; tool: string; scope: string; checkedAt: string; methods: string[]; title?: string; body?: string }
export interface PluginSkill { id: string; version: string; digest: string; presentation?: EntryPresentation }
export interface CapabilityPlugin {
  id: string; package: string; version?: string; state: string; reason?: string; selected: boolean;
  packagePresent: boolean; projectEnabled: boolean; dependenciesSatisfied: boolean; uiRenderable?: boolean;
  requires?: string[]; presentation?: PluginPresentation;
  nativeAvailability?: NativeAvailability;
  listing?: { skills?: PluginSkill[]; actions?: { presentation?: EntryPresentation }[]; views?: { id: string; version: string; ui: string; presentation?: EntryPresentation }[] };
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
export interface DocumentChange { changeId: string; expectedRevision: number }
export interface DocumentReceipt { changeId: string; requestDigest: string; kind: 'edit' | 'undo' | 'save' | 'abandon-save' | 'undo-own' | 'revert'; author: string; revision: number; version: number; at: string }
export interface DocumentHistoryEntry {
  changeId: string; requestDigest: string; author: string; kind: 'edit' | 'undo' | 'undo-own' | 'revert';
  undoGroup: string; groupId: string; version: number; revision: number; at: string;
  beforeDigest: string; afterDigest: string; reverts: string[];
}
export interface DocumentHistory { documentId: string; currentVersion: number; currentRevision: number; retainedFromVersion: number; entries: (DocumentHistoryEntry & { revertedBy: string | null })[] }
export interface DocumentBuffer extends DocumentSummary {
  author: string; undo: { content: string; group: string; author: string; changeIds?: string[] }[];
  revision: number; receipts: DocumentReceipt[]; retainedFromRevision: number;
  receipt?: DocumentReceipt;
  history: (DocumentHistoryEntry & { edits: { from: number; to: number; insert: string; removed: string }[] })[];
  historyRetainedFromVersion: number;
  pendingSave?: { requestDigest: string; author: string; expectedDiskDigest: string | null; contentDigest: string; at: string; change?: DocumentChange };
}
export type DocumentBinding = { documentId: string; version: number } | { kind: 'live-document'; documentId: string };
interface DocumentWrite extends DocumentChange { projectId: string; documentId: string; expectedVersion: number }
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
  'document.open': { input: { projectId: string; path: string }; output: DocumentBuffer };
  'document.read': { input: { projectId: string; documentId: string }; output: DocumentBuffer };
  'document.edit': { input: DocumentWrite & { edits: { from: number; to: number; insert: string }[]; undoGroup: string }; output: DocumentBuffer };
  'document.undo': { input: DocumentWrite; output: DocumentBuffer };
  'document.undoOwn': { input: DocumentWrite; output: DocumentBuffer };
  'document.revert': { input: DocumentWrite & { targetChangeId: string }; output: DocumentBuffer };
  'document.history': { input: { projectId: string; documentId: string }; output: DocumentHistory };
  'document.change.read': { input: { projectId: string; documentId: string; targetChangeId: string }; output: { documentId: string; change: DocumentHistory['entries'][number]; before: { version: number; digest: string; content: string }; after: { version: number; digest: string; content: string } } };
  'document.save': { input: DocumentWrite & { expectedDiskDigest: string | null }; output: DocumentBuffer };
  'document.abandonSave': { input: DocumentWrite & { pendingRequestDigest: string }; output: DocumentBuffer };
  'data.page': { input: { projectId: string; resource: { id: string; version: string }; offset: number; limit: number; sort?: { column: string; direction: 'asc' | 'desc' }; filter?: { column: string; op: 'eq' | 'lt' | 'gt' | 'isNull'; value?: string | number | boolean | null } }; output: TablePage };
  'interaction.selection.read': { input: { projectId: string; scope: SelectionScope }; output: SelectionChannel };
  'interaction.selection.set': { input: { projectId: string; scope: SelectionScope; expectedVersion: number; changeId: string; selection: SelectionValue }; output: SelectionChannel };
}
export interface TablePage { resource: ResourceSummary; columns: { name: string; type: 'string' | 'number' | 'boolean'; nullValues: string[] }[]; total: number; filtered: number; offset: number; nextOffset: number; more: boolean; rows: Record<string, string | number | boolean | null>[]; entityKey: string | null; namespace: string | null }
export type SelectionScope = { kind: 'caller' } | { kind: 'view' | 'shared'; id: string };
export type SelectionValue = { document: { documentId: string; version: number; from: number; to: number } } | { resource: { id: string; version: string }; entities: string[] } | null;
export interface SelectionChannel { key: string; scope: SelectionScope; version: number; selection: SelectionValue; author?: string }
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
