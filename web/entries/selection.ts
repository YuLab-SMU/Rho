import type { UiViewProps } from '../../src/ui-contract.js';

// The view's selection channel as the shell last read it. Views of one table version share
// that channel, so this is how a selection made in one of them reaches the others.
export function sharedSelection(props: Pick<UiViewProps, 'snapshot' | 'selectionScope'>) {
  const scope = props.selectionScope;
  if (!scope) return null;
  const channel = props.snapshot.interactions.find(c => c.scope.kind === 'shared' && 'id' in c.scope && c.scope.id === scope.id);
  if (!channel) return null;
  const selection = channel.selection as { resource?: { id: string; version: string }; entities?: string[] } | null;
  return { version: channel.version, resource: selection?.resource ?? null, entities: selection?.entities ?? [] };
}
