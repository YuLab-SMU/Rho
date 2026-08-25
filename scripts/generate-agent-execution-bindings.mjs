import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Agent context and turn control",
  defaultOutput: "desktop/ui/src/transport/generated/agent-execution.ts",
  fileStem: "agent-execution",
  temporaryPrefix: "rho-agent-execution-bindings-",
  testFilter: "agent_execution_typescript_export",
  outputEnvironment: "RHO_AGENT_EXECUTION_BINDINGS_PATH",
  factoryName: "createAgentExecutionCommands",
  invokeTypeName: "AgentExecutionInvoke",
  rustSources: "rho-store/runtime_output + rho-desktop/commands/agent_execution",
  externalTypes: [
    { name: "RuntimeExecutionStatus", from: "./runtime-output" },
    { name: "RuntimeOutputReference", from: "./runtime-output" },
    { name: "RuntimeOutputState", from: "./runtime-output" },
  ],
});
