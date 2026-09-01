import {
  createEnvironmentCommands,
  type EnvironmentInvoke,
  type EnvironmentHealthViewV1 as EnvironmentHealthViewWire,
} from "./generated/environment";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type EnvironmentHealthView = DeepReadonly<EnvironmentHealthViewWire>;

export interface EnvironmentReadTransport {
  environmentHealth(): Promise<EnvironmentHealthView>;
  reobserveEnvironment(): Promise<EnvironmentHealthView>;
}

export function createTauriEnvironmentReadTransport(
  invoke: EnvironmentInvoke,
): EnvironmentReadTransport {
  const commands = createEnvironmentCommands(invoke);
  return {
    environmentHealth: () => commands.environmentHealth(),
    reobserveEnvironment: () => commands.environmentReobserve(),
  };
}
