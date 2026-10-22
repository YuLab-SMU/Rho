import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrowserApiError, type BrowserClient, type CompositionSummary, type WorkspaceSnapshot } from '../src/browser.js';
import { authorLabel, emptyTaskMap, itemTarget, mapDefaults, nearestForm, presentationOf, standardForms, term, toneOf, zoom, zoomOrder, type FormDeclarations, type PresentationRecord, type TaskItem, type TaskMapState } from '../src/task-frame.js';
import type { FrameBodyProps, FrameContext, FrameControls, UiContribution } from '../src/ui-contract.js';
import { pluginPresentation } from '../src/plugin-presentation.js';
import { registry } from './registry.js';
import './frame.css';

// Rho's item frame. Every entry's body is drawn inside it: Rho writes the header
// (kind, state, the Agent's title, real progress) and footer (what is hidden,
// the declared next step, the plugin), the plugin writes only the body. The Agent
// map is an entry like any other; this file hosts it and supplies its controls.
export const mapComponent = 'rho.agent-map';
const mapEntry = () => registry.entries.find(e => e.component === mapComponent);
// Rho's generic body stands in for forms an entry does not draw itself.
const genericForms: FormDeclarations = { inline: standardForms.inline, card: standardForms.card, summary: standardForms.summary };
const formLabel = (forms: FormDeclarations, form: string) => forms[form]?.label ?? standardForms[form]?.label ?? form;
// "Keep" dismisses an attribution for this tab only; the record stays in the map.
const kept = new Set<string>();

interface Runtime extends Omit<FrameContext, 'Card'> {
  snapshot: WorkspaceSnapshot; client: BrowserClient; composition?: CompositionSummary; canSteer: boolean;
  failure: string; run: (work: Promise<void>) => void; open: (item: TaskItem) => void;
}
const Frame = createContext<Runtime | null>(null);

export function useTaskFrame({ snapshot, client, principalId, composition, activeViewId }: { snapshot: WorkspaceSnapshot; client: BrowserClient; principalId?: string; composition?: CompositionSummary; activeViewId?: string }) {
  const [local, setLocal] = useState<TaskMapState | null>(null), [failure, setFailure] = useState('');
  const served = snapshot.taskMap ?? null, projectId = snapshot.project.id;
  const localFor = useRef<Record<string, TaskMapState>>({});
  // Our own write can arrive before the observation event; keep the newer copy.
  const map = local && local.version > (served?.version ?? -1) && local === localFor.current[projectId] ? local : served;
  const latest = useRef(map); latest.current = map;
  const allowed = (method: string) => snapshot.catalog.operations.some(o => o.method === method && o.authorized && o.state === 'available');
  const call = useCallback(async (method: 'task.map.present' | 'task.map.respond', body: Record<string, unknown>) => {
    const input: any = { projectId, changeId: crypto.randomUUID(), expectedVersion: latest.current?.version ?? 0, ...body };
    let result;
    try { result = await client.call(method, input); }
    catch (error) {
      // A stale rejection applied nothing: retry once on the current version with
      // the same identity. An unconfirmed transport retries the identical request.
      if (error instanceof BrowserApiError && error.error.kind === 'stale') result = await client.call(method, { ...input, expectedVersion: (await client.call('task.map.read', { projectId })).version });
      else if (!(error instanceof BrowserApiError)) result = await client.call(method, input);
      else throw error;
    }
    // Chained actions (focus, then form) must use this version, not wait for a render.
    latest.current = result; localFor.current[projectId] = result; setLocal(result); setFailure('');
  }, [client, projectId]);
  const controls = useMemo<FrameControls>(() => {
    const params = (target: string) => latest.current?.presentation[target]?.params ?? {};
    return {
      setForm: (target, form, next) => call('task.map.present', { target, form, ...(next ? { params: next } : {}) }),
      setSubset: (target, form, subset) => call('task.map.present', { target, form, params: { ...params(target), subset } }),
      focus: item => call('task.map.present', { target: 'map:top', focus: item }),
      pin: (target, form, next) => call('task.map.respond', { target, action: 'pin', form, params: next ?? params(target) }),
      unpin: target => call('task.map.respond', { target, action: 'unpin' }),
      revert: target => call('task.map.respond', { target, action: 'revert' }),
      accept: (target, suggestionId) => call('task.map.respond', { target, action: 'accept', suggestionId }),
      dismiss: (target, suggestionId) => call('task.map.respond', { target, action: 'dismiss', suggestionId }),
      observe: () => latest.current ?? emptyTaskMap(),
    };
  }, [call]);
  const run = useCallback((work: Promise<void>) => { work.catch(error => setFailure(error instanceof Error ? error.message : 'The change could not be confirmed. The map is shown as last read.')); }, []);
  const open = useCallback((item: TaskItem) => run((async () => {
    await controls.focus(item.id);
    if (latest.current?.presentation['map:top']?.form === 'full') await controls.setForm('map:top', 'summary', mapDefaults.top.params);
  })()), [controls, run]);
  if (!map || !allowed('task.map.read')) return null;
  return { map, controls, principalId, activeViewId, snapshot, client, composition, canSteer: allowed('task.map.present') && allowed('task.map.respond'), failure, run, open } satisfies Runtime;
}
export function FrameProvider({ value, children }: { value: Runtime | null; children: ReactNode }) { return <Frame.Provider value={value}>{children}</Frame.Provider>; }
export function useFrameContext(): (FrameContext & { item?: TaskItem }) | null {
  const r = useContext(Frame);
  return r ? { map: r.map, controls: r.controls, Card, principalId: r.principalId, activeViewId: r.activeViewId } : null;
}
export function itemForView(map: TaskMapState | undefined | null, viewId: string) { return map?.items.find(i => i.view === viewId); }

