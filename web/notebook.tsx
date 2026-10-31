import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { durationText } from '../src/conversation-presentation.js';
import { agentName } from './agent-now.js';
import { clock } from './timeline-kinds.js';
import { highlight } from './languages.js';
import { statements, unfinished } from '../src/statements.js';
import { Icon } from './icons.js';
import { useProcess } from './process-context.js';
import { PlaceChip, usePlaces, whereOf } from './servers.js';
import './notebook.css';

// The project's live R and Python sessions, which the person shares with their Agent. Cells
// read in the order they were run, each with who ran it and why, its code, what it printed,
// its plots and how it ended. Where a session started or ended the list says so, since values
// from before an end are gone. The person runs their own cells below, in the same sessions.
type Read = RhoOutput<'kernel.read'>;
export type Cell = Read['cells'][number];
export type Session = Read['sessions'][number];
type Output = Cell['outputs'][number];
type Language = Cell['language'];
export const languages: Language[] = ['r', 'python'];
export const languageName: Record<Language, string> = { r: 'R', python: 'Python' };
// A Notebook view at least this wide shows the sessions beside the cells.
export const notebookViewLimits = { cells: 300, codeLines: 14, outputLines: 12, railPlots: 12, cachedPlots: 64, wideViewPx: 840 };
const me = 'browser:local';
const failure = (error: unknown) => error instanceof Error ? error.message : 'The live session could not be reached.';
export const versionOf = (session: Session) => session.version?.replace(/^R version (\S+).*$/, 'R $1') ?? languageName[session.language];
export const at = (iso: string) => clock(Date.parse(iso));

interface Author { name: string; conversationId?: string; title?: string }
export function useAuthors(snapshot: WorkspaceSnapshot) {
  return useMemo(() => {
    const byPrincipal = new Map<string, Author>();
    for (const c of snapshot.conversations ?? []) if (c.principal) byPrincipal.set(c.principal, { name: agentName(c.client), conversationId: c.conversationId, title: c.title });
    return (by: string): Author => by === me ? { name: 'You' } : byPrincipal.get(by) ?? { name: 'An Agent' };
  }, [snapshot.conversations]);
}

// Views of one page read the sessions together: a read already on its way is shared.
const reading = new WeakMap<BrowserClient, Map<string, Promise<Read>>>();
function readSessions(client: BrowserClient, projectId: string) {
  const mine = reading.get(client) ?? new Map<string, Promise<Read>>();
  reading.set(client, mine);
  let pending = mine.get(projectId);
  if (!pending) {
    pending = client.call('kernel.read', { projectId, limit: notebookViewLimits.cells });
    mine.set(projectId, pending);
    const done = () => { if (mine.get(projectId) === pending) mine.delete(projectId); };
    pending.then(done, done);
  }
  return pending;
}
export function useKernel(client: BrowserClient, projectId: string, cursor: number) {
  const [read, setRead] = useState<Read | null>(null);
  const [state, setState] = useState({ off: false, problem: '' });
  const again = () => readSessions(client, projectId).then(value => { setRead(value); setState({ off: false, problem: '' }); },
    error => setState({ off: error instanceof BrowserApiError && ['unavailable', 'unauthorized'].includes(error.error.kind), problem: failure(error) }));
  useEffect(() => { void again(); }, [client, projectId, cursor]);
  return { read, ...state, again };
}

// Plots are read once each and kept for this page; the oldest leave first.
const plotCache = new Map<string, Promise<string>>();
export function usePlot(client: BrowserClient, projectId: string, cellId: string, plot: number) {
  const [src, setSrc] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true; const key = cellId + ':' + plot;
    let pending = plotCache.get(key);
    if (!pending) {
      pending = client.call('kernel.plot', { projectId, cellId, plot }).then(value => `data:${value.mediaType};base64,${value.data}`);
      plotCache.set(key, pending); pending.catch(() => plotCache.delete(key));
      while (plotCache.size > notebookViewLimits.cachedPlots) plotCache.delete(plotCache.keys().next().value!);
    }
    pending.then(value => { if (live) setSrc(value); }, error => { if (live) setProblem(failure(error)); });
    return () => { live = false; };
  }, [client, projectId, cellId, plot]);
  return { src, problem };
}

function Plot({ client, projectId, cell, output, label }: { client: BrowserClient; projectId: string; cell: Cell; output: Output; label: string }) {
  const { src, problem } = usePlot(client, projectId, cell.cellId, output.plot!);
  // Plots are drawn at twice the size they are shown at, for sharp lines on dense screens.
  const width = Math.round((output.width || 1008) / 2), height = Math.round((output.height || 720) / 2);
  if (problem) return <p className="nb-note">This plot could not be read. {problem}</p>;
  return <figure className="nb-plot" style={{ maxWidth: width }}>{src ? <img src={src} width={width} height={height} alt={label} /> : <div className="nb-plot-wait" style={{ aspectRatio: `${width} / ${height}` }} aria-label="Reading the plot" />}</figure>;
}

export function Code({ code, language }: { code: string; language: Language }) {
  const lines = code.replace(/\n+$/, '').split('\n');
  const [whole, setWhole] = useState(false);
  const long = lines.length > notebookViewLimits.codeLines + 2;
  const shown = long && !whole ? lines.slice(0, notebookViewLimits.codeLines).join('\n') : lines.join('\n');
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    if (ref.current) ref.current.textContent = shown;
    highlight(shown, language).then(fragment => { if (live && fragment && ref.current) ref.current.replaceChildren(fragment); }, () => {});
    return () => { live = false; };
  }, [shown, language]);
  return <div className="nb-code">
    <pre><code ref={ref}>{shown}</code></pre>
    {long && <button className="text-button nb-more" onClick={() => setWhole(!whole)}>{whole ? 'Show less' : `Show all ${lines.length} lines`}</button>}
  </div>;
}

// Long printed output shows its first lines; the rest is a click away. Errors show whole.
function Printed({ output }: { output: Output }) {
  const lines = (output.text ?? '').replace(/\n$/, '').split('\n');
  const [whole, setWhole] = useState(false);
  const long = output.kind !== 'error' && lines.length > notebookViewLimits.outputLines + 4;
  return <>
    <pre className={'nb-out ' + output.kind}>{long && !whole ? lines.slice(0, notebookViewLimits.outputLines).join('\n') : lines.join('\n')}</pre>
    {long && <button className="text-button nb-more nb-out-more" onClick={() => setWhole(!whole)}>{whole ? 'Show less' : `Show all ${lines.length} lines`}</button>}
  </>;
}

