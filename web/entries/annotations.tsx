import { FeedbackComposer, feedbackEntry } from '@rho-workspace/plugin-annotations/ui';
import type { UiContribution, UiViewProps } from '../../src/ui-contract.js';
function Feedback(props: UiViewProps) {
  if (!props.feedbackConfiguration) return <p>This task has no selected feedback entry.</p>;
  if ((props.view.bindings.draft as { documentId?: string } | undefined)?.documentId !== props.feedbackConfiguration.draftDocumentId || props.view.props.taskId !== props.feedbackConfiguration.taskId) return <p>This feedback view does not match the task's original draft.</p>;
  const doc = props.snapshot.documents.find(d => d.id === props.feedbackConfiguration!.draftDocumentId);
  return <FeedbackComposer view={props.view} projectId={props.projectId} client={props.client} active={props.active} principalId={props.principalId} configuration={props.feedbackConfiguration} documentVersion={doc?.version} observationCursor={props.snapshot.cursor} />;
}
export const entry: UiContribution = { ...feedbackEntry, entryVersion: '0.1-draft', packageVersion: '0.4.1', commands: [], View: Feedback };
