import { TableView, tableEntry } from '@rho-workspace/plugin-tables/ui';
import type { UiContribution, UiViewProps } from '../../src/ui-contract.js';
function Table(props: UiViewProps) {
  return <TableView view={props.view} projectId={props.projectId} client={props.client} active={props.active} renderObservation={props.renderObservation} requestFeedback={props.requestFeedback} selectable={['interaction.selection.set', 'interaction.selection.read'].every(method => props.snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized))} />;
}
export const entry: UiContribution = { ...tableEntry, entryVersion: '0.1-draft', packageVersion: '0.4.2', propsSchema: { type: 'object', properties: { title: { type: 'string' } } }, commands: [], View: Table };
