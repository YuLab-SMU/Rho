import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Runtime Output",
  defaultOutput: "desktop/ui/src/transport/generated/runtime-output.ts",
  fileStem: "runtime-output",
  temporaryPrefix: "rho-runtime-output-bindings-",
  testFilter: "runtime_output_typescript_export",
  outputEnvironment: "RHO_RUNTIME_OUTPUT_BINDINGS_PATH",
  factoryName: "createRuntimeOutputCommands",
  invokeTypeName: "RuntimeOutputInvoke",
  rustSources: "rho-store/runtime_output + rho-desktop/runtime_registry",
});