function Outputs({ cell, client, projectId }: { cell: Cell; client: BrowserClient; projectId: string }) {
  let plots = 0;
  const purpose = cell.purpose ?? 'this cell';
  return <>
    {cell.outputs.map((output, i) => output.kind === 'plot'
      ? <Plot key={i} client={client} projectId={projectId} cell={cell} output={output} label={`Plot ${++plots} drawn by ${purpose}`} />
      : <Printed key={i} output={output} />)}
    {cell.cut && <p className="nb-note">Only the first {sizeText(cell.kept)} of the {sizeText(cell.bytes)} it printed were kept.</p>}
  </>;
}
const sizeText = (bytes: number) => bytes < 1024 ? bytes + ' bytes' : bytes < 1024 * 1024 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';

function Ending({ cell, now }: { cell: Cell; now: number }) {
  const took = cell.startedAt && cell.endedAt ? durationText(Date.parse(cell.endedAt) - Date.parse(cell.startedAt)) : '';
  if (cell.state === 'queued') return <span className="nb-ending waiting">Waiting</span>;
  if (cell.state === 'running') return <span className="nb-ending running"><span className="pulse-dot" aria-hidden="true" />Running {durationText(now - Date.parse(cell.startedAt ?? cell.queuedAt))}</span>;
  if (cell.state === 'done') return <span className="nb-ending">{took}</span>;
  if (cell.state === 'error') return <span className="nb-ending failed">Error{took ? ' · ' + took : ''}</span>;
  if (cell.state === 'interrupted') return <span className="nb-ending failed">Interrupted{took ? ' · ' + took : ''}</span>;
  if (cell.state === 'not-run') return <span className="nb-ending">Not run</span>;
  return <span className="nb-ending failed">Outcome unknown</span>;
}

function CellView({ cell, author, who, client, projectId, now, onEdit, onRunAgain, onConversation, onObject }: {
  cell: Cell; author: Author; who: (by: string) => Author; client: BrowserClient; projectId: string; now: number;
  onEdit: (cell: Cell) => void; onRunAgain: (cell: Cell) => void; onConversation: (id: string) => void; onObject?: (language: Language, name: string) => void;
}) {
  const settled = !['queued', 'running'].includes(cell.state);
  const interrupted = cell.interrupt ? `Interrupted by ${who(cell.interrupt.by).name === 'You' ? 'you' : who(cell.interrupt.by).name} at ${at(cell.interrupt.at)}.` : null;
  return <li className={'nb-cell ' + cell.state + (cell.by === me ? ' mine' : '')} id={'cell-' + cell.cellId}>
    <div className="nb-gutter" aria-hidden="true"><span className={'nb-lang ' + cell.language}>{languageName[cell.language]}</span><span className="nb-number">{cell.number}</span></div>
    <div className="nb-body">
      <header className="nb-head">
        <span className="nb-who">{author.conversationId
          ? <button className="text-button" title={author.title ? 'Open ' + author.title : undefined} onClick={() => onConversation(author.conversationId!)}>{author.name}</button>
          : author.name}</span>
        <span className="nb-purpose">{cell.purpose ?? <span className="nb-unnamed">{languageName[cell.language]} cell {cell.number}</span>}</span>
        <span className="nb-when"><time dateTime={cell.queuedAt}>{at(cell.queuedAt)}</time><Ending cell={cell} now={now} /></span>
      </header>
      <Code code={cell.code} language={cell.language} />
      <Outputs cell={cell} client={client} projectId={projectId} />
      {settled && ((cell.defined?.length ?? 0) > 0 || (cell.removed?.length ?? 0) > 0) && <p className="nb-values">
        {(cell.defined?.length ?? 0) > 0 && <><span>Made or changed</span>{cell.defined!.map(name => onObject
          ? <button key={name} className="nb-value" title={'Look at ' + name} onClick={() => onObject(cell.language, name)}>{name}</button>
          : <code key={name} className="nb-value">{name}</code>)}</>}
        {(cell.removed?.length ?? 0) > 0 && <><span>Removed</span>{cell.removed!.map(name => <code key={name} className="nb-value gone">{name}</code>)}</>}
      </p>}
      {(interrupted || (cell.problem && cell.state !== 'interrupted')) && <p className="nb-problem">{interrupted ?? cell.problem}</p>}
      {settled && <div className="nb-actions">
        <button className="text-button" onClick={() => onEdit(cell)}><Icon name="pencil" size={13} />Edit and run</button>
        <button className="text-button" onClick={() => onRunAgain(cell)}><Icon name="run" size={13} />Run again</button>
      </div>}
    </div>
  </li>;
}

// Where a session started and where it ended, among the cells.
function Mark({ session, edge, who }: { session: Session; edge: 'start' | 'end'; who: (by: string) => Author }) {
  const name = languageName[session.language];
  if (edge === 'start') {
    const by = who(session.startedBy).name;
    return <li className="nb-mark"><span>{name} session started{session.place ? ' ' + whereOf(session) : ''}{session.version ? ' · ' + versionOf(session) : ''} · by {by === 'You' ? 'you' : by} at {at(session.startedAt)}</span></li>;
  }
  return <li className={'nb-mark ended' + (session.ending === 'stopped' ? '' : ' problem')}>
    <span>{name} session ended at {at(session.endedAt!)} · {endedHow(session, who)}.</span>
    {session.problem && session.ending !== 'stopped' && <small>{session.ending === 'disconnected' ? `Its process there${session.pid ? ` (${session.pid})` : ''} was not seen to end.` : session.problem}</small>}
  </li>;
}

// How a session ended, as its marks say it.
function endedHow(session: Session, who: (by: string) => Author) {
  if (session.ending === 'disconnected') return `the connection to ${session.place?.label ?? 'its server'} was lost. Its values are out of reach`;
  const how = session.ending === 'stopped' ? `stopped by ${session.stop ? (who(session.stop.by).name === 'You' ? 'you' : who(session.stop.by).name) : 'request'}`
    : session.ending === 'rho-closed' ? 'Rho closed' : session.ending === 'not-started' ? 'it did not start' : 'its process ended';
  return how + '. Values defined before this are gone';
}

function SessionRow({ language, session, onInterrupt, onStop, asking }: { language: Language; session: Session | undefined; onInterrupt: () => void; onStop: (session: Session) => void; asking: string }) {
  const name = languageName[language];
  if (!session || session.state === 'ended') return <div className="nb-session off">
    <span className="nb-dot" aria-hidden="true" />
    <div><strong>{name}</strong><small>{session ? 'Ended. The next ' + name + ' cell starts a new session.' : 'Starts with the first ' + name + ' cell.'}</small></div>
  </div>;
  const busy = session.state === 'busy';
  return <div className={'nb-session ' + session.state}>
    <span className="nb-dot" aria-hidden="true" />
    <div><strong>{session.version ? versionOf(session) : name}</strong><small>{[whereOf(session), session.state === 'starting' ? (session.place ? 'Connecting…' : 'Starting…') : busy ? 'Running a cell' : 'Idle', `${session.cells} ${session.cells === 1 ? 'cell' : 'cells'}`].filter(Boolean).join(' · ')}</small></div>
    <div className="nb-session-actions">
      {busy && <button className="secondary" disabled={asking.startsWith('interrupt:')} onClick={onInterrupt}>Interrupt</button>}
      <button className="text-button" disabled={asking === 'stop:' + session.sessionId} title={`End the ${name} session; its values are gone`} onClick={() => onStop(session)}>Stop</button>
    </div>
  </div>;
}

