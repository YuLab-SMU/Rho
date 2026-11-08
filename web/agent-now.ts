import { useEffect, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { conversationBlocks, type Activity } from '../src/conversation-presentation.js';
import { commandFiles, projectPath, type GraphTurn } from '../src/work-graph.js';
import { externalWork, workSessions } from '../src/external-work.js';

// What the Agent in this project is doing now, from the conversation record Rho keeps:
// whether a turn is running, whether it waits for the person, and the files its actions
// named. These are the Agent's own reports; the bytes are read by their owners when shown.
export interface FileAction { key: string; path: string; action: 'read' | 'edit' | 'write' | 'run'; verb: string; outcome: Activity['outcome'] }
export interface AgentNow {
  conversationId: string; title: string; agent: string; running: boolean;
  // The title of a native permission request waiting for the person, if any.
  waiting: string | null;
  // The newest action of the running turn, and every action in it that named a project file.
  latest: Activity | null; files: FileAction[];
}

export const agentName = (client?: string | null) => client === 'codex' ? 'Codex' : client === 'claude-code' ? 'Claude Code' : 'Agent';
export { commandFiles, projectPath };
export function useAgentNow(client: BrowserClient, snapshot: WorkspaceSnapshot | null, outside: RhoOutput<'agent.sessions.list'>['sessions'] = []): AgentNow | null {
  const list = workSessions(snapshot?.conversations ?? [], outside);
  // The running conversation if there is one; otherwise the latest, so its ending stays visible.
  const chosen = [...list].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.lastAt.localeCompare(a.lastAt))[0];
  const [read, setRead] = useState<GraphTurn | null>(null);
  const projectId = snapshot?.project.id;
  useEffect(() => {
    if (!projectId || !chosen) { setRead(null); return; }
    let live = true;
    const pending = chosen.external
      ? client.call('agent.sessions.read', { projectId, session: chosen.id, limit: 1 }).then(value => externalWork(value, snapshot!.project)[0] ?? null)
      : client.call('conversation.read', { projectId, conversationId: chosen.id, limit: 1 }).then(value => value.turns[0] ? { conversationId: chosen.id, conversationTitle: chosen.title, agent: chosen.agent, turn: value.turns[0], observation: value.observation } : null);
    pending.then(value => { if (live) setRead(value); }, () => undefined);
    return () => { live = false; };
  }, [client, projectId, chosen?.id, chosen?.version]);
  if (!snapshot || !chosen || read?.conversationId !== chosen.id) return null;
  const turn = read.turn;
  const running = chosen.state === 'running' && turn?.state === 'running';
  const activities = turn ? conversationBlocks(turn, read.observation ?? null, snapshot.project.root).flatMap(block => block.kind === 'activity' ? block.activities : []) : [];
  const files: FileAction[] = [];
  for (const activity of activities) {
    if (activity.action === 'execute') {
      // A command names the files it works on: the script it runs, the table it prints.
      for (const path of commandFiles(activity.step.detail ?? '', snapshot.project)) files.push({ key: activity.key + ':' + path, path, action: 'run', verb: 'Ran', outcome: activity.outcome });
      continue;
    }
    if (activity.action !== 'read' && activity.action !== 'edit' && activity.action !== 'write') continue;
    const path = projectPath(activity.location ?? activity.step.detail ?? '', snapshot.project);
    if (path) files.push({ key: activity.key, path, action: activity.action, verb: activity.verb, outcome: activity.outcome });
  }
  return {
    conversationId: chosen.id, title: chosen.title, agent: chosen.agent, running,
    waiting: running ? turn?.permissions?.find(p => p.state === 'pending')?.title ?? null : null,
    latest: activities.at(-1) ?? null, files,
  };
}
