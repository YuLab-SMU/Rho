import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Startup",
  defaultOutput: "desktop/ui/src/transport/generated/startup.ts",
  fileStem: "startup",
  temporaryPrefix: "rho-startup-bindings-",
  testFilter: "startup_typescript_export",
  outputEnvironment: "RHO_STARTUP_BINDINGS_PATH",
  factoryName: "createStartupCommands",
  invokeTypeName: "StartupInvoke",
  rustSources: "rho-desktop startup service + commands/startup facade",
});
