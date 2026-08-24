import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Resource",
  defaultOutput: "desktop/ui/src/transport/generated/resource.ts",
  fileStem: "resource",
  temporaryPrefix: "rho-resource-bindings-",
  testFilter: "resource_typescript_export",
  outputEnvironment: "RHO_RESOURCE_BINDINGS_PATH",
  factoryName: "createResourceCommands",
  invokeTypeName: "ResourceInvoke",
  rustSources: "rho-ui-contract/resource + rho-desktop/resource_registry",
});
