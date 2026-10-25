// DOM-free projection for the real browser. The expression reducer alone decides
// attention, pacing, proposals and return digests. This adapter maps its object
// references to owner views, retaining descriptors rather than copying buffers.
import type { CompositionSummary, ViewDescription, WorkspaceSnapshot } from './browser.js';
import { actExpression, expressionScreen, observeExpression, settleExpression, startExpression, type ArtifactRef, type ExpressionState, type Fact, type PersonIntent, type Trace } from './expression.js';
import { liveIndex, referenceFor, snapshotTrace, type LiveIndex, type RunSummary, type TaskMap } from './live-trace.js';
export const liveLimits = { maxViews: 64, maxEvidence: 256, maxCheckpointBytes: 1024 * 1024 };
export interface LiveWorkspace {
  format: 1; expression: ExpressionState; index: LiveIndex; layout: CompositionSummary;
  latest: CompositionSummary; held: Record<string, ViewDescription>; refs: Record<string, ArtifactRef>; available: ViewDescription[];
  trace: Trace; evidence: Fact[]; gap: boolean; limit: string; active: string; names: Record<string, string>; preview?: string;
}
const objectOf = (ref: ArtifactRef) => ref.object ?? 'artifact:' + ref.artifact;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function ownerViews(snapshot: WorkspaceSnapshot): ViewDescription[] {
  const editor = snapshot.catalog?.components.find(c => c.id === 'rho.editor');
  const views: ViewDescription[] = editor ? snapshot.documents.map(d => ({ id: 'source:' + d.id, component: editor.id, version: editor.version, props: { title: d.path }, bindings: { document: { kind: 'live-document', documentId: d.id } } })) : [];
  for (const r of snapshot.resources) {
    const owner = snapshot.catalog?.components.find(c => c.id === (r.kind === 'table' ? 'rho.table' : r.kind === 'media' ? 'rho.media' : ''));
    if (!owner) continue;
    const key = Object.keys(owner.bindings)[0];
    if (key) views.push({ id: 'object:' + r.id.slice(0, 32) + ':' + r.version.slice(0, 32), component: owner.id, version: owner.version, props: { title: r.path.split('/').at(-1) }, bindings: { [key]: { id: r.id, version: r.version } } });
  }
  return views;
}
export function startLive(snapshot: WorkspaceSnapshot, runs: RunSummary[], composition: CompositionSummary, map?: TaskMap | null): LiveWorkspace {
  const index = liveIndex(), live = snapshotTrace(snapshot, runs, composition, index, map), expression = startExpression('working');
  for (const fact of live.trace.facts) observeExpression(expression, live.trace, fact);
  expression.attention = 'following'; expression.suggestions = []; expression.moves = [];
  expression.views = composition.views.flatMap(v => {
    const ref = referenceFor(v, live.refs);
    return ref ? [{ id: v.id, object: objectOf(ref), run: ref.run, ...(ref.version ? { version: ref.version } : {}), openedBy: 'agent' as const, pinned: !!v.protected, preview: false, selection: [], newer: null }] : [];
  });
  expression.active = expression.views[0]?.id ?? null;
  return { format: 1, expression, index, layout: structuredClone(composition), latest: structuredClone(composition), held: {}, refs: live.refs, available: ownerViews(snapshot), trace: live.trace, evidence: live.trace.facts.slice(-liveLimits.maxEvidence), gap: live.gap, limit: '', active: composition.views[0]?.id ?? '', names: live.names };
}
function adopt(state: LiveWorkspace) {
  const next = structuredClone(state.latest), remap = new Map<string, string>();
  for (const v of next.views) {
    const held = state.held[v.id];
    if (held && !same(held.bindings, v.bindings)) remap.set(v.id, 'new:' + v.id.slice(0, 70) + ':' + next.version);
  }
  next.views = next.views.map(v => ({ ...v, id: remap.get(v.id) ?? v.id }));
  if (next.nodes) next.nodes = next.nodes.map(n => n.kind === 'view' ? { ...n, id: remap.get(n.id) ?? n.id } : { ...n, children: n.children.map(id => remap.get(id) ?? id) });
  for (const held of Object.values(state.held)) if (!next.views.some(v => v.id === held.id)) {
    next.views.push(held);
    const root = next.nodes?.find(n => n.kind === 'group' && n.id === next.rootId);
    if (root?.kind === 'group') { root.children.push(held.id); if (root.presentation?.weights) root.presentation.weights.push(1); next.nodes!.push({ ...held, kind: 'view' }); }
  }
  if (next.views.length > liveLimits.maxViews) { state.limit = 'The 64-view presentation limit was reached. Existing views are kept; close or unpin views before accepting another layout.'; return; }
  state.layout = next; state.preview = undefined;
}
function projectMove(state: LiveWorkspace, since: number) {
  const moves = state.expression.moves.slice(since);
  if (moves.some(m => m.rule === 'agent-layout' || m.rule === 'accept')) adopt(state);
  const current = state.expression.views.find(v => v.id === state.expression.active);
  if (!current || !moves.length) return;
  const candidates = [...state.layout.views, ...state.latest.views, ...(state.available ?? [])];
  const target = candidates.find(v => {
    const ref = referenceFor(v, state.refs);
    return ref && objectOf(ref) === current.object && (current.run === null || ref.run === current.run) && (!current.version || ref.version === current.version);
  });
  if (target) {
    let id = target.id;
    const existing = state.layout.views.find(v => v.id === id);
    if (existing && !same(existing.bindings, target.bindings)) id = 'preview:' + id.slice(0, 70) + ':' + state.latest.version;
    if (!state.layout.views.some(v => v.id === id)) {
      if (state.layout.views.length >= liveLimits.maxViews) { state.limit = 'The 64-view presentation limit was reached; the new object remains in recorded evidence.'; return; }
      const kept = state.layout.views.filter(v => v.id !== state.preview || state.held[v.id]);
      state.layout = { ...state.layout, views: [...kept, { ...target, id }] };
      if (current.preview) state.preview = id;
    }
    state.active = id;
  } else if (current.object.startsWith('run:')) {
    const operationId = state.names[current.object];
    if (!operationId) return;
    const id = 'execution:' + operationId;
    if (!state.layout.views.some(v => v.id === id) && state.layout.views.length < liveLimits.maxViews) { state.layout = { ...state.layout, views: [...state.layout.views.filter(v => (v.component !== 'rho.execution' && v.id !== state.preview) || state.held[v.id]), { id, component: 'rho.execution', version: '1', props: { title: operationId, operationId }, bindings: {} }] }; state.preview = id; }
    if (state.layout.views.some(v => v.id === id)) state.active = id;
  }
}
export function advanceLive(state: LiveWorkspace, snapshot: WorkspaceSnapshot, runs: RunSummary[], composition: CompositionSummary, now: number, map?: TaskMap | null) {
  const live = snapshotTrace(snapshot, runs, composition, state.index, map), since = state.expression.moves.length;
  state.latest = structuredClone(composition); state.refs = live.refs; state.names = live.names; state.trace = live.trace;
  state.available = ownerViews(snapshot);
  state.gap ||= live.gap;
  for (const fact of live.trace.facts) observeExpression(state.expression, live.trace, fact, now);
  state.evidence.push(...live.trace.facts); state.evidence = state.evidence.slice(-liveLimits.maxEvidence);
  projectMove(state, since);
  // A non-Agent composition is a direct person's/operator's saved layout, not an
  // Agent suggestion. The same retained-version rule still applies.
  if (!composition.author?.startsWith('agent:') && state.layout.version !== composition.version) adopt(state);
  state.expression.moves = state.expression.moves.slice(-32);
}
export function actLive(state: LiveWorkspace, intent: PersonIntent) {
  const since = state.expression.moves.length;
  actExpression(state.expression, state.trace, intent); projectMove(state, since);
}
// The person closes a view they held: it stops being kept against the owner's layout, so
// their own change to that layout takes effect. Only the person's command releases a hold.
export function releaseView(state: LiveWorkspace, id: string) {
  delete state.held[id];
}
export function holdView(state: LiveWorkspace, id: string) {
  const descriptor = state.layout.views.find(v => v.id === id);
  if (!descriptor) return;
  state.held[id] = structuredClone(descriptor); state.active = id;
  const ref = referenceFor(descriptor, state.refs);
  actLive(state, ref ? { kind: 'open', target: objectOf(ref), run: ref.run, version: ref.version } : { kind: 'unfollow' });
  state.active = id;
}
export function tickLive(state: LiveWorkspace, now: number) {
  const since = state.expression.moves.length; settleExpression(state.expression, now); projectMove(state, since);
}
export function screenOf(state: LiveWorkspace) { return expressionScreen(state.expression); }
