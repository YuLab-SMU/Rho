import { requirementsSchema } from '@rho-workspace/plugin-contracts/requirements';
import { executionInputSchema } from '@rho-workspace/plugin-contracts/execution';
import { objectSchema as obj, text, refSchema as ref, declarationSchema } from '@rho-workspace/plugin-contracts';
import { protocol as v1 } from './legacy-protocol.js';
const base = structuredClone(v1);
const project = { projectId: base.operations['capability.list'].properties.projectId };
const op = { ...project, operationId: base.operations['action.lookup'].properties.operationId };
const positive = { type: 'integer', minimum: 1 };
const integer = { type: 'integer', minimum: 0 };
const record = { type: 'object' };
const array = (items: any) => ({ type: 'array', items });
const response = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
export const operations: Record<string, any> = { ...base.operations,
  'requirements.check': obj({ ...project, requirements: requirementsSchema }),
  'requirements.prepare': obj({ ...op, requirements: requirementsSchema }),
  'action.submit': obj({ ...op, action: { const: 'r.execute' }, actionVersion: { const: '0.2.0' }, input: executionInputSchema }),
  'resource.register': obj({ ...project, declaration: declarationSchema, expectedDigest: ref.properties.version }),
  'data.plot': obj({ ...project, resource: ref, x: text, y: text, maxPoints: positive }, ['projectId', 'resource', 'x', 'y']),
  'data.compare': obj({ ...project, left: ref, right: ref, options: obj({ leftKey: text, rightKey: text, leftNamespace: text, rightNamespace: text, mapping: { const: 'equal-string' }, leftField: text, rightField: text, join: { enum: ['left', 'inner', 'full'] } }) }),
  'object.read': obj({ ...project, resource: ref }),
  'media.describe': obj({ ...project, resource: ref })
};
operations['context.create'].properties.region = obj({ page: positive, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 }, units: { enum: ['pixels', 'points'] } });
operations['session.grant'].properties.methods.items = { enum: Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('project.')) };
export const resourceSchema = { ...base.definitions.resource, additionalProperties: true, properties: { ...base.definitions.resource.properties, kind: { enum: ['file', 'table', 'media', 'object', 'plot', 'model'] }, format: { anyOf: [record, { type: 'string' }] } } };
const retainedPlan: any = base.definitions.run.properties.plan;
export const runSchema = { ...base.definitions.run, properties: { ...base.definitions.run.properties, plan: { ...retainedPlan, properties: { ...retainedPlan.properties, completion: { type: ['string', 'null'] } } } } };
const selection = { ...base.definitions.selection, properties: { ...base.definitions.selection.properties, namespace: text } };
const definitions = { ...base.definitions, run: runSchema, resource: resourceSchema, selection, declaration: declarationSchema, executionInput: executionInputSchema, requirements: requirementsSchema };
const artifactFacts = response({ integrity: record, domain: record, resources: array(resourceSchema) }, ['integrity', 'domain']);
export const responses: Record<string, any> = { ...base.responses,
  'protocol.describe': response({ apiVersion: { const: '2.0' }, schemaVersion: { const: 2 }, operations: record, definitions: record, responses: record }),
  'requirements.check': response({ requirements: requirementsSchema, checkedAt: text, environment: record, native: record, status: { enum: ['present', 'missing', 'unknown'] }, checkId: ref.properties.version }),
  'resource.register': resourceSchema, 'resource.list': artifactFacts, 'artifact.check': artifactFacts,
  'resource.read': response({ resource: resourceSchema, encoding: { const: 'base64' }, data: { type: 'string' }, offset: integer, nextOffset: integer, more: { type: 'boolean' } }),
  'data.page': { ...base.responses['data.page'], properties: { ...base.responses['data.page'].properties, resource: resourceSchema, namespace: { type: ['string', 'null'] } } },
  'data.plot': { ...base.responses['data.plot'], properties: { ...base.responses['data.plot'].properties, resource: resourceSchema } },
  'data.compare': resourceSchema,
  'selection.set': selection,
  'object.read': response({ resource: resourceSchema, observation: { const: 'exported-snapshot' }, value: {} }),
  'media.describe': response({ resource: resourceSchema, original: ref, mimeType: text, rendering: { const: 'unavailable' } }),
  'workspace.save': { ...base.responses['workspace.save'], properties: { ...base.responses['workspace.save'].properties, schemaVersion: { const: 2 }, selection: { anyOf: [selection, { type: 'null' }] } } },
  'observation.snapshot': { ...base.responses['observation.snapshot'], properties: { ...base.responses['observation.snapshot'].properties, resources: array(resourceSchema), operations: array(runSchema), selection: { anyOf: [selection, { type: 'null' }] } } }
};
for (const method of ['requirements.prepare', 'action.submit', 'action.lookup', 'action.observe', 'action.retry', 'action.cancel']) responses[method] = runSchema;
responses['action.list'] = array(runSchema);
export const descriptions = { ...base.descriptions,
  'action.submit': 'Execute the explicitly selected project R script snapshot and requirements. Persist operationId before delivery; identical retries retain the original Core identity. Output directory is the first R argument, followed by explicit args or frozen resource paths. Artifact paths are output-relative; completion is run-directory-relative, returned as plan.completion, so an inventory can remain beside immutable producer artifacts.',
  'resource.register': 'Declare scoped existing bytes and their type/schema at the supplied digest. This read and registration starts no runtime.',
  'requirements.check': 'Probe only the explicitly declared R packages with bounded base R; no Core Host or project script starts.',
  'data.compare': 'Join two explicit table versions using declared keys, namespaces, fields and join policy. Scientific comparability remains the project responsibility.',
  'object.read': 'Read a bounded exported JSON object snapshot, not live R memory.',
  'artifact.check': 'Verify the selected completion inventory and file bytes only; domain check reports remain project resources.'
};
export const errorKinds = base.errorKinds;
export const errorSchema = base.definitions.error;
export const errorEnvelope = obj({ apiVersion: { const: '2.0' }, ok: { const: false }, error: errorSchema });
export const responseEnvelope = (method: string) => obj({ apiVersion: { const: '2.0' }, ok: { const: true }, value: responses[method] });
export const protocol = { ...base, apiVersion: '2.0', schemaVersion: 2, transport: 'HTTP JSON POST /api/v2/{operation}; GET /api/v2/events', operations, responses, descriptions, definitions, errorEnvelope, legacy: 'v1 schemas and captured fixtures are frozen. Legacy reads and explicit retry/cancel of accepted requests remain available; new recipe submissions require an explicit v2 project script.' };
