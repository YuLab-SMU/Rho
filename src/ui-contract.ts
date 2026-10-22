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
  // A shell-owned place in the context panel; null while that panel is closed.
  contextTarget: HTMLElement | null;
  // This tab's principal when known, so authors can be named "You".
  principalId?: string;
  // Shell-owned right side of the view tab bar; plugin supplies its controls.
  headerTarget?: HTMLElement | null;
  // Owner reports real cells, shell attaches exact layout/build/client identity.
  renderObservation?: (evidence: { evidence: 'dom-visible' | 'hidden' | 'unavailable' | 'unmounted'; coverage: any; time: { browserObservedAt: string; performanceNowMs: number; clockDomain: string } }) => Promise<void>;
  requestFeedback?: () => void;
  feedbackConfiguration?: NonNullable<WorkspaceSnapshot['feedback']>;
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
