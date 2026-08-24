import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Runtime",
  defaultOutput: "desktop/ui/src/transport/generated/runtime.ts",
  fileStem: "runtime",
  temporaryPrefix: "rho-runtime-bindings-",
  testFilter: "runtime_typescript_export",
  outputEnvironment: "RHO_RUNTIME_BINDINGS_PATH",
  factoryName: "createRuntimeCommands",
  invokeTypeName: "RuntimeInvoke",
  rustSources: "rho-ui-contract/runtime + rho-desktop/runtime_registry",
  externalTypes: [
    { name: "RuntimeExecution", from: "./runtime-output" },
  ],
  omitTypes: [
    "RuntimeExecutionStatus",
    "RuntimeOutputState",
    "RuntimeExecuteRequestV1",
    "RuntimeExecuteRequestV1_Serialize",
  ],
});
