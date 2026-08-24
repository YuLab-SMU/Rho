import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Agent runtime diagnostics",
  defaultOutput: "desktop/ui/src/transport/generated/agent-runtime.ts",
  fileStem: "agent-runtime",
  temporaryPrefix: "rho-agent-runtime-bindings-",
  testFilter: "agent_diagnostics_typescript_export",
  outputEnvironment: "RHO_AGENT_RUNTIME_BINDINGS_PATH",
  factoryName: "createAgentRuntimeCommands",
  invokeTypeName: "AgentRuntimeInvoke",
  rustSources: "rho-desktop/main Agent runtime diagnostic commands",
});
