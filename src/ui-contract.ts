import type { ComponentType } from 'react';
import type { BrowserClient, ViewDescription, WorkspaceSnapshot } from './browser.js';
import type { FormDeclarations, TaskItem, TaskMapState } from './task-frame.js';

// Shared interaction supplied by Rho to every framed body. The actions are the
// same ones the Agent calls; this tab's person is their author.
export interface FrameControls {
  setForm(target: string, form: string, params?: Record<string, unknown>): Promise<void>;
  setSubset(target: string, form: string, subset: unknown): Promise<void>;
  focus(itemId: string | null): Promise<void>;
  pin(target: string, form: string, params?: Record<string, unknown>): Promise<void>;
  unpin(target: string): Promise<void>;
  revert(target: string): Promise<void>;
  accept(target: string, suggestionId: string): Promise<void>;
  dismiss(target: string, suggestionId: string): Promise<void>;
  // Observation only.
  observe(): TaskMapState;
}
export interface FrameContext {
  map: TaskMapState;
  controls: FrameControls;
  // Rho's frame around one item, drawn by that item's own plugin body.
  Card: ComponentType<{ itemId: string; form?: string }>;
  principalId?: string;
  activeViewId?: string;
}
// Body of one form. Rho draws the header (kind, state, Agent-written title) and
// footer (what is hidden, the declared next step, plugin name) around it.
export interface FrameBodyProps extends FrameContext {
  form: string;
  params: Record<string, unknown>;
  item?: TaskItem;
  // The bound layout view when the body belongs to one.
  view?: UiViewProps;
}

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
  // Present when the task map is available; the same frame every plugin uses.
  frame?: FrameContext & { form: string; params: Record<string, unknown>; item?: TaskItem };
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
  // The full form inside a layout.
  View: ComponentType<UiViewProps>;
  // Forms this entry can draw, ordered by scale. Without a declaration an entry
  // draws only "full"; Rho's generic body stands in for smaller forms.
  forms?: FormDeclarations;
  Body?: ComponentType<FrameBodyProps>;
  // What the current form and parameters leave out, in the reader's terms.
  hiddenNote?: (form: string, params: Record<string, unknown>, context: { item?: TaskItem; map: TaskMapState }) => string;
  displayName?: string;
}
export interface UiRegistry { readonly entries: readonly UiContribution[] }
