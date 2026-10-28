import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import { capturable } from './sources.js';

// Opening a project file into a workspace: text becomes the one shared document buffer in
// its editor, a CSV or image becomes an immutable Files snapshot in its table or media
// view. Every placement is one conditional layout write; the owners keep the content.
export const canvasId = 'agent-canvas';
export function compositionName(id: string) { return id === canvasId ? 'Agent canvas' : id === 'observed-outputs' ? 'Observed outputs' : id; }

type Side = 'code' | 'data';
// A short, stable name for a file path, so a newer snapshot of the same file is recognised.
export function fileKey(path: string) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (const char of path) { const c = char.codePointAt(0)!; a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x811c9dc5) >>> 0; }
  return 'file-' + (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12) + '-';
}
interface Node { id: string; kind: 'group' | 'view'; children?: string[]; presentation?: { mode?: string; axis?: string; weights?: number[] }; props?: Record<string, unknown>; [key: string]: unknown }
// The canvas keeps the newest views on each side; older ones close from the left.
export const canvasLimits = { maxViewsPerSide: 6 };

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
  if (/\.(png|jpe?g|svg|gif|pdf|tiff?|webp|xlsx?|rds|rda|rdata|parquet|feather|h5|h5ad|bam|zip|gz)$/i.test(path)) return null;
  const editor = component(snapshot, 'rho.editor');
  if (!editor) return null;
  // Opening an unchanged buffer adopts what is on disk now, so an Agent's own edit shows.
  const document = await client.call('document.open', { projectId, path });
  return { side: 'code', node: { id: 'doc-' + document.id.slice(0, 12), kind: 'view', component: editor.id, version: editor.version, props: { title }, bindings: { document: { kind: 'live-document', documentId: document.id } } } };
}

function placed(current: { rootId?: string; nodes?: unknown[] } | null, view: Node, side: Side, canvas: boolean): { rootId: string; nodes: Node[] } | null {
  const nodes: Node[] = structuredClone((current?.nodes ?? []) as Node[]);
  const rootId = current?.rootId ?? (canvas ? 'canvas' : 'root');
  if (nodes.some(n => n.id === view.id)) return null;
  const parentOf = (id: string) => nodes.find(n => n.kind === 'group' && n.children?.includes(id));
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
  let root = nodes.find(n => n.id === rootId);
  if (!root) { root = { id: rootId, kind: 'group', children: [] }; nodes.push(root); }
  // The canvas keeps code on the left and data and figures on the right, wherever the person
  // or the Agent has since moved those two groups; a split needs both, so with one side the
  // canvas is that side's tabs. A side whose group was emptied returns at its edge of a
  // left-to-right split.
  const own = canvas ? nodes.find(n => n.id === 'canvas-' + side && n.kind === 'group') : undefined;
  let target: Node;
  if (own) target = own;
  else if (canvas && (root.children!.every(id => id.startsWith('canvas-')) || (root.presentation?.mode === 'split' && root.presentation.axis === 'horizontal'))) {
    const weights = root.presentation?.mode === 'split' && root.presentation.weights?.length === root.children!.length ? [...root.presentation.weights] : root.children!.map(() => 1);
    const at = side === 'code' ? 0 : root.children!.length;
    target = { id: 'canvas-' + side, kind: 'group', children: [] };
    nodes.push(target);
    root.children!.splice(at, 0, target.id);
    weights.splice(at, 0, weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : 1);
    if (root.children!.length > 1) root.presentation = { mode: 'split', axis: 'horizontal', weights };
    else delete root.presentation;
  } else if (root.presentation?.mode === 'split') {
    // A person's own split: the new view joins the first group of tabs.
    const tabs = (id: string): Node | undefined => { const n = nodes.find(x => x.id === id); return !n || n.kind === 'view' ? undefined : n.presentation?.mode === 'split' ? n.children!.map(tabs).find(Boolean) : n; };
    target = tabs(root.id) ?? root;
  } else target = root;
  target.children = [...(target.children ?? []), view.id];
  nodes.push(view);
  if (canvas) while (target.children.length > canvasLimits.maxViewsPerSide) {
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
    const projectId = snapshot.project.id, canvas = compositionId === canvasId;
    for (let attempt = 0; ; attempt++) {
      const current = await client.call('composition.read', { projectId, compositionId }).catch(error => {
        if (error instanceof BrowserApiError && error.error.kind === 'not_found') return null;
        throw error;
      }) as { version: number; rootId?: string; nodes?: unknown[] } | null;
      const existing = (current?.nodes as Node[] | undefined)?.find(n => n.id === made.node.id);
      if (existing) return { compositionId, viewId: existing.id };
      const next = placed(current, made.node, made.side, canvas);
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
