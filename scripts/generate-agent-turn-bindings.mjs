import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Agent turn detail",
  defaultOutput: "desktop/ui/src/transport/generated/agent-turn.ts",
  fileStem: "agent-turn",
  temporaryPrefix: "rho-agent-turn-bindings-",
  testFilter: "agent_turn_typescript_export",
  outputEnvironment: "RHO_AGENT_TURN_BINDINGS_PATH",
  factoryName: "createAgentTurnCommands",
  invokeTypeName: "AgentTurnInvoke",
  rustSources: "rho-store/agent + rho-store/runtime_output + rho-desktop/commands/agent_execution",
  externalTypes: [
    { name: "AgentTurnSummary", from: "./agent-conversation" },
  ],
});
