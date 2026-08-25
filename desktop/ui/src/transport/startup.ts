import {
  createStartupCommands,
  type StartupInvoke,
  type StartupView,
  type WorkspaceStatus,
} from "./generated/startup";

export interface StartupTransport {
  bootstrapStartup(): Promise<StartupView>;
  chooseRscript(): Promise<StartupView>;
  startWorkspace(): Promise<WorkspaceStatus>;
}

export function createTauriStartupTransport(invoke: StartupInvoke): StartupTransport {
  const commands = createStartupCommands(invoke);
  return {
    bootstrapStartup: commands.startupBootstrap,
    chooseRscript: commands.startupChooseRscript,
    startWorkspace: commands.workspaceStart,
  };
}