function entryFor(view?: { component: string; version: string }) { return view ? registry.entries.find(e => e.component === view.component && e.componentVersion === view.version) : undefined; }
function sourceName(r: Runtime, entry?: UiContribution, component?: string) {
  if (entry?.displayName) return entry.displayName;
  const descriptor = r.snapshot.catalog.components.find(c => c.id === component), plugin = r.snapshot.catalog.plugins.find(p => p.id === descriptor?.pluginId);
  return plugin ? pluginPresentation(plugin).displayName : 'From the Agent';
}

function Attribution({ target, record, forms = standardForms }: { target: string; record?: PresentationRecord; forms?: FormDeclarations }) {
  const r = useContext(Frame)!, [, refresh] = useState(0);
  if (!record || record.human || kept.has(record.changeId)) return null;
  return <div className="rho-attribution" role="status">
    <span>{authorLabel(record.author, r.principalId)} changed this to {formLabel(forms, record.form)}{record.reason ? ': ' + record.reason : '.'}</span>
    <button className="rho-chip-button" onClick={() => { kept.add(record.changeId); refresh(v => v + 1); }}>Keep</button>
    {r.canSteer && <button className="rho-chip-button" onClick={() => r.run(r.controls.revert(target))}>Revert</button>}
  </div>;
}
function Suggestions({ target, forms }: { target: string; forms: FormDeclarations }) {
  const r = useContext(Frame)!;
  return <>{r.map.suggestions.filter(s => s.target === target).map(s => <div key={s.id} className="rho-suggestion" role="status">
    <span>{authorLabel(s.author, r.principalId)} suggests {formLabel(forms, s.form)}{s.reason ? ': ' + s.reason : ''}{s.merged > 1 ? ` (${s.merged} requests merged)` : ''}. {s.cause === 'pinned' ? "You pinned this, so it wasn't changed." : 'Held back to keep the screen steady.'}</span>
    {r.canSteer && <><button className="rho-chip-button" onClick={() => r.run(r.controls.accept(target, s.id))}>Apply</button><button className="rho-chip-button" onClick={() => r.run(r.controls.dismiss(target, s.id))}>Dismiss</button></>}
  </div>)}</>;
}
function Pin({ target, form, params, record }: { target: string; form: string; params: Record<string, unknown>; record?: PresentationRecord }) {
  const r = useContext(Frame)!;
  if (!r.canSteer) return null;
  const pinned = !!record?.pinned;
  return <button className={'rho-pin' + (pinned ? ' pinned' : '')} aria-pressed={pinned} title={pinned ? 'Pinned: the Agent can only suggest changes here' : 'Pin this form so the Agent only suggests changes'}
    onClick={() => r.run(pinned ? r.controls.unpin(target) : r.controls.pin(target, form, params))}>{pinned ? 'Pinned' : 'Pin'}</button>;
}
function Progress({ item }: { item: TaskItem }) {
  const p = item.progress;
  if (!p) return null;
  return <span className="rho-item-progress">{p.done}{p.total ? ' / ' + p.total : ''}{p.unit ? ' ' + p.unit : ''}</span>;
}

