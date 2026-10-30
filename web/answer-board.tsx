import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { buildWorkGraph, foldVersions, type GraphNode, type WorkGraph } from '../src/work-graph.js';
import { boardThreads, commandGist, type BoardItem } from '../src/answer-board.js';
import { askText, askedAbout, type Asking } from '../src/asking.js';
import { durationText } from '../src/conversation-presentation.js';
import { useTurns } from './work-turns.js';
import { kindOf, type ProjectFiles } from './sources.js';
import { readPreview, readTable, readText, type Preview, type TablePage } from './previews.js';
import { Answer, day, took, pathIcon } from './agent-work.js';
import { Icon } from './icons.js';
import { HoldsText } from './holds.js';
import type { Holds } from '../src/file-describer.js';
import './board.css';
import { useMeaning } from './meaning.js';
import { ChoiceOptions } from './choices.js';

// The answer to one message, laid out by what each file is to it: the result that answers it
// largest, the results beside it, then the script and the command that made them and the data
// they started from. Each item says how it is connected, in the Graph's words. While the Agent
// works the board fills in as its files appear; the files are shown as the versions the message
// kept when it kept them, else as they are now.
const fileOf = (node: GraphNode) => ({ path: node.path!, bytes: node.bytes, modifiedAt: node.modifiedAt, resource: node.resource ? { ...node.resource, kind: /\.(csv|tsv)$/i.test(node.path!) ? 'table' : 'file' } : undefined });
const ended: Record<string, string> = { completed: 'Answered', failed: 'Failed', stopped: 'Stopped', running: 'Working', unknown: 'Outcome unknown' };

// A number as a person reads it: whole numbers as they are, others to four significant digits.
export function cellText(value: unknown) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+\.\d+(?:e[-+]?\d+)?$/i.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(number)) return value === null || value === undefined ? '' : String(value);
  if (Number.isInteger(number)) return String(number);
  if (Math.abs(number) >= 1e5) return String(Math.round(number));
  return String(Number(number.toPrecision(4)));
}

