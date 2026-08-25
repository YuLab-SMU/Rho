import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Agent conversation",
  defaultOutput: "desktop/ui/src/transport/generated/agent-conversation.ts",
  fileStem: "agent-conversation",
  temporaryPrefix: "rho-agent-conversation-bindings-",
  testFilter: "agent_conversation_typescript_export",
  outputEnvironment: "RHO_AGENT_CONVERSATION_BINDINGS_PATH",
  factoryName: "createAgentConversationCommands",
  invokeTypeName: "AgentConversationInvoke",
  rustSources: "rho-store/agent + rho-desktop commands/agent_conversation facade",
});
