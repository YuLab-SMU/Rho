import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Surface and Studio",
  defaultOutput: "desktop/ui/src/transport/generated/surface-studio.ts",
  fileStem: "surface-studio",
  temporaryPrefix: "rho-surface-studio-bindings-",
  testFilter: "surface_studio_typescript_export",
  outputEnvironment: "RHO_SURFACE_STUDIO_BINDINGS_PATH",
  factoryName: "createSurfaceStudioCommands",
  invokeTypeName: "SurfaceStudioInvoke",
  rustSources: "rho-ui-contract/surface+layout+resource+runtime + rho-desktop/surface_runtime+studio_runtime+runtime_registry",
  externalTypes: [
    { name: "ResourceBindingV1", from: "./resource" },
    { name: "RuntimeBindingV1", from: "./runtime" },
    { name: "RuntimeInstanceRequestV1", from: "./runtime" },
  ],
});
