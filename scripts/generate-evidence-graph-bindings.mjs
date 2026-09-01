import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Evidence Graph",
  defaultOutput: "desktop/ui/src/transport/generated/evidence-graph.ts",
  fileStem: "evidence-graph",
  temporaryPrefix: "rho-evidence-graph-bindings-",
  testFilter: "evidence_graph_typescript_export",
  outputEnvironment: "RHO_EVIDENCE_GRAPH_BINDINGS_PATH",
  factoryName: "createEvidenceGraphCommands",
  invokeTypeName: "EvidenceGraphInvoke",
  rustSources: "rho-ui-contract/evidence_graph + rho-desktop/commands/evidence_graph",
  externalTypes: [
    { name: "AuthorityReferenceViewV1", from: "./authority" },
    { name: "ProjectId", from: "./surface-studio" },
  ],
});
