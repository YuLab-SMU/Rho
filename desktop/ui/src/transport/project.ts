import {
  createProjectCommands,
  type PanelSizes as PanelSizesWire,
  type ProjectDocumentSession as ProjectDocumentSessionWire,
  type ProjectFile as ProjectFileWire,
  type ProjectInvoke,
  type ProjectRestoreResponse as ProjectRestoreResponseWire,
  type ProjectSessionSnapshot as ProjectSessionSnapshotWire,
  type ProjectState as ProjectStateWire,
  type ProjectSwitchBlocker as ProjectSwitchBlockerWire,
  type ProjectSwitchBlockerKind,
  type UnavailableProject as UnavailableProjectWire,
} from "./generated/project";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

const PROJECT_SWITCH_STATUSES = [
  "ready",
  "cancelled",
  "blocked",
  "unavailable",
  "failed_restored",
  "fatal",
] as const;

export type ProjectSwitchStatus = (typeof PROJECT_SWITCH_STATUSES)[number];
export type ProjectPanelSizes = DeepReadonly<PanelSizesWire>;
export type ProjectDocumentSession = DeepReadonly<ProjectDocumentSessionWire>;
export type ProjectFile = DeepReadonly<ProjectFileWire>;
export type ProjectSessionSnapshot = DeepReadonly<ProjectSessionSnapshotWire>;
export type ProjectState = DeepReadonly<ProjectStateWire>;
export type ProjectSwitchBlocker = DeepReadonly<ProjectSwitchBlockerWire>;
export type ProjectBlockerKind = ProjectSwitchBlockerKind;
export type UnavailableProject = DeepReadonly<UnavailableProjectWire>;

export type ProjectSwitchResponse = DeepReadonly<
  Omit<ProjectRestoreResponseWire, "status"> & {
    status: ProjectSwitchStatus;
  }
>;

export interface ProjectTransport {
  openProject(path: string): Promise<ProjectSwitchResponse>;
  pickProjectDirectory(): Promise<ProjectSwitchResponse>;
}

export type ProjectCommands = ReturnType<typeof createProjectCommands>;

export function createTauriProjectCommands(invoke: ProjectInvoke): ProjectCommands {
  return createProjectCommands(invoke);
}

export function assertProjectSwitchStatus(status: string): asserts status is ProjectSwitchStatus {
  if (!(PROJECT_SWITCH_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unsupported project transition status: ${status}`);
  }
}

export function normalizeProjectSwitchResponse(
  response: ProjectRestoreResponseWire,
): ProjectSwitchResponse {
  assertProjectSwitchStatus(response.status);
  return response as ProjectSwitchResponse;
}

export function createTauriProjectTransport(
  projectCommands: ProjectCommands,
): ProjectTransport {
  return {
    openProject: async (path) => normalizeProjectSwitchResponse(
      await projectCommands.projectOpen(path),
    ),
    pickProjectDirectory: async () => normalizeProjectSwitchResponse(
      await projectCommands.projectPickDirectory(),
    ),
  };
}
