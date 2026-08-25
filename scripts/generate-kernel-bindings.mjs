import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "UI Kernel",
  defaultOutput: "desktop/ui/src/transport/generated/kernel.ts",
  fileStem: "kernel",
  temporaryPrefix: "rho-kernel-bindings-",
  testFilter: "kernel_typescript_export",
  outputEnvironment: "RHO_KERNEL_BINDINGS_PATH",
  factoryName: "createKernelCommands",
  invokeTypeName: "KernelInvoke",
  rustSources: "rho-ui-contract command+context+snapshot + rho-desktop/ui_runtime+shell",
  externalTypes: [
    { name: "ResourceBindingV1", from: "./resource" },
    { name: "SurfaceOriginV1", from: "./surface-studio" },
  ],
});
