import type { RequestContext } from "./shared/ports";
import type { ApplicationWindowRef } from "./generated/ApplicationWindowRef";
import type { AgentTasksCommand } from "./generated/AgentTasksCommand";
import type { AgentTaskCommandResult } from "./generated/AgentTaskCommandResult";
import type { AgentTasksQuery } from "./generated/AgentTasksQuery";
import type { AgentTaskQueryResult } from "./generated/AgentTaskQueryResult";
import type { DiscoverAgent } from "./generated/DiscoverAgent";
import type { LocalAgent } from "./generated/LocalAgent";
import type { ReadAgentAsset } from "./generated/ReadAgentAsset";
import type { AgentHandoffPorts } from "./agent-handoff-ports";
import type { ProjectAgentTaskRef } from "./generated/ProjectAgentTaskRef";

export interface AgentAssetPreview { url: string; text: string | null }
export interface AgentTaskPorts {
  readonly windowId: string;
  context(): RequestContext;
  window(): ApplicationWindowRef | null;
  query(request: AgentTasksQuery): Promise<AgentTaskQueryResult>;
  projectQuery?(request: AgentTasksQuery): Promise<AgentTaskQueryResult>;
  handoffQuery?: AgentHandoffPorts["query"];
  handoffCommand?: AgentHandoffPorts["command"];
  synchronizeRhoDraft?(reference: ProjectAgentTaskRef & { kind: "rho" }): Promise<void>;
  refreshRhoTask?(reference: ProjectAgentTaskRef & { kind: "rho" }): Promise<void>;
  command(request: AgentTasksCommand): Promise<AgentTaskCommandResult>;
  discover(request: DiscoverAgent): Promise<LocalAgent>;
  asset(request: ReadAgentAsset): Promise<AgentAssetPreview>;
  releaseAsset(url: string): void;
  readLocal(project: string): unknown;
  writeLocal(project: string, value: unknown): void;
  changed(): void;
  schedule(): void;
}
