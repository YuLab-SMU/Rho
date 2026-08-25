import {
  createEnvironmentCommands,
  type EnvironmentInvoke,
  type EnvironmentOperationRequestSummary as EnvironmentOperationRequestSummaryWire,
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

export interface EnvironmentReadTransport {
  listInstalledPackages(limit?: number): Promise<unknown>;
  listEnvironmentOperationRequests(
    limit?: number,
    status?: string | null,
  ): Promise<readonly EnvironmentOperationRequestSummary[]>;
}

export function createTauriEnvironmentReadTransport(
  invoke: EnvironmentInvoke,
): EnvironmentReadTransport {
  const commands = createEnvironmentCommands(invoke);
  return {
    listInstalledPackages: (limit) => commands.listInstalledPackages(limit ?? null),
    listEnvironmentOperationRequests: (limit, status) =>
      commands.listEnvironmentOperationRequests(limit ?? null, status ?? null),
  };
}
