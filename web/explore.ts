import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import { addAtEdge, addBeside, addInto, addWithRoom, moveToEdge, paneShare, type LayoutNode, type LayoutTree } from '../src/shell-layout.js';
import { languageNames, loadCode, sourceCode, valueName, type Language } from '@rho-workspace/plugin-kernel/code';

// Looking into a result in the live sessions the person shares with the Agent. A table loads
// into a new value, so the person starts where the result is; a script is put into the
// Notebook's line for the person to check and run, since running it again writes its outputs
// again. Nothing here ends or restarts a session.
export { explorableTable, languageNames, loadCode, projectPath, scriptLanguage, sourceCode, valueName, type Language } from '@rho-workspace/plugin-kernel/code';
export const canExplore = (snapshot: WorkspaceSnapshot) => snapshot.catalog.operations.some(o => o.method === 'kernel.run' && o.authorized && o.state === 'available');

// A script waits in the Notebook's line, named with where it came from, for the person to run.
export function scriptPrepared(path: string, language: Language, dirty: boolean) {
  const name = path.split('/').at(-1)!;
  return { key: crypto.randomUUID(), language, code: sourceCode(path, language), note: `From ${name}${dirty ? ' as saved; your unsaved changes are not in it' : ''}. Running it again writes its outputs again. Check it, then press Run.` };
}
// Loads a table into the session of that language as a new value. The cell is the person's,
// named for what it loads; it runs in the shared session as any cell they run there. A session on
// a server reads the server's files: a copy from that server loads from where it was copied, and
// a file only on this machine is not sent there; the person is told where each is.
export async function loadTable(client: BrowserClient, projectId: string, path: string, language: Language, notebook?: string | null) {
  const where = notebook ? { notebook } : {};
  const read = await client.call('kernel.read', { projectId, limit: 1 });
  const live = read.sessions.find(s => s.language === language && s.state !== 'ended');
  const taken = new Set(live?.variables.map(v => v.name) ?? []);
  const name = valueName(path, language, taken), file = path.split('/').at(-1)!;
  const places = live?.place ? null : await client.call('kernel.places', { projectId }).catch(() => null);
  const placeId = live ? live.place?.placeId ?? null : places && places.use[language] !== 'local' ? places.use[language] : null;
  if (!placeId) return client.call('kernel.run', { projectId, language, code: loadCode(path, language, name), purpose: `Load ${file} as ${name}`, changeId: 'explore-' + crypto.randomUUID(), ...where });
  const known = places ?? await client.call('kernel.places', { projectId });
  const label = live?.place?.label ?? known.places.find(p => p.placeId === placeId)?.label ?? placeId;
  const copy = known.copies.find(c => c.placeId === placeId && c.to === path);
  if (!copy) throw new Error(`${languageNames[language]} runs on ${label}, and ${file} is on this machine only. Choose This machine beside the language in the Notebook to load it here, or put the file in the folder on ${label}.`);
  return client.call('kernel.run', { projectId, language, code: loadCode(copy.path, language, name), purpose: `Load ${file} on ${label} as ${name}`, changeId: 'explore-' + crypto.randomUUID(), ...where });
}

// The Notebook as a view of a Studio page. The first on a page is the project's notebook: every
// cell of the live sessions. Each one added after it is a notebook of its own over the same
// sessions, with an identity its view keeps and its cells carry, and a name the person gives it.
export const notebookComponent = 'rho.notebook';
export const notebookView = (id = 'notebook', form?: 'notebook' | 'console'): LayoutNode & { component: string; version: string; props: { title: string; form?: string }; bindings: Record<string, never> } =>
  ({ id, kind: 'view', component: notebookComponent, version: '1', props: { title: 'Notebook', ...(form ? { form } : {}) }, bindings: {} });
