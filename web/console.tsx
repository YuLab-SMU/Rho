import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { buildWorkGraph, type GraphNode, type WorkGraph } from '../src/work-graph.js';
import { briefOf, durationText, inProject, several } from '../src/conversation-presentation.js';
import { executionWord, type RunFacts } from '../src/execution-facts.js';
import { useTurns } from './work-turns.js';
import { useRuns } from './executions.js';
import { kindOf, type ProjectFiles } from './sources.js';
import { day, pathIcon } from './agent-work.js';
import { projectName } from './home.js';
import { Icon } from './icons.js';
import { RunView } from './shell/facts.js';
import { useProcess } from './process-context.js';
import './console.css';

// Every command run in the project, in one place: what the Agent ran in each message, from its
// own reports, the commands the person ran here, and the runs Rho managed. A message's commands
// read in the order they ran, each led by the Agent's own words on what it was for when it gave
// them, with how it ended when that was not a clean exit, how long it took, the files that
// changed on disk while it ran (seen, not claimed) and what it printed. Commands in a row that
// changed no file fold into one line. The record keeps each file's last change, so a command
// that wrote a file changed again later shows none of its own.
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const clean = (node: GraphNode) => node.outcome === 'returned' && (!node.end || /^exit 0\b/i.test(node.end));
// A command that returned without an exit code is not a problem; one that failed or exited non-zero is.
const troubled = (node: GraphNode) => node.outcome === 'failed' || node.outcome === 'rejected' || node.outcome === 'unknown' || /^exit [1-9]/i.test(node.end ?? '');
// Earlier records kept only a command's first line; a here-document without its body cannot run again.
const whole = (command: string) => !/<<-?\s*['"]?\w+['"]?\s*$/.test(command.trim());
function QuietRun({ runs, root, onPath, onRunAgain }: { runs: GraphNode[]; root: string; onPath: (path: string) => void; onRunAgain?: (command: string, from: string) => void }) {
  const named = runs.flatMap(run => run.purpose ? [run.purpose] : briefOf(inProject(run.command!, root)).split(' → ')).filter((word, i, all) => all.indexOf(word) === i);
  const took = runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0);
  return <li className="console-command console-quiet-row"><details>
    <summary>
      <span className="console-time">{clock(runs[0]!.at)}</span>
      <span className="console-what"><span className="console-purpose">{named.join(' · ')}</span></span>
      <span className="console-end">{runs.length} commands{took ? ' · ' + durationText(took) : ''}</span>
    </summary>
    <ol className="console-list">{runs.map(run => <Command key={run.id} node={run} changed={[]} root={root} onPath={onPath} onRunAgain={onRunAgain} />)}</ol>
  </details></li>;
}
type Item = { at: number; key: string; agent?: GraphNode; changed?: GraphNode[]; quiet?: GraphNode[]; mine?: Mine };
// A message's commands in the order they ran; those in a row that changed no file and ended
// cleanly go together.
function commandItems(graph: WorkGraph, runs: GraphNode[]): Item[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out: Item[] = [];
  for (const run of [...runs].sort((a, b) => a.at - b.at)) {
    const changed = graph.edges.filter(e => e.from === run.id && e.label === 'changed while it ran').map(e => byId.get(e.to)).filter((n): n is GraphNode => !!n && !!n.category);
    if (!changed.length && run.outcome !== 'requested' && clean(run)) {
      const last = out.at(-1);
      if (last?.quiet) { last.quiet.push(run); continue; }
      out.push({ at: run.at, key: 'quiet-' + run.id, quiet: [run] });
    } else out.push({ at: run.at, key: run.id, agent: run, changed });
  }
  return out;
}
function ItemRow({ item, root, onPath, onRunAgain }: { item: Item; root: string; onPath: (path: string) => void; onRunAgain?: (command: string, from: string) => void }) {
  if (item.quiet && item.quiet.length > 1) return <QuietRun runs={item.quiet} root={root} onPath={onPath} onRunAgain={onRunAgain} />;
  const run = item.quiet?.[0] ?? item.agent!;
  return <Command node={run} changed={item.changed ?? []} root={root} onPath={onPath} open={run.outcome === 'requested'} onRunAgain={onRunAgain} />;
}
const Changed = ({ files, onPath }: { files: Array<{ path: string; name: string }>; onPath: (path: string) => void }) => files.length > 0
  ? <div className="console-changed"><span>Changed while it ran</span>{files.map(file => <button key={file.path} className="work-file" title={file.path} onClick={() => onPath(file.path)}><Icon name={pathIcon(file.path)} size={13} stroke={1.7} /><span>{file.name}</span></button>)}</div> : null;

