import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Environment reads",
  defaultOutput: "desktop/ui/src/transport/generated/environment.ts",
  fileStem: "environment",
  temporaryPrefix: "rho-environment-bindings-",
  testFilter: "environment_typescript_export",
  outputEnvironment: "RHO_ENVIRONMENT_BINDINGS_PATH",
  factoryName: "createEnvironmentCommands",
  invokeTypeName: "EnvironmentInvoke",
  rustSources: "rho-store Environment operation summary + rho-desktop Environment read commands",
});
