// The Agent map: Rho owns it, but it is drawn as an ordinary plugin entry.
// It imports only the shared frame contract, never shell modules, so another
// entry could replace it through the same registry selection.
import { counts, itemsInRange, roleOf, term, toneOf, type TaskItem, type TaskMapState } from '../../src/task-frame.js';
import type { FrameBodyProps, UiContribution, UiViewProps } from '../../src/ui-contract.js';
import './map.css';

const forms = { inline: { scale: 0, label: 'Reference' }, card: { scale: 1, label: 'Card' }, summary: { scale: 2, label: 'Strip' }, full: { scale: 3, label: 'Whole task' }, compare: { scale: 4, label: 'Compare' } };

function Step({ map, item, onOpen }: { map: TaskMapState; item: TaskItem; onOpen: () => void }) {
  const role = roleOf(map, item), tone = toneOf(map, item), p = item.progress;
  return <button className={`map-step tone-${tone}${role === 'working' ? ' now' : ''}`} onClick={onOpen} title={term(map, 'states', item.state).label}>
    <span className="map-mark" aria-hidden="true" />
    <span className="map-step-title">{item.title}</span>
    {role === 'working' && p?.total ? <span className="map-step-meter" aria-hidden="true"><span style={{ width: Math.min(100, 100 * p.done / p.total) + '%' }} /></span> : null}
    {role === 'waiting' && <span className="map-step-state">{term(map, 'states', item.state).label}</span>}
  </button>;
}

function Inline({ map, controls }: FrameBodyProps) {
  const c = counts(map), now = map.items.find(i => roleOf(map, i) === 'working'), whole = map.presentation['map:top']?.form === 'full';
  // When nothing is moving there is no status worth claiming: the question says what
  // this work is, and "settled" would only restate the Agent's own count. Execution
  // outcomes are Rho's facts and are never summarised here as if they were the same.
  return <button className="map-chip" onClick={() => controls.setForm('map:top', whole ? 'summary' : 'full', whole ? { range: 'around', span: 2, axis: 'h' } : {}).catch(() => {})}
    aria-label={whole ? 'Back to the focused view' : 'Show the whole task'}>
    <span className={'map-mark' + (now ? ' tone-agent now' : '')} aria-hidden="true" />
    <span>{now ? now.title : map.question ?? 'No question declared'}</span>
    <span className="map-chip-count">{c.total}</span>
    {c.waiting > 0 && <span className="map-chip-waiting tone-waiting"><span className="map-mark" aria-hidden="true" />{c.waiting}<span className="map-chip-waiting-label"> waiting for you</span></span>}
  </button>;
}

function CardForm({ map, controls }: FrameBodyProps) {
  const shown = map.items.filter(i => ['working', 'waiting'].includes(roleOf(map, i)));
  if (!shown.length) return <p className="map-empty">Nothing is in progress or waiting for you.</p>;
  return <ul className="map-rows">{shown.map(item => <li key={item.id}><span className={'map-role tone-' + toneOf(map, item)}>{term(map, 'states', item.state).label}</span><Step map={map} item={item} onOpen={() => controls.focus(item.id).catch(() => {})} /></li>)}</ul>;
}

function Summary({ map, params, controls }: FrameBodyProps) {
  const items = itemsInRange(map, params);
  if (!items.length) return <p className="map-empty">{params.range === 'trail' ? 'No declared item has worked in this view yet.' : 'No items in this range.'}</p>;
  return <ol className={'map-strip axis-' + (params.axis === 'v' ? 'v' : 'h')}>
    {items.map(item => <li key={item.id}><Step map={map} item={item} onOpen={() => controls.focus(item.id).catch(() => {})} /></li>)}
  </ol>;
}

