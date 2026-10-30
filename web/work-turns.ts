import { useEffect, useMemo, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import type { GraphTurn } from '../src/work-graph.js';
import { agentName } from './agent-now.js';

type Read = RhoOutput<'conversation.read'>;
type Summary = NonNullable<WorkspaceSnapshot['conversations']>[number];
// The protected resource is the service and the tab: the newest conversations and their newest
// messages, as many as the Graph draws.
export const turnLimits = { conversations: 6, turns: 8 };

// The conversations the graph draws, read again when their recorded version changes.
export function useTurns(client: BrowserClient, snapshot: WorkspaceSnapshot) {
  const list = useMemo(() => [...(snapshot.conversations ?? [])].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, turnLimits.conversations), [snapshot.conversations]);
  const [reads, setReads] = useState<Record<string, { version: number; read: Read }>>({});
  const [problem, setProblem] = useState('');
  const key = list.map(c => c.conversationId + '@' + c.version).join(',');
  useEffect(() => {
    let live = true;
    const due = list.filter(c => reads[c.conversationId]?.version !== c.version);
    if (!due.length) return;
    const running = due.some(c => c.state === 'running');
    const timer = setTimeout(() => {
      Promise.all(due.map(c => client.call('conversation.read', { projectId: snapshot.project.id, conversationId: c.conversationId, limit: turnLimits.turns }).then(read => [c, read] as const)))
        .then(pairs => { if (!live) return; setProblem(''); setReads(old => { const next = { ...old }; for (const [c, read] of pairs) next[c.conversationId] = { version: c.version, read }; return next; }); },
          error => { if (live) setProblem(error instanceof Error ? error.message : 'A conversation could not be read.'); });
    }, running && Object.keys(reads).length ? 700 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [client, snapshot.project.id, key]);
  const turns: GraphTurn[] = useMemo(() => list.flatMap((c: Summary) => (reads[c.conversationId]?.read.turns ?? []).map(turn => ({ conversationId: c.conversationId, conversationTitle: c.agentTitle || c.title, agent: agentName(c.client), turn, observation: reads[c.conversationId]?.read.observation }))), [list, reads]);
  const omitted = list.reduce((n, c) => n + (reads[c.conversationId]?.read.first ?? 0), 0) + Math.max(0, (snapshot.conversations?.length ?? 0) - list.length);
  return { turns, problem, loading: list.length > 0 && !list.some(c => reads[c.conversationId]), omitted };
}

