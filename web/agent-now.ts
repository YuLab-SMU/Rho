import { useEffect, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { conversationBlocks, type Activity } from '../src/conversation-presentation.js';
import { commandFiles, projectPath } from '../src/work-graph.js';

// What the Agent in this project is doing now, from the conversation record Rho keeps:
// whether a turn is running, whether it waits for the person, and the files its actions
// named. These are the Agent's own reports; the bytes are read by their owners when shown.
type Read = RhoOutput<'conversation.read'>;
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
export function useAgentNow(client: BrowserClient, snapshot: WorkspaceSnapshot | null): AgentNow | null {
  const list = snapshot?.conversations ?? [];
  // The running conversation if there is one; otherwise the latest, so its ending stays visible.
  const chosen = [...list].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.lastAt.localeCompare(a.lastAt))[0];
  const [read, setRead] = useState<Read | null>(null);
  const projectId = snapshot?.project.id;
  useEffect(() => {
    if (!projectId || !chosen) { setRead(null); return; }
    let live = true;
    client.call('conversation.read', { projectId, conversationId: chosen.conversationId, limit: 1 })
      .then(value => { if (live) setRead(value); }, () => undefined);
    return () => { live = false; };
  }, [client, projectId, chosen?.conversationId, chosen?.version]);
  if (!snapshot || !chosen || read?.conversation.conversationId !== chosen.conversationId) return null;
  const turn = read.turns.at(-1);
  const running = chosen.state === 'running' && turn?.state === 'running';
  const activities = turn ? conversationBlocks(turn, read.observation, snapshot.project.root).flatMap(block => block.kind === 'activity' ? block.activities : []) : [];
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
    conversationId: chosen.conversationId, title: chosen.title, agent: agentName(chosen.client), running,
    waiting: running ? turn?.permissions?.find(p => p.state === 'pending')?.title ?? null : null,
    latest: activities.at(-1) ?? null, files,
  };
}
