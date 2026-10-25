import { ScatterView, scatterEntry } from '@rho-workspace/plugin-charts/ui';
import type { UiContribution, UiViewProps } from '../../src/ui-contract.js';
import { sharedSelection } from './selection.js';
function Scatter(props: UiViewProps) {
  return <ScatterView view={props.view} projectId={props.projectId} client={props.client}
    selectable={['interaction.selection.set', 'interaction.selection.read'].every(method => props.snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized))}
    selectionScope={props.selectionScope} sharedSelection={sharedSelection(props)} />;
}
export const entry: UiContribution = { ...scatterEntry, entryVersion: '0.1-draft', packageVersion: '0.4.0', propsSchema: { type: 'object', properties: { title: { type: 'string' }, x: { type: 'string' }, y: { type: 'string' } } }, commands: [], View: Scatter };