export const notebookOn = (nodes: unknown[] | undefined) => (nodes as LayoutNode[] | undefined)?.find(n => n.kind !== 'group' && n.component === notebookComponent)?.id ?? null;
const newId = (kind: string) => `${kind}-${crypto.randomUUID().slice(0, 8)}`;
type NotebookNode = LayoutNode & { props?: { title?: string; notebook?: string } };
const notebookNodes = (nodes: unknown[] | undefined) => ((nodes as NotebookNode[] | undefined) ?? []).filter(n => n.kind !== 'group' && n.component === notebookComponent);
// The identity a Notebook view's cells carry; none for the project's notebook.
export const notebookOf = (view: { props?: Record<string, unknown> } | undefined) => typeof view?.props?.notebook === 'string' && view.props.notebook ? view.props.notebook : null;
// Each notebook's name by its identity, across the project's pages, so a cell can say where it was run.
export const notebookNames = (pages: ReadonlyArray<{ views: ReadonlyArray<{ component: string; props: Record<string, unknown> }> }>) =>
  Object.fromEntries(pages.flatMap(page => page.views).filter(v => v.component === notebookComponent && notebookOf(v)).map(v => [notebookOf(v)!, String(v.props.title ?? 'Notebook')]));
// The page with the Notebook in a pane of its own beside a view, or as its one view.
export function withNotebook(tree: LayoutTree | null, beside: string | null, id?: string): LayoutTree | null {
  const view = notebookView(id);
  if (!tree) return { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [view.id] }, view] };
  return addBeside(tree, view as never, beside, 'right', newId);
}

// A pane added along an edge takes its share from every pane there. The explorer and the lists of
// files are narrow to begin with, so when one falls under the floor it gets its first width back.
function keepBrowser(tree: LayoutTree): LayoutTree {
  const browser = tree.nodes.find(n => n.kind !== 'group' && (n.component === 'rho.files' || n.component === 'rho.sources'));
  const holder = browser && tree.nodes.find(n => n.kind === 'group' && n.children?.includes(browser.id) && (n.presentation as { mode?: string } | undefined)?.mode !== 'split');
  if (!browser || !holder || tree.rootId === holder.id) return tree;
  const share = paneShare(tree, browser.id);
  if (!(share > 0 && share < browserShares.floor)) return tree;
  // Already a column of the page: only its width changes. Deeper in, it moves out to the left edge.
  const parent = tree.nodes.find(n => n.kind === 'group' && n.children?.includes(holder.id));
  const split = parent?.presentation as { mode?: string; axis?: string; weights?: number[] } | undefined;
  if (parent && parent.id === tree.rootId && split?.mode === 'split' && split.axis === 'horizontal') {
    const nodes = structuredClone(tree.nodes), column = nodes.find(n => n.id === parent.id)!;
    const weights = split.weights?.length === column.children!.length ? [...split.weights] : column.children!.map(() => 1);
    const at = column.children!.indexOf(holder.id), rest = weights.reduce((sum, weight, index) => index === at ? sum : sum + weight, 0);
    weights[at] = rest * browserShares.first / (1 - browserShares.first);
    column.presentation = { ...split, weights } as LayoutNode['presentation'];
    return { rootId: tree.rootId, nodes };
  }
  return moveToEdge(tree, holder.id, 'left', kind => `${kind}-${crypto.randomUUID().slice(0, 8)}`, browserShares.first) ?? tree;
}
export const browserShares = { first: 0.2, floor: 0.15 };
// Puts a view on a saved page, unless the page has one, with one conditional write; a newer
// layout from another tab is read once and the view placed on it.
async function addToPage(client: BrowserClient, projectId: string, compositionId: string, there: (nodes: unknown[] | undefined) => string | null, place: (tree: LayoutTree | null) => LayoutTree | null, change: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const current = await client.call('composition.read', { projectId, compositionId }).catch(error => {
      if (error instanceof BrowserApiError && error.error.kind === 'not_found') return null;
      throw error;
    }) as { version: number; rootId?: string; nodes?: unknown[] } | null;
    const found = there(current?.nodes);
    if (found) return found;
    const placed = place(current?.rootId && current.nodes?.length ? { rootId: current.rootId, nodes: current.nodes as LayoutNode[] } : null);
    if (!placed) throw new Error('The view could not be placed on this page.');
    const next = keepBrowser(placed);
    try {
      await client.call('composition.apply', { projectId, compositionId, expectedVersion: current?.version ?? 0, changeId: change + '-' + crypto.randomUUID(), operations: [{ op: 'replace', rootId: next.rootId, nodes: next.nodes }] } as never);
      return there(next.nodes)!;
    } catch (error) {
      if (attempt === 0 && error instanceof BrowserApiError && error.error.kind === 'stale') continue;
      throw error;
    }
  }
}
// A view put into the group the person chose, as its last tab; an empty page takes it as its one view.
const intoGroup = (view: LayoutNode, into: string) => (tree: LayoutTree | null): LayoutTree | null =>
  tree ? addInto(tree, view as never, into, newId) : { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [view.id] }, view] };