// One item, drawn by its own plugin body when the plugin draws this form.
// A requested inline form is a reference and ignores the item's presentation.
function Card({ itemId, form: requested }: { itemId: string; form?: string }) {
  const r = useContext(Frame);
  // The body reports what it leaves out once it has read; a note belongs to the
  // form and parameters it was reported for.
  const [reported, setReported] = useState<{ key: string; note: string } | null>(null);
  const drawn = useRef('');
  const reportHidden = useCallback((note: string) => setReported(prev => prev?.key === drawn.current && prev.note === note ? prev : { key: drawn.current, note }), []);
  const item = r?.map.items.find(i => i.id === itemId);
  if (!r || !item) return null;
  const view = item.view ? r.composition?.views.find(v => v.id === item.view) : undefined, entry = entryFor(view);
  const own = entry?.Body && entry.forms ? Object.fromEntries(Object.entries(entry.forms).filter(([, f]) => f.scale < standardForms.full.scale)) : {};
  const forms = Object.keys(own).length ? own : genericForms, target = itemTarget(item.id);
  const shown = presentationOf(r.map, target, { form: requested ?? 'card', params: {} });
  const form = requested === 'inline' ? 'inline' : nearestForm(forms, shown.form) ?? 'card';
  const plugin = !!entry?.Body && !!own[form], Body = plugin ? entry!.Body! : GenericBody;
  drawn.current = form + '\0' + JSON.stringify(shown.params);
  const hidden = plugin ? (reported?.key === drawn.current ? reported.note : entry!.hiddenNote?.(form, shown.params, { item, map: r.map }) ?? '') : genericHidden(item, form);
  const tone = toneOf(r.map, item), state = term(r.map, 'states', item.state), smaller = zoom(forms, form, -1), larger = zoom(forms, form, 1);
  const bound = view ? { viewId: view.id, view, projectId: r.snapshot.project.id, snapshot: r.snapshot, client: r.client, active: false, contextTarget: null, principalId: r.principalId } : undefined;
  const present = r.canSteer ? (params: Record<string, unknown>, next = form) => r.run(r.controls.setForm(target, next, params)) : undefined;
  const body = <Body form={form} params={shown.params} item={item} map={r.map} controls={r.controls} Card={Card} principalId={r.principalId} activeViewId={r.activeViewId}
    view={bound} present={present} reportHidden={plugin ? reportHidden : undefined} />;
  if (form === 'inline') return <button className={`rho-item-inline tone-${tone}`} onClick={() => r.run(r.controls.setForm(target, larger ?? 'card'))} title={item.title + ' · ' + state.label}>
    <span className="rho-dot" aria-hidden="true" />
    {plugin ? <><span className="visually-hidden">{item.title}: </span>{body}</> : <>{item.title}<span className="rho-item-inline-state">{state.label}</span></>}
  </button>;
  const focused = r.map.focus?.item === item.id;
  return <article className={`rho-item tone-${tone}${focused ? ' focused' : ''}`} data-form={form} aria-label={item.title}>
    <header className="rho-item-head">
      <div className="rho-item-meta">
        <span className="rho-item-kind">{term(r.map, 'kinds', item.kind).label}</span>
        <span className="rho-item-state"><span className="rho-dot" aria-hidden="true" />{state.label}</span>
        <Progress item={item} />
        <span className="rho-spacer" />
        {r.canSteer && <span className="rho-zoom" role="group" aria-label={'Size of ' + item.title}>
          <button aria-label="Smaller" disabled={!smaller} onClick={() => smaller && r.run(r.controls.setForm(target, smaller))}>−</button>
          <button aria-label={larger ? 'Larger' : 'Open in the workspace'} disabled={!larger && !view} onClick={() => larger ? r.run(r.controls.setForm(target, larger)) : r.open(item)}>+</button>
        </span>}
      </div>
      <h3 className="rho-item-title">{item.title}</h3>
    </header>
    <Attribution target={target} record={shown.record} forms={forms} />
    <Suggestions target={target} forms={forms} />
    <div className="rho-item-body">{body}</div>
    <footer className="rho-item-foot">
      <span>{hidden || (r.map.next.includes(item.id) ? 'Declared next step' : '')}</span>
      {view && <button className="rho-link" onClick={() => r.open(item)}>Open</button>}
      <span className="rho-item-source">{sourceName(r, entry, view?.component)}</span>
    </footer>
  </article>;
}
function genericHidden(item: TaskItem, form: string) {
  const lines = item.lines?.length ?? 0;
  return form === 'card' && lines > 3 ? `${lines - 3} more lines in Summary` : '';
}
// Facts the Agent reports sit above its judgments; the two are never mixed.
export function GenericBody({ form, item }: FrameBodyProps) {
  if (!item) return null;
  const lines = item.lines ?? [], limit = form === 'card' ? 3 : 12;
  const facts = lines.filter(l => !l.judgment), judgments = lines.filter(l => l.judgment);
  const shownFacts = facts.slice(0, limit), shownJudgments = judgments.slice(0, Math.max(0, limit - shownFacts.length));
  const p = item.progress;
  return <div className="rho-generic">
    {item.summary && <p className="rho-generic-summary">{item.summary}</p>}
    {p?.total ? <div className="rho-meter" role="meter" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label="Reported progress"><span style={{ width: Math.min(100, 100 * p.done / p.total) + '%' }} /></div> : null}
    {shownFacts.map((line, i) => <div key={'f' + i} className={'rho-line tone-' + (line.tone ?? 'neutral')}>{line.label && <span className="rho-line-label">{line.label}</span>}<span>{line.text}</span></div>)}
    {shownJudgments.length > 0 && <div className="rho-judgments">{shownJudgments.map((line, i) => <div key={'j' + i} className={'rho-line tone-' + (line.tone ?? 'agent')}><span className="rho-line-label">{line.label ?? 'Agent judgment'}</span><span>{line.text}</span></div>)}</div>}
  </div>;
}

