import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Check",
  defaultOutput: "desktop/ui/src/transport/generated/check.ts",
  fileStem: "check",
  temporaryPrefix: "rho-check-bindings-",
  testFilter: "check_typescript_export",
  outputEnvironment: "RHO_CHECK_BINDINGS_PATH",
  factoryName: "createCheckCommands",
  invokeTypeName: "CheckInvoke",
  rustSources: "rho-ui-contract/check+surface origin + rho-desktop/check_runtime",
  externalTypes: [
    { name: "ProjectId", from: "./surface-studio" },
    { name: "SurfaceOriginV1", from: "./surface-studio" },
  ],
});
