import {
  createRuntimeCommands,
  type RuntimeBindingV1 as GeneratedRuntimeBinding,
  type RuntimeCreateRequestV1 as GeneratedRuntimeCreateRequest,
  type RuntimeDescriptorV1 as GeneratedRuntimeDescriptor,
  type RuntimeExecuteRequestV1_Deserialize as GeneratedRuntimeExecuteRequest,
  type RuntimeExecutionSourceContextV1 as GeneratedRuntimeExecutionSourceContext,
  type RuntimeExecutionSourceRangeV1 as GeneratedRuntimeExecutionSourceRange,
  type RuntimeExecutionStartResponse as GeneratedRuntimeExecutionStartResponse,
  type RuntimeInstanceRequestV1 as GeneratedRuntimeInstanceRequest,
  type RuntimePersistenceClassV1,
  type RuntimeProviderDefinitionV1 as GeneratedRuntimeProviderDefinition,
  type RuntimeProviderRegistrationV1 as GeneratedRuntimeProviderRegistration,
  type RuntimeRegistrySnapshotV1 as GeneratedRuntimeRegistrySnapshot,
  type RuntimeStatusV1,
  type RuntimeInvoke,
} from "./generated/runtime";
import type { RuntimeExecution } from "./runtime-output";

export type RuntimeStatus = RuntimeStatusV1;
export type RuntimePersistenceClass = RuntimePersistenceClassV1;

export type RuntimeBinding = Omit<Readonly<GeneratedRuntimeBinding>, "attach_capabilities"> & {
  readonly attach_capabilities: readonly string[];
};

export type RuntimeDescriptor = Omit<
  Readonly<GeneratedRuntimeDescriptor>,
  "attach_capabilities"
> & {
  readonly attach_capabilities: readonly string[];
};

export type RuntimeProviderDefinition = Omit<
  Readonly<GeneratedRuntimeProviderDefinition>,
  "attach_capabilities"
> & {
  readonly attach_capabilities: readonly string[];
};

export type RuntimeProviderRegistration = Omit<
  Readonly<GeneratedRuntimeProviderRegistration>,
  "definition"
> & {
  readonly definition: RuntimeProviderDefinition;
};

export type RuntimeRegistrySnapshot = Omit<
  Readonly<GeneratedRuntimeRegistrySnapshot>,
  "contract" | "contract_major" | "providers" | "instances"
> & {
  readonly contract: "rho.ui.runtime-registry.snapshot.v1";
  readonly contract_major: 1;
  readonly providers: readonly RuntimeProviderRegistration[];
  readonly instances: readonly RuntimeDescriptor[];
};

export type RuntimeCreateRequest = Readonly<GeneratedRuntimeCreateRequest>;
export type RuntimeInstanceRequest = Readonly<GeneratedRuntimeInstanceRequest>;
export type RuntimeExecutionSourceRange = Readonly<GeneratedRuntimeExecutionSourceRange>;
export type RuntimeExecutionSourceContext = Omit<
  Readonly<GeneratedRuntimeExecutionSourceContext>,
  "execution_mode" | "source_range"
> & {
  readonly execution_mode: "selection" | "expression";
  readonly source_range: RuntimeExecutionSourceRange;
};
export type RuntimeExecuteRequest = Omit<
  Readonly<GeneratedRuntimeExecuteRequest>,
  "source_context"
> & {
  readonly source_context?: RuntimeExecutionSourceContext | null;
};
export type RuntimeExecutionStartResponse = Omit<
  Readonly<GeneratedRuntimeExecutionStartResponse>,
  "execution"
> & {
  readonly execution: RuntimeExecution;
};

export interface RuntimeTransport {
  loadRuntimes(): Promise<RuntimeRegistrySnapshot>;
  createRuntime(request: RuntimeCreateRequest): Promise<RuntimeRegistrySnapshot>;
  interruptRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  restartRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  stopRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  startRuntimeExecution(request: RuntimeExecuteRequest): Promise<RuntimeExecutionStartResponse>;
}

function checkedRuntimeSnapshot(snapshot: GeneratedRuntimeRegistrySnapshot): RuntimeRegistrySnapshot {
  if (
    snapshot.contract !== "rho.ui.runtime-registry.snapshot.v1" ||
    snapshot.contract_major !== 1
  ) {
    throw new Error("Runtime Registry returned an unsupported contract version.");
  }
  return snapshot as RuntimeRegistrySnapshot;
}

export function createTauriRuntimeTransport(invoke: RuntimeInvoke): RuntimeTransport {
  const commands = createRuntimeCommands(invoke);
  return {
    loadRuntimes: () => commands.runtimeList().then(checkedRuntimeSnapshot),
    createRuntime: (request) => commands.runtimeCreate(request).then(checkedRuntimeSnapshot),
    interruptRuntime: (request) => (
      commands.runtimeInterrupt(request).then(checkedRuntimeSnapshot)
    ),
    restartRuntime: (request) => commands.runtimeRestart(request).then(checkedRuntimeSnapshot),
    stopRuntime: (request) => commands.runtimeStop(request).then(checkedRuntimeSnapshot),
    startRuntimeExecution: commands.runtimeExecutionStart,
  };
}
