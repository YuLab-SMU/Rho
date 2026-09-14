import type { RequestContext } from "./shared/ports";
import type { ApplicationWindowRef } from "./generated/ApplicationWindowRef";
import type { AgentHandoffsQuery } from "./generated/AgentHandoffsQuery";
import type { AgentHandoffQueryResult } from "./generated/AgentHandoffQueryResult";
import type { AgentHandoffCommand } from "./generated/AgentHandoffCommand";
import type { AgentHandoffReceipt } from "./generated/AgentHandoffReceipt";
import type { AgentContextSelection } from "./generated/AgentContextSelection";
import type { AgentContextPreview } from "./generated/AgentContextPreview";
import type { ProjectAgentTaskRef } from "./generated/ProjectAgentTaskRef";

export interface AgentHandoffPorts {
  context(): RequestContext;
  window(): ApplicationWindowRef | null;
  query(request: AgentHandoffsQuery): Promise<AgentHandoffQueryResult>;
  command(request: AgentHandoffCommand): Promise<AgentHandoffReceipt>;
  synchronizeDraft(reference: ProjectAgentTaskRef): Promise<void>;
  refreshTarget(reference: ProjectAgentTaskRef): Promise<void>;
  preview(selection: AgentContextSelection): Promise<AgentContextPreview | null>;
  changed(required?: boolean): void;
}
