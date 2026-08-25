import {
  createEvidenceCommands,
  type EvidenceClaim as EvidenceClaimWire,
  type EvidenceInvoke,
} from "./generated/evidence";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type EvidenceClaim = DeepReadonly<EvidenceClaimWire>;

export interface EvidenceReadTransport {
  listEvidenceClaims(limit?: number): Promise<readonly EvidenceClaim[]>;
}

export function createTauriEvidenceReadTransport(invoke: EvidenceInvoke): EvidenceReadTransport {
  const commands = createEvidenceCommands(invoke);
  return {
    listEvidenceClaims: (limit) => commands.listEvidenceClaims(limit ?? null),
  };
}
