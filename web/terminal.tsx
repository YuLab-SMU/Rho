import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { BrowserApiError, type BrowserClient } from '../src/browser.js';
import './terminal.css';

// The person's own shell on a terminal, in the project folder: a real pseudo-terminal the
// Console plugin keeps while Rho runs, drawn here. The view keeps its terminal's identity with
// the page, so a reload, another tab or a view shown again comes back to the same shell and what
// it printed. Closing the view hangs the shell up.
//
// A read waits this long for output before asking again; keys typed within typeBatchMs go in one
// request; the page keeps this many lines of scrollback (the service keeps the last megabyte).
export const terminalViewLimits = { waitMs: 20000, typeBatchMs: 4, scrollbackLines: 10000, resizeMs: 80, retryMs: 1500 };

interface TerminalFacts { terminalId: string; shell: string; cwd: string; cols: number; rows: number; endedAt: string | null; exit: { code: number | null; signal: string | null } | null; bytes: number; kept: number; problem: string | null }
type State = { kind: 'starting' } | { kind: 'live' } | { kind: 'ended'; how: string } | { kind: 'refused'; why: string; others: TerminalFacts[] } | { kind: 'lost' };

// The machine's own monospace face; a prompt drawn with a Nerd Font finds its symbols when one
// of the common ones is installed.
const terminalFont = '"MesloLGS NF", "MesloLGS Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", "Hack Nerd Font Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Symbols Nerd Font Mono", monospace';
const decode = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
const kindOf = (error: unknown) => error instanceof BrowserApiError ? error.error.kind : '';
const said = (error: unknown) => error instanceof Error ? error.message : 'The terminal could not be reached.';
// The page's own colours, so the terminal reads as part of the workspace; the sixteen named
// colours are the ones a light terminal is usually given.
function theme(element: HTMLElement) {
  const style = getComputedStyle(element), token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const ink = token('--color-ink', '#1f2328'), surface = token('--color-surface', '#ffffff');
  return {
    background: surface, foreground: ink, cursor: ink, cursorAccent: surface, selectionBackground: token('--color-accent-soft', '#cfe3d8'),
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  };
}
const ending = (facts: TerminalFacts) => facts.problem ?? (facts.exit?.signal ? `The shell was ended (${facts.exit.signal}).` : facts.exit?.code ? `The shell ended with exit code ${facts.exit.code}.` : 'The shell ended.');

