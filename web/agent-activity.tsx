import { useCallback } from 'react';
import { ActivityFeed, type ActivityFeedProps } from '@rho-workspace/plugin-agent/ui';
import { BrowserApiError, type BrowserClient } from '../src/browser.js';

// Application scope and layout only; interpretation and the actual view belong
// to Agent, with Files/Tables/Media retaining exact artifact bytes and semantics.
export function AgentActivity({ client, projectId, onOpened }: { client: BrowserClient; projectId: string; onOpened: (compositionId: string, viewId?: string) => void }) {
  const read: ActivityFeedProps['read'] = useCallback((streamId, after, signal) => client.call('agent.activity.read', { projectId, ...(streamId ? { streamId, after } : {}) }, signal), [client, projectId]);
  const outputs: ActivityFeedProps['outputs'] = useCallback((directory, signal) => client.call('agent.activity.outputs', { projectId, directory }, signal), [client, projectId]);
  const open: ActivityFeedProps['open'] = async file => {
    if (/\.pdf$/i.test(file.path)) throw new Error('PDF preview is not available in Activity. Open this file with a PDF viewer.');
    const compositionId = 'observed-outputs';
    const current = await client.call('composition.read', { projectId, compositionId }).catch(e => {
      if (e instanceof BrowserApiError && e.error.kind === 'not_found') return null;
      throw e;
    });
    if (!/\.(csv|png|jpe?g|svg|pdf)$/i.test(file.path)) {
      const result = await client.call('project.openFile', { projectId, path: file.path, compositionId, expectedVersion: current?.version ?? 0, changeId: 'open-' + crypto.randomUUID() });
      onOpened(compositionId, result.viewId); return;
    }
    if (!file.sha256) throw new Error('Refresh the output observation before opening.');
    if (current && !('rootId' in current)) throw new Error('This workspace uses an older layout. Choose a new workspace before opening another output.');
    const parent = current?.nodes.find(n => n.id === current.rootId && n.kind === 'group');
    const resource = await client.call('agent.activity.capture', { projectId, path: file.path, expectedDigest: file.sha256 });
    const viewId = 'observed-' + resource.id.slice(0, 12) + '-' + resource.version.slice(0, 12);
    const view = { id: viewId, kind: 'view' as const, component: resource.kind === 'table' ? 'rho.table' : 'rho.media', version: '0.2.0', props: { title: file.path.split('/').at(-1)! }, bindings: { data: { id: resource.id, version: resource.version } } };
    if (!current?.views.some(v => v.id === viewId)) {
      await client.call('composition.apply', { projectId, compositionId, expectedVersion: current?.version ?? 0, changeId: 'open-' + crypto.randomUUID(), operations: current?.rootId
        ? [{ op: 'insert', parentId: current.rootId, index: parent && 'children' in parent ? parent.children.length : 0, node: view }]
        : [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [viewId] }, view] }] });
    }
    onOpened(compositionId, viewId);
  };
  return <ActivityFeed key={projectId} read={read} outputs={outputs} open={open} />;
}
