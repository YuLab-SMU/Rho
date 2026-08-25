import {
  createKernelCommands,
  type AppInfo as AppInfoWire,
  type ActiveOperationStateV1,
  type ActiveOperationV1,
  type CommandAvailabilityV1,
  type CommandDefinitionV1,
  type CommandPlacementTagV1,
  type CommandRegistrationV1,
  type HealthStateV1,
  type KernelInvoke,
  type SetUiSelectionRequest as SetUiSelectionRequestWire,
  type UiContextV1,
  type UiKernelSnapshotV1,
  type UiSelectionV1,
} from "./generated/kernel";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type HealthState = HealthStateV1;
export type ActiveOperationState = ActiveOperationStateV1;
export type CommandPlacementTag = CommandPlacementTagV1;
export type ActiveOperation = DeepReadonly<ActiveOperationV1>;
export type UiSelection = DeepReadonly<UiSelectionV1>;
export type UiContext = DeepReadonly<UiContextV1>;
export type CommandDefinition = DeepReadonly<CommandDefinitionV1>;
export type CommandAvailability = DeepReadonly<CommandAvailabilityV1>;
export type CommandRegistration = DeepReadonly<CommandRegistrationV1>;
export type SetUiSelectionRequest = DeepReadonly<SetUiSelectionRequestWire>;
export type AppInfo = DeepReadonly<AppInfoWire>;

export type UiKernelSnapshot = Omit<
  DeepReadonly<UiKernelSnapshotV1>,
  "contract" | "contract_major"
> & {
  readonly contract: "rho.ui.kernel.snapshot.v1";
  readonly contract_major: 1;
};

export interface KernelTransport {
  appInfo(): Promise<AppInfo>;
  loadSnapshot(): Promise<UiKernelSnapshot>;
  setSelection(request: SetUiSelectionRequest): Promise<UiKernelSnapshot>;
}

function snapshotFromWire(snapshot: UiKernelSnapshotV1): UiKernelSnapshot {
  if (snapshot.contract !== "rho.ui.kernel.snapshot.v1" || snapshot.contract_major !== 1) {
    throw new Error(
      `Unsupported UI Kernel contract: ${snapshot.contract} major ${snapshot.contract_major}`,
    );
  }
  return snapshot as UiKernelSnapshot;
}

export function createTauriKernelTransport(invoke: KernelInvoke): KernelTransport {
  const commands = createKernelCommands(invoke);
  return {
    appInfo: () => commands.appInfo(),
    loadSnapshot: async () => snapshotFromWire(await commands.uiKernelSnapshot()),
    setSelection: async (request) => snapshotFromWire(
      await commands.uiSetSelection(request),
    ),
  };
}