// The session shown is the person's choice, else the one the newest cell ran in.
function Variables({ sessions, onObject, pane = false, recent }: { sessions: Partial<Record<Language, Session>>; onObject?: (language: Language, name: string) => void; pane?: boolean; recent?: Language }) {
  const live = languages.filter(l => sessions[l] && sessions[l]!.state !== 'ended');
  const [chosen, setChosen] = useState<Language | null>(null);
  useEffect(() => setChosen(null), [recent]);
  const shown = chosen && live.includes(chosen) ? chosen : recent && live.includes(recent) ? recent : live[live.length - 1] ?? null;
  const session = shown ? sessions[shown] : undefined;
  const id = useId();
  return <section className={'nb-rail-section' + (pane ? ' nb-pane-section' : '')} aria-labelledby={id}>
    <header>{pane
      ? <h2 id={id} className="nb-pane-state">{session ? <><span className={'nb-dot ' + session.state} aria-hidden="true" />{[versionOf(session), whereOf(session), session.state === 'busy' ? 'running a cell' : session.state === 'starting' ? 'starting' : 'idle', `${session.variables.length + session.variablesOmitted} ${session.variables.length + session.variablesOmitted === 1 ? 'value' : 'values'}`].filter(Boolean).join(' · ')}</> : 'Variables'}</h2>
      : <h2 id={id}>Variables</h2>}
      {live.length > 1 && <div className="nb-tabs" role="group" aria-label="Session">{live.map(l => <button key={l} aria-pressed={l === shown} onClick={() => setChosen(l)}>{languageName[l]}</button>)}</div>}
    </header>
    {!session ? <p className="nb-empty-line">{pane ? 'No live session. Values show here once a cell runs in R or Python, from the Notebook or a script\'s line.' : 'No live session.'}</p>
      : !session.variables.length ? <p className="nb-empty-line">Nothing defined in {languageName[session.language]} yet.</p>
      : <ul className="nb-vars">{session.variables.map(v => <li key={v.name} title={v.summary}>
          {onObject ? <button className="nb-var-name" title={'Look at ' + v.name} onClick={() => onObject(session.language, v.name)}>{v.name}</button> : <span className="nb-var-name">{v.name}</span>}<span className="nb-var-type">{v.type}{v.size ? ' · ' + v.size : ''}</span>
          {v.summary && <span className="nb-var-summary">{v.summary}</span>}
        </li>)}</ul>}
    {session && session.variablesOmitted > 0 && <p className="nb-note">{session.variablesOmitted} more not listed.</p>}
  </section>;
}

function RailPlot({ client, projectId, cell, output, onShow }: { client: BrowserClient; projectId: string; cell: Cell; output: Output; onShow: () => void }) {
  const { src } = usePlot(client, projectId, cell.cellId, output.plot!);
  const label = (cell.purpose ?? `${languageName[cell.language]} cell ${cell.number}`);
  return <button className="nb-thumb" title={'Show ' + label} onClick={onShow}>{src ? <img src={src} alt="" /> : <span className="nb-plot-wait" />}<span>{label}</span></button>;
}

// The person's own cell: the language it runs in and its code. A failed request keeps its
// identity, so pressing Run again for the same code never runs it twice.
// An example from what the session holds, so the hint names a value that is there.
function example(language: Language, session: Session | undefined) {
  const live = session && session.state !== 'ended' ? session.variables : [];
  const table = live.filter(v => /^(data\.frame|tbl_df|data\.table|DataFrame)$/.test(v.type)).sort((a, b) => b.bytes - a.bytes)[0];
  if (language === 'r') return table ? `summary(${table.name})` : live.length ? 'ls()' : 'x <- 1:10';
  return table ? `${table.name}.describe()` : live.length ? 'dir()' : 'x = list(range(10))';
}

// Which session a cell goes to, as the chip each cell carries: pressing it switches to the other.
function LanguageChip({ language, onLanguage }: { language: Language; onLanguage: (language: Language) => void }) {
  const other: Language = language === 'r' ? 'python' : 'r';
  return <button type="button" className={'nb-lang-switch ' + language} aria-label={`${languageName[language]}. Switch to ${languageName[other]}`}
    title={`Runs in the ${languageName[language]} session you share with the Agent. Switch to ${languageName[other]}`} onClick={() => onLanguage(other)}>
    {languageName[language]}<Icon name="updown" size={10} stroke={2.2} /></button>;
}

function Composer({ language, setLanguage, draft, setDraft, busy, problem, note, onRun, onInterrupt, running, input, placeholder, small, place }: {
  language: Language; setLanguage: (l: Language) => void; draft: string; setDraft: (t: string) => void; busy: boolean; problem: string; note?: string; placeholder: string; small?: boolean; place?: React.ReactNode;
  onRun: () => void; onInterrupt: () => void; running: boolean; input: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const id = useId(), lines = Math.max(small ? 1 : 2, Math.min(small ? 8 : 14, draft.split('\n').length));
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return <form className="nb-composer" onSubmit={event => { event.preventDefault(); onRun(); }}>
    <div className="nb-compose-bar">
      <LanguageChip language={language} onLanguage={l => { setLanguage(l); input.current?.focus(); }} />
      {place}
      <label htmlFor={id}>Runs in the {languageName[language]} session you share with the Agent</label>
    </div>
    {note && <p className="nb-compose-note">{note}</p>}
    <textarea id={id} ref={input} rows={lines} value={draft} spellCheck={false} autoComplete="off" autoCapitalize="off"
      placeholder={placeholder}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.shiftKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onRun(); } }} />
    <div className="nb-compose-foot">
      <small>{mac ? '⌘' : 'Ctrl'}+Enter or Shift+Enter runs it</small>
      {running && <button type="button" className="secondary" onClick={onInterrupt}>Interrupt</button>}
      <button type="submit" className="primary" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Run'}</button>
    </div>
    {problem && <p className="inline-error" role="alert">{problem}</p>}
  </form>;
}

export { FormSwitch, type NotebookForm } from './notebook-form.js';
import type { NotebookForm } from './notebook-form.js';
const prompts: Record<Language, [string, string]> = { r: ['>', '+'], python: ['>>>', '...'] };

