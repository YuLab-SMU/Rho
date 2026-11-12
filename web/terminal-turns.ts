import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import { personPrincipal, terminalWork, type TerminalCommandRecord } from '../src/terminal-work.js';
import type { GraphTurn } from '../src/work-graph.js';
import { agentDisplayName } from './brand-marks.js';

// The protected resources are the service and this tab: the terminals' commands are read whole
// (at most the console's kept records, `pageCommands` a call), again when the project's records
// move, no more often than readMs.
export const terminalReadLimits = { pageCommands: 200, pages: 5, readMs: 1000 };

// Who typed in a terminal, by name.
export const terminalName = (snapshot: WorkspaceSnapshot) => (principal: string) => principal === personPrincipal ? 'You' : agentDisplayName(snapshot.agents?.find(a => a.principal === principal)?.label ?? 'An Agent');

// The Graph's turns with the commands typed in the project's terminals among them (terminal-work.ts).
export function useTerminalTurns(client: BrowserClient, snapshot: WorkspaceSnapshot, turns: GraphTurn[]): GraphTurn[] {
  const available = snapshot.catalog.operations.some(o => o.method === 'console.terminal.commands' && o.state === 'available' && o.authorized);
  const [commands, setCommands] = useState<TerminalCommandRecord[]>([]);
  const last = useRef(0), asked = useRef(0);
  useEffect(() => {
    if (!available) { setCommands([]); return; }
    const timer = setTimeout(async () => {
      last.current = Date.now();
      const sequence = ++asked.current, all: TerminalCommandRecord[] = [];
      try {
        for (let page = 0; page < terminalReadLimits.pages; page++) {
          const read = await client.call('console.terminal.commands', { projectId: snapshot.project.id, limit: terminalReadLimits.pageCommands, offset: all.length });
          all.push(...read.commands);
          if (!read.omitted) break;
        }
        if (sequence === asked.current) setCommands(all);
      } catch { /* the terminals' commands stay as last read */ }
    }, Math.max(0, last.current + terminalReadLimits.readMs - Date.now()));
    return () => clearTimeout(timer);
  }, [client, snapshot.project.id, snapshot.cursor, available]);
  const name = terminalName(snapshot);
  const owners = useMemo(() => (snapshot.conversations ?? []).map(c => ({ conversationId: c.conversationId, principal: c.principal ?? null })), [snapshot.conversations]);
  return useMemo(() => terminalWork(turns, commands, owners, name, Date.now()), [turns, commands, owners, snapshot.agents]);
}
