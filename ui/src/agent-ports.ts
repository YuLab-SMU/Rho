import type { RequestContext } from "./shared/ports";
import type { WorkbenchAgentConnection } from "./generated/WorkbenchAgentConnection";
import type { ApplicationWindowRef } from "./generated/ApplicationWindowRef";

export type AgentConfigurationFormat = "codex" | "mcp";
export interface AgentPorts {
  context(): RequestContext;
  window(): ApplicationWindowRef | null;
  read(): Promise<WorkbenchAgentConnection>;
  configuration(observation: WorkbenchAgentConnection, format: AgentConfigurationFormat, masked: boolean): string;
  copy(text: string): Promise<void>;
  schedule(): void;
}