type Mine = RhoOutput<'console.list'>['commands'][number];
const failure = (error: unknown) => error instanceof Error ? error.message : 'The Console could not be reached.';
// The protected resource is this tab: it shows at most this much of one command's output and
// reads a running command again this often.
export const consoleViewLimits = { shownBytes: 256 * 1024, pollMs: 700, listed: 50 };

function Command({ node, changed, root, onPath, open, onRunAgain }: { node: GraphNode; changed: GraphNode[]; root: string; onPath: (path: string) => void; open?: boolean; onRunAgain?: (command: string, from: string) => void }) {
  const command = node.ran ?? node.command!, shown = inProject(node.command!, root);
  const running = node.outcome === 'requested', problem = troubled(node);
  // A clean exit is the usual ending and goes unsaid; anything else is said.
  const ending = running ? 'Running' : node.outcome === 'rejected' ? 'Refused' : node.outcome === 'unknown' ? 'Outcome unknown' : problem ? node.end ?? 'Failed' : null;
  const took = node.durationMs ? durationText(node.durationMs) : '';
  const again = onRunAgain && !running && (whole(command)
    ? <button className="text-button console-again" onClick={() => onRunAgain(command, 'the Agent\'s command at ' + clock(node.at))}>Run again</button>
    : <span className="console-note">Only its first line was recorded, so it cannot run again from here.</span>);
  return <li className={'console-command' + (changed.length ? ' made' : '') + (problem ? ' problem' : '')}>
    <details open={open}>
      <summary>
        <span className="console-time">{clock(node.at)}</span>
        <span className="console-what" title={command}>
          {node.purpose ? <><span className="console-purpose">{node.purpose}</span><code>{shown}</code></>
            : several(shown) ? <><code className="alone">{briefOf(shown)}</code><code>{shown}</code></> : <code className="alone">{shown}</code>}
        </span>
        <span className={'console-end' + (running ? ' running' : problem ? ' problem' : '')}>{[ending, took].filter(Boolean).join(' · ')}</span>
      </summary>
      <div className="console-detail">
        {(shown.includes('\n') || shown.length > 90 || command !== node.command) && <pre className="console-ran">{inProject(command, root)}</pre>}
        {node.output?.text ? <pre className="console-output" ref={e => { if (e && running) e.scrollTop = e.scrollHeight; }}>{node.output.text}{node.output.cut ? '\n…' : ''}</pre> : <p className="console-note">{running ? 'Running…' : 'No output was reported.'}</p>}
        {again && <div className="console-actions">{again}</div>}
      </div>
    </details>
    <Changed files={changed.map(file => ({ path: file.path!, name: file.title }))} onPath={onPath} />
  </li>;
}

// A command's output as it arrives: pages from where the last read stopped, again while it runs.
function useOutput(client: BrowserClient, projectId: string, record: Mine, open: boolean) {
  const [out, setOut] = useState({ text: '', more: false, problem: '' });
  const at = useRef(0);
  useEffect(() => {
    if (!open) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const pull = async () => {
      try {
        for (;;) {
          if (at.current >= consoleViewLimits.shownBytes) { setOut(o => ({ ...o, more: true })); return; }
          const page = await client.call('console.output', { projectId, commandId: record.commandId, offset: at.current, maxBytes: 65536 });
          if (!live) return;
          at.current = page.nextOffset;
          setOut(o => ({ text: o.text + page.text, more: false, problem: '' }));
          if (!page.more) break;
        }
      } catch (error) { if (live) setOut(o => ({ ...o, problem: failure(error) })); }
      if (live && record.state === 'running') timer = setTimeout(pull, consoleViewLimits.pollMs);
    };
    void pull();
    return () => { live = false; clearTimeout(timer); };
  }, [client, projectId, record.commandId, record.state, open]);
  return out;
}

