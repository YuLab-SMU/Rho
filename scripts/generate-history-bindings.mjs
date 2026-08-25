import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "History and artifact reads",
  defaultOutput: "desktop/ui/src/transport/generated/history.ts",
  fileStem: "history",
  temporaryPrefix: "rho-history-bindings-",
  testFilter: "history_typescript_export",
  outputEnvironment: "RHO_HISTORY_BINDINGS_PATH",
  factoryName: "createHistoryCommands",
  invokeTypeName: "HistoryInvoke",
  rustSources: "rho-store run+artifact summaries + rho-desktop run/history/plot commands",
});
