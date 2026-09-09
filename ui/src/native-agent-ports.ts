import type { RequestContext } from "./shared/ports";
import type { ApplicationWindowRef } from "./generated/ApplicationWindowRef";
import type { LocalAgent } from "./generated/LocalAgent";
import type { DiscoverAgent } from "./generated/DiscoverAgent";
import type { SetupAgent } from "./generated/SetupAgent";
import type { ConnectAgent } from "./generated/ConnectAgent";
import type { AgentClientSession } from "./generated/AgentClientSession";
import type { AgentClientAction } from "./generated/AgentClientAction";
export interface NativeAgentPorts {
  context(): RequestContext;
  window(): ApplicationWindowRef | null;
  discover(request: DiscoverAgent): Promise<LocalAgent>;
  setup(request: SetupAgent): Promise<LocalAgent>;
  connect(request: ConnectAgent): Promise<AgentClientSession>;
  sessions(): Promise<AgentClientSession[]>;
  action(request: AgentClientAction): Promise<AgentClientSession>;
  schedule(): void;
}