const ended = (r: Mine) => r.state === 'running' ? 'Running' : r.state === 'stopped' ? 'Stopped' : r.state === 'continuing' ? 'Still running outside Rho' : r.state === 'unknown' ? 'Outcome unknown' : r.state === 'not-started' ? 'Did not start'
  : r.exit?.signal ? 'Ended by ' + r.exit.signal : 'Exit ' + (r.exit?.code ?? '?');
function Yours({ record, client, projectId, changed, onPath, onRunAgain, onStop }: { record: Mine; client: BrowserClient; projectId: string; changed: Array<{ path: string; name: string }>; onPath: (path: string) => void; onRunAgain: (record: Mine) => void; onStop: (record: Mine) => void }) {
  const [open, setOpen] = useState(record.state === 'running');
  const [now, setNow] = useState(Date.now());
  const out = useOutput(client, projectId, record, open);
  const running = record.state === 'running';
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running]);
  const took = (record.endedAt ? Date.parse(record.endedAt) : now) - Date.parse(record.startedAt);
  const clean = record.state === 'exited' && record.exit?.code === 0;
  const ending = [clean ? '' : ended(record), took >= 1000 ? durationText(took) : ''].filter(Boolean).join(' · ');
  return <li className={'console-command mine' + (changed.length || running ? ' made' : '') + (!clean && !running ? ' problem' : '')}>
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="console-time">{clock(Date.parse(record.startedAt))}</span>
        <span className="console-what" title={record.command}><code className="alone">{record.command}</code></span>
        <span className={'console-end' + (running ? ' running' : clean ? '' : ' problem')}>{ending}</span>
      </summary>
      <div className="console-detail">
      {record.cwd && <p className="console-note">In {record.cwd}/</p>}
      {out.text ? <pre className="console-output" ref={e => { if (e && running) e.scrollTop = e.scrollHeight; }}>{out.text}</pre> : <p className="console-note">{running ? 'Waiting for output…' : out.problem ? '' : 'It printed nothing.'}</p>}
      {out.more && <p className="console-note">Showing the first {(consoleViewLimits.shownBytes / 1024).toFixed(0)} KiB of {record.kept.toLocaleString('en-US')} kept bytes.</p>}
      {record.cut && !running && <p className="console-note">It printed {record.bytes.toLocaleString('en-US')} bytes; the middle was not kept.</p>}
      {record.problem && <p className="console-note">{record.problem}</p>}
      {out.problem && <p className="inline-error" role="alert">{out.problem}</p>}
      {!running && record.state !== 'continuing' && <div className="console-actions"><button className="text-button console-again" onClick={() => onRunAgain(record)}>Run again</button></div>}
      </div>
    </details>
    <Changed files={changed} onPath={onPath} />
    {running && <div className="console-actions"><button className="text-button console-again" disabled={!!record.stop} onClick={() => onStop(record)}>{record.stop ? 'Stopping…' : 'Stop'}</button></div>}
  </li>;
}

// The person's own line: a command runs in the project folder with their shell. A failed
// request keeps its identity, so pressing Run again for the same words never runs it twice.
function Prompt({ folder, draft, setDraft, note, busy, problem, onRun, input }: { folder: string; draft: string; setDraft: (text: string) => void; note: string; busy: boolean; problem: string; onRun: () => void; input: React.RefObject<HTMLTextAreaElement | null> }) {
  const lines = Math.min(8, draft.split('\n').length), id = useId();
  return <form className="console-prompt" onSubmit={event => { event.preventDefault(); onRun(); }}>
    <label htmlFor={id} className="console-prompt-label">Run a command in <strong>{folder}</strong></label>
    <div className="console-line">
      <span aria-hidden="true">$</span>
      <textarea id={id} ref={input} rows={lines} value={draft} spellCheck={false} autoComplete="off" autoCapitalize="off" placeholder="python3 analysis.py"
        onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onRun(); } }} />
      <button type="submit" className="primary" disabled={busy || !draft.trim()}>{busy ? 'Starting…' : 'Run'}</button>
    </div>
    {note && <p className="console-note">{note}</p>}
    {problem && <p className="inline-error" role="alert">{problem}</p>}
  </form>;
}

