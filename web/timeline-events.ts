import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { eventMarks, type EventMark, type LaneOwner, type SourcedEvent } from '../src/timeline-events.js';
import { agentName } from './agent-now.js';

// The protected resources are the service and this tab: each plugin's newest events, read
// again when the project's records move, no more often than readMs.
export const eventLimits = { events: 200, readMs: 1000 };

// The reads plugins name for the timeline, each available and granted to this tab.
export function eventSources(snapshot: WorkspaceSnapshot) {
  return snapshot.catalog.plugins.flatMap(p => p.timeline && snapshot.catalog.operations.some(o => o.method === p.timeline && o.state === 'available' && o.authorized) ? [p.timeline] : []);
}

// What the plugins say was done, as marks in the lanes of whoever did it.
export function useEventMarks(client: BrowserClient, snapshot: WorkspaceSnapshot): { marks: EventMark[]; problem: string } {
  const sources = eventSources(snapshot), key = sources.join(',');
  const [events, setEvents] = useState<SourcedEvent[]>([]), [problem, setProblem] = useState('');
  // A read that started earlier than the one shown is not shown; one in flight still lands
  // while the records keep moving.
  const last = useRef(0), asked = useRef(0), shown = useRef(0);
  useEffect(() => {
    if (!sources.length) { setEvents([]); return; }
    const timer = setTimeout(() => {
      last.current = Date.now();
      const sequence = ++asked.current;
      Promise.all(sources.map(source => client.call(source as 'kernel.events', { projectId: snapshot.project.id, limit: eventLimits.events })
        .then((read: RhoOutput<'kernel.events'>) => read.events.map(e => ({ ...e, source })))))
        .then(lists => { if (sequence > shown.current) { shown.current = sequence; setEvents(lists.flat()); setProblem(''); } },
          error => { if (sequence > shown.current) setProblem(error instanceof Error ? error.message : 'What was run could not be read.'); });
    }, Math.max(0, last.current + eventLimits.readMs - Date.now()));
    return () => clearTimeout(timer);
  }, [client, snapshot.project.id, snapshot.cursor, key]);
  const owners: LaneOwner[] = useMemo(() => (snapshot.conversations ?? []).map(c => ({ conversationId: c.conversationId, principal: c.principal, title: c.agentTitle || c.title, agent: agentName(c.client) })), [snapshot.conversations]);
  const marks = useMemo(() => eventMarks(events, owners, Date.now()), [events, owners]);
  return { marks, problem };
}
