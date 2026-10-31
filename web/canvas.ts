import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import { capturable } from './sources.js';

// Opening a project file into a workspace: text becomes the one shared document buffer in
// its editor, a CSV or image becomes an immutable Files snapshot in its table or media
// view. Every placement is one conditional layout write; the owners keep the content.
// The person and the Agent share one workspace: what the Agent opens lands beside what the
// person has open, in the same saved layout either of them can arrange.
export const defaultWorkspace = 'workspace';
const names: Record<string, string> = { workspace: 'Workspace', 'agent-canvas': 'Agent canvas', 'observed-outputs': 'Observed outputs' };
// The person's own pages after the first are numbered (see createWorkspace).
export function compositionName(id: string) { return names[id] ?? (/^workspace-(\d+)$/.exec(id) ? 'Workspace ' + id.slice('workspace-'.length) : id); }
// Each conversation started in Rho has its own Studio layout, derived from its work until the
// person arranges it; it is saved under this name only then.
export const processComposition = (conversationId: string) => 'conversation-' + conversationId;
export const processConversation = (compositionId: string) => compositionId.startsWith('conversation-') ? compositionId.slice('conversation-'.length) : null;

type Side = 'code' | 'data';
// A short, stable name for a file path, so a newer snapshot of the same file is recognised.
export function fileKey(path: string) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (const char of path) { const c = char.codePointAt(0)!; a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x811c9dc5) >>> 0; }
  return 'file-' + (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12) + '-';
}
interface Node { id: string; kind: 'group' | 'view'; children?: string[]; presentation?: { mode?: string; axis?: string; weights?: number[] }; props?: Record<string, unknown>; [key: string]: unknown }
// A group the Agent's work made keeps its newest views; older ones close from the left. Groups
// the person made are never trimmed.
export const canvasLimits = { maxViewsPerSide: 6 };
const agentGroup = 'canvas-';
const markdownReader = 'markdown.reader';
const sideOf = (node: Node): Side | null => node.kind !== 'view' ? null : node.component === 'rho.editor' || node.component === markdownReader ? 'code' : node.component === 'rho.table' || node.component === 'rho.media' ? 'data' : null;

// Files no Studio view reads; anything else that is text opens in the editor.
const unviewable = /\.(png|jpe?g|svg|gif|pdf|tiff?|webp|xlsx?|rds|rda|rdata|parquet|feather|h5|h5ad|bam|zip|gz)$/i;
export const studioViewable = (path: string) => capturable(path) || !unviewable.test(path);
const allowed = (snapshot: WorkspaceSnapshot, method: string) => snapshot.catalog.operations.some(o => o.method === method && o.authorized && o.state === 'available');
const component = (snapshot: WorkspaceSnapshot, id: string) => snapshot.catalog.components.find(c => c.id === id);
export const canCapture = (snapshot: WorkspaceSnapshot) => allowed(snapshot, 'agent.activity.capture') && !!component(snapshot, 'rho.table') && !!component(snapshot, 'rho.media');

export interface ResourceTarget { id: string; version: string; kind: string; path: string }
// The view a file opens in, without placing it anywhere: a preview shows it as it is.
export async function viewFor(client: BrowserClient, snapshot: WorkspaceSnapshot, target: string | ResourceTarget): Promise<{ node: Node; side: Side } | null> {
  // A registered result opens as exactly that version, keeping its provenance.
  if (typeof target !== 'string') {
    const owner = component(snapshot, target.kind === 'table' ? 'rho.table' : 'rho.media');
    if (!owner || !['table', 'media'].includes(target.kind)) return null;
    const binding = Object.keys(owner.bindings)[0] ?? 'data';
    return { side: 'data', node: { id: 'result-' + target.id.slice(0, 12) + '-' + target.version.slice(0, 12), kind: 'view', component: owner.id, version: owner.version, props: { title: target.path.split('/').at(-1) ?? target.path }, bindings: { [binding]: { id: target.id, version: target.version } } } };
  }
  const path = target;
  const projectId = snapshot.project.id, title = path.split('/').at(-1) ?? path;
  if (capturable(path) && canCapture(snapshot)) {
    const resource = await client.call('agent.activity.capture', { projectId, path });
    const owner = component(snapshot, resource.kind === 'table' ? 'rho.table' : 'rho.media')!;
    const binding = Object.keys(owner.bindings)[0] ?? 'data';
    return { side: 'data', node: { id: fileKey(path) + resource.version.slice(0, 12), kind: 'view', component: owner.id, version: owner.version, props: { title }, bindings: { [binding]: { id: resource.id, version: resource.version } } } };
  }
  if (unviewable.test(path)) return null;
  // Markdown reads as formatted text, from the same buffer the editor shows under Source.
  const editor = (/\.(md|markdown)$/i.test(path) ? component(snapshot, markdownReader) : undefined) ?? component(snapshot, 'rho.editor');
  if (!editor) return null;
  // Opening an unchanged buffer adopts what is on disk now, so an Agent's own edit shows.
  const document = await client.call('document.open', { projectId, path });
  return { side: 'code', node: { id: 'doc-' + document.id.slice(0, 12), kind: 'view', component: editor.id, version: editor.version, props: { title }, bindings: { document: { kind: 'live-document', documentId: document.id } } } };
}

