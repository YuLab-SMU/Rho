import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import { externalWork, workSessions, type WorkSession } from '../src/external-work.js';
import type { GraphTurn } from '../src/work-graph.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { useExternalConversations } from './external-conversations.js';

// One read model for the Graph, Console, answer board and a session's Studio.
// Reading a native session observes its record; it does not continue it or send a message.
// The answer board and the Console read the newest sessions and their last messages. The Graph
// reads every session whole (`everything`), a few sessions at a time and each in pages, since
// it stands for all the work; the protected resource is the service, which answers at most
// `pageTurns` messages a call and `sessionsAtOnce` sessions at once.
export const turnLimits = { conversations: 6, turns: 8, pageTurns: 50, sessionsAtOnce: 4 };
export function useTurns(client: BrowserClient, snapshot: WorkspaceSnapshot, onlyId?: string, everything = false) {
  const outside = useExternalConversations(client, snapshot.catalog.operations.some(o => o.method === 'agent.sessions.list' && o.authorized) ? snapshot.project.id : null);
  const all = useMemo(() => workSessions(snapshot.conversations ?? [], outside.sessions), [snapshot.conversations, outside.sessions]);
  const list = useMemo(() => onlyId ? all.filter(s => s.id === onlyId) : everything ? all : all.slice(0, turnLimits.conversations), [all, onlyId, everything]);
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
      // A whole session is read newest page first until its first message.
      const pages = async <T,>(read: (before?: number) => Promise<{ first: number; turns: T[] }>) => {
        let page = await read(), turns = page.turns;
        while (everything && page.first > 0) { page = await read(page.first); turns = [...page.turns, ...turns]; }
        return { turns, first: page.first };
      };
      const limit = everything ? turnLimits.pageTurns : turnLimits.turns;
      let failed = false;
      for (let i = 0; i < due.length && live; i += turnLimits.sessionsAtOnce) {
        const results = await Promise.allSettled(due.slice(i, i + turnLimits.sessionsAtOnce).map(async s => {
          if (s.external) {
            let session: RhoOutput<'agent.sessions.read'> | undefined;
            const read = await pages(async before => { session = await client.call('agent.sessions.read', { projectId: project.id, session: s.id, limit, ...(before !== undefined ? { before } : {}) }); return { first: session.first, turns: externalWork(session, project) }; });
            return { s, turns: read.turns, omitted: read.first + session!.session.omittedTurns };
          }
          let observation: GraphTurn['observation'];
          const read = await pages(async before => { const page = await client.call('conversation.read', { projectId: project.id, conversationId: s.id, limit, ...(before !== undefined ? { before } : {}) }); observation ??= page.observation; return page; });
          return { s, turns: read.turns.map(turn => ({ conversationId: s.id, conversationTitle: s.title, agent: s.agent, turn, observation })), omitted: read.first };
        }));
        if (!live) break;
        failed ||= results.some(r => r.status === 'rejected');
        const next = { ...readsRef.current };
        for (const r of results) if (r.status === 'fulfilled') { const { s, turns, omitted } = r.value; next[s.id] = { project: project.id, version: s.version, turns, omitted }; }
        readsRef.current = next; setReads(next);
      }
      busy = false;
      if (!live) return;
      setProblem(failed ? 'Some session records could not be read. Earlier observations are kept; retrying.' : '');
    };
    // A newer cut does not cancel a read already in flight. Rapid stream updates must
    // still land on screen; one failed source cannot hide the other sessions.
    void readDue(); const timer = setInterval(() => { if (!document.hidden) void readDue(); }, 700);
    return () => { live = false; clearInterval(timer); };
  }, [client, project.id, onlyId, everything]);
  const turns = useMemo(() => list.flatMap(s => cached(s)?.turns ?? []), [list, reads, project.id]);
  const omitted = list.reduce((n, s) => n + (cached(s)?.omitted ?? 0), 0) + (onlyId ? 0 : Math.max(0, all.length - list.length) + outside.omitted);
  return { turns, sessions: list, problem: problem || outside.problem, loading: list.length > 0 && !list.some(cached), omitted,
    // How many of the sessions have been read so far.
    read: list.filter(cached).length };
}
