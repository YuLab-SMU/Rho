import { ObservationClient, httpObservation, type observationLimits } from './observation.js';

// This entry deliberately imports neither Node, the DOM nor optional owners.
// A tab opened on this machine needs no credential: the service authorizes the same-origin
// request as the local person. `token` is present only for a deliberately narrowed link.
export interface BrowserConnection { url: string; token?: string; expiresAt?: string; methods?: string[]; principalId?: string; root?: string; rootLabel?: string }
export interface SourceFolder { id: string; root: string; name: string }
export interface FolderSelection extends SourceFolder { selectionId: string }
export type ProjectSummary = RhoOutput<'project.list'>[number];
import type { EntryPresentation, PluginPresentation } from '@rho-workspace/plugin-contracts';
import type { RhoInput, RhoMethod, RhoOperationError, RhoOutput } from './contract.generated.js';
import type { TaskMapState } from './task-frame.js';
export type { TaskMapState } from './task-frame.js';
export type { EntryPresentation, PluginPresentation } from '@rho-workspace/plugin-contracts';
export interface NativeAvailability { state: 'present' | 'missing' | 'unknown'; tool: string; scope: string; checkedAt: string; methods: string[]; title?: string; body?: string }
export interface PluginSkill { id: string; version: string; digest: string; presentation?: EntryPresentation }
// These were hand-written copies of the wire contract. They are derived from the one
// generated contract (src/contract.generated.ts), so the shell cannot compile against
// a field the service does not return. Only genuinely local view-model shapes stay
// hand-written here (project bootstrap, folder selection, presentation hints).
type Catalog = RhoOutput<'capability.list'>;
export type CapabilityPlugin = Catalog['plugins'][number];
export type CapabilityOperation = Catalog['operations'][number];
export type CapabilityAction = Catalog['actions'][number];
export type ComponentDescriptor = Catalog['components'][number];
// `observation.snapshot.catalog` and `capability.list` carry the same catalog; only
// the direct operation adds the Core host report. The shell reads the snapshot form.
export type CapabilityCatalog = RhoOutput<'observation.snapshot'>['catalog'];
export type CapabilityList = Catalog;
export type DocumentSummary = RhoOutput<'observation.snapshot'>['documents'][number];
export type DocumentChange = { changeId: string; expectedRevision: number };
export type DocumentBuffer = RhoOutput<'document.read'>;
export type DocumentReceipt = NonNullable<DocumentBuffer['receipt']>;
export type DocumentHistoryEntry = NonNullable<DocumentBuffer['history']>[number];
export type DocumentHistory = RhoOutput<'document.history'>;
// A view binding names either a resource version or a document: a document at an
// exact version, or the live shared buffer of one.
export type DocumentBinding = { id: string; version: string } | { documentId: string; version: number } | { kind: 'live-document'; documentId: string };
export type ResourceSummary = RhoOutput<'resource.read'>['resource'];
// A view as the shell draws it: the contract's view fields, with bindings kept as the
// owner-facing union so both a resource and a live document binding are allowed.
export type ViewDescription = { id: string; component: string; version: string; props: Record<string, unknown>; bindings: Record<string, DocumentBinding>; selection?: string[]; protected?: boolean; presentation?: { emphasis: 'normal' | 'highlight' } };
export type GroupPresentation = NonNullable<Extract<RhoOutput<'composition.apply'>['nodes'][number], { kind: 'group' }>['presentation']>;
// A stored layout is either the legacy put record or the current structured one. The
// shell reads only the facts both carry, so this is a rendering projection of the
// contract value rather than a second definition of it.
export type CompositionSummary = {
  compositionId: string; version: number; availability?: Record<string, unknown>; author?: string; acknowledgedAt?: string;
  views: ViewDescription[];
  rootId?: string;
  nodes?: Extract<RhoOutput<'composition.apply'>['nodes'][number], { kind: 'group' | 'view' }>[];
};
export type StoredComposition = RhoOutput<'composition.read'>;
export type WorkspaceSnapshot = RhoOutput<'observation.snapshot'>;
export type TablePage = RhoOutput<'data.page'>;
export type SelectionChannel = RhoOutput<'interaction.selection.read'>;
export type SelectionScope = RhoInput<'interaction.selection.read'>['scope'];
export type SelectionValue = SelectionChannel['selection'];
export type TaskMapResponse = RhoOutput<'task.map.read'>;
export type ProjectRuns = RhoOutput<'project.runs'>;
export type ProjectEntries = RhoOutput<'project.entries'>;
export type DoctorReport = RhoOutput<'project.doctor'>;
// The error half of the envelope comes from the contract's published error object.

// Owner paths carry the host separator, so a Windows root arrives as C:\work\atlas.
// Display helpers accept either separator instead of assuming '/'.
const separator = /[\\/]/;
export function lastSegment(value: string) { return value.split(separator).filter(Boolean).at(-1) ?? ''; }
// True when child sits below parent. Compares whole segments, so /work/atlas is not
// read as a parent of /work/atlas-old.
export function beneath(child: string, parent: string) {
  if (!parent || child === parent) return false;
  const head = parent.endsWith('/') || parent.endsWith('\\') ? parent : parent + (parent.includes('\\') ? '\\' : '/');
  return child.startsWith(head);
}
// navigator.platform is deprecated; userAgentData.platform replaces it but Safari
// and Firefox still omit it, so callers pass whichever string they have. iPadOS
// reports MacIntel while userAgentData reports iOS, so both spellings have to
// resolve to an Apple keyboard carrying ⌘.
export type Platform = 'macos' | 'ios' | 'other';
export function platformKind(reported: string | undefined): Platform {
  const value = (reported ?? '').toLowerCase();
  if (/iphone|ipad|ipod|ios/.test(value)) return 'ios';
  if (/mac/.test(value)) return 'macos';
  return 'other';
}

export type ApiFailure = RhoOperationError;
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
  async call<M extends RhoMethod>(method: M, input: RhoInput<M>, signal?: AbortSignal): Promise<RhoOutput<M>> {
    // Native browser fetch must not receive this client as its receiver.
    const fetcher = this.fetcher;
    const response = await fetcher(new URL('/api/v2/' + method, this.connection.url), {
      method: 'POST', credentials: 'omit', headers: { ...(this.connection.token ? { authorization: 'Bearer ' + this.connection.token } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: signal ?? AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!result.ok) throw new BrowserApiError(result.error);
    return result.value as RhoOutput<M>;
  }
  observe(projectId: string, limits: Partial<typeof observationLimits> = {}) {
    return new ObservationClient<WorkspaceSnapshot>(httpObservation(this.connection.url, this.connection.token, projectId, limits.maxBufferedEventBytes, this.fetcher), limits);
  }
}
