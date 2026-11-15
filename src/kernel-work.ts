import type { RhoOutput } from './contract.generated.js';
import type { ConversationStep, ConversationTurn } from './conversation-presentation.js';
import { personPrincipal } from './terminal-work.js';
import type { GraphTurn } from './work-graph.js';

// Notebook cells run by the person are kept by the kernel rather than in an Agent
// conversation. The Graph still needs one presentation record for them, so the
// browser can show the person's work beside Agent work without changing ownership.
type Cell = RhoOutput<'kernel.read'>['cells'][number];

const cellAt = (cell: Cell) => cell.endedAt ?? cell.startedAt ?? cell.queuedAt;
const cellOutcome = (state: Cell['state']): NonNullable<ConversationStep['outcome']> => {
  if (state === 'done' || state === 'error' || state === 'interrupted') return 'returned';
  if (state === 'queued' || state === 'running') return 'requested';
  if (state === 'not-run') return 'rejected';
  return 'unknown';
};
const turnState = (cells: readonly Cell[]): ConversationTurn['state'] => {
  if (cells.some(c => c.state === 'queued' || c.state === 'running')) return 'running';
  if (cells.some(c => c.state === 'error')) return 'failed';
  if (cells.some(c => c.state === 'interrupted' || c.state === 'not-run')) return 'stopped';
  if (cells.some(c => c.state === 'unknown')) return 'unknown';
  return 'completed';
};
const outputOf = (cell: Cell) => {
  const text = [...cell.outputs.flatMap(o => o.text ? [o.text] : []), ...(cell.problem ? [cell.problem] : [])].join('\n');
  if (!text) return undefined;
  return { text, lines: text.split('\n').length, bytes: new TextEncoder().encode(text).byteLength, cut: cell.cut };
};

function stepOf(cell: Cell): ConversationStep {
  const outcome = cellOutcome(cell.state), failed = cell.state === 'error' || cell.state === 'interrupted';
  return {
    kind: 'tool', id: cell.cellId, at: cellAt(cell), ...(cell.startedAt ? { startedAt: cell.startedAt } : {}),
    tool: 'run', operation: 'kernel.run', toolKind: 'execute', detail: cell.code,
    ...(cell.purpose ? { purpose: cell.purpose } : {}), outcome, ...(failed ? { failed: true } : {}),
    ...(outputOf(cell) ? { output: outputOf(cell) } : {}),
  };
}

function changedFiles(cells: readonly Cell[]) {
  const paths = new Map<string, { path: string; change: 'added' | 'modified' | 'removed'; modifiedAt: string | null; bytes: number | null }>();
  for (const cell of cells) {
    const at = cellAt(cell);
    for (const file of cell.files ?? []) if (file.how === 'wrote') paths.set(file.path, { path: file.path, change: 'modified', modifiedAt: at, bytes: null });
    for (const file of cell.saved ?? []) paths.set(file.path, { path: file.path, change: 'modified', modifiedAt: at, bytes: file.bytes });
  }
  return [...paths.values()];
}

// Add one human Notebook turn per kernel session. The source records remain the
// cells themselves; this is only the read-side shape the Graph already consumes.
export function notebookWork(cells: readonly Cell[]): GraphTurn[] {
  const groups = new Map<string, Cell[]>();
  for (const cell of cells) {
    if (cell.by !== personPrincipal) continue;
    const key = cell.sessionId + '\0' + (cell.notebook ?? '');
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  return [...groups.values()].map(list => {
    const ordered = [...list].sort((a, b) => cellAt(a).localeCompare(cellAt(b)));
    const first = ordered[0]!, last = ordered.at(-1)!;
    const conversationId = 'notebook:' + first.sessionId + (first.notebook ? ':' + first.notebook : '');
    const startedAt = first.startedAt ?? first.queuedAt, endedAt = ordered.some(c => !c.endedAt) ? null : last.endedAt;
    const turn: ConversationTurn = {
      id: 'cells-' + first.cellId, by: personPrincipal, text: 'Notebook', sentAt: first.queuedAt,
      startedAt, endedAt, state: turnState(ordered), model: null, stop: null, retry: null, result: null, problem: null,
      steps: ordered.map(stepOf), omitted: 0,
      files: { changed: changedFiles(ordered), omitted: 0, partial: false },
    };
    return { conversationId, conversationTitle: first.notebook ? 'Notebook · ' + first.notebook : 'Notebook', agent: 'You', turn, person: true, kernelCells: ordered.map(c => c.cellId) };
  }).sort((a, b) => a.turn.sentAt.localeCompare(b.turn.sentAt));
}
