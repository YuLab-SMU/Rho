import { MediaView } from '@rho-workspace/plugin-media/ui';
import type { UiContribution, UiViewProps } from '../../src/ui-contract.js';

// The full form of registered media: the bytes of this exact version, read in bounded
// chunks and shown. A produced figure becomes visible here; nothing is written.
function Media(props: UiViewProps) {
  return <MediaView view={props.view} projectId={props.projectId} client={props.client} active={props.active} />;
}

export const entry: UiContribution = {
  entryVersion: '0.1-draft',
  owner: 'rho-plugins.media',
  package: '@rho-workspace/plugin-media',
  packageVersion: '0.4.0',
  component: 'rho.media',
  componentVersion: '0.2.0',
  propsSchema: { type: 'object', properties: { title: { type: 'string' } } },
  bindings: { data: 'resource' },
  requiredOperations: ['resource.read'],
  commands: [],
  selection: [],
  View: Media
};
