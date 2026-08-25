import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Agent settings and capacity",
  defaultOutput: "desktop/ui/src/transport/generated/agent-settings.ts",
  fileStem: "agent-settings",
  temporaryPrefix: "rho-agent-settings-bindings-",
  testFilter: "agent_settings_typescript_export",
  outputEnvironment: "RHO_AGENT_SETTINGS_BINDINGS_PATH",
  factoryName: "createAgentSettingsCommands",
  invokeTypeName: "AgentSettingsInvoke",
  rustSources: "rho-desktop/agent_llm service + commands/agent_llm facade",
});
