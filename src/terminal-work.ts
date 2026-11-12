import type { RhoOutput } from './contract.generated.js';
import type { ConversationStep } from './conversation-presentation.js';
import type { GraphTurn } from './work-graph.js';

export type TerminalCommandRecord = RhoOutput<'console.terminal.commands'>['commands'][number];
export interface TerminalOwner { conversationId: string; principal: string | null }

// The commands typed in the project's terminals, in the work record the Graph draws. They are
// steps like an Agent's own commands, with what the terminal recorded of them: who typed each,
// the folder, its exit status and the start of what it printed. A command an Agent entered while
// a message of its conversation in Rho was being answered is a step of that message. Every other
// command is a step of a "Typed in the terminal" message of whoever entered it: the person, or an
// Agent working from outside Rho; such a message is a run of their commands with no pause longer
// than gapMs. Commands are drawn from when they started until they ended, and a file is drawn as
// changed by one only when it changed while that command ran.
export const terminalWorkLimits = { gapMs: 30 * 60_000, slackMs: 2000 };
export const personPrincipal = 'browser:local';

const time = (iso?: string | null) => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? value : null; };
const bytes = (text: string) => new TextEncoder().encode(text).length;

export function terminalStep(command: TerminalCommandRecord, name: (principal: string) => string): ConversationStep {
  const ended = command.state !== 'running';
  return { kind: 'tool', id: 'terminal:' + command.commandId, at: command.endedAt ?? command.startedAt, startedAt: command.startedAt, tool: 'Bash', detail: command.command,
    outcome: !ended ? 'requested' : command.state === 'exited' ? 'returned' : 'unknown',
    ...(command.state === 'exited' && command.exit !== null ? { exitCode: command.exit } : {}),
    ...(command.output ? { output: { text: command.output, bytes: command.outputBytes, lines: command.output.split('\n').length, cut: command.outputBytes > bytes(command.output) + 1 } } : {}),
    terminal: { commandId: command.commandId, terminalId: command.terminalId, cwd: command.cwd, by: command.by.map(name), enteredBy: name(command.enteredBy), stored: command.stored, screens: command.screens, problem: command.problem } };
}

// The turns with the terminal's commands among them: some added to an Agent's own messages, the
// rest in messages of their own.
export function terminalWork(turns: readonly GraphTurn[], commands: readonly TerminalCommandRecord[], owners: readonly TerminalOwner[], name: (principal: string) => string, now: number): GraphTurn[] {
  if (!commands.length) return [...turns];
  const conversationsOf = new Map<string, Set<string>>();
  for (const o of owners) if (o.principal) conversationsOf.set(o.principal, (conversationsOf.get(o.principal) ?? new Set()).add(o.conversationId));
  const added = new Map<GraphTurn, ConversationStep[]>(), rest: TerminalCommandRecord[] = [];
  const ordered = [...commands].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const command of ordered) {
    const mine = conversationsOf.get(command.enteredBy), at = time(command.startedAt) ?? now;
    const turn = mine && turns.find(t => {
      if (!mine.has(t.conversationId)) return false;
      const start = time(t.turn.startedAt) ?? time(t.turn.sentAt) ?? Infinity, end = time(t.turn.endedAt) ?? (t.turn.state === 'running' ? now : start);
      return at >= start - terminalWorkLimits.slackMs && at <= end + terminalWorkLimits.slackMs;
    });
    if (turn) added.set(turn, [...added.get(turn) ?? [], terminalStep(command, name)]);
    else rest.push(command);
  }
  const out = turns.map(t => {
    const steps = added.get(t);
    return steps ? { ...t, turn: { ...t.turn, steps: [...t.turn.steps, ...steps].sort((a, b) => a.at.localeCompare(b.at)) } } : t;
  });
  // The rest, by who entered them, in runs without a long pause.
  const groups: TerminalCommandRecord[][] = [], open = new Map<string, { group: TerminalCommandRecord[]; last: number }>();
  for (const command of rest) {
    const at = time(command.startedAt) ?? now, run = open.get(command.enteredBy);
    const end = command.state === 'running' ? now : time(command.endedAt) ?? at;
    if (run && at - run.last <= terminalWorkLimits.gapMs) { run.group.push(command); run.last = Math.max(run.last, end); continue; }
    const group = [command]; groups.push(group); open.set(command.enteredBy, { group, last: end });
  }
  for (const group of groups) {
    const first = group[0]!, who = first.enteredBy, running = group.some(c => c.state === 'running');
    const last = group.reduce((latest, c) => (c.endedAt ?? c.startedAt) > latest ? c.endedAt ?? c.startedAt : latest, first.startedAt);
    const agent = who === personPrincipal ? 'You' : name(who);
    out.push({ conversationId: 'terminal:' + who, conversationTitle: who === personPrincipal ? 'Terminal' : agent + ' in the terminal', agent, terminal: true,
      turn: { id: 'tg-' + first.commandId.slice(3), by: who, text: 'Typed in the terminal', sentAt: first.startedAt, startedAt: first.startedAt, endedAt: running ? null : last,
        state: running ? 'running' : 'completed', model: null, stop: null, retry: null, result: null, problem: null, omitted: 0, steps: group.map(c => terminalStep(c, name)) } });
  }
  return out;
}
