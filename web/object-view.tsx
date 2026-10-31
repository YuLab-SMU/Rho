import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { languageNames, type Language } from './explore.js';
import { Icon, type IconName } from './icons.js';
import { clock } from './timeline-kinds.js';
import './object-view.css';

// One value of a live session, as its session describes it: what kind of thing it is, its facts,
// and a page of its rows, elements or parts. A part opens in place; the trail above leads back.
// The view reads the value again when the sessions change while it is shown, and once more when
// it is shown again, and says when the value it shows was read: while a cell runs, or after the
// value or its session is gone, the last reading stays, marked as such.
type Reading = RhoOutput<'kernel.inspect'>;
type Described = NonNullable<Reading['object']>;
type Table = NonNullable<Described['table']>;
type Sort = { column: number; descending: boolean };
export const objectViewLimits = { rows: 50 };
const kinds: Record<Described['kind'], { icon: IconName; name: string }> = {
  table: { icon: 'table', name: 'Table' }, model: { icon: 'chart', name: 'Model' }, vector: { icon: 'grid', name: 'Vector' },
  list: { icon: 'list', name: 'List' }, function: { icon: 'code', name: 'Function' }, value: { icon: 'braces', name: 'Value' }, other: { icon: 'braces', name: 'Value' },
};
const when = (iso: string) => clock(Date.parse(iso));

