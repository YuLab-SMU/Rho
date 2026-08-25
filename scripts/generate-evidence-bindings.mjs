import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Evidence reads",
  defaultOutput: "desktop/ui/src/transport/generated/evidence.ts",
  fileStem: "evidence",
  temporaryPrefix: "rho-evidence-bindings-",
  testFilter: "evidence_typescript_export",
  outputEnvironment: "RHO_EVIDENCE_BINDINGS_PATH",
  factoryName: "createEvidenceCommands",
  invokeTypeName: "EvidenceInvoke",
  rustSources: "rho-store Evidence claim + rho-desktop Evidence read command",
});
