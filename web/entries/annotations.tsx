import { FeedbackComposer, feedbackEntry, TableQuestion } from '@rho-workspace/plugin-annotations/ui';
import type { UiContribution, UiViewProps } from '../../src/ui-contract.js';
function Feedback(props: UiViewProps) {
  if (!props.feedbackConfiguration) return <p>This task has no selected feedback entry.</p>;
  if ((props.view.bindings.draft as { documentId?: string } | undefined)?.documentId !== props.feedbackConfiguration.draftDocumentId || props.view.props.taskId !== props.feedbackConfiguration.taskId) return <p>This feedback view does not match the task's original draft.</p>;
  const doc = props.snapshot.documents.find(d => d.id === props.feedbackConfiguration!.draftDocumentId);
  return <FeedbackComposer view={props.view} projectId={props.projectId} client={props.client} active={props.active} principalId={props.principalId} configuration={props.feedbackConfiguration} documentVersion={doc?.version} observationCursor={props.snapshot.cursor} />;
}
const Question: NonNullable<UiContribution['TableQuestion']> = ({ snapshot, requestFeedback, ...props }) => <TableQuestion {...props} documents={snapshot.documents} threads={snapshot.annotations} contexts={snapshot.contexts} onRoutedQuestion={requestFeedback}
  enabled={['document.open', 'document.read', 'document.edit', 'document.undoOwn', 'document.revert', 'document.history', 'document.change.read', 'annotation.create', 'annotation.read', 'context.create', 'interaction.selection.read'].every(method => snapshot.catalog.operations.some(o => o.method === method && o.authorized && o.state === 'available'))} />;
export const entry: UiContribution = { ...feedbackEntry, entryVersion: '0.1-draft', packageVersion: '0.4.3', commands: [], View: Feedback, TableQuestion: Question };
