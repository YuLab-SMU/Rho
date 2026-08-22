export type BootstrapSource = "tauri" | "mock";

export type StartupHealthState =
  | "checking"
  | "ready"
  | "needs_attention"
  | "unavailable";

export interface ProjectBootstrapView {
  readonly root: string;
  readonly label: string;
}

export interface StartupHealthView {
  readonly state: StartupHealthState;
  readonly phase: string;
  readonly title: string;
  readonly detail?: string;
}

export interface BootstrapSnapshot {
  readonly source: BootstrapSource;
  readonly project: ProjectBootstrapView;
  readonly startup: StartupHealthView;
}

export interface BootstrapTransport {
  loadBootstrap(): Promise<BootstrapSnapshot>;
}

export interface RawStartupView {
  readonly phase?: unknown;
  readonly busy?: unknown;
  readonly runtime?: unknown;
  readonly issue?: {
    readonly code?: unknown;
    readonly title?: unknown;
    readonly message?: unknown;
  } | null;
}

export interface RawProjectState {
  readonly root?: unknown;
}