// The Notebook beside a view, or in the group the person chose, unless the page has one.
export const addNotebook = (client: BrowserClient, projectId: string, compositionId: string, beside: string | null, into?: string) =>
  addToPage(client, projectId, compositionId, notebookOn, into ? intoGroup(notebookView(), into) : tree => withNotebook(tree, beside), 'notebook');
// Another notebook on the page: a tab beside the page's notebooks, or in the group the person
// chose. Its name counts on from the notebooks already there.
export function addNewNotebook(client: BrowserClient, projectId: string, compositionId: string, into?: string): Promise<string> {
  const key = crypto.randomUUID().slice(0, 8), id = 'notebook-' + key;
  return addToPage(client, projectId, compositionId, nodes => (nodes as LayoutNode[] | undefined)?.some(n => n.id === id) ? id : null, tree => {
    const there = notebookNodes(tree?.nodes), names = new Set(there.map(n => n.props?.title));
    let number = there.length + 1;
    while (names.has('Notebook ' + number)) number++;
    const view = { ...notebookView(id), props: { title: 'Notebook ' + number, notebook: 'nb-' + key } };
    if (into || !tree) return intoGroup(view, into ?? '')(tree);
    const last = there.at(-1), holder = last && tree.nodes.find(n => n.kind === 'group' && n.children?.includes(last.id) && (n.presentation as { mode?: string } | undefined)?.mode !== 'split');
    return holder ? addInto(tree, view as never, holder.id, newId) : addBeside(tree, view as never, null, 'right', newId);
  }, 'notebook');
}

// The sessions' variables, plots and data flow, and the servers they can run on, as views of
// their own, one of each per page. Added to a page, the first takes a column along the page's
// right side, beside a script and its console. Variables go above Plots there and Plots below;
// the data flow and the servers are tabs beside the Variables, as they answer what the sessions
// hold and where.
export type SessionView = 'variables' | 'plots' | 'flow' | 'servers';
export const sessionComponents: Record<SessionView, string> = { variables: 'rho.variables', plots: 'rho.plots', flow: 'rho.flow', servers: 'rho.servers' };
export const sessionTitles: Record<SessionView, string> = { variables: 'Variables', plots: 'Plots', flow: 'Data flow', servers: 'Servers' };
export const sessionView = (kind: SessionView): LayoutNode => ({ id: kind, kind: 'view', component: sessionComponents[kind], version: '1', props: { title: sessionTitles[kind] }, bindings: {} });
export const sessionViewOn = (kind: SessionView, nodes: unknown[] | undefined) => (nodes as LayoutNode[] | undefined)?.find(n => n.kind !== 'group' && n.component === sessionComponents[kind])?.id ?? null;
export function withSessionView(tree: LayoutTree | null, kind: SessionView): LayoutTree | null {
  const view = sessionView(kind);
  if (!tree) return { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [view.id] }, view] };
  if (sessionViewOn(kind, tree.nodes)) return null;
  const tab = kind === 'flow' || kind === 'servers' ? sessionViewOn('variables', tree.nodes) ?? sessionViewOn(kind === 'flow' ? 'servers' : 'flow', tree.nodes) : kind === 'variables' ? sessionViewOn('flow', tree.nodes) ?? sessionViewOn('servers', tree.nodes) : null;
  const holder = tab && tree.nodes.find(n => n.kind === 'group' && n.children?.includes(tab) && (n.presentation as { mode?: string } | undefined)?.mode !== 'split');
  if (holder) {
    const nodes = structuredClone(tree.nodes), group = nodes.find(n => n.id === holder.id)!;
    group.children = [...group.children!, view.id];
    return { rootId: tree.rootId, nodes: [...nodes, view] };
  }
  const other = kind === 'plots' ? sessionViewOn('variables', tree.nodes) ?? sessionViewOn('flow', tree.nodes) ?? sessionViewOn('servers', tree.nodes) : sessionViewOn('plots', tree.nodes);
  return other ? addBeside(tree, view as never, other, kind === 'plots' ? 'bottom' : 'top', newId) : addAtEdge(tree, view as never, 'right', newId);
}
export const addSessionView = (client: BrowserClient, projectId: string, compositionId: string, kind: SessionView, into?: string) =>
  addToPage(client, projectId, compositionId, nodes => sessionViewOn(kind, nodes), into ? intoGroup(sessionView(kind), into) : tree => withSessionView(tree, kind), kind);

