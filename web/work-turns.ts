import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import { externalWork, workSessions, type WorkSession } from '../src/external-work.js';
import type { GraphTurn } from '../src/work-graph.js';
import { useExternalConversations } from './external-conversations.js';

// One bounded read model for the Graph, Console, answer board and a session's Studio.
// Reading a native session observes its record; it does not continue it or send a message.
export const turnLimits = { conversations: 6, turns: 8 };
export function useTurns(client: BrowserClient, snapshot: WorkspaceSnapshot, onlyId?: string) {
  const outside = useExternalConversations(client, snapshot.catalog.operations.some(o => o.method === 'agent.sessions.list' && o.authorized) ? snapshot.project.id : null);
  const all = useMemo(() => workSessions(snapshot.conversations ?? [], outside.sessions), [snapshot.conversations, outside.sessions]);
  const list = useMemo(() => onlyId ? all.filter(s => s.id === onlyId) : all.slice(0, turnLimits.conversations), [all, onlyId]);
  const [reads, setReads] = useState<Record<string, { project: string; version: string; turns: GraphTurn[]; omitted: number }>>({});
  const [problem, setProblem] = useState('');
  const project = snapshot.project;
  const readsRef = useRef(reads), wanted = useRef({ list, project });
  wanted.current = { list, project };
  const cached = (s: WorkSession) => reads[s.id]?.project === project.id ? reads[s.id] : undefined;
  useEffect(() => {
    let live = true, busy = false;
    setProblem('');
    const readDue = async () => {
      if (!live || busy) return;
      const { list, project } = wanted.current;
      const due = list.filter(s => readsRef.current[s.id]?.project !== project.id || readsRef.current[s.id]?.version !== s.version);
      if (!due.length) return;
      busy = true;
      const results = await Promise.allSettled(due.map(async s => {
        if (s.external) {
          const read = await client.call('agent.sessions.read', { projectId: project.id, session: s.id, limit: turnLimits.turns });
          return { s, turns: externalWork(read, project), omitted: read.first + read.session.omittedTurns };
        }
        const read = await client.call('conversation.read', { projectId: project.id, conversationId: s.id, limit: turnLimits.turns });
        return { s, turns: read.turns.map(turn => ({ conversationId: s.id, conversationTitle: s.title, agent: s.agent, turn, observation: read.observation })), omitted: read.first };
      }));
      busy = false;
      if (!live) return;
      setProblem(results.some(r => r.status === 'rejected') ? 'Some session records could not be read. Earlier observations are kept; retrying.' : '');
      const next = { ...readsRef.current };
      for (const r of results) if (r.status === 'fulfilled') {
        const { s, turns, omitted } = r.value; next[s.id] = { project: project.id, version: s.version, turns, omitted };
      }
      readsRef.current = next; setReads(next);
    };
    // A newer cut does not cancel a read already in flight. Rapid stream updates must
    // still land on screen; one failed source cannot hide the other sessions.
    void readDue(); const timer = setInterval(() => { if (!document.hidden) void readDue(); }, 700);
    return () => { live = false; clearInterval(timer); };
  }, [client, project.id, onlyId]);
  const turns = useMemo(() => list.flatMap(s => cached(s)?.turns ?? []), [list, reads, project.id]);
  const omitted = list.reduce((n, s) => n + (cached(s)?.omitted ?? 0), 0) + (onlyId ? 0 : Math.max(0, all.length - list.length) + outside.omitted);
  return { turns, sessions: list, problem: problem || outside.problem, loading: list.length > 0 && !list.some(cached), omitted };
}
