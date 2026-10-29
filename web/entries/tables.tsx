import { TableCardBody, TableView, tableEntry, tableForms } from '@rho-workspace/plugin-tables/ui';
import type { FrameBodyProps, UiContribution, UiViewProps } from '../../src/ui-contract.js';
import { sharedSelection } from './selection.js';
function Table(props: UiViewProps) {
  return <TableView view={props.view} projectId={props.projectId} client={props.client} active={props.active} renderObservation={props.renderObservation} requestFeedback={props.requestFeedback} selectable={['interaction.selection.set', 'interaction.selection.read'].every(method => props.snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized))}
    selectionScope={props.selectionScope} sharedSelection={sharedSelection(props)} />;
}
// The item's card, summary and comparison inside Rho's frame, read from the view's table.
function Body({ form, params, view, present, reportHidden }: FrameBodyProps) {
  if (!view) return null;
  return <TableCardBody form={form} params={params} projectId={view.projectId} client={view.client} resource={view.view.bindings.data as { id: string; version: string } | undefined} onParams={present} reportHidden={reportHidden} />;
}
export const entry: UiContribution = { ...tableEntry, entryVersion: '0.1-draft', packageVersion: '0.5.0', propsSchema: { type: 'object', properties: { title: { type: 'string' } } }, commands: [], View: Table, forms: tableForms, Body };