// The code of one cell as typed at the prompt: the first line after the prompt, the rest after
// the continuation mark. Lines do not wrap, so the marks stay beside their lines.
function PromptCode({ code, language }: { code: string; language: Language }) {
  const text = code.replace(/\n+$/, ''), [first, rest] = prompts[language];
  // Each statement starts at the prompt; only the lines that carry one on take the continuation mark.
  const marks = useMemo(() => {
    const out = text.split('\n').map(() => first);
    for (const s of statements(text, language)) for (let line = s.from + 1; line <= s.to; line++) out[line - 1] = rest;
    return out.join('\n');
  }, [text, language]);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    if (ref.current) ref.current.textContent = text;
    highlight(text, language).then(fragment => { if (live && fragment && ref.current) ref.current.replaceChildren(fragment); }, () => {});
    return () => { live = false; };
  }, [text, language]);
  return <div className="nbc-code"><pre className="nbc-prompt" aria-hidden="true">{marks}</pre><pre className="nbc-input"><code ref={ref}>{text}</code></pre></div>;
}

// A plot in the console: under its prompt, or a line that opens it here when the page shows
// plots in a view of their own.
function ConsolePlot({ client, projectId, cell, output, number, beside }: { client: BrowserClient; projectId: string; cell: Cell; output: Output; number?: number; beside: boolean }) {
  const [open, setOpen] = useState(!beside);
  useEffect(() => setOpen(!beside), [beside]);
  return <div className="nbc-plot">
    {beside && <button className="text-button nbc-plot-line" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chart" size={13} />{number ? `Plot ${number}${open ? '' : ' · in Plots'}` : 'Plot'}</button>}
    {open && <PlotSmall client={client} projectId={projectId} cell={cell} output={output} />}
  </div>;
}
function PlotSmall({ client, projectId, cell, output }: { client: BrowserClient; projectId: string; cell: Cell; output: Output }) {
  const { src, problem } = usePlot(client, projectId, cell.cellId, output.plot!);
  if (problem) return <p className="nbc-quiet">This plot could not be read. {problem}</p>;
  return src ? <img className="nbc-plot-img" src={src} alt={`Plot drawn by ${cell.purpose ?? 'this cell'}`} /> : <span className="nb-plot-wait nbc-plot-img" />;
}

// One cell as the console shows it. A cell someone else ran says who, and why, as a comment.
function ConsoleCell({ cell, author, who, client, projectId, now, plotsBeside, plotNumber, onConversation }: {
  cell: Cell; author: Author; who: (by: string) => Author; client: BrowserClient; projectId: string; now: number; plotsBeside: boolean; plotNumber: (cellId: string, plot: number) => number | undefined; onConversation: (id: string) => void;
}) {
  const interrupted = cell.interrupt ? `Interrupted by ${who(cell.interrupt.by).name === 'You' ? 'you' : who(cell.interrupt.by).name}` : null;
  return <div className={'nbc-cell ' + cell.state + ' ' + cell.language} id={'cell-' + cell.cellId}>
    {author.name !== 'You' && <p className="nbc-who"># {author.conversationId ? <button className="text-button" title={author.title ? 'Open ' + author.title : undefined} onClick={() => onConversation(author.conversationId!)}>{author.name}</button> : author.name}{cell.purpose ? ' · ' + cell.purpose : ''}</p>}
    <PromptCode code={cell.code} language={cell.language} />
    {cell.outputs.map((output, i) => output.kind === 'plot'
      ? <ConsolePlot key={i} client={client} projectId={projectId} cell={cell} output={output} number={plotNumber(cell.cellId, output.plot!)} beside={plotsBeside} />
      : <pre key={i} className={'nbc-out ' + output.kind}>{(output.text ?? '').replace(/\n$/, '')}</pre>)}
    {cell.cut && <p className="nbc-quiet">Only the first {sizeText(cell.kept)} of the {sizeText(cell.bytes)} it printed were kept.</p>}
    {cell.state === 'running' && <p className="nbc-state running"><span className="pulse-dot" aria-hidden="true" />Running {durationText(now - Date.parse(cell.startedAt ?? cell.queuedAt))}</p>}
    {cell.state === 'queued' && <p className="nbc-state">Waiting for the cell before it</p>}
    {(interrupted || cell.state === 'not-run' || cell.state === 'unknown' || (cell.problem && cell.state !== 'error' && cell.state !== 'interrupted')) &&
      <p className="nbc-state">{interrupted ?? (cell.state === 'not-run' ? 'Not run' : cell.state === 'unknown' ? 'Outcome unknown' : cell.problem)}</p>}
  </div>;
}
function ConsoleMark({ session, edge, who }: { session: Session; edge: 'start' | 'end'; who: (by: string) => Author }) {
  const name = languageName[session.language];
  if (edge === 'start') { const by = who(session.startedBy).name; return <p className="nbc-mark">{name} session started{session.place ? ' ' + whereOf(session) : ''}{session.version ? ' · ' + versionOf(session) : ''} · by {by === 'You' ? 'you' : by} at {at(session.startedAt)}</p>; }
  return <p className={'nbc-mark ended' + (session.ending === 'stopped' ? '' : ' problem')}>{name} session ended at {at(session.endedAt!)} · {endedHow(session, who)}.</p>;
}
// The sessions above the console: their state, Interrupt while a cell runs, Stop, and Clear.
function ConsoleBar({ sessions, asking, onInterrupt, onStop, onClear, place }: { sessions: Partial<Record<Language, Session>>; asking: string; onInterrupt: (language: Language) => void; onStop: (session: Session) => void; onClear?: () => void; place?: React.ReactNode }) {
  const live = languages.filter(l => sessions[l] && sessions[l]!.state !== 'ended');
  return <div className="nbc-bar">
    {!live.length && <span className="nbc-bar-session off"><span className="nb-dot" aria-hidden="true" />No live session · the first cell starts one</span>}
    {live.map(l => { const s = sessions[l]!; return <span key={l} className={'nbc-bar-session ' + s.state}>
      <span className="nb-dot" aria-hidden="true" />{[versionOf(s), whereOf(s), s.state === 'busy' ? 'running' : s.state].filter(Boolean).join(' · ')}
      {s.state === 'busy' && <button className="text-button" disabled={asking.startsWith('interrupt:')} onClick={() => onInterrupt(l)}>Interrupt</button>}
      <button className="text-button nbc-stop" disabled={asking === 'stop:' + s.sessionId} title={`End the ${languageName[l]} session; its values are gone`} onClick={() => onStop(s)}>Stop</button>
    </span>; })}
    {place}
    {onClear && <button className="text-button nbc-clear" title="Clear the console (Ctrl+L); the sessions keep their values" onClick={onClear}>Clear</button>}
  </div>;
}

// The prompt: Enter runs finished code and goes on to another line in unfinished code, as a
// console does; Shift+Enter adds a line and ⌘/Ctrl+Enter runs whatever is there. ↑ and ↓ bring
// back what the person ran; Esc interrupts the running cell; Ctrl+L clears the view.
function ConsolePrompt({ language, setLanguage, draft, setDraft, note, problem, busy, running, input, history, onRun, onInterrupt, onClear }: {
  language: Language; setLanguage: (l: Language) => void; draft: string; setDraft: (text: string) => void; note: string; problem: string; busy: boolean; running: boolean;
  input: React.RefObject<HTMLTextAreaElement | null>; history: Array<{ code: string; language: Language }>; onRun: (code: string) => void; onInterrupt: () => void; onClear: () => void;
}) {
  const [back, setBack] = useState<{ at: number; kept: string } | null>(null);
  const lines = draft.split('\n').length, [first, rest] = prompts[language];
  // Where the caret goes once the new text is in the box, before the next key arrives.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => { const el = input.current; if (el && caret.current !== null) { el.selectionStart = el.selectionEnd = Math.min(caret.current, el.value.length); caret.current = null; } }, [draft]);
  const recall = (at: number) => {
    const kept = back?.kept ?? draft;
    if (at >= history.length) { setBack(null); caret.current = kept.length; setDraft(kept); return; }
    const item = history[at]!;
    setBack({ at, kept }); setLanguage(item.language); caret.current = item.code.length; setDraft(item.code);
  };
  // A command brought back and not yet changed moves through the history from any line.
  const browsing = !!back && history[back.at]?.code === draft;
  const send = () => { const code = draft.replace(/\s+$/, ''); if (code.trim()) { setBack(null); onRun(code); } };
  function keys(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = event.currentTarget;
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      if (!unfinished(draft, language) && el.selectionStart === draft.length) { event.preventDefault(); send(); return; }
      // Another line, indented as the one before it, and further after a block's header.
      event.preventDefault();
      const before = draft.slice(0, el.selectionStart), line = before.split('\n').at(-1)!, indent = line.match(/^\s*/)![0] + (/[:{(\[]\s*$/.test(line) ? (language === 'python' ? '    ' : '  ') : '');
      caret.current = before.length + 1 + indent.length;
      setDraft(before + '\n' + indent + draft.slice(el.selectionEnd));
      return;
    }
    // A closing bracket typed on an empty line goes back one step of indentation.
    if ('}])'.includes(event.key) && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      const before = draft.slice(0, el.selectionStart), line = before.split('\n').at(-1)!;
      if (line.length && !line.trim()) {
        event.preventDefault();
        const kept = before.slice(0, before.length - Math.min(line.length, language === 'python' ? 4 : 2)) + event.key;
        caret.current = kept.length; setDraft(kept + draft.slice(el.selectionEnd));
        return;
      }
    }
    if (event.key === 'ArrowUp' && (browsing || !draft.slice(0, el.selectionStart).includes('\n')) && history.length) { event.preventDefault(); recall(Math.max(0, (back?.at ?? history.length) - 1)); return; }
    if (event.key === 'ArrowDown' && back && (browsing || !draft.slice(el.selectionEnd).includes('\n'))) { event.preventDefault(); recall(back.at + 1); return; }
    if (event.key === 'Escape' && running) { event.preventDefault(); onInterrupt(); return; }
    if (event.key.toLowerCase() === 'l' && event.ctrlKey && !event.metaKey) { event.preventDefault(); onClear(); }
  }
  return <div className={'nbc-prompt-row ' + language}>
    {note && <p className="nbc-quiet">{note}</p>}
    <div className="nbc-prompt-line">
      <LanguageChip language={language} onLanguage={l => { setLanguage(l); input.current?.focus(); }} />
      <pre className="nbc-prompt" aria-hidden="true">{[first, ...Array(lines - 1).fill(rest)].join('\n')}</pre>
      <textarea ref={input} rows={lines} value={draft} spellCheck={false} autoComplete="off" autoCapitalize="off" aria-label={`${languageName[language]} prompt`}
        onChange={event => { setBack(null); setDraft(event.target.value); }} onKeyDown={keys} />
      {busy && <span className="nbc-busy">Sending…</span>}
    </div>
    {problem && <p className="inline-error" role="alert">{problem}</p>}
  </div>;
}

// The box that scrolls the cells: a Studio view scrolls itself; on the page, the nearest box that
// scrolls, or the document itself.
function scrollerOf(element: HTMLElement | null): Element {
  const view = element?.closest('.nb-view');
  if (view) return view;
  for (let at = element?.parentElement; at; at = at.parentElement) if (/(auto|scroll)/.test(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight) return at;
  return document.scrollingElement ?? document.documentElement;
}

type Row = { at: number; order: number; key: string } & ({ cell: Cell } | { session: Session; edge: 'start' | 'end' });

// The Notebook as a view of a Studio page. In a conversation's Studio it shows that
// conversation's part of the sessions: the sessions its Agent ran cells in, with every cell
// run there (the person's too, since they share the values), and the person's own cells since
// the conversation began, up to the moment the Studio shows. On the person's own pages it shows
// the sessions whole. A wide view has the sessions, values and plots beside the cells; a narrow
// one folds them above.
export interface Prepared { key: string; language: Language; code: string; note: string }
// The variables and plots leave its side when the page shows them in views of their own.
export interface Beside { variables?: boolean; plots?: boolean }
export function SessionPane({ client, snapshot, prepared, onTaken, onConversation, onObject, beside, form }: { client: BrowserClient; snapshot: WorkspaceSnapshot; prepared?: Prepared | null; onTaken?: () => void; onConversation?: (id: string) => void; onObject?: (language: Language, name: string) => void; beside?: Beside; form?: NotebookForm }) {
  const process = useProcess();
  const principal = snapshot.conversations?.find(c => c.conversationId === process?.conversationId)?.principal ?? null;
  const starts = process ? process.whole.turns.filter(t => t.conversationId === process.conversationId).map(t => t.start) : [];
  const since = starts.length ? Math.min(...starts) : null;
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false), [shown, setShown] = useState(0);
  // A view the shell hides or moves leaves the page and loses its scroll; each time it shows at
  // a new size it counts, so a reader who was at the newest cell returns there.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (!width) return;
      setShown(n => n + 1); setWide(width >= notebookViewLimits.wideViewPx);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div className="nb-view" ref={box}>
    <NotebookPage client={client} snapshot={snapshot} onConversation={onConversation ?? (() => {})} compact={!wide} inView shown={shown} prepared={prepared} onTaken={onTaken} onObject={onObject} beside={beside} form={form}
      scope={process ? { principal, since, at: process.at } : undefined} />
  </div>;
}

export function NotebookPage({ client, snapshot, onConversation, onObject, scope, compact = false, inView = false, shown = 0, prepared, onTaken, beside = {}, form = 'notebook' }: {
  client: BrowserClient; snapshot: WorkspaceSnapshot; onConversation: (id: string) => void; onObject?: (language: Language, name: string) => void; compact?: boolean; inView?: boolean; shown?: number; prepared?: Prepared | null; onTaken?: () => void; beside?: Beside; form?: NotebookForm;
  scope?: { principal: string | null; since: number | null; at: number | null } }) {
  const projectId = snapshot.project.id;
  const { read, off, problem, again } = useKernel(client, projectId, snapshot.cursor);
  const { places, setPlaces } = usePlaces(client, projectId, snapshot.cursor);
  const who = useAuthors(snapshot);
  const cells = useMemo(() => {
    const all = read?.cells ?? [];
    if (!scope) return all;
    const theirs = new Set(all.filter(c => c.by === scope.principal).map(c => c.sessionId));
    return all.filter(c => (theirs.has(c.sessionId) || (c.by === me && scope.since !== null && Date.parse(c.queuedAt) >= scope.since))
      && (scope.at === null || Date.parse(c.queuedAt) <= scope.at));
  }, [read, scope?.principal, scope?.since, scope?.at]);
  const latest = useMemo(() => {
    const out: Partial<Record<Language, Session>> = {};
    for (const s of read?.sessions ?? []) if (!out[s.language] || s.startedAt > out[s.language]!.startedAt) out[s.language] = s;
    return out;
  }, [read]);
  const [language, setLanguage] = useState<Language | null>(null);
  const shownLanguage: Language = language ?? cells.at(-1)?.language ?? 'r';
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [runProblem, setRunProblem] = useState('');
  const [asking, setAsking] = useState('');
  const [cleared, setCleared] = useState(0);
  const [askProblem, setAskProblem] = useState('');
  const pending = useRef<{ code: string; language: Language; changeId: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const running = cells.some(c => c.state === 'running');
  // Code another view puts here waits in the line for the person to check and run.
  useEffect(() => {
    if (!prepared) return;
    setLanguage(prepared.language); setDraft(prepared.code); setNote(prepared.note); setRunProblem(''); onTaken?.();
    requestAnimationFrame(() => { input.current?.focus(); input.current?.scrollIntoView({ block: 'nearest' }); });
  }, [prepared?.key]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running]);

  // The list in time: each cell, and where a session started or ended among them.
  const rows = useMemo(() => {
    const out: Row[] = cells.map(cell => ({ at: Date.parse(cell.queuedAt), order: 1, key: cell.cellId, cell }));
    const first = out[0]?.at ?? Infinity, until = scope?.at ?? Infinity;
    for (const session of read?.sessions ?? []) {
      const has = cells.some(c => c.sessionId === session.sessionId);
      if (scope && !has) continue;
      if (has || Date.parse(session.startedAt) >= first) out.push({ at: Date.parse(session.startedAt), order: 0, key: session.sessionId + ':start', session, edge: 'start' });
      if (session.endedAt && Date.parse(session.endedAt) <= until && (has || Date.parse(session.endedAt) >= first)) out.push({ at: Date.parse(session.endedAt), order: 2, key: session.sessionId + ':end', session, edge: 'end' });
    }
    return out.sort((a, b) => a.at - b.at || a.order - b.order);
  }, [cells, read?.sessions, scope?.at]);

  // A new cell, and output arriving in the last one, stay in view while the reader is at the end.
  const last = cells.at(-1);
  const tail = last ? `${cells.length}:${last.state}:${last.outputs.length}:${last.kept}` : '';
  const atEnd = useRef(true);
  // Only the reader's own moves (wheel, touch, keys, the scroll bar) decide whether they are at the
  // end; the browser keeping their place as content grows, or a view taken off the page, does not.
  useEffect(() => {
    const scroller = scrollerOf(page.current);
    const target = scroller === document.scrollingElement ? window : scroller;
    let input = 0;
    const moved = () => { input = Date.now(); };
    const track = () => { if (Date.now() - input < 1000 && scroller.isConnected && scroller.clientHeight) atEnd.current = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 160; };
    const events = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
    for (const name of events) target.addEventListener(name, moved, { passive: true });
    target.addEventListener('scroll', track, { passive: true });
    return () => { for (const name of events) target.removeEventListener(name, moved); target.removeEventListener('scroll', track); };
  }, [!!read]);
  // The person's own cell sits above the composer, which stays at the foot of the page. A view
  // shown again returns to the newest cell when the reader had been there.
  useEffect(() => { if (tail && atEnd.current) requestAnimationFrame(() => { const scroller = scrollerOf(page.current); scroller.scrollTo({ top: scroller.scrollHeight }); }); }, [tail, shown, compact, form]);
  // Output that grows after it is drawn (highlighted code, a plot read later) keeps the newest
  // cell in view for a reader who was there.
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (atEnd.current && element.isConnected) { const scroller = scrollerOf(element); scroller.scrollTo({ top: scroller.scrollHeight }); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [!!read, compact, form]);

  async function run(code: string, lang: Language) {
    if (!code.trim() || busy) return;
    if (pending.current?.code !== code || pending.current.language !== lang) pending.current = { code, language: lang, changeId: 'notebook-' + crypto.randomUUID() };
    setBusy(true); setRunProblem('');
    try {
      await client.call('kernel.run', { projectId, language: lang, code, changeId: pending.current.changeId });
      pending.current = null; setDraft(''); setNote(''); atEnd.current = true; void again();
    } catch (error) { setRunProblem(failure(error)); }
    finally { setBusy(false); }
  }
  // Interrupting names the cell running now and stopping names the session, so neither reaches
  // a later one.
  async function interrupt(lang: Language) {
    const cell = cells.find(c => c.language === lang && c.state === 'running');
    if (!cell) return;
    setAsking('interrupt:' + cell.cellId); setAskProblem('');
    try { await client.call('kernel.interrupt', { projectId, cellId: cell.cellId }); void again(); }
    catch (error) { setAskProblem(failure(error)); }
    finally { setAsking(''); }
  }
  async function stop(session: Session) {
    const name = languageName[session.language];
    if (!window.confirm(`Stop the ${name} session${session.place ? ' on ' + session.place.label : ''}? The values defined in it are gone; the next ${name} cell starts a new session.`)) return;
    setAsking('stop:' + session.sessionId); setAskProblem('');
    try { await client.call('kernel.stop', { projectId, sessionId: session.sessionId }); void again(); }
    catch (error) { setAskProblem(failure(error)); }
    finally { setAsking(''); }
  }
  const edit = (cell: Cell) => { setLanguage(cell.language); setDraft(cell.code); requestAnimationFrame(() => { input.current?.focus(); input.current?.scrollIntoView({ block: 'nearest' }); }); };
  const plots = useMemo(() => cells.flatMap(cell => cell.outputs.filter(o => o.kind === 'plot').map(output => ({ cell, output }))).slice(-notebookViewLimits.railPlots).reverse(), [cells]);
  const show = (cellId: string) => document.getElementById('cell-' + cellId)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  if (off) return <p className="nb-empty-line">{problem}</p>;
  // The line to run waits for now during a replay.
  const composing = (scope?.at ?? null) === null;
  // Where the language's next cell runs, when the project names any server.
  const placeChip = <PlaceChip client={client} projectId={projectId} language={shownLanguage} session={latest[shownLanguage]} places={places} onChanged={setPlaces} />;
  const composer = (small: boolean) => composing && <Composer small={small} language={shownLanguage} setLanguage={setLanguage} draft={draft} setDraft={text => { setDraft(text); if (!text) setNote(''); }} busy={busy} problem={runProblem} note={note} onRun={() => void run(draft, shownLanguage)}
    running={latest[shownLanguage]?.state === 'busy'} onInterrupt={() => void interrupt(shownLanguage)} input={input} placeholder={example(shownLanguage, latest[shownLanguage])} place={placeChip} />;
  const nothing = scope?.at != null ? 'No cells by then.' : scope ? 'No cells in this conversation yet. What you run here runs in the sessions you share with the Agent.' : 'Nothing has run in the live sessions yet. What you run here runs in the sessions you share with the Agent.';
  // In a narrow view the cells take the whole view; the sessions and their values fold above them.
  const live = languages.filter(l => latest[l] && latest[l]!.state !== 'ended' && (!scope || cells.some(c => c.sessionId === latest[l]!.sessionId)));
  // A value named in a cell opens while that cell's session is live; with an ended session its
  // values are gone, and the same name in a newer session is another value.
  const current = new Set(languages.map(l => latest[l]).filter(session => session && session.state !== 'ended').map(session => session!.sessionId));
  // The console: the cells as one transcript, each prompt with what it printed, and the prompt
  // under the last of them. Cleared output leaves this view only.
  if (form === 'console') {
    const history = cells.filter(c => c.by === me).map(c => ({ code: c.code.replace(/\n+$/, ''), language: c.language }));
    const shownRows = rows.filter(row => row.at > cleared);
    // Plots of the live sessions are numbered as the Plots view counts them.
    const plotNumbers = new Map((read?.cells ?? []).filter(c => current.has(c.sessionId)).flatMap(c => c.outputs.filter(o => o.kind === 'plot').map(o => c.cellId + ':' + o.plot)).map((key, i) => [key, i + 1]));
    return <div className="nb-console" ref={page} onMouseUp={event => {
      if (!composing || window.getSelection()?.toString() || (event.target as HTMLElement).closest('button, a, textarea, summary, img')) return;
      input.current?.focus({ preventScroll: true });
    }}>
      <ConsoleBar sessions={latest} asking={asking} onInterrupt={l => void interrupt(l)} onStop={session => void stop(session)} onClear={composing ? () => setCleared(rows.at(-1)?.at ?? Date.now()) : undefined} place={composing ? placeChip : undefined} />
      {problem && <p className="inline-error" role="alert">{problem}</p>}
      {askProblem && <p className="inline-error" role="alert">{askProblem}</p>}
      <div className="nbc-log" role="log" aria-label="Console">
        {!read ? <p className="nbc-quiet">Reading the live sessions…</p>
          : !cells.length ? <p className="nbc-quiet">{nothing}</p> : null}
        {read && read.omitted > 0 && cleared === 0 && <p className="nbc-quiet">{read.omitted} earlier {read.omitted === 1 ? 'cell is' : 'cells are'} kept but not shown.</p>}
        {cleared > 0 && <p className="nbc-quiet">Earlier output is cleared from this view; the sessions keep their values. <button className="text-button" onClick={() => setCleared(0)}>Show it again</button></p>}
        {shownRows.map(row => 'cell' in row
          ? <ConsoleCell key={row.key} cell={row.cell} author={who(row.cell.by)} who={who} client={client} projectId={projectId} now={now} plotsBeside={!!beside.plots} plotNumber={(cellId, plot) => plotNumbers.get(cellId + ':' + plot)} onConversation={onConversation} />
          : <ConsoleMark key={row.key} session={row.session} edge={row.edge} who={who} />)}
      </div>
      {composing && <ConsolePrompt language={shownLanguage} setLanguage={setLanguage} draft={draft} setDraft={text => { setDraft(text); if (!text) setNote(''); }} note={note} problem={runProblem} busy={busy} input={input} history={history}
        running={latest[shownLanguage]?.state === 'busy'} onRun={code => void run(code, shownLanguage)} onInterrupt={() => void interrupt(shownLanguage)} onClear={() => setCleared(rows.at(-1)?.at ?? Date.now())} />}
    </div>;
  }
  if (compact) return <div className="nb-page compact" ref={page}>
    <div className="nb-main">
      {problem && <p className="inline-error" role="alert">{problem}</p>}
      {live.length > 0 && !beside.variables && <details className="nb-strip">
        <summary>{live.map(l => <span key={l} className={'nb-strip-session ' + latest[l]!.state}><span className="nb-dot" aria-hidden="true" />{versionOf(latest[l]!)} · {latest[l]!.state === 'busy' ? 'running' : latest[l]!.state} · {latest[l]!.variables.length} {latest[l]!.variables.length === 1 ? 'value' : 'values'}</span>)}</summary>
        <Variables sessions={Object.fromEntries(live.map(l => [l, latest[l]]))} onObject={onObject} />
      </details>}
      {!read ? <p className="nb-empty-line">Reading the live sessions…</p>
        : !cells.length ? <p className="nb-empty-line">{nothing}</p>
        : <ol className="nb-cells" ref={list}>{rows.map(row => 'cell' in row
          ? <CellView key={row.key} cell={row.cell} author={who(row.cell.by)} who={who} client={client} projectId={projectId} now={now} onEdit={edit} onRunAgain={cell => void run(cell.code, cell.language)} onConversation={onConversation} onObject={current.has(row.cell.sessionId) ? onObject : undefined} />
          : <Mark key={row.key} session={row.session} edge={row.edge} who={who} />)}</ol>}
      {composer(true)}
    </div>
  </div>;
  return <div className={'nb-page' + (inView ? ' in-view' : '')} ref={page}>
    <div className="nb-main">
      {problem && <p className="inline-error" role="alert">{problem}</p>}
      {!read ? <p className="nb-empty-line">Reading the live sessions…</p>
        : !cells.length ? inView ? <p className="nb-empty-line">{nothing}</p> : <div className="nb-empty">
          <h2>Nothing has run here yet</h2>
          <p>When the Agent runs R or Python in this project's live sessions, each cell shows here with its purpose, its code, what it printed, its plots and the values it left. Your own cells run in the same sessions, so you can look at what the Agent made.</p>
        </div>
        : <ol className="nb-cells" ref={list}>{rows.map(row => 'cell' in row
          ? <CellView key={row.key} cell={row.cell} author={who(row.cell.by)} who={who} client={client} projectId={projectId} now={now} onEdit={edit} onRunAgain={cell => void run(cell.code, cell.language)} onConversation={onConversation} onObject={current.has(row.cell.sessionId) ? onObject : undefined} />
          : <Mark key={row.key} session={row.session} edge={row.edge} who={who} />)}</ol>}
      {read && read.omitted > 0 && <p className="nb-note">{read.omitted} earlier {read.omitted === 1 ? 'cell is' : 'cells are'} kept but not shown.</p>}
      {composer(false)}
    </div>
    <aside className="nb-rail" aria-label="Live sessions">
      <section className="nb-rail-section" aria-labelledby="nb-sessions">
        <header><h2 id="nb-sessions">Sessions</h2></header>
        {languages.map(l => <SessionRow key={l} language={l} session={latest[l]} asking={asking} onInterrupt={() => void interrupt(l)} onStop={session => void stop(session)} />)}
        {askProblem && <p className="inline-error" role="alert">{askProblem}</p>}
      </section>
      {!beside.variables && <Variables sessions={latest} onObject={onObject} />}
      {plots.length > 0 && !beside.plots && <section className="nb-rail-section" aria-labelledby="nb-plots">
        <header><h2 id="nb-plots">Plots</h2></header>
        <div className="nb-thumbs">{plots.map(({ cell, output }) => <RailPlot key={cell.cellId + ':' + output.plot} client={client} projectId={projectId} cell={cell} output={output} onShow={() => show(cell.cellId)} />)}</div>
      </section>}
    </aside>
  </div>;
}

// The newest session of each language.
export function latestSessions(read: Read | null) {
  const out: Partial<Record<Language, Session>> = {};
  for (const s of read?.sessions ?? []) if (!out[s.language] || s.startedAt > out[s.language]!.startedAt) out[s.language] = s;
  return out;
}

// The live sessions' variables as a view of their own, beside a script and the Notebook: each
// with its type, size and summary, read again after every cell. A name opens the value.
export function VariablesPane({ client, snapshot, onObject }: { client: BrowserClient; snapshot: WorkspaceSnapshot; onObject?: (language: Language, name: string) => void }) {
  const { read, off, problem } = useKernel(client, snapshot.project.id, snapshot.cursor);
  const latest = useMemo(() => latestSessions(read), [read]);
  return <div className="nb-pane">
    {off || (problem && !read) ? <p className="nb-empty-line">{problem}</p>
      : !read ? <p className="nb-empty-line">Reading the live sessions…</p>
      : <Variables pane sessions={latest} onObject={onObject} recent={read.cells.at(-1)?.language} />}
  </div>;
}

// The plots the live sessions drew, as a view of their own: the newest at the size of the view,
// the ones before it to step back through. A new plot comes forward as it is drawn. Plots of an
// ended session stay with their cells in the Notebook.
export const plotsPaneLimits = { plots: 24 };
export function PlotsPane({ client, snapshot }: { client: BrowserClient; snapshot: WorkspaceSnapshot }) {
  const projectId = snapshot.project.id;
  const { read, off, problem } = useKernel(client, projectId, snapshot.cursor);
  const who = useAuthors(snapshot);
  const all = useMemo(() => {
    const live = new Set((read?.sessions ?? []).filter(s => s.state !== 'ended').map(s => s.sessionId));
    return (read?.cells ?? []).filter(cell => live.has(cell.sessionId)).flatMap(cell => cell.outputs.filter(o => o.kind === 'plot').map(output => ({ key: cell.cellId + ':' + output.plot, cell, output })));
  }, [read]);
  const plots = all.slice(-plotsPaneLimits.plots);
  const newest = plots.at(-1)?.key ?? '';
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [newest]);
  const index = Math.max(0, chosen ? plots.findIndex(p => p.key === chosen) : plots.length - 1), shown = plots[index];
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => { strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [shown?.key]);
  if (off || (problem && !read)) return <div className="nb-pane"><p className="nb-empty-line">{problem}</p></div>;
  if (!read) return <div className="nb-pane"><p className="nb-empty-line">Reading the live sessions…</p></div>;
  if (!shown) return <div className="nb-pane"><p className="nb-empty-line">No plots in the live sessions yet. What R and Python draw shows here, the newest first.</p></div>;
  // A cell is named by its purpose, else by its code's first line.
  const label = (cell: Cell) => cell.purpose ?? (cell.code.split('\n').find(line => line.trim())?.trim() || `${languageName[cell.language]} cell ${cell.number}`);
  const step = (by: number) => setChosen(plots[Math.min(plots.length - 1, Math.max(0, index + by))]!.key);
  const cell = document.getElementById('cell-' + shown.cell.cellId) ? shown.cell.cellId : null;
  return <div className="nb-pane nb-plots" onKeyDown={event => { if (event.key === 'ArrowLeft') step(-1); else if (event.key === 'ArrowRight') step(1); }}>
    <header className="nb-plots-head">
      <div className="nb-plots-nav">
        <button className="text-button" disabled={index === 0} aria-label="Previous plot" onClick={() => step(-1)}><Icon name="back" size={14} /></button>
        <span>{index + 1} of {plots.length}</span>
        <button className="text-button nb-next" disabled={index === plots.length - 1} aria-label="Next plot" onClick={() => step(1)}><Icon name="back" size={14} /></button>
      </div>
      <p className="nb-plots-from" title={label(shown.cell)}><span className={'nb-lang ' + shown.cell.language}>{languageName[shown.cell.language]}</span> {shown.cell.number} · {label(shown.cell)} · {who(shown.cell.by).name} · {at(shown.cell.queuedAt)}</p>
      {cell && <button className="text-button" onClick={() => document.getElementById('cell-' + cell)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>Show the cell</button>}
    </header>
    <PlotFit client={client} projectId={projectId} cell={shown.cell} output={shown.output} label={`Plot drawn by ${label(shown.cell)}`} />
    {plots.length > 1 && <div className="nb-plots-strip" ref={strip} role="group" aria-label="Plots">
      {plots.map((plot, i) => <PlotThumb key={plot.key} client={client} projectId={projectId} cell={plot.cell} output={plot.output} current={i === index} label={label(plot.cell)} onShow={() => setChosen(plot.key)} />)}
    </div>}
    {all.length > plots.length && <p className="nb-note">The {plotsPaneLimits.plots} newest plots are here; earlier ones stay with their cells in the Notebook.</p>}
  </div>;
}
function PlotFit({ client, projectId, cell, output, label }: { client: BrowserClient; projectId: string; cell: Cell; output: Output; label: string }) {
  const { src, problem } = usePlot(client, projectId, cell.cellId, output.plot!);
  if (problem) return <p className="nb-note">This plot could not be read. {problem}</p>;
  return <figure className="nb-plots-fit">{src ? <img src={src} alt={label} /> : <span className="nb-plot-wait" aria-label="Reading the plot" />}</figure>;
}
function PlotThumb({ client, projectId, cell, output, current, label, onShow }: { client: BrowserClient; projectId: string; cell: Cell; output: Output; current: boolean; label: string; onShow: () => void }) {
  const { src } = usePlot(client, projectId, cell.cellId, output.plot!);
  return <button className="nb-plots-thumb" aria-current={current} title={label} onClick={onShow}>{src ? <img src={src} alt={label} /> : <span className="nb-plot-wait" />}</button>;
}
