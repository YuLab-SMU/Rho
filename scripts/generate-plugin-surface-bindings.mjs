import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Workspace-plugin Surface",
  defaultOutput: "desktop/ui/src/transport/generated/plugin-surface.ts",
  fileStem: "plugin-surface",
  temporaryPrefix: "rho-plugin-surface-bindings-",
  testFilter: "plugin_surface_typescript_export",
  outputEnvironment: "RHO_PLUGIN_SURFACE_BINDINGS_PATH",
  factoryName: "createPluginSurfaceCommands",
  invokeTypeName: "PluginSurfaceInvoke",
  rustSources: "rho-extension-runtime/surface+viewer + rho-desktop/plugin_surface_runtime",
  externalTypes: [
    { name: "ProjectId", from: "./surface-studio" },
    { name: "SurfaceId", from: "./surface-studio" },
    { name: "SurfaceInstanceId", from: "./surface-studio" },
    { name: "SurfaceInstanceRequestV1", from: "./surface-studio" },
  ],
});
