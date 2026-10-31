import { useEffect, useRef, useState } from 'react';
import type { BrowserClient } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';

// What the live R and Python sessions hold, for the sidebar. One short read (the sessions and
// a single cell) follows the project's records, at most once a second; a read never starts a
// session. A session that ended holds nothing, so only the newest live one of each language counts.
type Session = RhoOutput<'kernel.read'>['sessions'][number];
export type ValueLanguage = Session['language'];
export type LiveSession = Pick<Session, 'language' | 'version' | 'state' | 'variables' | 'variablesOmitted'>;
export interface LiveValues { sessions: LiveSession[]; read: boolean; problem: string }
export const liveValueLimits = { readEveryMs: 1000 };

export function useLiveValues(client: BrowserClient | null, projectId: string | undefined, cursor: number | undefined, enabled: boolean): LiveValues {
  const [state, setState] = useState<LiveValues>({ sessions: [], read: false, problem: '' });
  const last = useRef(0), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [due, setDue] = useState(0);
  useEffect(() => { setState({ sessions: [], read: false, problem: '' }); last.current = 0; }, [projectId]);
  useEffect(() => {
    if (!enabled || !projectId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDue(d => d + 1), Math.max(0, last.current + liveValueLimits.readEveryMs - Date.now()));
    return () => clearTimeout(timer.current);
  }, [enabled, projectId, cursor]);
  useEffect(() => {
    if (!enabled || !projectId || !client || !due) return;
    let current = true;
    last.current = Date.now();
    client.call('kernel.read', { projectId, limit: 1 }).then(read => {
      if (!current) return;
      const newest = new Map<ValueLanguage, Session>();
      for (const s of read.sessions) if (!newest.has(s.language) || s.startedAt > newest.get(s.language)!.startedAt) newest.set(s.language, s);
      setState({ sessions: [...newest.values()].filter(s => s.state !== 'ended').sort((a, b) => Number(a.language !== 'r') - Number(b.language !== 'r')), read: true, problem: '' });
    }, error => { if (current) setState(s => ({ ...s, read: true, problem: error instanceof Error ? error.message : 'The live sessions could not be read.' })); });
    return () => { current = false; };
  }, [client, projectId, due, enabled]);
  return state;
}
