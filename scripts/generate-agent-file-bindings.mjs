import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Agent file mutation",
  defaultOutput: "desktop/ui/src/transport/generated/agent-file.ts",
  fileStem: "agent-file",
  temporaryPrefix: "rho-agent-file-bindings-",
  testFilter: "agent_file_typescript_export",
  outputEnvironment: "RHO_AGENT_FILE_BINDINGS_PATH",
  factoryName: "createAgentFileCommands",
  invokeTypeName: "AgentFileInvoke",
  rustSources: "rho-desktop/main Agent file mutation commands",
});
