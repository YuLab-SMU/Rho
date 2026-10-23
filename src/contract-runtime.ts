import { Ajv, type ValidateFunction } from 'ajv';
import { operations, responses, errorEnvelope, protocol } from './protocol.js';
import type { RhoInput, RhoMethod, RhoOutput } from './contract.generated.js';
import { isNativeTime } from './native-time.js';

// The one place an untrusted value becomes a typed value.
//
// Ajv compiles exactly the published JSON Schema, so the type predicate below is
// backed by the runtime check that just ran: a caller may not invent a return type
// (`call<T>`), and a request body is `unknown` until this function accepts it. Every
// other boundary — HTTP handling, the Node client, the browser client, dynamic
// discovery — goes through these functions instead of casting.
export const contractAjv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
contractAjv.addFormat('date-time', { type: 'string', validate: isNativeTime });

type Compiled<M extends RhoMethod> = { input: ValidateFunction<RhoInput<M>>; output: ValidateFunction<RhoOutput<M>> };
const compiled = new Map<string, Compiled<RhoMethod>>();

function compilers<M extends RhoMethod>(method: M): Compiled<M> {
  const existing = compiled.get(method);
  if (existing) return existing as Compiled<M>;
  const entry = { input: contractAjv.compile<RhoInput<M>>(operations[method]), output: contractAjv.compile<RhoOutput<M>>(responses[method]) };
  compiled.set(method, entry as unknown as Compiled<RhoMethod>);
  return entry;
}

export type ContractProblem = { path: string; keyword: string; message: string; fix: string };

// A schema path is not advice. Turn the common shapes of refusal into the edit the
// caller should make, so fixing a request does not require reading the JSON Schema.
export function fixFor(error: { instancePath?: string; keyword?: string; params?: Record<string, unknown>; message?: string }): string {
  const field = String(error.instancePath ?? '').replace(/^\//, '').split('/').filter(Boolean).join('.') || 'the request';
  const at = (error.params ?? {}) as Record<string, unknown>;
  switch (error.keyword) {
    case 'required': return `Add "${at.missingProperty}"; ${field === 'the request' ? 'the request' : field} requires it.`;
    case 'dependencies': return `Adding "${at.property}" also requires "${at.missingProperty}".`;
    case 'enum': return `Use one of: ${((at.allowedValues ?? []) as unknown[]).join(', ')}.`;
    case 'const': return `This value must be ${JSON.stringify(at.allowedValue)}.`;
    case 'additionalProperties': return `Remove "${at.additionalProperty}"; it is not part of this body.`;
    case 'pattern': return `"${field}" must match ${String(at.pattern)}.`;
    case 'type': return `"${field}" must be ${String(at.type)}.`;
    case 'oneOf': return `"${field}" must match exactly one accepted shape; each variant may need different fields.`;
    default: return error.message ?? 'The request does not match the schema.';
  }
}

export function explainSchema(errors: readonly { instancePath?: string; keyword?: string; params?: Record<string, unknown>; message?: string }[] | null | undefined): ContractProblem[] {
  return (errors ?? []).slice(0, 8).map(error => ({ path: error.instancePath || '/', keyword: error.keyword ?? 'schema', message: error.message ?? '', fix: fixFor(error) }));
}

export type Validation<M extends RhoMethod> = { ok: true; value: RhoInput<M> } | { ok: false; problems: ContractProblem[] };
export type ResponseValidation<M extends RhoMethod> = { ok: true; value: RhoOutput<M> } | { ok: false; problems: ContractProblem[] };

// `value is RhoInput<M>` is what makes the rest of the code typed: after this call the
// handler receives the operation's input, not a bag of fields.
export function validateRequest<M extends RhoMethod>(method: M, value: unknown): value is RhoInput<M> {
  return compilers(method).input(value);
}
export function readRequest<M extends RhoMethod>(method: M, value: unknown): Validation<M> {
  const validator = compilers(method).input;
  return validator(value) ? { ok: true, value } : { ok: false, problems: explainSchema(validator.errors) };
}
export function validateResponse<M extends RhoMethod>(method: M, value: unknown): value is RhoOutput<M> {
  return compilers(method).output(value);
}
export function readResponse<M extends RhoMethod>(method: M, value: unknown): ResponseValidation<M> {
  const validator = compilers(method).output;
  return validator(value) ? { ok: true, value } : { ok: false, problems: explainSchema(validator.errors) };
}

export const isRhoMethod = (value: string): value is RhoMethod => Object.hasOwn(operations, value);
export const requestProblems = <M extends RhoMethod>(method: M) => explainSchema(compilers(method).input.errors);
export const responseProblems = <M extends RhoMethod>(method: M) => explainSchema(compilers(method).output.errors);

const errorValidator = contractAjv.compile(errorEnvelope);
const eventValidator = contractAjv.compile({ type: 'object', additionalProperties: true, required: protocol.definitions.event.required, properties: protocol.definitions.event.properties });
export function validateErrorEnvelope(value: unknown): boolean { return errorValidator(value); }
export function validateEvent(value: unknown): boolean { return eventValidator(value); }
export const errorProblems = () => explainSchema(errorValidator.errors);
export const eventProblems = () => explainSchema(eventValidator.errors);
