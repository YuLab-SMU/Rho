import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import { addBeside, addWithRoom, type LayoutNode, type LayoutTree } from '../src/shell-layout.js';
import { loadCode, sourceCode, valueName, type Language } from '../src/explore-code.js';

// Looking into a result in the live sessions the person shares with the Agent. A table loads
// into a new value, so the person starts where the result is; a script is put into the
// Notebook's line for the person to check and run, since running it again writes its outputs
// again. Nothing here ends or restarts a session.
export { explorableTable, languageNames, loadCode, projectPath, scriptLanguage, sourceCode, valueName, type Language } from '../src/explore-code.js';
export const canExplore = (snapshot: WorkspaceSnapshot) => snapshot.catalog.operations.some(o => o.method === 'kernel.run' && o.authorized && o.state === 'available');

// A script waits in the Notebook's line, named with where it came from, for the person to run.
export function scriptPrepared(path: string, language: Language, dirty: boolean) {
  const name = path.split('/').at(-1)!;
  return { key: crypto.randomUUID(), language, code: sourceCode(path, language), note: `From ${name}${dirty ? ' as saved; your unsaved changes are not in it' : ''}. Running it again writes its outputs again. Check it, then press Run.` };
}
// Loads a table into the session of that language as a new value. The cell is the person's,
// named for what it loads; it runs in the shared session as any cell they run there.
export async function loadTable(client: BrowserClient, projectId: string, path: string, language: Language) {
  const read = await client.call('kernel.read', { projectId, limit: 1 });
  const taken = new Set(read.sessions.filter(s => s.language === language && s.state !== 'ended').flatMap(s => s.variables.map(v => v.name)));
  const name = valueName(path, language, taken);
  return client.call('kernel.run', { projectId, language, code: loadCode(path, language, name), purpose: `Load ${path.split('/').at(-1)} as ${name}`, changeId: 'explore-' + crypto.randomUUID() });
}

// The Notebook as a view of a Studio page: one per page, showing the live sessions.
export const notebookComponent = 'rho.notebook';
export const notebookView = (id = 'notebook'): LayoutNode & { component: string; version: string; props: { title: string }; bindings: Record<string, never> } =>
  ({ id, kind: 'view', component: notebookComponent, version: '1', props: { title: 'Notebook' }, bindings: {} });
export const notebookOn = (nodes: unknown[] | undefined) => (nodes as LayoutNode[] | undefined)?.find(n => n.kind !== 'group' && n.component === notebookComponent)?.id ?? null;
const newId = (kind: string) => `${kind}-${crypto.randomUUID().slice(0, 8)}`;
// The page with the Notebook in a pane of its own beside a view, or as its one view.
export function withNotebook(tree: LayoutTree | null, beside: string | null, id?: string): LayoutTree | null {
  const view = notebookView(id);
  if (!tree) return { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [view.id] }, view] };
  return addBeside(tree, view as never, beside, 'right', newId);
}

// Puts the Notebook on a saved page beside a view, unless the page has one, with one
// conditional write; a newer layout from another tab is read once and the Notebook placed on it.
export async function addNotebook(client: BrowserClient, projectId: string, compositionId: string, beside: string | null): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const current = await client.call('composition.read', { projectId, compositionId }).catch(error => {
      if (error instanceof BrowserApiError && error.error.kind === 'not_found') return null;
      throw error;
    }) as { version: number; rootId?: string; nodes?: unknown[] } | null;
    const there = notebookOn(current?.nodes);
    if (there) return there;
    const next = withNotebook(current?.rootId && current.nodes?.length ? { rootId: current.rootId, nodes: current.nodes as LayoutNode[] } : null, beside);
    if (!next) throw new Error('The Notebook could not be placed on this page.');
    try {
      await client.call('composition.apply', { projectId, compositionId, expectedVersion: current?.version ?? 0, changeId: 'notebook-' + crypto.randomUUID(), operations: [{ op: 'replace', rootId: next.rootId, nodes: next.nodes }] } as never);
      return notebookOn(next.nodes)!;
    } catch (error) {
      if (attempt === 0 && error instanceof BrowserApiError && error.error.kind === 'stale') continue;
      throw error;
    }
  }
}

