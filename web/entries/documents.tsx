import { useMemo } from 'react';
import { DocumentCardBody, DocumentEditorView, documentForms, editorEntry } from '@rho-workspace/plugin-documents/ui';
import type { FrameBodyProps, UiContribution, UiViewProps } from '../../src/ui-contract.js';
// A session without edit grants still reads the document.
const editable = (props: UiViewProps) => ['document.edit', 'document.undoOwn', 'document.revert', 'document.change.read'].every(m => props.snapshot.catalog.operations.some(o => o.method === m && o.state === 'available' && o.authorized));
const bufferBytes = (props: UiViewProps) => Math.max(1, Math.min(1024 * 1024, (props.snapshot.limits.documents as { maxBufferBytes?: number } | undefined)?.maxBufferBytes ?? 1024 * 1024));
// Saving, registering and executing stay Agent or operator work: a browser grant never
// carries document.save. A person who can type is told that here, instead of
// discovering it after typing into a buffer that cannot reach the disk.
function Editor(props: UiViewProps) {
  const binding = props.view.bindings.document as { documentId?: string } | undefined;
  const doc = props.snapshot.documents.find(d => d.id === binding?.documentId);
  const canType = editable(props);
  return <>
    {canType && <p className="rho-tab-buffer-note" role="status" style={{ padding: '6px 12px', margin: 0, fontSize: 12, color: 'var(--color-meta)', borderBottom: '1px solid var(--color-hairline)' }}>
      Your edits stay in this tab’s buffer. Saving to disk is an Agent step: ask the Agent to save this document.
    </p>}
    <DocumentEditorView view={props.view} projectId={props.projectId} client={props.client} active={props.active}
      documentVersion={doc?.version} principalId={props.principalId} contextTarget={props.contextTarget} headerTarget={props.headerTarget} maxUnconfirmedBytes={bufferBytes(props)} editable={canType} />
  </>;
}
// The item's passage, change, outline or summary inside Rho's frame. Cards read
// the same buffer as the editor; a reference to another item is Rho's chip.
function Body({ form, params, view, present, reportHidden, Card }: FrameBodyProps) {
  const Reference = useMemo(() => ({ itemId }: { itemId: string }) => <Card itemId={itemId} form="inline" />, [Card]);
  if (!view) return null;
  const binding = view.view.bindings.document as { documentId?: string; version?: number; kind?: string } | undefined;
  if (binding?.kind !== 'live-document' && typeof binding?.version === 'number') return form === 'inline' ? <span>Version {binding.version}</span> : <p className="rho-generic-summary">This view is pinned to version {binding.version}. Open it to read that version.</p>;
  const doc = view.snapshot.documents.find(d => d.id === binding?.documentId);
  return <DocumentCardBody form={form} params={params} projectId={view.projectId} client={view.client} documentId={binding?.documentId} documentVersion={doc?.version} principalId={view.principalId}
    editable={editable(view)} maxUnconfirmedBytes={bufferBytes(view)} onParams={present} reportHidden={reportHidden} Reference={Reference} />;
}
export const entry: UiContribution = { ...editorEntry, entryVersion: '0.1-draft', packageVersion: '0.4.1', propsSchema: { type: 'object', properties: { title: { type: 'string' } } }, commands: [], requiredOperations: ['document.read'], View: Editor, forms: documentForms, Body };
