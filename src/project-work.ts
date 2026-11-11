import type { Conversations } from './conversations.js';
import { projectNotesPath } from './project-notes.js';
import type { Project } from './state.js';
import type { observeSessionFiles, readAgentActivity, readExternalAcp, listExternalSessions, readExternalSession } from '@rho-workspace/plugin-agent';
import type { RhoOutput } from './contract.generated.js';

// An application read model linking owner identities. The cursor invalidates
// observations; it is not a transaction or a shared resource revision.
export async function projectWork(input: {
  project: Project; cursor: number; conversations: Awaited<ReturnType<Conversations['work']>>;
  documents: Array<{ id: string; path: string; version: number; dirty: boolean }>;
  activity: Array<{ principal: string; outcome: string; operationId?: string; resource?: { id: string; version: string } }>;
  native: Awaited<ReturnType<typeof readAgentActivity>> | null;
  external?: ReturnType<typeof readExternalAcp>; inspect?: typeof observeSessionFiles;
  observed?: ReturnType<typeof listExternalSessions>; readObserved?: typeof readExternalSession;
}): Promise<RhoOutput<'project.work.read'>> {
  const notesPath = projectNotesPath, note = input.documents.find(d => d.path === notesPath);
  const owned = input.conversations.sessions.map(c => {
    const calls = input.activity.filter(a => a.principal === c.principal && a.outcome === 'returned');
    return { id: 'conversation:' + c.conversationId, source: c.backend !== 'claude-cli' ? 'acp' as const : 'claude-cli' as const, sessionId: c.sessionId,
      title: c.title, agent: c.client, state: c.state, conversationId: c.conversationId, principal: c.principal, version: c.version, observation: c.observation,
      operationIds: [...new Set(calls.flatMap(a => a.operationId ? [a.operationId] : []))].slice(-256),
      resourceRefs: [...new Map(calls.flatMap(a => a.resource ? [[a.resource.id + '@' + a.resource.version, a.resource] as const] : [])).values()].slice(-256) };
  });
  const native = (input.native?.streams ?? []).map((s: any) => ({ id: 'activity:' + s.id, source: 'native-transcript' as const, sessionId: s.sessionId,
    title: s.producer + ' · ' + s.sessionId, agent: String(s.producer), state: 'retained', streamId: s.id, cursor: s.nextCursor, retainedFrom: s.retainedFrom, droppedEvents: s.droppedEvents,
    observation: null, operationIds: [] as string[], resourceRefs: [] as Array<{ id: string; version: string }> }));
  const externalSessions = [...(input.external?.sessions ?? [])].sort((a, b) => Number(b.connected) - Number(a.connected) || b.heartbeatAt.localeCompare(a.heartbeatAt));
  const external = externalSessions.slice(0, 8).map(s => ({ id: 'external-acp:' + s.id, source: 'external-acp' as const,
    sessionId: s.sessionId, title: s.observation.info?.title || (s.agent === 'codex' ? 'Codex' : 'Claude Code') + ' session', agent: s.agent,
    state: s.state, observation: s.observation, version: s.observation.sequence, connected: s.connected,
    lastMessage: s.lastMessage, omittedMessageChars: s.omittedMessageChars, pendingPermissions: s.pendingPermissions,
    operationIds: [] as string[], resourceRefs: [] as Array<{ id: string; version: string }> }));
  const refs = [...owned, ...external].flatMap(s => [...(s.observation?.tools ?? [])].reverse().flatMap(t => t.locations.map(l => ({ path: l.path, session: s.id, tool: t.id }))));
  const observed = (input.observed?.sessions ?? []).slice(0, 8).map(s => {
    let turns: ReturnType<typeof readExternalSession>['turns'] = [];
    try { turns = input.readObserved?.(input.project.root, { session: s.id, limit: 2 }).turns ?? []; } catch { /* Summary remains available when detail cannot be read. */ }
    for (const turn of turns) for (const tool of turn.tools) for (const path of tool.paths) refs.push({ path, session: s.id, tool: tool.id });
    const resources = turns.flatMap(t => t.results.filter(r => r.id && r.version && r.projectId === input.project.id).map(r => ({ id: r.id!, version: r.version! })));
    return { id: s.id, source: 'external-session' as const, sessionId: s.sessionId, title: s.title, agent: s.producer, state: s.state, version: s.sourceCursor, observation: null, operationIds: [], resourceRefs: [...new Map(resources.map(r => [r.id + '@' + r.version, r])).values()] }; });
  const inspected = input.inspect ? await input.inspect(input.project.root, refs) : { files: [], omitted: refs.length };
  return { projectId: input.project.id, cursor: input.cursor, observedAt: new Date().toISOString(),
    notes: { path: notesPath, ...(note ? { documentId: note.id, version: note.version, dirty: note.dirty } : {}) },
    sessions: [...owned, ...observed, ...external, ...native], files: inspected.files,
    native: { state: input.native ? 'available' as const : 'unavailable' as const, message: input.native ? 'Activity is kept from the Agents\' own records.' : 'Native activity is not available from the current Host. Reading this view does not start it.' },
    omitted: { conversations: input.conversations.omitted, fileReferences: inspected.omitted, external: (input.external?.omitted ?? 0) + (input.observed?.omitted ?? 0) + Math.max(0, (input.observed?.sessions.length ?? 0) - observed.length) + Math.max(0, externalSessions.length - external.length) } };
}