export function TerminalPane({ client, projectId, terminalId, onTerminal, onCommands }: {
  client: BrowserClient; projectId: string;
  // The terminal this view keeps, and how it keeps another.
  terminalId: string | null; onTerminal: (terminalId: string) => void;
  // The record of commands, offered where a terminal cannot be opened.
  onCommands?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: 'starting' });
  const [shell, setShell] = useState('');
  // Each start counts, so an older terminal's reads stop when a new shell is asked for.
  const [round, setRound] = useState(0);
  const wanted = useRef<string | null>(terminalId), seen = useRef(terminalId), fresh = useRef(false), saved = useRef(onTerminal);
  saved.current = onTerminal;
  // The page's word on which terminal this is, when it changes (another tab started a new shell).
  if (seen.current !== terminalId) { seen.current = terminalId; if (terminalId) wanted.current = terminalId; }

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const stop = new AbortController(), call = <T,>(method: string, input: object) => client.call(method as never, { projectId, ...input } as never, stop.signal) as Promise<T>;
    const term = new Terminal({ fontFamily: terminalFont, fontSize: 13, lineHeight: 1.25, cursorBlink: true, scrollback: terminalViewLimits.scrollbackLines, macOptionIsMeta: true, theme: theme(element) });
    const fit = new FitAddon();
    term.loadAddon(fit); term.open(element);
    const fitted = () => { if (element.clientWidth > 40 && element.clientHeight > 20) try { fit.fit(); } catch { /* Not on the page yet. */ } };
    fitted();
    let id: string | null = null, live = false, typed = '', sending: Promise<unknown> = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined, sized: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (!id || !live || !typed) return;
      const data = typed, to = id; typed = '';
      // In the order typed: each request follows the one before it.
      for (let at = 0; at < data.length; at += 16000) { const part = data.slice(at, at + 16000); sending = sending.then(() => call('console.terminal.write', { terminalId: to, data: part })).catch(() => {}); }
    };
    const keys = term.onData(data => { if (!live) return; typed += data; timer ??= setTimeout(flush, terminalViewLimits.typeBatchMs); });
    const resized = term.onResize(({ cols, rows }) => {
      clearTimeout(sized);
      sized = setTimeout(() => { if (id && live) void call('console.terminal.resize', { terminalId: id, cols, rows }).catch(() => {}); }, terminalViewLimits.resizeMs);
    });
    const observer = new ResizeObserver(fitted);
    observer.observe(element);
    const pause = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); stop.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });

    void (async () => {
      try {
        // The view's own terminal when the service still has it; otherwise a new shell.
        const { terminals } = await call<{ terminals: TerminalFacts[] }>('console.terminal.list', {});
        let facts = !fresh.current ? terminals.find(t => t.terminalId === wanted.current) : undefined;
        if (!facts) {
          try { facts = (await call<{ terminal: TerminalFacts }>('console.terminal.open', { cols: Math.max(2, term.cols), rows: Math.max(1, term.rows) })).terminal; }
          catch (error) {
            if (stop.signal.aborted) return;
            setState({ kind: 'refused', why: said(error), others: kindOf(error) === 'limit' ? terminals : [] }); return;
          }
          fresh.current = false; wanted.current = facts.terminalId; saved.current(facts.terminalId);
        } else if (!facts.endedAt && (facts.cols !== term.cols || facts.rows !== term.rows)) void call('console.terminal.resize', { terminalId: facts.terminalId, cols: Math.max(2, term.cols), rows: Math.max(1, term.rows) }).catch(() => {});
        id = facts.terminalId; live = !facts.endedAt;
        setShell(facts.shell.split('/').at(-1) ?? ''); setState(live ? { kind: 'live' } : { kind: 'ended', how: ending(facts) });
        term.focus();
        // Everything it printed that is still kept, then what it prints from now on.
        for (let after = 0; !stop.signal.aborted;) {
          let read;
          try { read = await call<{ data: string; nextOffset: number; dropped: number; more: boolean; terminal: TerminalFacts }>('console.terminal.read', { terminalId: id, after, waitMs: terminalViewLimits.waitMs }); }
          catch (error) {
            if (stop.signal.aborted) return;
            if (kindOf(error) === 'not_found') { live = false; setState({ kind: 'lost' }); return; }
            await pause(terminalViewLimits.retryMs); continue;
          }
          if (stop.signal.aborted) return;
          if (read.dropped && !after) term.write(`\x1b[2m… ${read.dropped.toLocaleString('en-US')} earlier bytes are no longer kept …\x1b[0m\r\n`);
          if (read.data) term.write(decode(read.data));
          after = read.nextOffset;
          if (read.terminal.endedAt && !read.more && after >= read.terminal.bytes) { live = false; setState({ kind: 'ended', how: ending(read.terminal) }); return; }
        }
      } catch (error) { if (!stop.signal.aborted) setState({ kind: 'refused', why: said(error), others: [] }); }
    })();
    return () => { stop.abort(); clearTimeout(timer); clearTimeout(sized); observer.disconnect(); keys.dispose(); resized.dispose(); term.dispose(); };
  }, [client, projectId, round]);

  const again = () => { fresh.current = true; setState({ kind: 'starting' }); setRound(n => n + 1); };
  const attach = (other: string) => { fresh.current = false; wanted.current = other; saved.current(other); setState({ kind: 'starting' }); setRound(n => n + 1); };
  const close = (other: string) => void client.call('console.terminal.close' as never, { projectId, terminalId: other } as never).then(again, again);
  return <div className="terminal-pane" data-state={state.kind}>
    <div className="terminal-screen" ref={box} aria-label={shell ? `Terminal, ${shell}` : 'Terminal'} hidden={state.kind === 'refused'} />
    {state.kind === 'ended' && <p className="terminal-note" role="status">{state.how} <button className="text-button" onClick={again}>Start a new shell</button></p>}
    {state.kind === 'lost' && <p className="terminal-note" role="status">This terminal was closed, or Rho was started again since. <button className="text-button" onClick={again}>Start a new shell</button></p>}
    {state.kind === 'refused' && <div className="terminal-refused" role="alert">
      <p>{state.why}</p>
      {state.others.length > 0 && <ul>{state.others.map(other => <li key={other.terminalId}>
        <span>{other.shell.split('/').at(-1)}{other.cwd ? ' in ' + other.cwd : ''} · {other.endedAt ? 'ended' : 'open'}</span>
        <button className="text-button" onClick={() => attach(other.terminalId)}>Show it here</button>
        <button className="text-button" onClick={() => close(other.terminalId)}>Close it</button>
      </li>)}</ul>}
      <p><button className="text-button" onClick={again}>Try again</button>{onCommands && <button className="text-button" onClick={onCommands}>Show the commands instead</button>}</p>
    </div>}
  </div>;
}
