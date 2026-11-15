import { useEffect, useMemo, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { notebookWork } from '../src/kernel-work.js';
import type { EventMark } from '../src/timeline-events.js';
import type { GraphTurn } from '../src/work-graph.js';

type Cell = RhoOutput<'kernel.read'>['cells'][number];
export const notebookReadLimits = { cells: 500 };

// The kernel keeps the person's Notebook cells outside Agent conversations. Read
// that record and expose the same presentation turns the Graph already consumes.
export function useNotebookTurns(client: BrowserClient, snapshot: WorkspaceSnapshot, turns: GraphTurn[]) {
  const available = snapshot.catalog.operations.some(o => o.method === 'kernel.read' && o.state === 'available' && o.authorized);
  const [state, setState] = useState<{ cells: Cell[]; omitted: number; loading: boolean; problem: string }>({ cells: [], omitted: 0, loading: available, problem: '' });
  useEffect(() => {
    if (!available) { setState({ cells: [], omitted: 0, loading: false, problem: '' }); return; }
    let live = true;
    setState(previous => ({ ...previous, loading: true, problem: '' }));
    client.call('kernel.read', { projectId: snapshot.project.id, limit: notebookReadLimits.cells }).then(read => {
      if (live) setState({ cells: read.cells, omitted: read.omitted, loading: false, problem: '' });
    }, error => {
      if (live) setState(previous => ({ ...previous, loading: false, problem: error instanceof Error ? error.message : 'The Notebook work could not be read.' }));
    });
    return () => { live = false; };
  }, [available, client, snapshot.cursor, snapshot.project.id]);
  const human = useMemo(() => notebookWork(state.cells), [state.cells]);
  return { turns: [...turns, ...human], loading: state.loading, problem: state.problem, omitted: state.omitted };
}

// Once a human cell is represented as a Graph step, its plugin timeline mark is
// the same fact and must not be drawn a second time below the graph.
export function withoutGraphNotebookMarks(marks: readonly EventMark[], turns: readonly GraphTurn[]) {
  const cells = new Set(turns.filter(t => t.person).flatMap(t => t.kernelCells ?? []));
  return marks.filter(mark => !(mark.source === 'kernel.events' && cells.has(mark.key.slice('kernel.events:'.length))));
}
