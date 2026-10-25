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
  // Open the view that already shows one exact artifact version. The shell decides
  // where that is; an entry never guesses or creates a view.
  openArtifact(id: string, version: string): Promise<void>;
  // Observation only.
  observe(): TaskMapState;
}
// What an item names as its artifact, resolved by the shell from registered
// resources. An entry reads this instead of the project itself.
export interface NamedArtifact { id: string; version: string; name: string }
export interface FrameContext {
  map: TaskMapState;
  controls: FrameControls;
  // Rho's frame around one item, drawn by that item's own plugin body. The
  // inline form always draws the item's reference, whatever its presentation.
  Card: ComponentType<{ itemId: string; form?: string }>;
  principalId?: string;
  activeViewId?: string;
  // Resolves an item's declared artifact against what is registered right now.
  artifacts?: { of(item: TaskItem): NamedArtifact | null };
}
// Body of one form. Rho draws the header (kind, state, Agent-written title) and
// footer (what is hidden, the declared next step, plugin name) around it.
export interface FrameBodyProps extends FrameContext {
  form: string;
  params: Record<string, unknown>;
  item?: TaskItem;
  // The bound layout view when the body belongs to one.
  view?: UiViewProps;
  // Present when this tab may change how the item is shown. The person becomes
  // the author of the new presentation; the frame shows a failure.
  present?: (params: Record<string, unknown>, form?: string) => void;
  // What the drawn form leaves out once the body has read it, counted from the
  // whole resource. Preferred over the entry's hiddenNote for this form.
  reportHidden?: (note: string) => void;
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
  // A rendered feedback view always has its draft document: the shell only mounts the
  // entry when the routed configuration names one, and the entry re-checks the binding.
  feedbackConfiguration?: Omit<NonNullable<WorkspaceSnapshot['feedback']>, 'draftDocumentId'> & { draftDocumentId: string };
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
  // Optional object feedback supplied only by the selected Annotations entry.
  TableQuestion?: ComponentType<Pick<UiViewProps, 'projectId' | 'viewId' | 'snapshot' | 'client' | 'principalId' | 'requestFeedback' | 'headerTarget'> & {
    resource: { id: string; version: string };
    onOpenResource?: (ref: { id: string; version: string }) => void;
  }>;
  // Forms this entry can draw, ordered by scale. Without a declaration an entry
  // draws only "full"; Rho's generic body stands in for smaller forms.
  forms?: FormDeclarations;
  Body?: ComponentType<FrameBodyProps>;
  // What the current form and parameters leave out, in the reader's terms.
  hiddenNote?: (form: string, params: Record<string, unknown>, context: { item?: TaskItem; map: TaskMapState }) => string;
  displayName?: string;
}
export interface UiRegistry { readonly entries: readonly UiContribution[] }
