import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Project transition",
  defaultOutput: "desktop/ui/src/transport/generated/project.ts",
  fileStem: "project",
  temporaryPrefix: "rho-project-bindings-",
  testFilter: "project_typescript_export",
  outputEnvironment: "RHO_PROJECT_BINDINGS_PATH",
  factoryName: "createProjectCommands",
  invokeTypeName: "ProjectInvoke",
  rustSources: "rho-desktop/project transition commands",
});
