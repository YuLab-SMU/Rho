import { DocumentEditorView, editorEntry } from '@rho-workspace/plugin-documents/ui';
import type { UiContribution, UiViewProps } from '../../src/ui-contract.js';
function Editor(props: UiViewProps) {
  const binding = props.view.bindings.document as { documentId?: string } | undefined;
  const doc = props.snapshot.documents.find(d => d.id === binding?.documentId);
  const limits = props.snapshot.limits.documents as { maxBufferBytes?: number } | undefined;
  // A session without edit grants still reads the document.
  const editable = ['document.edit', 'document.undoOwn', 'document.revert', 'document.change.read'].every(m => props.snapshot.catalog.operations.some(o => o.method === m && o.state === 'available' && o.authorized));
  return <DocumentEditorView view={props.view} projectId={props.projectId} client={props.client} active={props.active}
    documentVersion={doc?.version} principalId={props.principalId} contextTarget={props.contextTarget} headerTarget={props.headerTarget} maxUnconfirmedBytes={Math.max(1, Math.min(1024 * 1024, limits?.maxBufferBytes ?? 1024 * 1024))} editable={editable} />;
}
export const entry: UiContribution = { ...editorEntry, entryVersion: '0.1-draft', packageVersion: '0.4.0', propsSchema: { type: 'object', properties: { title: { type: 'string' } } }, commands: [], requiredOperations: ['document.read'], View: Editor };
