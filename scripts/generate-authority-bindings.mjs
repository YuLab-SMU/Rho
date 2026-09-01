import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Authority",
  defaultOutput: "desktop/ui/src/transport/generated/authority.ts",
  fileStem: "authority",
  temporaryPrefix: "rho-authority-bindings-",
  testFilter: "authority_typescript_export",
  outputEnvironment: "RHO_AUTHORITY_BINDINGS_PATH",
  factoryName: "createAuthorityCommands",
  invokeTypeName: "AuthorityInvoke",
  rustSources: "rho-ui-contract/authority + rho-desktop/commands/authority",
  externalTypes: [
    { name: "ProjectId", from: "./surface-studio" },
  ],
});