function useMine(client: BrowserClient, projectId: string, cursor: number) {
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [state, setState] = useState<{ off: boolean; problem: string }>({ off: false, problem: '' });
  const read = useCallback(() => client.call('console.list', { projectId, limit: consoleViewLimits.listed }).then(value => { setMine(value.commands); setState({ off: false, problem: '' }); },
    error => setState({ off: error instanceof BrowserApiError && ['unavailable', 'unauthorized'].includes(error.error.kind), problem: failure(error) })), [client, projectId]);
  useEffect(() => { void read(); }, [read, cursor]);
  return { mine, ...state, read };
}

function Message({ graph, turn, root, onPath, onConversation, focused, onRunAgain }: { graph: WorkGraph; turn: WorkGraph['turns'][number]; root: string; onPath: (path: string) => void; onConversation: (id: string) => void; focused: boolean; onRunAgain?: (command: string, from: string) => void }) {
  const question = graph.nodes.find(n => n.id === 'q:' + turn.id);
  const runs = graph.nodes.filter(n => n.kind === 'run' && n.turn === turn.id);
  const items = commandItems(graph, runs);
  const changed = new Set(items.flatMap(item => (item.changed ?? []).map(file => file.path)));
  const failed = runs.filter(troubled).length;
  const section = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) section.current?.scrollIntoView({ block: 'start' }); }, [focused]);
  if (!runs.length) return null;
  return <section ref={section} className={'console-message' + (focused ? ' focused' : '')} aria-label={question?.title ?? 'A message'}>
    <header>
      <button className="text-button console-ask" title={question?.text} onClick={() => onConversation(turn.conversationId)}>{question?.title ?? 'A message'}</button>
      <small>{turn.agent} · {day(new Date(turn.start).toISOString())} · {runs.length} {runs.length === 1 ? 'command' : 'commands'}{changed.size ? ` · ${changed.size} ${changed.size === 1 ? 'file' : 'files'} changed` : ''}{failed ? ` · ${failed} did not end cleanly` : ''}{turn.running ? ' · working' : ''}</small>
    </header>
    <ol className="console-list">{items.map(item => <ItemRow key={item.key} item={item} root={root} onPath={onPath} onRunAgain={onRunAgain} />)}</ol>
  </section>;
}