// A value of a live session as a view: one per value on a page. A page's values share one group
// of tabs. The first goes in a pane beside the Notebook when the Notebook's pane, on a stage
// `width` pixels wide, leaves both at least minViewPx; otherwise it joins the tab group next to
// the Notebook's, so that neither is squeezed. Without a width it goes beside the Notebook.
export const objectComponent = 'rho.object';
export const objectLimits = { minViewPx: 360 };
export function objectViewId(language: Language, name: string) {
  const safe = [...name].map(c => /[A-Za-z0-9_-]/.test(c) ? c : '.').join('').slice(0, 96);
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.codePointAt(0)!) >>> 0;
  return 'object-' + language + '-' + safe + (safe === name ? '' : '-' + hash.toString(36));
}
export const objectView = (language: Language, name: string): LayoutNode => ({ id: objectViewId(language, name), kind: 'view', component: objectComponent, version: '1', props: { title: name, language, name }, bindings: {} });
export function withObject(tree: LayoutTree | null, language: Language, name: string, width?: number): LayoutTree | null {
  const view = objectView(language, name);
  if (!tree) return { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [view.id] }, view] };
  if (tree.nodes.some(n => n.id === view.id)) return null;
  const sibling = tree.nodes.find(n => n.kind === 'view' && n.component === objectComponent);
  const holder = sibling && tree.nodes.find(n => n.kind === 'group' && n.children?.includes(sibling.id) && (n.presentation as { mode?: string } | undefined)?.mode !== 'split');
  if (holder) {
    const nodes = structuredClone(tree.nodes), group = nodes.find(n => n.id === holder.id)!;
    group.children = [...group.children!, view.id];
    return { rootId: tree.rootId, nodes: [...nodes, view] };
  }
  const notebook = notebookOn(tree.nodes);
  return notebook ? addWithRoom(tree, view as never, notebook, width, objectLimits.minViewPx, newId) : addBeside(tree, view as never, null, 'right', newId);
}
export async function addObject(client: BrowserClient, projectId: string, compositionId: string, language: Language, name: string, width?: number): Promise<string> {
  const id = objectViewId(language, name);
  for (let attempt = 0; ; attempt++) {
    const current = await client.call('composition.read', { projectId, compositionId }).catch(error => {
      if (error instanceof BrowserApiError && error.error.kind === 'not_found') return null;
      throw error;
    }) as { version: number; rootId?: string; nodes?: unknown[] } | null;
    if ((current?.nodes as LayoutNode[] | undefined)?.some(n => n.id === id)) return id;
    const next = withObject(current?.rootId && current.nodes?.length ? { rootId: current.rootId, nodes: current.nodes as LayoutNode[] } : null, language, name, width);
    if (!next) return id;
    try {
      await client.call('composition.apply', { projectId, compositionId, expectedVersion: current?.version ?? 0, changeId: 'object-' + crypto.randomUUID(), operations: [{ op: 'replace', rootId: next.rootId, nodes: next.nodes }] } as never);
      return id;
    } catch (error) {
      if (attempt === 0 && error instanceof BrowserApiError && error.error.kind === 'stale') continue;
      throw error;
    }
  }
}

// The person's own Studio pages are named in order after the first.
export const workspacePage = (n: number) => 'workspace-' + n;
export function nextWorkspace(ids: string[]) {
  let n = 2;
  while (ids.includes(workspacePage(n))) n++;
  return workspacePage(n);
}
// A new page holds nothing until the person adds a view to it.
export async function createWorkspace(client: BrowserClient, projectId: string, ids: string[]) {
  const compositionId = nextWorkspace(ids);
  await client.call('composition.apply', { projectId, compositionId, expectedVersion: 0, changeId: 'new-' + compositionId + '-' + crypto.randomUUID().slice(0, 8), operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [] }] }] } as never);
  return compositionId;
}
