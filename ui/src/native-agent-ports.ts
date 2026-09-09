import type { RequestContext } from "./shared/ports";
import type { ApplicationWindowRef } from "./generated/ApplicationWindowRef";
import type { LocalAgent } from "./generated/LocalAgent";
import type { DiscoverAgent } from "./generated/DiscoverAgent";
import type { SetupAgent } from "./generated/SetupAgent";
import type { TestAgent } from "./generated/TestAgent";
import type { AgentDiagnostic } from "./generated/AgentDiagnostic";
export interface NativeAgentPorts {
  context(): RequestContext;
  window(): ApplicationWindowRef | null;
  discover(request: DiscoverAgent): Promise<LocalAgent>;
  setup(request: SetupAgent): Promise<LocalAgent>;
  test(request: TestAgent): Promise<AgentDiagnostic>;
  schedule(): void;
}