export function ConsolePage({ client, snapshot, files, focusTurn, onPath, onConversation, children }: {
  client: BrowserClient; snapshot: WorkspaceSnapshot; files: ProjectFiles; focusTurn?: string | null;
  onPath: (path: string) => void; onConversation: (id: string) => void; children?: React.ReactNode;
}) {
  const projectId = snapshot.project.id;
  const { turns, loading, problem, omitted } = useTurns(client, snapshot);
  const graph = useMemo(() => buildWorkGraph({ turns, files: files.files.map(f => ({ path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, category: f.category })), project: snapshot.project, kindOf, now: Date.now() }), [turns, files.files, snapshot.project]);
  const { runs, problem: runsProblem, readAgain } = useRuns(client, projectId, snapshot.cursor);
  const { mine, off, problem: mineProblem, read } = useMine(client, projectId, snapshot.cursor);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (inspecting && !dialog.current?.open) dialog.current?.showModal(); }, [inspecting]);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [runProblem, setRunProblem] = useState('');
  const pending = useRef<{ command: string; changeId: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // A finished command may have changed files; read the folders again so its changes show.
  const finished = (mine ?? []).filter(r => r.state !== 'running').length;
  useEffect(() => { if (mine) files.refresh(); }, [finished]);
  async function start(command: string) {
    if (!command.trim() || busy) return;
    if (pending.current?.command !== command) pending.current = { command, changeId: 'console-' + crypto.randomUUID() };
    setBusy(true); setRunProblem('');
    try {
      await client.call('console.run', { projectId, command, changeId: pending.current.changeId });
      pending.current = null; setDraft(''); setNote(''); void read();
    } catch (error) { setRunProblem(failure(error)); }
    finally { setBusy(false); }
  }
  async function stop(record: Mine) {
    try { await client.call('console.stop', { projectId, commandId: record.commandId, changeId: 'stop-' + record.commandId }); void read(); }
    catch (error) { setRunProblem(failure(error)); }
  }
  function prepare(command: string, from: string) {
    setDraft(command); setNote('From ' + from + '. Check it, then press Run.'); setRunProblem('');
    input.current?.scrollIntoView({ block: 'center' }); input.current?.focus();
  }
  // What changed on disk between a command's start and end: seen, not claimed.
  const changedDuring = (r: Mine) => {
    const from = Date.parse(r.startedAt), to = r.endedAt ? Date.parse(r.endedAt) + 1000 : Date.now();
    return files.files.filter(f => f.category && f.modifiedAt && Date.parse(f.modifiedAt) >= from - 1000 && Date.parse(f.modifiedAt) <= to).slice(0, 8);
  };
  const messages = [...graph.turns].sort((a, b) => b.start - a.start).filter(t => graph.nodes.some(n => n.kind === 'run' && n.turn === t.id));
  // One story, newest first: each message's commands, and the commands the person ran between them.
  type Block = { kind: 'message'; at: number; turn: WorkGraph['turns'][number] } | { kind: 'mine'; at: number; records: Mine[] };
  const blocks: Block[] = [];
  for (const item of [...messages.map(turn => ({ at: turn.start, turn })), ...(mine ?? []).map(record => ({ at: Date.parse(record.startedAt), record }))].sort((a, b) => b.at - a.at)) {
    if ('turn' in item) blocks.push({ kind: 'message', at: item.at, turn: item.turn });
    else { const last = blocks.at(-1); if (last?.kind === 'mine') last.records.push(item.record); else blocks.push({ kind: 'mine', at: item.at, records: [item.record] }); }
  }
  const managed = [...(runs ?? [])].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  const nothing = !loading && !blocks.length && !managed.length;
  return <div className="console-page">
    {children}
    {!off && <Prompt folder={projectName(snapshot.project)} draft={draft} setDraft={text => { setDraft(text); if (!text) setNote(''); }} note={note} busy={busy} problem={runProblem} onRun={() => void start(draft)} input={input} />}
    {off && <p className="console-note">Running commands here needs the Console plugin, which is off for this project.</p>}
    {mineProblem && !off && <p className="inline-error" role="alert">{mineProblem}</p>}
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    {loading && <p className="muted" role="status">Reading the conversations…</p>}
    {nothing && <div className="empty-state compact"><p>No commands yet. The commands the Agent runs here, and the ones you run, appear in this list.</p></div>}
    {blocks.map(block => block.kind === 'message'
      ? <Message key={block.turn.id} graph={graph} turn={block.turn} root={snapshot.project.root} onPath={onPath} onConversation={onConversation} focused={focusTurn === block.turn.id} onRunAgain={off ? undefined : prepare} />
      : <section key={block.records[0]!.commandId} className="console-message mine" aria-label="Your commands">
          <header><strong>You ran</strong><small>{day(block.records.at(-1)!.startedAt)} · {block.records.length} {block.records.length === 1 ? 'command' : 'commands'}{block.records.some(r => r.state === 'running') ? ' · running' : ''}</small></header>
          <ol className="console-list">{block.records.map(record => <Yours key={record.commandId} record={record} client={client} projectId={projectId} changed={changedDuring(record)} onPath={onPath} onRunAgain={r => void start(r.command)} onStop={r => void stop(r)} />)}</ol>
        </section>)}
    {omitted > 0 && <p className="console-note">{omitted} earlier {omitted === 1 ? 'message is' : 'messages are'} not read here.</p>}
    {(managed.length > 0 || runsProblem) && <section className="console-message" aria-label="Managed runs">
      <header><strong>Managed runs</strong><small>Runs Rho submitted to Core, with their retained request and output</small></header>
      {runsProblem && <p className="inline-error" role="alert">{runsProblem}</p>}
      <ol className="console-list">{managed.map((run: RunFacts) => <li key={run.operationId} className="console-command made">
        <button className="console-managed" onClick={() => setInspecting(run.operationId)}>
          <span className="console-time">{new Date(run.acceptedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
          <code>{run.script ?? run.action}</code>
          <span className={'console-end ' + run.execution}>{executionWord(run.execution)} · {run.operationId}</span>
        </button>
      </li>)}</ol>
    </section>}
    {inspecting && <dialog ref={dialog} className="run-dialog" aria-label={inspecting} onClose={() => setInspecting(null)} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      <button className="icon-button run-dialog-close" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="close" size={18} /></button>
      <RunView key={inspecting} snapshot={snapshot} client={client} operationId={inspecting} runs={runs} readRuns={readAgain} onOpenRun={setInspecting} opener={() => null} />
    </dialog>}
  </div>;
}

// One conversation's commands in its Studio, read as a terminal reads: oldest first, the newest
// at the bottom and open while it runs, the person's own commands where they ran, and a line to
// run one. Commands with no recorded file change fold where they happened. During a replay it
// shows what had run by then, and the line to run waits for now.
export function CommandPane({ client, snapshot }: { client: BrowserClient; snapshot: WorkspaceSnapshot }) {
  const process = useProcess();
  const projectId = snapshot.project.id;
  const { mine, off, problem, read } = useMine(client, projectId, snapshot.cursor);
  const [draft, setDraft] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [runProblem, setRunProblem] = useState('');
  const pending = useRef<{ command: string; changeId: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), list = useRef<HTMLOListElement>(null), atEnd = useRef(true);
  const graph = process?.graph, at = process?.at ?? null;
  const items = useMemo(() => {
    if (!graph || !process) return [];
    const turns = graph.turns.filter(t => t.conversationId === process.conversationId);
    const since = Math.min(...turns.map(t => t.start));
    const out = commandItems(graph, graph.nodes.filter(n => n.kind === 'run' && turns.some(t => t.id === n.turn)));
    for (const record of mine ?? []) {
      const started = Date.parse(record.startedAt);
      if (started >= since && (at === null || started <= at)) out.push({ at: started, key: record.commandId, mine: record });
    }
    return out.sort((a, b) => a.at - b.at);
  }, [graph, mine, at, process?.conversationId]);
  useEffect(() => { const element = list.current; if (element && atEnd.current) element.scrollTop = element.scrollHeight; }, [items]);
  const finished = (mine ?? []).filter(r => r.state !== 'running').length;
  useEffect(() => { if (mine) void read(); }, [finished]);
  async function start(command: string) {
    if (!command.trim() || busy) return;
    if (pending.current?.command !== command) pending.current = { command, changeId: 'console-' + crypto.randomUUID() };
    setBusy(true); setRunProblem('');
    try { await client.call('console.run', { projectId, command, changeId: pending.current.changeId }); pending.current = null; setDraft(''); setNote(''); atEnd.current = true; void read(); }
    catch (error) { setRunProblem(failure(error)); }
    finally { setBusy(false); }
  }
  async function stop(record: Mine) {
    try { await client.call('console.stop', { projectId, commandId: record.commandId, changeId: 'stop-' + record.commandId }); void read(); }
    catch (error) { setRunProblem(failure(error)); }
  }
  const prepare = (command: string, from: string) => { setDraft(command); setNote('From ' + from + '. Check it, then press Run.'); input.current?.focus(); };
  const showPath = (path: string) => process?.showPath(path);
  const changedDuring = (r: Mine) => {
    const from = Date.parse(r.startedAt), to = r.endedAt ? Date.parse(r.endedAt) + 1000 : Date.now();
    return (process?.files ?? []).filter(f => f.versions.some(v => v.at >= from - 1000 && v.at <= to)).map(f => ({ path: f.path, name: f.title }));
  };
  if (!process) return <p className="console-note">Commands show in a conversation's Studio.</p>;
  return <div className="command-pane">
    <ol ref={list} className="console-list command-pane-list" onScroll={event => { const e = event.currentTarget; atEnd.current = e.scrollHeight - e.scrollTop - e.clientHeight < 24; }}>
      {!items.length && <li className="console-note">No commands yet. The commands the Agent runs in this conversation appear here, and you can run your own below.</li>}
      {items.map(item => !item.mine ? <ItemRow key={item.key} item={item} root={snapshot.project.root} onPath={showPath} onRunAgain={at === null && !off ? prepare : undefined} />
        : <Yours key={item.key} record={item.mine!} client={client} projectId={projectId} changed={changedDuring(item.mine!)} onPath={showPath} onRunAgain={r => void start(r.command)} onStop={r => void stop(r)} />)}
    </ol>
    {at !== null ? <p className="console-note command-pane-replay">Replaying · commands run from here use the project as it is now.</p>
      : off ? <p className="console-note">Running commands here needs the Console plugin, which is off for this project.</p>
      : <Prompt folder={projectName(snapshot.project)} draft={draft} setDraft={text => { setDraft(text); if (!text) setNote(''); }} note={note} busy={busy} problem={runProblem || problem} onRun={() => void start(draft)} input={input} />}
  </div>;
}