// Whole task: items grouped by the stage the Agent named, each in its own card form.
function Whole({ map, Card }: FrameBodyProps) {
  const groups: { name: string; items: TaskItem[] }[] = [];
  for (const item of map.items) {
    const name = item.group ?? term(map, 'kinds', item.kind).label;
    (groups.find(g => g.name === name) ?? groups[groups.push({ name, items: [] }) - 1]).items.push(item);
  }
  const c = counts(map);
  return <div className="map-whole">
    <p className="map-whole-meta">{c.total} items · {c.working} in progress{c.waiting ? ` · ${c.waiting} waiting for you` : ''}</p>
    <div className="map-columns">{groups.map((group, index) => <section key={group.name} className="map-column" aria-label={group.name}>
      <h3><span className="map-column-index">{String(index + 1).padStart(2, '0')}</span>{group.name}</h3>
      {group.items.map(item => <Card key={item.id} itemId={item.id} />)}
    </section>)}</div>
  </div>;
}

// Two paths side by side, aligned by position. Read-only.
function Compare({ map, params }: FrameBodyProps) {
  const path = (value: unknown) => Array.isArray(value) ? value.map(step => String(map.items.find(i => i.id === step)?.title ?? step)) : [];
  const left = path(params.left), right = path(params.right), labels = Array.isArray(params.labels) ? params.labels.map(String) : ['Before', 'Now'];
  if (!left.length || !right.length) return <p className="map-empty">The Agent hasn't named two paths to compare.</p>;
  const width = Math.max(left.length, right.length);
  return <div className="map-compare" role="table" aria-label="Two paths">
    {[left, right].map((steps, row) => <div key={row} className="map-compare-row" role="row">
      <span className="map-compare-label" role="rowheader">{labels[row] ?? ''}</span>
      {Array.from({ length: width }, (_, i) => <span key={i} role="cell" className={'map-compare-step' + (left[i] !== right[i] ? ' differs' : '') + (steps[i] === undefined ? ' missing' : '')}>{steps[i] ?? 'No step'}</span>)}
    </div>)}
  </div>;
}

export function MapBody(props: FrameBodyProps) {
  switch (props.form) {
    case 'inline': return <Inline {...props} />;
    case 'card': return <CardForm {...props} />;
    case 'full': return <Whole {...props} />;
    case 'compare': return <Compare {...props} />;
    default: return <Summary {...props} />;
  }
}

export function hiddenNote(form: string, params: Record<string, unknown>, { map }: { map: TaskMapState }) {
  const total = map.items.length;
  if (form === 'card') { const shown = map.items.filter(i => ['working', 'waiting'].includes(roleOf(map, i))).length; return total > shown ? `${total - shown} other items hidden` : ''; }
  if (form === 'summary') {
    const shown = itemsInRange(map, params);
    if (params.range === 'trail') return `Only items in this view · ${total - shown.length} elsewhere`;
    if (params.range === 'around') {
      const before = Math.max(0, map.items.indexOf(shown[0])), after = Math.max(0, total - before - shown.length);
      return [before && `${before} earlier`, after && `${after} later`].filter(Boolean).join(' and ') + (before || after ? ' items hidden' : '');
    }
  }
  if (form === 'compare') return 'Read-only: comparing changes nothing';
  return '';
}

// Placed in a layout, the map draws the form named by its props.
function MapView({ view, frame }: UiViewProps) {
  if (!frame) return <p className="map-empty">The task map isn't available in this tab.</p>;
  const form = typeof view.props.form === 'string' && view.props.form in forms ? view.props.form : 'card';
  return <div className="map-in-layout"><MapBody {...frame} form={form} params={(view.props.params as Record<string, unknown>) ?? {}} /></div>;
}

export const entry: UiContribution = {
  entryVersion: '0.1-draft', owner: 'rho', package: '@rho-workspace/local', packageVersion: '0.4.0',
  component: 'rho.agent-map', componentVersion: '0.1.0', displayName: 'Agent map',
  propsSchema: { type: 'object', properties: { title: { type: 'string' }, form: { type: 'string' }, params: { type: 'object' } } },
  bindings: {}, requiredOperations: ['task.map.read'], commands: [], selection: [],
  forms, Body: MapBody, hiddenNote, View: MapView,
};
