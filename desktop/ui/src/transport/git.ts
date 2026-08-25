import {
  createGitCommands,
  type GitInvoke,
  type GitLogEntry as GitLogEntryWire,
  type GitStatus as GitStatusWire,
} from "./generated/git";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type GitStatus = DeepReadonly<GitStatusWire>;
export type GitLogEntry = DeepReadonly<GitLogEntryWire>;

export interface GitReadTransport {
  status(): Promise<GitStatus>;
  log(limit?: number): Promise<readonly GitLogEntry[]>;
}

export function createTauriGitReadTransport(invoke: GitInvoke): GitReadTransport {
  const commands = createGitCommands(invoke);
  return {
    status: commands.gitStatus,
    log: (limit) => commands.gitLog(limit ?? null),
  };
}
