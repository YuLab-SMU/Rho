import type { RequestContext } from "./shared/ports";
import type { ApplicationWindowRef } from "./generated/ApplicationWindowRef";
import type { ComponentAgentConversation } from "./generated/ComponentAgentConversation";
import type { ComponentAgentRun } from "./generated/ComponentAgentRun";
import type { ComponentAgentEventPage } from "./generated/ComponentAgentEventPage";
import type { ComponentAgentQuery } from "./generated/ComponentAgentQuery";
import type { ComponentAgentsQuery } from "./generated/ComponentAgentsQuery";
import type { ComponentAgentsCommand } from "./generated/ComponentAgentsCommand";
import type { ComponentAgentCommand } from "./generated/ComponentAgentCommand";
import type { ComponentModelSettings } from "./generated/ComponentModelSettings";
import type { ComponentModelDiagnostic } from "./generated/ComponentModelDiagnostic";
import type { ComponentToolReceipt } from "./generated/ComponentToolReceipt";
import type { ComponentAgentRunSummary } from "./generated/ComponentAgentRunSummary";
import type { AgentAsset } from "./generated/AgentAsset";
import type { AgentAssetPreview } from "./agent-task-ports";

export interface ComponentQueryReplies {
  assets: { assets: AgentAsset[] };
  runs: { runs: ComponentAgentRunSummary[] };
  settings: { settings: ComponentModelSettings };
  credential_status: { credential_status: import("./generated/ComponentCredentialStatus").ComponentCredentialStatus };
  diagnostics: { diagnostics: ComponentModelDiagnostic[] };
  diagnostic: { diagnostic: ComponentModelDiagnostic | null };
  conversations: { conversations: ComponentAgentConversation[] };
  conversation: { conversation: ComponentAgentConversation };
  run: { run: ComponentAgentRun };
  request: { run: ComponentAgentRun | null };
  tools: { tools: ComponentToolReceipt[] };
  events: { page: ComponentAgentEventPage };
}
export interface ComponentCommandReplies {
  add_asset: { asset: AgentAsset };
  remove_asset: { conversation: ComponentAgentConversation };
  rename: { conversation: ComponentAgentConversation };
  archive: { conversation: ComponentAgentConversation };
  decision: { run: ComponentAgentRun };
  create: { conversation: ComponentAgentConversation };
  save_draft: { conversation: ComponentAgentConversation };
  take_control: { conversation: ComponentAgentConversation };
  start: { run: ComponentAgentRun };
  stop: { run: ComponentAgentRun };
  reconcile: { run: ComponentAgentRun };
  configure: { settings: ComponentModelSettings };
  remove_credential: { credential_status: import("./generated/ComponentCredentialStatus").ComponentCredentialStatus };
  stop_test: { diagnostic: ComponentModelDiagnostic };
}
export interface ComponentAgentPorts {
  selectedConversation?(): string | null;
  asset?(request: { project_root: string; conversation_id: string; asset_id: string }): Promise<AgentAssetPreview>;
  releaseAsset?(url: string): void;
  synchronizeContext?(): Promise<void>;
  sourceSearch?(request: import("./generated/ComponentSourceSearch").ComponentSourceSearch): Promise<import("./generated/ComponentSourceSearchResult").ComponentSourceSearchResult>;
  sourcePreview?(request: import("./generated/ComponentSourcePreviewRequest").ComponentSourcePreviewRequest): Promise<import("./generated/ComponentSourcePreview").ComponentSourcePreview>;
  credential?(request: import("./generated/ComponentLocalCredential").ComponentLocalCredential): Promise<{ credential: import("./generated/ComponentCredentialRef").ComponentCredentialRef }>;
  test?(request: import("./generated/ComponentModelTestRequest").ComponentModelTestRequest): Promise<{ diagnostic: ComponentModelDiagnostic }>;
  initial?(profile: import("./generated/ComponentAgentProfile").ComponentAgentProfile, viewId?: string): { session: import("./generated/ComponentAgentSession").ComponentAgentSession | null; sources: import("./generated/AgentContextSelection").AgentContextSelection[]; documentId?: string };
  context(): RequestContext;
  window(): ApplicationWindowRef | null;
  query<Q extends ComponentAgentQuery>(request: ComponentAgentsQuery & { query: Q }): Promise<ComponentQueryReplies[Q["kind"]]>;
  command<C extends ComponentAgentCommand>(request: ComponentAgentsCommand & { command: C }): Promise<ComponentCommandReplies[C["kind"]]>;
  /** Local records belong to this browser window; adapters must not share a key across controllers. */
  readLocal(project: string): unknown;
  /** Must finish synchronously; submission identity must be durable before dispatch. */
  writeLocal(project: string, value: unknown): void;
}