export function ObjectView({ client, snapshot, language, name, onUse }: { client: BrowserClient; snapshot: WorkspaceSnapshot; language: Language; name: string; onUse?: (expression: string) => void }) {
  const projectId = snapshot.project.id, session = languageNames[language];
  const [path, setPath] = useState<number[]>([]);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<Sort | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [kept, setKept] = useState<{ key: string; reading: Reading } | null>(null);
  const [problem, setProblem] = useState('');
  const [again, setAgain] = useState(0);
  const at = JSON.stringify(path), key = JSON.stringify([at, offset, sort]);
  // A view the shell keeps hidden behind another tab has no width, and reads nothing.
  const root = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(true);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setVisible(entry.contentRect.width > 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The sessions changed (a cell ran, a session ended): read again. A reading answered while
  // the view moved on is dropped.
  useEffect(() => {
    if (!visible) return;
    let live = true;
    client.call('kernel.inspect', { projectId, language, name, path, offset, limit: objectViewLimits.rows, ...(sort ? { sort } : {}) }).then(answer => {
      if (!live) return;
      setReading(answer); setProblem('');
      if (answer.state === 'shown') setKept({ key, reading: answer });
    }, error => { if (live) setProblem(error instanceof Error ? error.message : 'The value could not be read.'); });
    return () => { live = false; };
  }, [key, snapshot.cursor, again, visible]);
  const go = (next: number[]) => { setPath(next); setOffset(0); setSort(null); };
  const shown = kept && JSON.parse(kept.key)[0] === at ? kept.reading : null, object = shown?.object ?? null;
  // What the newest reading says when it is not the value itself.
  const note = !reading ? null : reading.state === 'shown' ? null
    : reading.state === 'busy' ? (object ? `A cell is running. This is ${object.expression} as it was after cell ${shown!.afterCell}.` : 'A cell is running. The value shows when it ends.')
    : reading.state === 'none' ? `There is no live ${session} session${object ? `; this is ${object.expression} as it was after cell ${shown!.afterCell}, and it is gone now` : ''}. A cell of ${session} starts a new session.`
    : reading.state === 'missing' ? `${reading.problem ?? name + ' is not in the session.'}${object ? ` This is it as it was after cell ${shown!.afterCell}.` : ''}`
    : reading.state === 'ended' ? `The ${session} session ended while the value was read.`
    : reading.problem ?? 'The value could not be read.';
  const trail = object?.trail ?? [];
  return <div className={'ov' + (note && object ? ' stale' : '')} ref={root}>
    <header className="ov-head">
      <nav className="ov-trail" aria-label="Where in the value">
        <button className="ov-crumb" disabled={!path.length} onClick={() => go([])}>{name}</button>
        {trail.map((step, i) => <span key={i}><span className="ov-sep" aria-hidden="true">›</span><button className="ov-crumb" disabled={i === trail.length - 1} onClick={() => go(path.slice(0, i + 1))}>{step.name}</button></span>)}
      </nav>
      {object && <p className="ov-meta"><Icon name={kinds[object.kind].icon} size={13} stroke={2} /><span>{kinds[object.kind].name}</span><span>{object.type}{object.size && object.kind !== 'model' ? ' · ' + object.size : ''}</span>
        <span title={'Read ' + new Date(shown!.readAt).toLocaleString()}>{session} · after cell {shown!.afterCell} · {when(shown!.readAt)}</span></p>}
      {object && <div className="ov-actions"><code className="ov-expression" title="The code that reaches this value">{object.expression}</code>
        {onUse && (reading?.state === 'shown' || reading?.state === 'busy') && <button className="secondary" onClick={() => onUse(object.expression)}>Use in Notebook</button>}</div>}
    </header>
    {(note || problem) && <p className={'ov-note' + (reading?.state === 'busy' ? '' : ' problem')} role="status">{problem || note}
      {(problem || ['timeout', 'failed', 'ended'].includes(reading?.state ?? '')) && <button className="text-button" onClick={() => setAgain(n => n + 1)}>Read again</button>}</p>}
    {!object ? (!reading && !problem ? <p className="ov-empty">Reading {name}…</p> : null) : <Body object={object} sort={sort} onSort={column => { setSort(s => s?.column !== column ? { column, descending: false } : !s.descending ? { column, descending: true } : null); setOffset(0); }} onPage={setOffset} onPart={index => go([...path, index])} />}
  </div>;
}

function Body({ object, sort, onSort, onPage, onPart }: { object: Described; sort: Sort | null; onSort: (column: number) => void; onPage: (offset: number) => void; onPart: (index: number) => void }) {
  const facts = object.facts.length > 0 && <dl className="ov-facts">{object.facts.map((f, i) => <div key={i}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>;
  const text = (open: boolean) => object.text && <Folded title={object.text.label} open={open}><pre className="ov-text">{object.text.text}</pre>{object.text.cut && <p className="ov-small">Only the first part is shown.</p>}</Folded>;
  const parts = (open: boolean) => object.children && <Folded title={`Parts · ${object.children.total}`} open={open}><Parts children={object.children} onPart={onPart} onPage={object.kind === 'list' ? onPage : undefined} /></Folded>;
  if (object.kind === 'table') return <>{facts}{object.table && <TableSection table={object.table} sort={sort} onSort={onSort} onPage={onPage} noun="rows" />}</>;
  if (object.kind === 'model') return <>{facts}{object.table && <TableSection title="Coefficients" table={object.table} sort={sort} onSort={onSort} onPage={onPage} noun="terms" plain />}{text(false)}{parts(false)}</>;
  if (object.kind === 'vector') return <>{facts}{object.table && <TableSection title="Counts" table={object.table} noun="values" plain />}{object.values && <Values values={object.values} onPage={onPage} />}{parts(false)}</>;
  if (object.kind === 'value') return <p className="ov-value">{object.values?.items[0]?.value}</p>;
  if (object.kind === 'list') return <>{facts}{object.children ? <Parts children={object.children} onPart={onPart} onPage={onPage} /> : text(true)}</>;
  return <>{facts}{text(true)}{parts(false)}</>;
}

function Folded({ title, open, children }: { title: string; open: boolean; children: ReactNode }) {
  return <details className="ov-fold" open={open}><summary>{title}</summary>{children}</details>;
}

function Pager({ offset, count, total, noun, onPage, step }: { offset: number; count: number; total: number; noun: string; onPage?: (offset: number) => void; step: number }) {
  if (total <= count && !offset) return null;
  return <div className="ov-pager">
    <span>{count ? `${offset + 1}–${offset + count}` : 0} of {total} {noun}</span>
    {onPage && <><button className="text-button" disabled={!offset} onClick={() => onPage(Math.max(0, offset - step))}>Previous</button>
      <button className="text-button" disabled={offset + count >= total} onClick={() => onPage(offset + step)}>Next</button></>}
  </div>;
}

// Column names with their type and a short summary; a name sorts by it, a second time the other
// way, a third time back to the order the rows have. A table read as a result (coefficients,
// counts) shows its names alone, so that its columns fit beside each other.
function TableSection({ table, title, sort, onSort, onPage, noun, plain = false }: { table: Table; title?: string; sort?: Sort | null; onSort?: (column: number) => void; onPage?: (offset: number) => void; noun: string; plain?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [table.offset, sort?.column, sort?.descending]);
  return <section className="ov-section">
    {title && <h3>{title}</h3>}
    <div className="ov-table-scroll" ref={scroller}><table className="ov-table">
      <thead><tr><th className="ov-rowlabel" scope="col"><span className="visually-hidden">Row</span></th>
        {table.columns.map((c, j) => { const sorted = sort?.column === j ? (sort.descending ? 'descending' : 'ascending') : undefined;
          return <th key={j} scope="col" aria-sort={sorted} className={c.numeric ? 'num' : ''}>
            {onSort ? <button className="ov-col" title={`Sort by ${c.name}`} onClick={() => onSort(j)}><span className="ov-col-name">{c.name}</span>{sorted && <span aria-hidden="true">{sorted === 'ascending' ? '↑' : '↓'}</span>}</button> : <span className="ov-col-name">{c.name}</span>}
            {!plain && <span className="ov-col-meta">{c.type}{c.missing ? ` · ${c.missing} missing` : ''}</span>}
            {!plain && c.summary && <span className="ov-col-meta">{c.summary}</span>}
          </th>; })}</tr></thead>
      <tbody>{table.rowLabels.map((label, i) => <tr key={i}><th scope="row" className="ov-rowlabel">{label}</th>{table.columns.map((c, j) => <td key={j} className={c.numeric ? 'num' : ''}>{c.values[i]}</td>)}</tr>)}</tbody>
    </table></div>
    <Pager offset={table.offset} count={table.rowLabels.length} total={table.rows} noun={noun} onPage={onPage} step={objectViewLimits.rows} />
    {table.columnsTotal > table.columns.length && <p className="ov-small">{table.columnsTotal - table.columns.length} more columns are not shown.</p>}
    {table.sortRefused && <p className="ov-small">{table.sortRefused}</p>}
  </section>;
}

function Values({ values, onPage }: { values: NonNullable<Described['values']>; onPage: (offset: number) => void }) {
  const named = values.items.some(item => item.name !== null);
  return <section className="ov-section">
    <h3>Values</h3>
    <ol className={'ov-values' + (named ? ' named' : '')} start={values.offset + 1}>
      {values.items.map((item, i) => <li key={i}>{named && <span className="ov-value-name">{item.name ?? ''}</span>}<span className="ov-value-text">{item.value}</span></li>)}
    </ol>
    <Pager offset={values.offset} count={values.items.length} total={values.total} noun="values" onPage={onPage} step={objectViewLimits.rows} />
  </section>;
}

function Parts({ children, onPart, onPage }: { children: NonNullable<Described['children']>; onPart: (index: number) => void; onPage?: (offset: number) => void }) {
  return <section className="ov-section">
    <ul className="ov-parts">{children.items.map(part => <li key={part.index}>
      <button className="ov-part" title={part.expression} onClick={() => onPart(part.index)}>
        <span className="ov-part-name">{part.name}</span><span className="ov-part-type">{part.type}{part.size ? ' · ' + part.size : ''}</span>
        <span className="ov-part-summary">{part.summary}</span><Icon name="chevron" size={12} stroke={2} />
      </button></li>)}</ul>
    <Pager offset={children.offset} count={children.items.length} total={children.total} noun="parts" onPage={onPage} step={objectViewLimits.rows} />
  </section>;
}
