import {
  createEnvironmentCommands,
  type ComputeTargetListView as ComputeTargetListViewWire,
  type ConfigureSshTargetRequest as ConfigureSshTargetRequestWire,
  type ConfigureSshTargetView as ConfigureSshTargetViewWire,
  type EnvironmentInvoke,
  type EnvironmentOperationRequestSummary as EnvironmentOperationRequestSummaryWire,
  type ResourceMonitorView as ResourceMonitorViewWire,
  type SshConnectionProbeRequest as SshConnectionProbeRequestWire,
  type SshConnectionProbeView as SshConnectionProbeViewWire,
  type ToolchainDoctorView as ToolchainDoctorViewWire,
  type ToolchainInitializeRequest as ToolchainInitializeRequestWire,
} from "./generated/environment";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type EnvironmentOperationRequestSummary =
  DeepReadonly<EnvironmentOperationRequestSummaryWire>;
export type ToolchainDoctorView = DeepReadonly<ToolchainDoctorViewWire>;
export type ResourceMonitorView = DeepReadonly<ResourceMonitorViewWire>;
export type ComputeTargetListView = DeepReadonly<ComputeTargetListViewWire>;
export type SshConnectionProbeRequest = DeepReadonly<SshConnectionProbeRequestWire>;
export type SshConnectionProbeView = DeepReadonly<SshConnectionProbeViewWire>;
export type ConfigureSshTargetRequest = DeepReadonly<ConfigureSshTargetRequestWire>;
export type ConfigureSshTargetView = DeepReadonly<ConfigureSshTargetViewWire>;
export type ToolchainInitializeRequest = DeepReadonly<ToolchainInitializeRequestWire>;

export interface EnvironmentReadTransport {
  listInstalledPackages(limit?: number): Promise<unknown>;
  listEnvironmentOperationRequests(
    limit?: number,
    status?: string | null,
  ): Promise<readonly EnvironmentOperationRequestSummary[]>;
  toolchainDoctor(): Promise<ToolchainDoctorView>;
  initializeToolchain(request: ToolchainInitializeRequest): Promise<void>;
  resourceMonitorSnapshot(): Promise<ResourceMonitorView>;
  computeTargetList(): Promise<ComputeTargetListView>;
  remoteConnectionProbe(request: SshConnectionProbeRequest): Promise<SshConnectionProbeView>;
  configureSshTarget(request: ConfigureSshTargetRequest): Promise<ConfigureSshTargetView>;
}

export function createTauriEnvironmentReadTransport(
  invoke: EnvironmentInvoke,
): EnvironmentReadTransport {
  const commands = createEnvironmentCommands(invoke);
  return {
    listInstalledPackages: (limit) => commands.listInstalledPackages(limit ?? null),
    listEnvironmentOperationRequests: (limit, status) =>
      commands.listEnvironmentOperationRequests(limit ?? null, status ?? null),
    toolchainDoctor: () => commands.toolchainDoctor(),
    initializeToolchain: (request) => commands.toolchainInitialize(request).then(() => undefined),
    resourceMonitorSnapshot: () => commands.resourceMonitorSnapshot(),
    computeTargetList: () => commands.computeTargetList(),
    remoteConnectionProbe: (request) => commands.remoteConnectionProbe(request),
    configureSshTarget: (request) => commands.configureSshTarget({
      ...request,
      capabilities: [...request.capabilities],
    }),
  };
}
