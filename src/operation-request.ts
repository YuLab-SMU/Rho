import type { RhoInput, RhoMethod } from './contract.generated.js';
import { isRhoMethod, readRequest, type ContractProblem } from './contract-runtime.js';

// A request that has passed the published schema, as a discriminated union.
//
// The union is what makes the service's dispatch typed without rewriting it: after
// `if (request.method === 'document.read')` TypeScript narrows the whole value, so
// `request.body` is exactly that operation's input type. No caller-chosen generic,
// no `any` and no cast is involved: the only way to build one is `readOperation`,
// which validates against the same JSON Schema Ajv enforces at runtime.
export type OperationRequest = { [M in RhoMethod]: { method: M; body: RhoInput<M> } }[RhoMethod];
export type Rejection = { ok: false; problems: ContractProblem[] };
export type Acceptance = { ok: true; request: OperationRequest };

// A wire method name is only a string until it is checked against the contract. This
// function is the single place that correlation happens: the pair is returned only
// when the name is published and the body matches that operation's schema.
export function readOperation(method: string, value: unknown): { ok: true; request: OperationRequest } | Rejection & { kind: 'invalid' | 'not_found' } {
  if (!isRhoMethod(method)) return { ok: false, problems: [{ path: '/', keyword: 'not_found', message: `Unknown API operation "${method}".`, fix: 'Call protocol.describe for the accepted method names.' }], kind: 'not_found' };
  const read = readRequest(method, value);
  return read.ok ? { ok: true, request: { method, body: read.value } as OperationRequest } : { ...read, kind: 'invalid' };
}
export function operationRequest<M extends RhoMethod>(method: M, body: RhoInput<M>): { method: M; body: RhoInput<M> } { return { method, body }; }