function placed(current: { rootId?: string; nodes?: unknown[] } | null, view: Node, side: Side): { rootId: string; nodes: Node[] } | null {
  const nodes: Node[] = structuredClone((current?.nodes ?? []) as Node[]);
  let rootId = current?.rootId ?? 'root';
  if (nodes.some(n => n.id === view.id)) return null;
  const byId = (id: string) => nodes.find(n => n.id === id);
  const parentOf = (id: string) => nodes.find(n => n.kind === 'group' && n.children?.includes(id));
  const isTabs = (n: Node | undefined) => !!n && n.kind === 'group' && n.presentation?.mode !== 'split';
  // A newer snapshot of the same file takes the older one's place.
  const file = view.id.startsWith('file-') ? view.id.slice(0, 18) : '';
  const older = file ? nodes.find(n => n.kind === 'view' && n.id.startsWith(file)) : undefined;
  if (older) {
    const parent = parentOf(older.id);
    if (parent) {
      parent.children = parent.children!.map(id => id === older.id ? view.id : id);
      return { rootId, nodes: [...nodes.filter(n => n.id !== older.id), view] };
    }
  }
  let root = byId(rootId);
  if (!root) { root = { id: rootId, kind: 'group', children: [] }; nodes.push(root); }
  // Code joins code and data and figures join data: first the group the Agent's work made for
  // that side, wherever it now is; then a group of tabs already holding that side's views; an
  // empty workspace takes the view in its one group. Otherwise the side gets a group of its
  // own at its edge, code on the left and data on the right of what is there.
  const counts = new Map<Node, number>();
  for (const n of nodes) if (sideOf(n) === side) { const holder = parentOf(n.id); if (isTabs(holder)) counts.set(holder!, (counts.get(holder!) ?? 0) + 1); }
  let target = nodes.find(n => n.id === agentGroup + side && n.kind === 'group')
    ?? [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? (!root.children?.length ? root : undefined);
  if (!target) {
    target = { id: agentGroup + side, kind: 'group', children: [] };
    nodes.push(target);
    const at = (length: number) => side === 'code' ? 0 : length;
    if (root.presentation?.mode === 'split' && root.presentation.axis === 'horizontal') {
      const weights = root.presentation.weights?.length === root.children!.length ? [...root.presentation.weights] : root.children!.map(() => 1);
      const index = at(root.children!.length);
      root.children!.splice(index, 0, target.id);
      weights.splice(index, 0, weights.reduce((a, b) => a + b, 0) / weights.length);
      root.presentation = { ...root.presentation, weights };
    } else {
      let id = 'split', n = 1;
      while (byId(id)) id = 'split-' + ++n;
      const children = [rootId]; children.splice(at(1), 0, target.id);
      nodes.push({ id, kind: 'group', children, presentation: { mode: 'split', axis: 'horizontal', weights: [1, 1] } });
      rootId = id;
    }
  }
  target.children = [...(target.children ?? []), view.id];
  nodes.push(view);
  if (target.id.startsWith(agentGroup)) while (target.children.length > canvasLimits.maxViewsPerSide) {
    const dropped = target.children.shift()!;
    const index = nodes.findIndex(n => n.id === dropped);
    if (index >= 0) nodes.splice(index, 1);
  }
  return { rootId, nodes };
}

// Writes to one workspace go one at a time, each against the version the last one left.
const queues = new Map<string, Promise<unknown>>();
export function openInWorkspace(client: BrowserClient, snapshot: WorkspaceSnapshot, compositionId: string, target: string | ResourceTarget): Promise<{ compositionId: string; viewId: string } | null> {
  const key = snapshot.project.id + '/' + compositionId;
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const made = await viewFor(client, snapshot, target);
    if (!made) return null;
    const projectId = snapshot.project.id;
    for (let attempt = 0; ; attempt++) {
      const current = await client.call('composition.read', { projectId, compositionId }).catch(error => {
        if (error instanceof BrowserApiError && error.error.kind === 'not_found') return null;
        throw error;
      }) as { version: number; rootId?: string; nodes?: unknown[] } | null;
      const existing = (current?.nodes as Node[] | undefined)?.find(n => n.id === made.node.id);
      if (existing) return { compositionId, viewId: existing.id };
      const next = placed(current, made.node, made.side);
      if (!next) return { compositionId, viewId: made.node.id };
      try {
        await client.call('composition.apply', { projectId, compositionId, expectedVersion: current?.version ?? 0, changeId: 'open-' + crypto.randomUUID(), operations: [{ op: 'replace', rootId: next.rootId, nodes: next.nodes }] } as never);
        return { compositionId, viewId: made.node.id };
      } catch (error) {
        // Another tab moved the layout first: place the view again on what it wrote.
        if (attempt === 0 && error instanceof BrowserApiError && error.error.kind === 'stale') continue;
        throw error;
      }
    }
  });
  queues.set(key, run);
  return run;
}
