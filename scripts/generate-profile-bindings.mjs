import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Profile and Vibe",
  defaultOutput: "desktop/ui/src/transport/generated/profile.ts",
  fileStem: "profile",
  temporaryPrefix: "rho-profile-bindings-",
  testFilter: "profile_typescript_export",
  outputEnvironment: "RHO_PROFILE_BINDINGS_PATH",
  factoryName: "createProfileCommands",
  invokeTypeName: "ProfileInvoke",
  rustSources: "rho-ui-contract/profile+vibe + rho-desktop/ui_profile",
  externalTypes: [
    { name: "ResourceBindingV1", from: "./resource" },
    { name: "SceneStateV1", from: "./surface-studio" },
    { name: "SurfaceOriginV1", from: "./surface-studio" },
  ],
  omitTypes: [
    "ApplicationComponentId",
    "LayoutAxisV1",
    "LayoutBasisV1",
    "LayoutChildV1",
    "LayoutNodeId",
    "LayoutNodeV1",
    "PackageDigest",
    "PluginId",
    "ResourceKindId",
    "ResourceProviderId",
    "StackNodeV1",
  ],
});