// The project's own tools as views of a page: its Console, its folders as a file explorer, and
// one kind of its files as a list. One of each per page. The Console takes a strip along the
// page's foot, as a terminal does; the explorer and the lists share one group of tabs along its
// left side, so the files chosen in them open beside them.
export type Tool = 'console' | 'files' | `kind:${string}`;
export const toolComponents = { console: 'rho.console', files: 'rho.files', kind: 'rho.sources' } as const;
const toolKind = (tool: Tool) => tool.startsWith('kind:') ? tool.slice(5) : null;
const isTool = (tool: Tool) => (n: LayoutNode) => n.kind !== 'group' && (toolKind(tool) ? n.component === toolComponents.kind && (n.props as { kind?: string } | undefined)?.kind === toolKind(tool) : n.component === toolComponents[tool as 'console' | 'files']);
export const isBrowser = (n: { kind?: string; component?: unknown }) => n.kind !== 'group' && (n.component === toolComponents.files || n.component === toolComponents.kind);
export const toolView = (tool: Tool, title: string): LayoutNode =>
  ({ id: tool.replace(':', '-'), kind: 'view', component: toolKind(tool) ? toolComponents.kind : toolComponents[tool as 'console' | 'files'], version: '1', props: { title, ...(toolKind(tool) ? { kind: toolKind(tool) } : {}) }, bindings: {} });
export const toolOn = (tool: Tool, nodes: unknown[] | undefined) => (nodes as LayoutNode[] | undefined)?.find(isTool(tool))?.id ?? null;
export function withTool(tree: LayoutTree | null, tool: Tool, title: string): LayoutTree | null {
  const view = toolView(tool, title);
  if (!tree) return { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [view.id] }, view] };
  if (toolOn(tool, tree.nodes) || tree.nodes.some(n => n.id === view.id)) return null;
  const other = tree.nodes.find(isBrowser);
  const holder = other && tree.nodes.find(n => n.kind === 'group' && n.children?.includes(other.id) && (n.presentation as { mode?: string } | undefined)?.mode !== 'split');
  if (tool === 'console') {
    // Under the work, with the explorer still the whole height of the page beside both.
    const share = other ? paneShare(tree, other.id) : 0, under = addAtEdge(tree, view as never, 'bottom', newId, toolShares.console);
    return under && holder && share > 0 && share < 0.5 ? moveToEdge(under, holder.id, 'left', newId, share) ?? under : under;
  }
  if (holder) {
    const nodes = structuredClone(tree.nodes), group = nodes.find(n => n.id === holder.id)!;
    group.children = [...group.children!, view.id];
    return { rootId: tree.rootId, nodes: [...nodes, view] };
  }
  return addAtEdge(tree, view as never, 'left', newId, toolShares.browser);
}
// The share of the page a tool's pane takes when it is first put there.
export const toolShares = { console: 0.34, browser: browserShares.first };
export const addTool = (client: BrowserClient, projectId: string, compositionId: string, tool: Tool, title: string, into?: string) =>
  addToPage(client, projectId, compositionId, nodes => toolOn(tool, nodes), into ? intoGroup(toolView(tool, title), into) : tree => withTool(tree, tool, title), 'tool');

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
  const retained = await client.call('composition.read', { projectId, compositionId }).catch(error => {
    if (error instanceof BrowserApiError && error.error.kind === 'not_found') return null;
    throw error;
  });
  if (retained && !('deleted' in retained && retained.deleted)) throw new Error('That workspace was created in another window. Refresh and try again.');
  await client.call('composition.apply', { projectId, compositionId, expectedVersion: retained?.version ?? 0, changeId: 'new-' + compositionId + '-' + crypto.randomUUID().slice(0, 8), operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [] }] }] } as never);
  return compositionId;
}