function Figure({ client, snapshot, node }: { client: BrowserClient; snapshot: WorkspaceSnapshot; node: GraphNode }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const key = node.path + '@' + (node.resource?.version ?? node.modifiedAt);
  useEffect(() => { let live = true; readPreview(client, snapshot, fileOf(node)).then(p => { if (live) setPreview(p); }); return () => { live = false; }; }, [key]);
  if (!preview) return <span className="board-figure loading" aria-hidden="true" />;
  return preview.kind === 'image' ? <img className="board-figure" src={preview.url} alt={node.title} /> : <span className="board-figure none">{preview.kind === 'none' ? preview.note : ''}</span>;
}
function Table({ client, snapshot, node, rows }: { client: BrowserClient; snapshot: WorkspaceSnapshot; node: GraphNode; rows: number }) {
  const [page, setPage] = useState<TablePage | null | undefined>(undefined);
  const key = node.path + '@' + (node.resource?.version ?? node.modifiedAt);
  useEffect(() => { let live = true; readTable(client, snapshot, fileOf(node), rows).then(p => { if (live) setPage(p); }); return () => { live = false; }; }, [key, rows]);
  if (page === undefined) return <span className="board-table loading" aria-hidden="true" />;
  if (!page) return <p className="board-note">This table could not be read.</p>;
  const shown = page.rows.slice(0, rows);
  return <div className="board-table-wrap">
    <table className="board-table"><thead><tr>{page.columns.map(c => <th key={c} title={c}>{c}</th>)}</tr></thead>
      <tbody>{shown.map((row, i) => <tr key={i}>{page.columns.map(c => <td key={c} title={row[c] === null || row[c] === undefined ? '' : String(row[c])}>{cellText(row[c])}</td>)}</tr>)}</tbody></table>
    <small>{page.total > shown.length ? `First ${shown.length} of ${page.total.toLocaleString()} rows` : `${page.total.toLocaleString()} ${page.total === 1 ? 'row' : 'rows'}`}{page.width > page.columns.length ? ` · ${page.columns.length} of ${page.width} columns` : ''}</small>
  </div>;
}
// A script as the places a reader would look: its functions and the comments that head its sections.
export function outline(text: string, path: string) {
  const lines = text.split('\n'), marks: Array<{ line: number; text: string }> = [];
  const python = /\.py$/i.test(path), r = /\.[rR]$/.test(path);
  lines.forEach((line, i) => {
    const heading = /^#{1,3}\s*[-=#*]*\s*([A-Za-z0-9].{2,80}?)\s*[-=#*]*\s*$/.exec(line);
    if (python && /^(?:async\s+)?(?:def|class)\s+\w+/.test(line)) marks.push({ line: i + 1, text: line.replace(/\s*:\s*$/, '').replace(/^async\s+/, '') });
    else if (r && /^[\w.]+\s*(?:<-|=)\s*function\s*\(/.test(line)) marks.push({ line: i + 1, text: line.replace(/\s*\{\s*$/, '') });
    else if (heading && !/^#!/.test(line) && !/^#\s*(?:TODO|NOTE|FIXME)\b/i.test(line)) marks.push({ line: i + 1, text: heading[1] });
  });
  return { lines: lines.length - (lines.at(-1) === '' ? 1 : 0), marks };
}
function Method({ client, snapshot, node }: { client: BrowserClient; snapshot: WorkspaceSnapshot; node: GraphNode }) {
  const [text, setText] = useState<{ text: string; cut: boolean } | null | undefined>(undefined);
  const key = node.path + '@' + (node.resource?.version ?? node.modifiedAt);
  useEffect(() => { let live = true; readText(client, snapshot, fileOf(node)).then(t => { if (live) setText(t); }); return () => { live = false; }; }, [key]);
  if (text === undefined) return <span className="board-outline loading" aria-hidden="true" />;
  if (!text) return null;
  const { lines, marks } = outline(text.text, node.path!);
  return <div className="board-outline">
    {marks.length > 0 && <ol>{marks.slice(0, 12).map(m => <li key={m.line}><span>{m.line}</span><code>{m.text}</code></li>)}</ol>}
    <small>{lines.toLocaleString()} lines{text.cut ? ' (more than Rho read)' : ''}{marks.length > 12 ? ` · ${marks.length - 12} more sections` : ''}</small>
  </div>;
}
// A result written as text (JSON, plain text, a note) opens at its first lines; JSON on one line
// is laid out first, so its first fields read.
function Text({ client, snapshot, node, lines }: { client: BrowserClient; snapshot: WorkspaceSnapshot; node: GraphNode; lines: number }) {
  const [text, setText] = useState<{ text: string; cut: boolean } | null | undefined>(undefined);
  const key = node.path + '@' + (node.resource?.version ?? node.modifiedAt);
  useEffect(() => { let live = true; readText(client, snapshot, fileOf(node)).then(t => { if (live) setText(t); }); return () => { live = false; }; }, [key]);
  if (text === undefined) return <span className="board-text loading" aria-hidden="true" />;
  if (!text) return null;
  let shown = text.text;
  if (/\.json$/i.test(node.path!) && !text.cut) try { shown = JSON.stringify(JSON.parse(shown), null, 2); } catch { /* shown as written */ }
  const all = shown.replace(/\n$/, '').split('\n');
  return <div className="board-text"><pre>{all.slice(0, lines).join('\n')}</pre>
    {(all.length > lines || text.cut) && <small>First {Math.min(lines, all.length)} of {text.cut ? 'more than ' + all.length : all.length.toLocaleString()} lines</small>}</div>;
}
function Run({ node }: { node: GraphNode }) {
  const clean = node.outcome === 'returned' && (!node.end || /^exit 0\b/i.test(node.end));
  return <details className="board-run">
    <summary><code title={node.ran ?? node.command}>$ {commandGist(node.ran ?? node.command ?? '')}</code>
      <span className={'board-run-end' + (clean ? '' : ' problem')}>{node.end ?? (node.outcome === 'requested' ? 'Running' : 'Returned')}{node.durationMs ? ' · ' + durationText(node.durationMs) : ''}</span></summary>
    <pre className="board-run-full">{node.ran ?? node.command}</pre>
    {node.output?.text ? <pre ref={e => { if (e) e.scrollTop = e.scrollHeight; }}>{node.output.text}</pre> : <p className="board-note">The Agent reported no output for this command.</p>}
  </details>;
}

const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
const failure = (error: unknown) => error instanceof Error ? error.message : 'The message could not be sent.';

// The person's question, where they are looking. It goes to the conversation that gave this
// answer; a failed send keeps its identity, so sending the same words again never sends twice.
function AskBox({ about, onSend, onCancel }: { about: Asking | { kind: 'changes' }; onSend: (question: string) => Promise<void>; onCancel: () => void }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  async function send() {
    if (!question.trim() || busy) return;
    setBusy(true); setProblem('');
    try { await onSend(question); } catch (error) { setProblem(failure(error)); } finally { setBusy(false); }
  }
  return <form className="board-ask-box" onSubmit={event => { event.preventDefault(); void send(); }} onKeyDown={event => { if (event.key === 'Escape') onCancel(); }}>
    {about.kind === 'passage' ? <blockquote>{about.text}</blockquote> : about.kind === 'file' ? <p className="board-ask-about">About <strong>{about.title}</strong>{about.resource ? ' as this message left it' : ''}</p> : <p className="board-ask-about"><strong>What needs to change?</strong> The Agent receives your words.</p>}
    <textarea ref={input} rows={2} value={question} aria-label={about.kind === 'changes' ? 'What needs to change' : 'Your question'} placeholder={about.kind === 'changes' ? 'Say what is wrong or missing' : 'What do you want to know or change?'}
      onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    <div className="board-ask-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" className="primary" disabled={busy || !question.trim()}>{busy ? 'Sending…' : about.kind === 'changes' ? 'Send to the Agent' : 'Ask the Agent'}</button></div>
  </form>;
}

// A reason names commands between backticks; they read as code, not as punctuation.
function Said({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => i % 2 ? <code key={i}>{part}</code> : part)}</>;
}

function Item({ client, snapshot, item, onPath, said, span, ask, holds }: { client: BrowserClient; snapshot: WorkspaceSnapshot; item: BoardItem; onPath: (path: string) => void; said?: string; span?: number; ask?: { open: boolean; toggle: () => void; box: React.ReactNode };
  // What the file holds: the notes' words, else a model's sentence, else facts read from it.
  holds?: Holds }) {
  const { node, role } = item;
  const figure = node.category === 'figures', table = /\.(csv|tsv)$/i.test(node.path ?? '');
  const body = role === 'run' ? null : figure ? <Figure client={client} snapshot={snapshot} node={node} />
    : table && (role === 'primary' || role === 'supporting') ? <Table client={client} snapshot={snapshot} node={node} rows={role === 'primary' ? 12 : 5} />
    : role === 'method' ? <Method client={client} snapshot={snapshot} node={node} />
    : (role === 'primary' || role === 'supporting') && /\.(json|txt|md|ya?ml|log)$/i.test(node.path ?? '') ? <Text client={client} snapshot={snapshot} node={node} lines={role === 'primary' ? 16 : 8} /> : null;
  if (role === 'run') return <div className="board-item role-run"><Run node={node} /><small className="board-why"><Said text={item.why} /></small></div>;
  return <article className={'board-item role-' + role + (span ? ' span-' + span : '') + (ask?.open ? ' asking' : '')}>
    <header><div className="board-item-title"><button className="board-name" title={'Show ' + node.path} onClick={() => onPath(node.path!)}><Icon name={pathIcon(node.path!)} size={15} stroke={1.7} /><strong>{node.title}</strong></button>
      {ask && <button className="text-button board-ask-button" aria-expanded={ask.open} onClick={ask.toggle}>Ask</button>}</div>
      {holds && <HoldsText className="board-holds" holds={holds} />}
      {item.why !== said && <small className="board-why"><Said text={item.why} /></small>}</header>
    {ask?.open && ask.box}
    {body}
  </article>;
}

type Turn = RhoOutput<'conversation.read'>['turns'][number];
// The person's word on this answer. It holds for the versions the message kept; a result that
// changed on disk since is named, because the decision does not cover it.
function Verdict({ record, graph, shown, onDecide, onNeedsChanges }: { record: Turn; graph: WorkGraph; shown: string[]; onDecide: () => Promise<void>; onNeedsChanges: (note: string) => Promise<void> }) {
  const last = record.decisions?.at(-1);
  const [changing, setChanging] = useState(false);
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => { setChanging(false); setWriting(false); setProblem(''); }, [record.id, last?.changeId]);
  if (record.state === 'running') return null;
  const since = last ? last.results.filter(r => { const node = graph.nodes.find(n => n.kind === 'file' && n.path === r.path); return !!node?.modifiedAt && Date.parse(node.modifiedAt) > Date.parse(last.at) + 1000; }) : [];
  // Results on the board of which this message kept no version: the decision cannot name them.
  const uncovered = last ? shown.filter(path => !last.results.some(r => r.path === path)) : [];
  async function accept() { setBusy(true); setProblem(''); try { await onDecide(); } catch (error) { setProblem(failure(error)); } finally { setBusy(false); } }
  if (writing) return <div className="board-verdict"><AskBox about={{ kind: 'changes' }} onSend={onNeedsChanges} onCancel={() => setWriting(false)} /></div>;
  return <div className={'board-verdict' + (last && !changing ? ' ' + last.decision : '')}>
    {last && !changing ? <>
      <p><Icon name={last.decision === 'accepted' ? 'check' : 'pencil'} size={14} stroke={2} /> <strong>{last.decision === 'accepted' ? 'You chose to use this answer' : 'You said this needs changes'}</strong>
        <span className="board-meta"> · {day(last.at)} · for the {last.results.length} {last.results.length === 1 ? 'file version' : 'file versions'} this message kept</span></p>
      {last.note && <blockquote>{last.note}</blockquote>}
      {uncovered.length > 0 && <p className="board-meta">Not covered: no version was kept of {uncovered.map(path => path.split('/').at(-1)).join(', ')}.</p>}
      {since.length > 0 && <p className="board-verdict-since">Changed since: {since.map(r => r.path.split('/').at(-1)).join(', ')}. The decision does not cover the new {since.length === 1 ? 'version' : 'versions'}.</p>}
      <button className="text-button" onClick={() => setChanging(true)}>Change</button>
    </> : <>
      <p className="board-meta">Will you use this answer?</p>
      <div className="board-verdict-actions">
        <button className="primary" disabled={busy} onClick={() => void accept()}>{busy ? 'Saving…' : 'Use this answer'}</button>
        <button disabled={busy} onClick={() => setWriting(true)}>Needs changes</button>
        {changing && <button className="text-button" onClick={() => setChanging(false)}>Cancel</button>}
      </div>
    </>}
    {problem && <p className="inline-error" role="alert">{problem}</p>}
  </div>;
}

// A question asked about this answer since, with what it was about and the Agent's reply.
function FollowUp({ id, node, running, at, onOpen }: { id: string; node?: GraphNode; running: boolean; at: number; onOpen: () => void }) {
  if (!node) return null;
  const { about, quote, question } = askedAbout(node.text ?? '');
  return <li className="board-follow-up" id={'board-follow-' + id}>
    <div className="board-follow-ask">
      {(about || quote) && <span className="board-follow-about" title={quote ?? about ?? ''}>{about ? 'About ' + (about.split('/').at(-1) ?? about) : '“' + clip(quote!, 60) + '”'}</span>}
      <p>{question}</p>
      <button className="text-button" onClick={onOpen}>{running ? 'Answering…' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} <Icon name="chevron" size={12} /></button>
    </div>
    {node.answer ? <Answer text={node.answer} streaming={running} /> : running ? <p className="board-note" role="status">The Agent is working on this.</p> : null}
  </li>;
}

export function AnswerBoard({ client, snapshot, files, notesText = '', onConversation, onPath, onConsole, onGraph, onAsked }: {
  client: BrowserClient; snapshot: WorkspaceSnapshot; files: ProjectFiles; notesText?: string;
  onConversation: (conversationId: string) => void; onPath: (path: string) => void; onConsole: (turn?: string) => void; onGraph: () => void;
  // After a question is sent: show the conversation where the Agent answers it.
  onAsked?: (conversationId: string) => void;
}) {
  const { turns, loading } = useTurns(client, snapshot);
  const graphFiles = useMemo(() => files.files.map(f => ({ path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, category: f.category })), [files.files]);
  const graph = useMemo(() => foldVersions(buildWorkGraph({ turns, files: graphFiles, project: snapshot.project, kindOf, now: Date.now() })), [turns, graphFiles, snapshot.project]);
  // What the notes say each file holds, and the choices this conversation's section records.
  const meaning = useMeaning(client, snapshot, graph, graphFiles, notesText, turns);
  const threads = useMemo(() => boardThreads(graph), [graph]);
  // The newest answer is shown, and a new one takes its place, unless the person chose another.
  const [chosen, setChosen] = useState<string | null>(null);
  const thread = (chosen && threads.find(t => t.turn.id === chosen)) || threads[0];
  const shown = thread?.turn, board = thread?.board, followUps = thread?.followUps ?? [];
  // What the person is asking about: a key for where its box shows, and the request identity
  // for the words they are sending.
  const [asking, setAsking] = useState<{ key: string; about: Asking } | null>(null);
  const [selected, setSelected] = useState<{ text: string; top: number; left: number } | null>(null);
  const sending = useRef<{ text: string; changeId: string } | null>(null);
  // A decision keeps its request identity until it is recorded; the words sent with "needs
  // changes" keep theirs, so retrying either never records or sends twice.
  const deciding = useRef<{ key: string; changeId: string } | null>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setAsking(null); setSelected(null); }, [shown?.id]);
  if (loading || !board || !shown) return null;
  const conversationId = shown.conversationId;
  const busy = snapshot.conversations?.find(c => c.conversationId === conversationId)?.state === 'running';
  async function send(about: Asking, question: string) {
    const text = askText(about, question);
    if (sending.current?.text !== text) sending.current = { text, changeId: 'ask-' + crypto.randomUUID() };
    await client.call('conversation.send', { projectId: snapshot.project.id, conversationId, changeId: sending.current.changeId, text });
    sending.current = null; setAsking(null);
    (onAsked ?? onConversation)(conversationId);
  }
  async function decide(decision: 'accepted' | 'needs-changes', note?: string) {
    const key = shown!.id + ':' + decision + ':' + (note ?? '');
    if (deciding.current?.key !== key) deciding.current = { key, changeId: 'decide-' + crypto.randomUUID() };
    await client.call('conversation.decide', { projectId: snapshot.project.id, conversationId, turnId: record!.id, changeId: deciding.current.changeId, decision, ...(note ? { note } : {}) });
    deciding.current = null;
  }
  async function needsChanges(note: string) {
    await decide('needs-changes', note.trim());
    const text = 'Needs changes: ' + note.trim();
    if (sending.current?.text !== text) sending.current = { text, changeId: 'ask-' + crypto.randomUUID() };
    await client.call('conversation.send', { projectId: snapshot.project.id, conversationId, changeId: sending.current.changeId, text });
    sending.current = null;
    (onAsked ?? onConversation)(conversationId);
  }
  const box = (key: string, about: Asking) => asking?.key === key ? <AskBox about={asking.about} onSend={question => send(asking.about, question)} onCancel={() => setAsking(null)} /> : null;
  const askFor = (item: BoardItem) => {
    const key = 'file:' + item.node.path;
    return { open: asking?.key === key, toggle: () => setAsking(asking?.key === key ? null : { key, about: { kind: 'file', path: item.node.path!, title: item.node.title, resource: item.node.resource ?? null } }), box: box(key, { kind: 'file', path: item.node.path!, title: item.node.title }) };
  };
  // A passage of the answer the person selected, offered as something to ask about.
  function select() {
    const selection = getSelection(), text = selection?.toString().trim() ?? '';
    const holder = answerRef.current;
    if (!selection || !text || !holder || !selection.rangeCount || !holder.contains(selection.anchorNode) || !holder.contains(selection.focusNode)) { setSelected(null); return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect(), base = holder.getBoundingClientRect();
    setSelected({ text: text.slice(0, 2000), top: rect.bottom - base.top + 6, left: Math.max(0, Math.min(rect.left - base.left, base.width - 140)) });
  }
  const { question } = board, record = turns.find(t => t.conversationId + '/' + t.turn.id === shown.id)?.turn;
  const roles = (role: BoardItem['role']) => board.items.filter(i => i.role === role);
  const primary = roles('primary')[0], supporting = roles('supporting'), method = roles('method'), runs = roles('run'), inputs = roles('input'), reports = roles('report');
  const more = (role: BoardItem['role']) => board.omitted[role] ? <small className="board-more">{board.omitted[role]} more in Files</small> : null;
  // What the Agent is doing now, named by its target; the state already says it is working.
  const live = shown.running ? graph.live : null, liveNode = live && graph.nodes.find(n => n.id === live.node);
  const now = live && liveNode && liveNode.kind !== 'question' ? live.label + ' ' + (liveNode.kind === 'run' && liveNode.ran ? commandGist(liveNode.ran) : liveNode.title) : live?.waiting ? live.label : null;
  // A question asked since that the Agent is answering now, named where the eye starts.
  const running = followUps.find(t => t.running), askingNow = running ? { id: running.id, title: clip(askedAbout(graph.nodes.find(n => n.id === 'q:' + running.id)?.text ?? '').question.split('\n')[0]!, 60) } : null;
  const results = [primary, ...supporting].filter(Boolean) as BoardItem[];
  const holds = (item: BoardItem) => item.node.path ? meaning.holds(item.node.path) : undefined;
  const section = meaning.meanings.find(m => m.conversationId === conversationId);
  const choices = section?.statements.filter(s => s.kind === 'choice') ?? [];
  const said = results.length > 1 && results.every(i => i.why === results[0].why) ? results[0].why : undefined;
  // Results past the two beside the leading one go three to a row; a last row of one or two is shared out.
  const below = primary ? Math.max(0, supporting.length - 2) : supporting.length, tail = below % 3;
  return <section className="project-section answer-board" aria-labelledby="board-title">
    <header className="board-head">
      <div className="board-ask">
        <h2 id="board-title" title={question.text}>{question.title}</h2>
        <p className="board-meta"><span className={'work-state ' + (question.state ?? '')}>{ended[question.state ?? ''] ?? question.state}</span>
          {record && <> · {day(record.endedAt ?? record.sentAt)}{record.endedAt && took(record.startedAt ?? record.sentAt, record.endedAt) ? ' · took ' + took(record.startedAt ?? record.sentAt, record.endedAt) : ''}</>}
          {now && <> · <span className={'board-live' + (live?.waiting ? ' waiting' : '')} title={now}>{now}</span></>}
          {askingNow && <> · <button className="text-button board-live" onClick={() => document.getElementById('board-follow-' + askingNow.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>Answering “{askingNow.title}”</button></>}</p>
      </div>
      <div className="board-actions">
        {threads.length > 1 && <select aria-label="Answer to show" value={shown.id} onChange={event => setChosen(event.target.value)}>
          {threads.map(({ turn: t }) => <option key={t.id} value={t.id}>{new Date(t.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · {graph.nodes.find(n => n.id === 'q:' + t.id)?.title ?? 'A message'}</option>)}</select>}
        <button className="text-button" onClick={() => onConversation(shown.conversationId)}>Conversation <Icon name="chevron" size={12} /></button>
      </div>
    </header>
    {question.answer ? <div className="board-answer" ref={answerRef} onMouseUp={select} onKeyUp={select}>
        <Answer text={question.answer} streaming={!!shown.running} />
        {selected && !shown.running && <button className="board-select-ask" style={{ top: selected.top, left: selected.left }} onMouseDown={event => event.preventDefault()}
          onClick={() => { setAsking({ key: 'passage', about: { kind: 'passage', text: selected.text } }); setSelected(null); getSelection()?.removeAllRanges(); }}>Ask about this</button>}
      </div> : shown.running ? <p className="board-note" role="status">The Agent is working on this message.</p> : null}
    {asking?.key === 'passage' && box('passage', asking.about)}
    {busy && asking && <p className="board-note">The Agent is still answering. Your question can be sent when it has finished.</p>}
    {(primary || supporting.length > 0) && <div className="board-results-block">
      {/* How the results came about, said once when it is the same for all of them. */}
      <p className="board-results-why"><strong>Results</strong>{said && <> · <Said text={said} /></>}</p>
      <div className={'board-results beside-' + Math.min(supporting.length, 2)}>
        {primary && <Item client={client} snapshot={snapshot} item={primary} onPath={onPath} said={said} holds={holds(primary)} ask={shown.running ? undefined : askFor(primary)} />}
        {supporting.map((item, i) => <Item key={item.node.id} client={client} snapshot={snapshot} item={item} onPath={onPath} said={said} holds={holds(item)} span={i >= supporting.length - tail ? 6 / tail : undefined} ask={shown.running ? undefined : askFor(item)} />)}
      </div>
      {more('supporting')}
    </div>}
    {(method.length > 0 || runs.length > 0 || inputs.length > 0 || reports.length > 0 || board.otherCommands > 0) && <div className="board-how">
      {method.length > 0 && <div className="board-row"><span className="board-label">Method</span><div className="board-cells">{method.map(item => <Item key={item.node.id} client={client} snapshot={snapshot} item={item} onPath={onPath} holds={holds(item)} ask={shown.running ? undefined : askFor(item)} />)}</div></div>}
      {(runs.length > 0 || board.otherCommands > 0) && <div className="board-row"><span className="board-label">Ran</span><div className="board-cells">
        {runs.map(item => <Item key={item.node.id} client={client} snapshot={snapshot} item={item} onPath={onPath} />)}
        {board.otherCommands > 0 && <button className="text-button board-console" onClick={() => onConsole(shown.id)}>{runs.length ? board.otherCommands + ' other ' + (board.otherCommands === 1 ? 'command' : 'commands') : board.otherCommands + (board.otherCommands === 1 ? ' command' : ' commands')} in the Console <Icon name="chevron" size={12} /></button>}
      </div></div>}
      {inputs.length > 0 && <div className="board-row"><span className="board-label">From</span><div className="board-chips">{inputs.map(item => <button key={item.node.id} className="work-file" title={item.why.replaceAll('`', '') + ' · ' + item.node.path} onClick={() => onPath(item.node.path!)}><Icon name={pathIcon(item.node.path!)} size={14} stroke={1.7} /><span>{item.node.title}</span></button>)}{more('input')}</div></div>}
      {reports.length > 0 && <div className="board-row"><span className="board-label">Report</span><div className="board-chips">{reports.map(item => <button key={item.node.id} className="work-file" title={item.why.replaceAll('`', '') + ' · ' + item.node.path} onClick={() => onPath(item.node.path!)}><Icon name="document" size={14} stroke={1.7} /><span>{item.node.title}</span></button>)}</div></div>}
    </div>}
    {/* Choices the Agent took and went on with, each beside what the other options give. Nothing
        here waits on the person; another option is theirs to ask for. */}
    {choices.length > 0 && <div className="board-choices">
      <p className="board-results-why"><strong>Choices</strong> · the Agent went on with one option; the others are shown with what they give</p>
      {choices.map(choice => <ChoiceOptions key={choice.line} statement={choice} trace={meaning.traces.get(choice)} conversationId={conversationId} client={client} projectId={snapshot.project.id} onPath={onPath} onSent={id => (onAsked ?? onConversation)(id)} />)}
    </div>}
    {followUps.length > 0 && <div className="board-follow">
      <p className="board-results-why"><strong>Asked since</strong></p>
      <ol>{followUps.map(t => <FollowUp key={t.id} id={t.id} node={graph.nodes.find(n => n.id === 'q:' + t.id)} running={!!t.running} at={t.start} onOpen={() => onConversation(t.conversationId)} />)}</ol>
    </div>}
    {record && <Verdict record={record} graph={graph} shown={[primary, ...supporting, ...reports].filter((i): i is BoardItem => !!i).map(i => i.node.path!)} onDecide={() => decide('accepted')} onNeedsChanges={needsChanges} />}
    <footer className="board-foot"><button className="text-button" onClick={onGraph}>How each file connects, in the Graph <Icon name="chevron" size={12} /></button></footer>
  </section>;
}
