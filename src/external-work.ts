import type { RhoOutput } from './contract.generated.js';
import type { ConversationStep, ConversationTurn } from './conversation-presentation.js';
import { projectPath, type GraphTurn, type PathScope } from './work-graph.js';

type Summary = RhoOutput<'agent.sessions.list'>['sessions'][number];
type Owned = NonNullable<RhoOutput<'observation.snapshot'>['conversations']>[number];
type Read = RhoOutput<'agent.sessions.read'>;
export interface WorkSession {
  id: string; title: string; agent: string; state: string; lastAt: string; version: string;
  owned?: Owned; external?: Summary;
}
export const workAgent = (name: string) => name === 'dsh' ? 'DeepSeek Harness' : name === 'codex' ? 'Codex' : name === 'claude-code' ? 'Claude Code' : name === 'acp' ? 'Agent' : name;

// A native session continued here is one session, not an outside copy beside a Rho copy.
// Trashed conversations do not reappear through their native records.
export function workSessions(owned: readonly Owned[], outside: readonly Summary[]): WorkSession[] {
  return [...owned.filter(c => !c.trashedAt).map(c => ({ id: c.conversationId, title: c.agentTitle || c.title, agent: workAgent(c.client), state: c.state, lastAt: c.lastAt, version: String(c.version), owned: c })),
    ...outside.filter(s => !s.conversationId).map(s => ({ id: s.id, title: s.title, agent: workAgent(s.producer), state: s.state, lastAt: s.lastAt, version: [s.sourceCursor, s.lastAt, s.state].join(':'), external: s }))]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

const json = (text: string): Record<string, any> | null => { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
const bytes = (text: string) => new TextEncoder().encode(text).length;
const rhoCall = (name: string) => name === 'kernel.run' || /^mcp__[\w.-]+__rho_call$/.test(name);
export function externalTurnAt(turn: Read['turns'][number], at: number | null): Read['turns'][number] | null {
  if (at === null) return turn;
  if (Date.parse(turn.at) > at) return null;
  if (turn.endedAt && Date.parse(turn.endedAt) <= at) return turn;
  return { ...turn, state: 'running', endedAt: undefined, reply: '', results: [], messages: turn.messages.filter(m => Date.parse(m.at) <= at),
    tools: turn.tools.filter(t => Date.parse(t.at) <= at).map(t => ({ ...t, output: '', exitCode: undefined, outcome: t.outcome === 'requested' ? 'requested' : 'unknown' })) };
}
// A bounded tool reply can end in the middle of a cell's large plot. Only its complete,
// identifying prefix is read in that case; no outcome or omitted output is filled in.
function cellOf(name: string, detail: Record<string, any> | null, output: string): string | null {
  if (!rhoCall(name) || typeof detail?.code !== 'string' || !['r', 'python'].includes(detail?.language)) return null;
  const cell = json(output)?.value?.cell;
  if (cell?.changeId === detail.changeId && /^k-[a-f0-9]+$/.test(cell?.cellId)) return cell.cellId;
  const prefix = /^\s*\{\s*"apiVersion"\s*:\s*"2\.0"\s*,\s*"ok"\s*:\s*true\s*,\s*"value"\s*:\s*\{\s*"cell"\s*:\s*\{\s*"cellId"\s*:\s*"(k-[a-f0-9]+)"\s*,\s*"changeId"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(output);
  return prefix && JSON.parse(prefix[2]) === detail.changeId ? prefix[1] : null;
}

// Presentation only: original native session/turn/call identities stay intact. This is never
// persisted or submitted as a Rho conversation. No native action becomes a managed run.
export function externalWork(read: Read, project: PathScope & { id: string }): GraphTurn[] {
  return read.turns.map(t => {
    const cells: string[] = [];
    const steps: ConversationStep[] = t.tools.map(tool => {
      const input = json(tool.detail), cell = cellOf(tool.name, input, tool.output);
      if (cell) cells.push(cell);
      const fileTool = /^(?:read|read_file|read_image|view_image|write|write_file|edit|apply_patch)$/i.test(tool.name);
      const candidate = input?.file_path ?? input?.path ?? (fileTool ? tool.paths[0] : null);
      const location = typeof candidate === 'string' ? projectPath(candidate, project) : null;
      const toolName = /^(?:read_image|read_file)$/i.test(tool.name) ? 'read' : tool.name === 'write_file' ? 'write' : tool.name;
      return { kind: 'tool', id: tool.id, at: tool.at, tool: cell ? 'mcp__rho__rho_call' : toolName,
        // Older native projections kept the call time but not the result time. Do not
        // invent a duration or show that result before the cut which retained it.
        outcomeAt: t.endedAt ?? read.session.observedAt,
        ...(cell || tool.name === 'kernel.run' ? { operation: 'kernel.run' } : {}),
        ...(fileTool ? { detail: location ?? '' } : { detail: typeof input?.command === 'string' ? input.command : tool.detail }),
        ...(input?.purpose && typeof input.purpose === 'string' ? { purpose: input.purpose } : {}),
        outcome: tool.outcome === 'failed' ? 'returned' : tool.outcome, ...(tool.outcome === 'failed' ? { failed: true } : {}),
        ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {}),
        ...(tool.output ? { output: { text: tool.output, bytes: bytes(tool.output), lines: tool.output.split('\n').length, cut: t.omittedChars > 0 } } : {}) };
    });
    for (const m of t.messages) steps.push({ kind: 'text', at: m.at, text: m.text });
    if (t.reply) steps.push({ kind: 'text', at: t.endedAt ?? read.session.lastAt, text: t.reply });
    steps.sort((a, b) => a.at.localeCompare(b.at));
    const turn: ConversationTurn = { id: t.id, by: read.session.producer, text: t.prompt, sentAt: t.at, startedAt: t.at, endedAt: t.endedAt ?? null,
      state: t.state, model: null, stop: null, retry: null, result: null, problem: null, steps, omitted: t.omittedTools + t.omittedChars,
      // This observation did not watch the disk during the turn. Today's mtime is not a
      // historical file-change observation.
      files: { changed: [], omitted: 0, partial: false } };
    const results = new Map<string, NonNullable<GraphTurn['reportedResults']>[number]>();
    for (const r of t.results) {
      const path = projectPath(r.path, project); if (!path) continue;
      const exact = r.projectId === project.id && /^[a-f0-9]{64}$/.test(r.id ?? '') && /^[a-f0-9]{64}$/.test(r.version ?? '');
      results.set(path, { path, at: t.endedAt ?? read.session.observedAt, ...(exact ? { resource: { id: r.id!, version: r.version! } } : {}) });
    }
    // Links in the final answer are reported results, not observations of file writes.
    for (const m of t.reply.matchAll(/!?\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
      const path = projectPath(m[1] ?? m[2], project);
      if (path && /\.[A-Za-z0-9]{1,8}$/.test(path) && !/^[a-z][a-z0-9+.-]*:/i.test(path) && !results.has(path)) results.set(path, { path, at: t.endedAt ?? read.session.observedAt });
    }
    return { conversationId: read.session.id, conversationTitle: read.session.title, agent: workAgent(read.session.producer), turn,
      external: true, kernelCells: cells, reportedResults: [...results.values()].slice(0, 64) };
  });
}
