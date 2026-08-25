import { runTauriSpectaBindingGenerator } from "./lib/tauri-specta-bindings.mjs";

runTauriSpectaBindingGenerator({
  domainLabel: "Git reads",
  defaultOutput: "desktop/ui/src/transport/generated/git.ts",
  fileStem: "git",
  temporaryPrefix: "rho-git-bindings-",
  testFilter: "git_typescript_export",
  outputEnvironment: "RHO_GIT_BINDINGS_PATH",
  factoryName: "createGitCommands",
  invokeTypeName: "GitInvoke",
  rustSources: "rho-desktop Git DTOs + git_commands read adapters",
});