// The Agent map, an ordinary entry, hosted in a shell placement.
export function MapPlacement({ slot, inline = false, compact = false }: { slot: string; inline?: boolean; compact?: boolean }) {
  const r = useContext(Frame), entry = mapEntry();
  if (!r || !entry?.Body || !r.map.items.length) return null;
  const target = 'map:' + slot, forms = entry.forms ?? standardForms;
  const shown = presentationOf(r.map, target, mapDefaults[slot] ?? { form: 'summary', params: {} });
  const form = inline ? 'inline' : nearestForm(forms, shown.form) ?? 'summary';
  const params = !inline && shown.params.range === 'trail' && shown.params.view === undefined ? { ...shown.params, view: r.activeViewId } : inline ? {} : shown.params;
  const Body = entry.Body;
  const body = <Body form={form} params={params} map={r.map} controls={r.controls} Card={Card} principalId={r.principalId} activeViewId={r.activeViewId} />;
  if (inline) return <div className="rho-map-inline">{body}</div>;
  if (form === 'inline') return null;
  const next = r.map.next.map(id => r.map.items.find(i => i.id === id)?.title).filter(Boolean);
  const choose = (name: string) => r.run(r.controls.setForm(target, name, name === form ? params : name === mapDefaults[slot]?.form ? mapDefaults[slot].params : {}));
  const switcher = r.canSteer && <span className="rho-forms" role="group" aria-label="Map form">
    {zoomOrder(forms).map(name => <button key={name} aria-pressed={name === form} onClick={() => choose(name)}>{formLabel(forms, name)}</button>)}
  </span>;
  const hidden = entry.hiddenNote?.(form, params, { map: r.map }) ?? '';
  // Secondary placements keep to one line: their body, what they hide and their controls.
  if (compact && form === 'summary') return <section className={`rho-map rho-map-${slot} compact`} data-form={form} aria-label="Agent map trail">
    <div className="rho-map-head"><span className="rho-map-name">This view's trail</span><div className="rho-map-body">{body}</div><span className="rho-map-hidden">{hidden}</span>{switcher}<Pin target={target} form={form} params={params} record={shown.record} /></div>
    <Attribution target={target} record={shown.record} forms={forms} />
    <Suggestions target={target} forms={forms} />
  </section>;
  return <section className={`rho-map rho-map-${slot}`} data-form={form} aria-label="Agent map">
    <header className="rho-map-head">
      <span className="rho-map-name">Agent map</span>
      {r.map.question && form !== 'card' && <span className="rho-map-question">{r.map.question}</span>}
      <span className="rho-spacer" />
      {switcher}
      <Pin target={target} form={form} params={params} record={shown.record} />
    </header>
    <Attribution target={target} record={shown.record} forms={forms} />
    <Suggestions target={target} forms={forms} />
    {r.failure && <p className="rho-map-failure" role="alert">{r.failure}</p>}
    <div className="rho-map-body">{body}</div>
    <footer className="rho-item-foot">
      <span>{hidden}</span>
      {next.length > 0 && <span className="rho-next">Next, as the Agent declared: {next.join(', ')}</span>}
      <span className="rho-item-source">{entry.displayName ?? 'Agent map'}</span>
    </footer>
  </section>;
}

// A slim header above a full-form layout view that draws a declared item.
export function ViewItemHeader({ item }: { item: TaskItem }) {
  const r = useContext(Frame);
  if (!r) return null;
  const record = r.map.presentation[itemTarget(item.id)];
  return <div className={`rho-view-item tone-${toneOf(r.map, item)}`}>
    <span className="rho-item-kind">{term(r.map, 'kinds', item.kind).label}</span>
    <span className="rho-item-state"><span className="rho-dot" aria-hidden="true" />{term(r.map, 'states', item.state).label}</span>
    <strong>{item.title}</strong><Progress item={item} />
    {r.map.next.includes(item.id) && <span className="rho-next">Declared next step</span>}
    <Attribution target={itemTarget(item.id)} record={record} />
  </div>;
}
