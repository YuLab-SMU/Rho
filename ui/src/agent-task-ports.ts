import type { RequestContext } from "./shared/ports";
import type { ApplicationWindowRef } from "./generated/ApplicationWindowRef";
import type { AgentTasksCommand } from "./generated/AgentTasksCommand";
import type { AgentTaskCommandResult } from "./generated/AgentTaskCommandResult";
import type { AgentTasksQuery } from "./generated/AgentTasksQuery";
import type { AgentTaskQueryResult } from "./generated/AgentTaskQueryResult";
import type { DiscoverAgent } from "./generated/DiscoverAgent";
import type { LocalAgent } from "./generated/LocalAgent";
import type { ReadAgentAsset } from "./generated/ReadAgentAsset";

export interface AgentAssetPreview { url: string; text: string | null }
export interface AgentTaskPorts {
  readonly windowId: string;
  context(): RequestContext;
  window(): ApplicationWindowRef | null;
  query(request: AgentTasksQuery): Promise<AgentTaskQueryResult>;
  command(request: AgentTasksCommand): Promise<AgentTaskCommandResult>;
  discover(request: DiscoverAgent): Promise<LocalAgent>;
  asset(request: ReadAgentAsset): Promise<AgentAssetPreview>;
  releaseAsset(url: string): void;
  readLocal(project: string): unknown;
  writeLocal(project: string, value: unknown): void;
  changed(): void;
  schedule(): void;
}
