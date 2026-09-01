import type {
  AuthorityObservationViewV1,
  AuthorityReceiptPageV1,
  AuthorityReceiptSummaryV1,
  AuthorityReferenceViewV1,
  AuthorityInvoke,
} from "./generated/authority";
import { createAuthorityCommands } from "./generated/authority";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AuthorityReference = DeepReadonly<AuthorityReferenceViewV1>;
export type AuthorityObservation = DeepReadonly<AuthorityObservationViewV1>;
export type AuthorityReceipt = DeepReadonly<AuthorityReceiptSummaryV1>;
export type AuthorityReceiptPage = DeepReadonly<AuthorityReceiptPageV1>;
export type AuthorityKind = AuthorityReference["kind"];

export interface AuthorityResolveRequest {
  readonly references: readonly AuthorityReference[];
}

export interface AuthorityReceiptListRequest {
  readonly kind: AuthorityKind;
  readonly cursor: number | null;
  readonly limit: number;
}

export interface AuthorityReadTransport {
  resolveAuthorityRefs(
    request: AuthorityResolveRequest,
  ): Promise<readonly AuthorityObservation[]>;
  listAuthorityReceipts(
    request: AuthorityReceiptListRequest,
  ): Promise<AuthorityReceiptPage>;
}

export function createTauriAuthorityTransport(
  invoke: AuthorityInvoke,
): AuthorityReadTransport {
  const commands = createAuthorityCommands(invoke);
  return {
    resolveAuthorityRefs: async (request) =>
      (await commands.authorityResolveRefs({ references: [...request.references] })).observations,
    listAuthorityReceipts: (request) => commands.authorityListReceipts({ ...request }),
  };
}
