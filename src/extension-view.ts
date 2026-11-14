// A runtime HTML plugin view is a composition leaf, not a compiled owner component.
// The saved props keep the exact package revision that the person or Agent chose.
export const runtimeExtensionComponent = 'rho.extension.html';
export const runtimeExtensionVersion = '1';

export interface RuntimeExtensionViewProps {
  pluginId: string;
  expectedDigest: string;
  entryId: string;
  title?: string;
}

const identity = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const digest = /^[a-f0-9]{64}$/;

export function runtimeExtensionProps(value: unknown): value is RuntimeExtensionViewProps {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const props = value as Partial<RuntimeExtensionViewProps>;
  return typeof props.pluginId === 'string' && identity.test(props.pluginId)
    && typeof props.expectedDigest === 'string' && digest.test(props.expectedDigest)
    && typeof props.entryId === 'string' && identity.test(props.entryId)
    && (props.title === undefined || typeof props.title === 'string' && props.title.length > 0 && props.title.length <= 120);
}

export function runtimeExtensionView(props: RuntimeExtensionViewProps, id = `extension-${props.pluginId}-${props.entryId}`) {
  return {
    id,
    kind: 'view' as const,
    component: runtimeExtensionComponent,
    version: runtimeExtensionVersion,
    props,
    bindings: {},
  };
}
