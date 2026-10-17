import type { ComponentType } from 'react';
import type { BrowserClient, ViewDescription, WorkspaceSnapshot } from './browser.js';

// Draft, not a stable plugin API. Owner entries are selected at build time only.
export interface UiViewProps {
  viewId: string;
  view: ViewDescription;
  projectId: string;
  snapshot: WorkspaceSnapshot;
  client: BrowserClient;
  active: boolean;
}
export interface UiContribution {
  entryVersion: '0.1-draft';
  owner: string;
  package: string;
  packageVersion: string;
  component: string;
  componentVersion: string;
  propsSchema: Record<string, unknown>;
  bindings: Record<string, 'document' | 'resource'>;
  requiredOperations: string[];
  commands: { id: string; title: string; operation: string }[];
  selection: ('document-utf16' | 'table-entities')[];
  View: ComponentType<UiViewProps>;
}
export interface UiRegistry { readonly entries: readonly UiContribution[] }
