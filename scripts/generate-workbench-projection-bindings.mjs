import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Workbench projection",
  defaultOutput: "desktop/ui/src/transport/generated/workbench-projection.ts",
  fileStem: "workbench-projection",
  temporaryPrefix: "rho-workbench-projection-bindings-",
  testFilter: "workbench_projection_typescript_export",
  outputEnvironment: "RHO_WORKBENCH_PROJECTION_BINDINGS_PATH",
  factoryName: "createWorkbenchProjectionCommands",
  invokeTypeName: "WorkbenchProjectionInvoke",
  rustSources: "rho-ui-contract/workbench + rho-desktop/workbench_projection",
  externalTypes: [
    { name: "UiKernelSnapshotV1", from: "./kernel" },
    { name: "ProjectUiProfileSnapshotV1", from: "./profile" },
    { name: "ResourceRegistrySnapshotV1", from: "./resource" },
    { name: "RuntimeRegistrySnapshotV1", from: "./runtime" },
    { name: "StudioRuntimeSnapshotV1", from: "./surface-studio" },
    { name: "SurfaceRuntimeSnapshotV1_Deserialize", from: "./surface-studio" },
    { name: "SurfaceRuntimeSnapshotV1_Serialize", from: "./surface-studio" },
  ],
  omitTypes: ["SurfaceRuntimeSnapshotV1"],
});
