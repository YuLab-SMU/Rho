import { ownerContracts } from './contracts/owners.generated.js';
import { enhancementSchemas } from './enhancement-contracts.js';
import { discoverySchemas } from './discovery-contracts.js';
import { presentationSchemas } from './presentation-contracts.js';
import * as contract from './response-contracts.js';
import { objectSchema as obj, text, refSchema as ref } from '@rho-workspace/plugin-contracts';
import { routeSchemas } from './task-routing-contract.js';
import { baseProtocol } from './protocol-base.js';
import { projectWorkSchema } from './work-contract.js';
const base = structuredClone(baseProtocol);

// ---------------------------------------------------------------------------
// Owner-declared operations.
//
// Each functional component owns the schema of every operation it declares. Rho
// keeps no second copy: the snapshot in contracts/owners.generated.ts is derived
// from the owner package's pure contract entry (source identity and entry digest
// recorded there), and this file adds only what the application actually owns —
// the project every request is scoped to.
// ---------------------------------------------------------------------------
type JsonSchema = { [key: string]: unknown };
interface OwnerOperationContract { inputSchema: JsonSchema; outputSchema: JsonSchema; requires: string[]; effect: string }
const ownerSchema = (id: string, name: string): JsonSchema => ownerContracts.selected[id][name] as JsonSchema;
const ownerSchemaRecord = (id: string, name: string): Record<string, JsonSchema> => ownerContracts.selected[id][name] as Record<string, JsonSchema>;

const project = { projectId: base.operations['capability.list'].properties.projectId };
const op = { ...project, operationId: base.operations['action.lookup'].properties.operationId };
const positive = { type: 'integer', minimum: 1 };
const integer = { type: 'integer', minimum: 0 };
const record = { type: 'object' };
const array = (items: any) => ({ type: 'array', items });
const response = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
const changeId = { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$' };
const identity = changeId;
const agentBackend = { enum: ['claude-acp', 'codex-acp'] };
const choiceText = { type: 'string', minLength: 1, maxLength: 512 }, choiceValue = { anyOf: [choiceText, { type: 'boolean' }] };
const choices = { type: 'object', maxProperties: 12, propertyNames: { maxLength: 512 }, additionalProperties: choiceValue };
const digest = ref.properties.version;

// The application's scope is the one field every owner operation gains here. Owner
// inputs keep their own additionalProperties/required meaning; only the project
// identity and its requirement are added, exactly as a caller supplies them.
function scoped(input: JsonSchema): JsonSchema {
  const properties = (input.properties ?? {}) as Record<string, JsonSchema>;
  const required = (input.required as string[] | undefined) ?? Object.keys(properties);
  return { ...input, properties: { ...project, ...properties }, required: ['projectId', ...required.filter(name => name !== 'projectId')] };
}

const ownerOperations: Record<string, OwnerOperationContract> = {};
for (const owner of ['documents', 'files', 'r', 'requirements', 'tables', 'media', 'charts', 'agent']) {
  for (const [method, contract] of Object.entries(ownerSchemaRecord(owner, 'operationContracts') as unknown as Record<string, OwnerOperationContract>)) {
    ownerOperations[method] = contract;
  }
}

export const operations: Record<string, any> = { ...base.operations,
  'protocol.describe': obj({ ...project, method: text, cursor: { type: ['string', 'null'], maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, maxBytes: { type: 'integer', minimum: 1024, maximum: 65536 } }, []),
  'project.pick': obj({}),
  'project.source.pick': obj({}),
  'project.source.add': obj(project),
  'project.createWorkspace': obj({ name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' }, selectionIds: { type: 'array', items: text, minItems: 1, maxItems: 32, uniqueItems: true }, changeId: text }),
  'project.create': obj({ name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^/\\\\]+$', not: { enum: ['.', '..', '.rho', '.git'] } } }),
  // The person's own view of their selected folders: bounded one-level entries and
  // opening one text file as a document in front of them.
  'project.entries': obj({ ...project, path: { type: 'string', minLength: 1, maxLength: 1024 } }, ['projectId']),
  'project.openFile': obj({ ...project, path: { type: 'string', minLength: 1, maxLength: 1024 }, compositionId: text, expectedVersion: integer, changeId: text }),
  // What this project is running: a bounded summary a person may read.
  'project.runs': obj({ ...project, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['projectId']),
  'project.work.read': obj({ ...project, limit: { type: 'integer', minimum: 1, maximum: 8 } }, ['projectId']),
  // One run as ordinary files in a new folder, with where they came from and what was checked.
  'action.export': obj({ ...op, destination: { type: 'string', minLength: 1, maxLength: 240 }, unsaved: { enum: ['leave', 'include'] } }, ['projectId', 'operationId']),
  // Dry run: check a body against an operation's schema without doing anything.
  'protocol.validate': obj({ method: text, body: record }),
  'project.doctor': obj({ ...project, intent: { enum: ['run-r', 'edit-documents', 'inspect-tables', 'present'] } }, ['projectId']),
  'session.browser.pair': obj({ path: text }, []),
  'session.browser.revoke': obj({ sessionId: text }),
  'capability.configure': obj({ ...project, expectedVersion: integer, changeId: text, enabled: { type: 'array', items: text, maxItems: 32, uniqueItems: true } }),
  'skill.list': obj(project),
  'skill.read': obj({ ...project, skillId: text, expectedDigest: { anyOf: [ref.properties.version, { type: 'null' }] } }, ['projectId', 'skillId']),
  'data.plot': obj({ ...project, resource: ref, x: text, y: text, maxPoints: positive }, ['projectId', 'resource', 'x', 'y']),
  'data.compare': obj({ ...project, left: ref, right: ref, options: obj({ leftKey: text, rightKey: text, leftNamespace: text, rightNamespace: text, mapping: { const: 'equal-string' }, leftField: text, rightField: text, join: { enum: ['left', 'inner', 'full'] } }) }),
  'media.describe': obj({ ...project, resource: ref }),
  // A conversation the person starts in Rho: their words, under a request identity they hold.
  'conversation.start': obj({ ...project, changeId, text: { type: 'string', minLength: 1, maxLength: 16384 }, backend: agentBackend, config: choices }, ['projectId', 'changeId', 'text']),
  'conversation.send': obj({ ...project, conversationId: changeId, changeId, text: { type: 'string', minLength: 1, maxLength: 16384 } }),
  'conversation.permission': obj({ ...project, conversationId: changeId, turnId: changeId, permissionId: changeId, optionId: { type: 'string', minLength: 1, maxLength: 256 } }),
  'conversation.stop': obj({ ...project, conversationId: changeId, turnId: changeId }),
  'conversation.read': obj({ ...project, conversationId: changeId, before: integer, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['projectId', 'conversationId']),
  'conversation.list': obj({ ...project, trashed: { type: 'boolean' } }, ['projectId']),
  'conversation.trash': obj({ ...project, conversationId: changeId }),
  'conversation.restore': obj({ ...project, conversationId: changeId }),
  'conversation.delete': obj({ ...project, conversationId: changeId }),
  // The person's Agent and its settings (model, effort, mode…) among those the Agent offers.
  'conversation.configure': obj({ ...project, conversationId: changeId, configId: choiceText, value: choiceValue }),
  'conversation.settings.read': obj(project),
  'conversation.settings.update': obj({ ...project, expectedVersion: integer, backend: { anyOf: [agentBackend, { type: 'null' }] }, choices: obj({ 'claude-acp': choices, 'codex-acp': choices }, []) }, ['projectId', 'expectedVersion']),
  'conversation.settings.check': obj({ ...project, backend: agentBackend })
};

// Every owner-declared operation and response comes from the snapshot, scoped once.
for (const [method, contract] of Object.entries(ownerOperations)) operations[method] = scoped(contract.inputSchema);
for (const [method, schema] of Object.entries(ownerSchemaRecord('annotations', 'inputs'))) operations[method] = scoped(schema);


const condition = { ...project, compositionId: changeId, expectedVersion: integer, changeId };
const view = { ...base.operations['composition.put'].properties.views.items, additionalProperties: false };
view.properties.bindings = { type: 'object', additionalProperties: { oneOf: [ref, obj({ documentId: ref.properties.version, version: positive }), obj({ kind: { const: 'live-document' }, documentId: ref.properties.version })] } };
operations['composition.put'].properties.views.items = view;
view.properties.presentation = obj({ emphasis: { enum: ['normal', 'highlight'] } });
const node = { oneOf: [obj({ id: changeId, kind: { const: 'group' }, children: { ...array(changeId), maxItems: 256, uniqueItems: true }, presentation: presentationSchemas.GroupPresentation }, ['id', 'kind', 'children']), obj({ ...view.properties, kind: { const: 'view' }, protected: { type: 'boolean' } }, [...view.required, 'kind'])] };
const applyOperation = { oneOf: [
  obj({ op: { const: 'replace' }, rootId: changeId, nodes: { ...array(node), minItems: 1, maxItems: 256 } }),
  obj({ op: { const: 'insert' }, parentId: changeId, index: integer, node }),
  obj({ op: { const: 'move' }, id: changeId, parentId: changeId, index: integer }),
  obj({ op: { const: 'remove' }, id: changeId }),
  obj({ op: { const: 'props' }, id: changeId, props: record }),
  obj({ op: { const: 'bind' }, id: changeId, bindings: view.properties.bindings })
] };
operations['composition.apply'] = obj({ ...condition, operations: { ...array(applyOperation), minItems: 1, maxItems: 256 } });
operations['composition.undo'] = obj(condition);
operations['view.protection.set'] = obj({ ...condition, viewId: changeId, protected: { type: 'boolean' } });
operations['view.close'] = obj({ ...operations['view.close'].properties, changeId }, operations['view.close'].required);
const selectionScope = { oneOf: [obj({ kind: { const: 'caller' } }), obj({ kind: { enum: ['view', 'shared'] }, id: changeId })] };
const documentRange = obj({ documentId: text, version: positive, from: integer, to: integer });
operations['interaction.selection.read'] = obj({ ...project, scope: selectionScope });
operations['interaction.selection.set'] = obj({ ...project, scope: selectionScope, expectedVersion: integer, changeId, selection: { oneOf: [obj({ document: documentRange }), obj({ resource: ref, entities: { ...array(text), minItems: 1, maxItems: 1024, uniqueItems: true } }), { type: 'null' }] } });
// Task map: the words are the Agent's. Kinds, states, tones, roles and form names
// are open identifiers; schemas bound only their shape and size.
// The Agent's words may be any script; prototype keys are refused.
const word = { type: 'string', minLength: 1, maxLength: 64, pattern: '^\\S+$', not: { enum: ['__proto__', 'constructor', 'prototype'] } };
const hint = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' };
const phrase = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const term = obj({ label: phrase(80), tone: hint, role: hint, icon: hint, description: phrase(240) }, ['label']);
const terms = { type: 'object', maxProperties: 64, propertyNames: word, additionalProperties: { anyOf: [term, { type: 'null' }] } };
const mapTarget = { type: 'string', pattern: '^(map:[a-z0-9-]{1,32}|item:[A-Za-z0-9._:@-]{1,128})$' };
const formParams = { type: 'object', maxProperties: 16 };
const taskItem = obj({ id: changeId, kind: word, state: word, title: phrase(160), group: phrase(60), summary: phrase(280),
  lines: { ...array(obj({ label: phrase(40), text: phrase(280), tone: hint, judgment: { type: 'boolean' } }, ['text'])), maxItems: 12 },
  progress: obj({ done: integer, total: positive, unit: phrase(24) }, ['done']), view: changeId,
  // The exact artifact version this item produced or works on. An item may name an
  // artifact that is registered later; the shell resolves it before drawing a link
  // and never guesses which artifact an item meant.
  artifact: obj({ id: text, version: digest }, ['id', 'version']),
  from: { ...array(changeId), maxItems: 16, uniqueItems: true } }, ['id', 'kind', 'state', 'title']);
operations['task.map.read'] = obj(project);
operations['task.map.declare'] = obj({ ...project, expectedVersion: integer, changeId, question: { anyOf: [phrase(240), { type: 'null' }] }, compositionId: { anyOf: [changeId, { type: 'null' }] }, vocabulary: obj({ kinds: terms, states: terms }, []), items: { ...array(taskItem), maxItems: 256 }, remove: { ...array(changeId), maxItems: 256, uniqueItems: true }, next: { ...array(changeId), maxItems: 16, uniqueItems: true } }, ['projectId', 'expectedVersion', 'changeId']);
operations['task.map.present'] = obj({ ...project, expectedVersion: integer, changeId, target: mapTarget, form: hint, params: formParams, focus: { anyOf: [changeId, { type: 'null' }] }, reason: phrase(160) }, ['projectId', 'expectedVersion', 'changeId', 'target']);
operations['task.map.respond'] = obj({ ...project, expectedVersion: integer, changeId, target: mapTarget, action: { enum: ['pin', 'unpin', 'revert', 'accept', 'dismiss'] }, form: hint, params: formParams, suggestionId: changeId }, ['projectId', 'expectedVersion', 'changeId', 'target', 'action']);
operations['context.create'] = obj({ ...operations['context.create'].properties, annotations: { ...array(obj({ annotationId: changeId, version: positive })), minItems: 1, maxItems: 128 }, changeId, expectedVersion: { const: 0 } }, ['projectId']);
for (const method of ['workspace.save', 'workspace.export']) operations[method] = obj({ ...operations[method].properties, format: { enum: [1, 2, 3] } }, operations[method].required);
operations['context.create'].properties.region = obj({ page: positive, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 }, units: { enum: ['pixels', 'points'] } });
// Application refinements of owner operations keep their owner schema and add the
// one relation this application enforces.
operations['binding.activity'] = { ...operations['binding.activity'], required: ['projectId'], allOf: [{ if: { required: ['source'] }, then: { required: ['source', 'taskId', 'query'] }, else: { not: { anyOf: [{ required: ['taskId'] }, { required: ['query'] }] } } }] };
operations['view.observe'] = presentationSchemas.VisibilityInput;
operations['view.observations.read'] = presentationSchemas.VisibilityReadInput;
for (const [method, schema] of Object.entries({ 'workspace.observe': enhancementSchemas.PresentationReadInput, 'workspace.enhance': enhancementSchemas.EnhanceInput, 'capability.index': discoverySchemas.IndexInput, 'capability.resolve': discoverySchemas.ResolveInput })) operations[method] = schema;
operations['task.routing.put'] = { ...routeSchemas.RouteInput };
operations['session.grant'].properties.profile = { enum: ['layered-business', 'layered-presentation'] };
operations['session.grant'].properties.methods.items = { enum: Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('conversation.') && (!m.startsWith('project.') || m === 'project.entries')).sort() };

const documentSchema = ownerSchema('documents', 'documentSchema');
const documentSummarySchema = ownerSchema('documents', 'documentSummarySchema');
// A registered resource's format is the declaration's format: owner-specific and
// therefore open by key, but every declared media field is named so a consumer can
// read it without guessing.
const resourceFormat = { type: 'object', properties: { mimeType: text, encoding: text, observation: text, columns: array(record), key: { anyOf: [record, { type: 'null' }] }, classes: array(text), pages: positive, width: { type: 'number' }, height: { type: 'number' } }, additionalProperties: true };
export const resourceSchema = { ...base.definitions.resource, additionalProperties: true, properties: { ...base.definitions.resource.properties, kind: { enum: ['file', 'table', 'media', 'object', 'plot', 'model'] }, format: { anyOf: [resourceFormat, { type: 'string' }] } } };
const retainedPlan: any = base.definitions.run.properties.plan;
// A retained run reports exactly what the execution bridge keeps: the original
// request digest and body, the Core identity, distinct delivery/execution facts and
// the bounded native/usage reports. Open payloads stay open where the owner owns
// them (native, interpretation, provenance); required facts stay required.
export const runSchema = { ...base.definitions.run, additionalProperties: false, properties: {
  ...base.definitions.run.properties,
  request: { type: 'object', additionalProperties: true },
  core: obj({ caller: identity, requestId: identity }, ['caller', 'requestId']),
  native: { anyOf: [contract.nativeRunSchema, { type: 'null' }] },
  integrity: contract.integrityReportSchema,
  domain: contract.domainReportSchema,
  interpretation: { type: 'object', additionalProperties: true },
  plan: { ...retainedPlan, properties: { ...retainedPlan.properties, source: contract.planSourceSchema, completion: { type: ['string', 'null'] } } },
  lastCli: contract.cliSchema,
  checks: contract.checkSchema,
  cancellation: contract.cancellationSchema
} };
const selection = { ...base.definitions.selection, properties: { ...base.definitions.selection.properties, namespace: text } };
const definitions = { ...base.definitions, document: documentSchema, run: runSchema, resource: resourceSchema, selection, declaration: ownerSchema('entry-files', 'declarationSchema'), executionInput: ownerSchema('execution', 'input'), requirements: ownerSchema('entry-requirements', 'requirementsSchema') };
const artifactFacts = response({ integrity: contract.integrityReportSchema, domain: contract.domainReportSchema, resources: array(resourceSchema) }, ['integrity', 'domain']);

// Layer one: every operation an owner declares takes that owner's response schema.
// Layer two: the application adds the facts Rho itself puts in the reply. Writing it
// in this order means an owner's schema is never silently replaced by a Rho copy,
// and an application override is always visible as such.
const ownerResponses: Record<string, any> = {};
for (const [method, ownerContract] of Object.entries(ownerOperations)) ownerResponses[method] = ownerContract.outputSchema;
for (const [method, schema] of Object.entries(ownerSchemaRecord('annotations', 'outputs'))) ownerResponses[method] = schema;

const catalog = { ...contract.capabilityCatalogSchema };
// A conversation started in Rho and one of its messages: the person's words, the Agent's visible
// text and tool steps in order, and how the message ended. Hidden reasoning is never kept.
// A list reads a conversation from its summary: the Agent's own title for the session, the
// Agent and adapter, the last model, the person's choices, reported usage and cost, the session
// identity and whether it is in the trash.
const conversationSummary = response({ conversationId: text, title: text, client: text, principal: { anyOf: [text, { type: 'null' }] }, createdAt: text, updatedAt: text, version: integer, turns: integer, state: { enum: ['idle', 'running', 'completed', 'failed', 'stopped', 'unknown'] }, lastAt: text,
  backend: text, agentTitle: { anyOf: [text, { type: 'null' }] }, adapter: { anyOf: [response({ name: text, version: text }, ['name']), { type: 'null' }] }, model: { anyOf: [text, { type: 'null' }] }, config: choices,
  usage: { anyOf: [response({ used: { type: 'number', minimum: 0 }, size: { type: 'number', minimum: 0 }, cost: { anyOf: [response({ amount: { type: 'number' }, currency: text }), { type: 'null' }] } }), { type: 'null' }] },
  costUsd: { anyOf: [{ type: 'number' }, { type: 'null' }] }, sessionId: { anyOf: [text, { type: 'null' }] }, trashedAt: { anyOf: [text, { type: 'null' }] } },
  ['conversationId', 'title', 'client', 'principal', 'createdAt', 'updatedAt', 'version', 'turns', 'state', 'lastAt']);
const sessionObservation = ownerSchema('agent-session', 'sessionObservationSchema');
// What one Agent offered, from a check or a conversation's first session, and the person's choices.
const offered = response({ at: text, source: { enum: ['check', 'conversation'] }, adapter: { anyOf: [response({ name: text, version: text }, ['name']), { type: 'null' }] }, options: array(ownerSchema('agent-session', 'configOptionSchema')), omitted: integer });
const agentSettings = response({ version: integer, updatedAt: { anyOf: [text, { type: 'null' }] }, backend: { anyOf: [agentBackend, { type: 'null' }] }, serviceBackend: { enum: ['claude-acp', 'codex-acp', 'claude-cli'] },
  choices: response({ 'claude-acp': choices, 'codex-acp': choices }, []), offered: response({ 'claude-acp': offered, 'codex-acp': offered }, []), checking: array(agentBackend) });
// A tool step keeps its original identity, the Agent's bounded human title, its ACP
// category and one identifying input (command, path, pattern or query). Raw tool
// output and reasoning are never part of this record.
const conversationStep = response({ kind: { enum: ['text', 'tool', 'error'] }, at: text, text: { type: 'string' }, cut: { type: 'boolean' }, id: text, tool: text, operation: text,
  title: text, toolKind: { enum: ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] }, detail: text,
  outcome: { enum: ['requested', 'returned', 'rejected', 'unknown'] } }, ['kind', 'at']);
const conversationTurn = response({ id: text, by: text, text: { type: 'string' }, sentAt: text, state: { enum: ['running', 'completed', 'failed', 'stopped', 'unknown'] }, startedAt: { anyOf: [text, { type: 'null' }] }, endedAt: { anyOf: [text, { type: 'null' }] }, model: { anyOf: [text, { type: 'null' }] },
  stop: { anyOf: [response({ requestedAt: text, by: text, reason: { enum: ['person', 'closing', 'wall-limit', 'output-limit', 'line-limit', 'identity'] } }), { type: 'null' }] },
  steps: array(conversationStep), omitted: integer,
  permissions: array(response({ id: text, title: { type: 'string' }, toolCallId: text, details: { type: 'string' }, options: array(response({ id: text, name: text, kind: text })), state: { enum: ['pending', 'selected', 'cancelled'] }, selected: text }, ['id', 'title', 'toolCallId', 'options', 'state'])),
  retry: { anyOf: [response({ attempt: { anyOf: [integer, { type: 'null' }] }, of: { anyOf: [integer, { type: 'null' }] }, status: { anyOf: [integer, { type: 'null' }] }, at: text }), { type: 'null' }] },
  result: { anyOf: [response({ isError: { type: 'boolean' }, kind: { anyOf: [text, { type: 'null' }] }, reason: { anyOf: [text, { type: 'null' }] }, steps: { anyOf: [integer, { type: 'null' }] }, durationMs: { anyOf: [{ type: 'number' }, { type: 'null' }] }, costUsd: { anyOf: [{ type: 'number' }, { type: 'null' }] }, message: { anyOf: [{ type: 'string' }, { type: 'null' }] } }), { type: 'null' }] },
  problem: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  // Project files that changed on disk while the message ran, compared at its start and end.
  files: response({ changed: array(response({ path: text, change: { enum: ['added', 'modified', 'removed'] }, modifiedAt: { anyOf: [text, { type: 'null' }] }, bytes: { anyOf: [integer, { type: 'null' }] } })), omitted: integer, partial: { type: 'boolean' } }) }, ['id', 'by', 'text', 'sentAt', 'state', 'steps', 'omitted', 'problem']);
const observationSnapshot = response({
  project: contract.projectRecordSchema,
  catalog,
  documents: array(documentSummarySchema),
  operations: array(runSchema),
  resources: array(resourceSchema),
  compositions: array({ anyOf: [contract.legacyCompositionSchema, contract.structuredCompositionSchema] }),
  feedback: { anyOf: [contract.feedbackConfigurationSchema, { type: 'null' }] },
  presentation: { anyOf: [contract.presentationStateSchema, { type: 'null' }] },
  interactions: { type: 'array', items: contract.selectionChannelSchema, maxItems: 128 },
  taskMap: contract.taskMapStateSchema,
  annotations: { type: 'array', items: { type: 'object', additionalProperties: true }, maxItems: 128 },
  contexts: { type: 'array', items: { type: 'object', additionalProperties: true }, maxItems: 128 },
  // The calls of the Agents bound to this project, as the activity record keeps them.
  activity: obj({ cursor: integer, retainedFrom: positive, entries: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: true, properties: { cursor: positive, principal: text, method: text, at: text, outcome: { enum: ['returned', 'rejected'] } }, required: ['cursor', 'principal', 'method', 'at', 'outcome'] } } }, ['cursor', 'retainedFrom', 'entries']),
  // The Agent sessions with access to this project: no token, only who, what and when.
  agents: { type: 'array', maxItems: 64, items: response({ principal: text, label: { anyOf: [text, { type: 'null' }] }, profile: { anyOf: [text, { type: 'null' }] }, methods: array(text), expiresAt: { anyOf: [text, { type: 'null' }] }, ended: { type: 'boolean' },
    // A session started in Rho names its conversation; one started elsewhere has none here.
    conversationId: { anyOf: [text, { type: 'null' }] },
    last: { anyOf: [{ type: 'null' }, response({ at: text, method: text, outcome: { enum: ['returned', 'rejected'] }, operationId: text }, ['at', 'method', 'outcome'])] } }, ['principal', 'label', 'profile', 'methods', 'expiresAt', 'ended', 'last']) },
  // Conversations started in Rho, for the person at this machine; empty for anyone else.
  conversations: { type: 'array', maxItems: 64, items: conversationSummary },
  selection: { anyOf: [selection, { type: 'null' }] },
  bindings: array(contract.bindingSchema),
  cursor: integer,
  host: contract.cliSchema,
  limits: contract.limitReportSchema
});
// Retained snapshots from before the Agents summary are read through this same contract.
observationSnapshot.required = observationSnapshot.required.filter(key => key !== 'agents' && key !== 'conversations');

const structuredComposition = contract.structuredCompositionSchema;
const composition = { anyOf: [contract.legacyCompositionSchema, structuredComposition] };
const taskMap = { ...contract.taskMapStateSchema, properties: { ...contract.taskMapStateSchema.properties, receipt: obj({ changeId: identity, requestDigest: digest, kind: { enum: ['declare', 'present', 'respond'] }, author: text, version: positive, at: { type: 'string', format: 'date-time' }, outcome: contract.taskMapReceiptField }, ['changeId', 'kind', 'author', 'version', 'at']) } };

export const responses: Record<string, any> = { ...base.responses, ...ownerResponses,
  'project.work.read': projectWorkSchema(sessionObservation),
  'project.open': { ...contract.projectRecordSchema, properties: { ...contract.projectRecordSchema.properties, host: contract.cliSchema }, required: [...contract.projectRecordSchema.required, 'host'] },
  'project.pick': response({ cancelled: { type: 'boolean' }, project: { anyOf: [contract.projectSummarySchema, { type: 'null' }] } }),
  'project.source.pick': response({ cancelled: { type: 'boolean' }, selection: { anyOf: [response({ selectionId: text, id: text, root: text, name: text }), { type: 'null' }] } }),
  'project.source.add': response({ cancelled: { type: 'boolean' }, project: { anyOf: [contract.projectSummarySchema, { type: 'null' }] } }),
  'project.createWorkspace': contract.projectSummarySchema,
  'project.create': contract.projectSummarySchema,
  'project.list': array(contract.projectSummarySchema),
  'action.export': response({ destination: text, state: { const: 'complete' }, partial: { type: 'boolean' }, exported: integer, provenanceDigest: digest,
    files: array(response({ role: { enum: ['script', 'unsaved-script', 'output'] }, path: text, state: { enum: ['exported', 'not-written', 'changed', 'not-retained', 'left-out'] }, file: text, bytes: integer, sha256: text, check: text, reason: text }, ['role', 'path', 'state'])) }),
  // A run reports two different things and never merges them: the files its plan
  // asked the producer to write, and what is on disk now. Neither one is an
  // integrity check; only artifact.check verifies bytes against the inventory.
  'project.runs': response({ runs: array(response({
    operationId: text, action: text, execution: text, delivery: text, acceptedAt: text, author: text,
    declared: array(response({ path: text, present: { type: 'boolean' }, bytes: integer })),
    missing: array(text),
    completion: { enum: ['present', 'absent'] },
    integrity: { enum: ['unchecked', 'declared', 'incomplete', 'verified', 'not-applicable'] },
    domain: { enum: ['unchecked', 'checked'] },
    // Runs of one script share this digest; that is how a retry is recognised.
    script: { anyOf: [text, { type: 'null' }] },
    // A stable key for the file the run was submitted from, with the path itself
    // withheld: submissions of one file share it, so a retry chain is visible
    // without this summary disclosing the project's file names.
    sourceKey: { anyOf: [text, { type: 'null' }] },
    hasStderr: { type: 'boolean' },
    // When Core observed the process spawn and its exit; null until it did, and the end stays
    // null when the process went without an observed exit.
    startedAt: { anyOf: [text, { type: 'null' }] }, endedAt: { anyOf: [text, { type: 'null' }] },
    // A stop request and what Core reported afterwards, kept apart: "requested" and
    // "signalled" are not stopped; only an ended process is.
    stop: { anyOf: [{ type: 'null' }, response({ requestedAt: text, by: text, state: { enum: ['requested', 'signalled', 'stopped', 'finished-first', 'unconfirmed'] }, exit: { anyOf: [text, { type: 'null' }] } })] },
    // The failed or unknown run this one repairs, under its own new identity.
    repairOf: { anyOf: [text, { type: 'null' }] }
  })), total: integer, truncated: { type: 'boolean' } }),
  'protocol.validate': response({ method: text, valid: { type: 'boolean' }, problems: array(response({ path: text, keyword: text, message: text, fix: text })), requires: array(text) }),
  // A passing check carries no remedy, so the remedy is a possibly-empty string.
  'project.doctor': response({ ok: { type: 'boolean' }, checks: array(response({ id: text, state: { enum: ['ok', 'warn', 'fail'] }, detail: text, remedy: { type: 'string' } })), intent: { anyOf: [response({ id: text, methods: array(text), missing: array(text), ready: { type: 'boolean' } }), { type: 'null' }] } }),
  'project.entries': response({ entries: array(response({ path: text, name: text, kind: { enum: ['file', 'folder'] }, bytes: integer, hidden: { type: 'boolean' }, modifiedAt: { type: 'string', format: 'date-time' } }, ['path', 'name', 'kind', 'bytes', 'hidden'])), total: integer, truncated: { type: 'boolean' }, roots: array(text), path: { type: 'string', maxLength: 1024 } }),
  'session.browser.pair': response({ code: text, expiresAt: text }),
  'session.browser.revoke': response({ sessionId: text, revoked: { type: 'boolean' } }),
  'conversation.start': response({ conversation: conversationSummary, turn: conversationTurn }),
  'conversation.send': response({ conversation: conversationSummary, turn: conversationTurn }),
  'conversation.permission': response({ conversation: conversationSummary, turn: conversationTurn }),
  'conversation.stop': response({ conversation: conversationSummary, turn: conversationTurn }),
  'conversation.read': response({ conversation: conversationSummary, observation: { anyOf: [sessionObservation, { type: 'null' }] }, config: choices, first: integer, turns: array(conversationTurn) }, ['conversation', 'first', 'turns']),
  'conversation.list': response({ conversations: { type: 'array', maxItems: 64, items: conversationSummary } }),
  'conversation.trash': response({ conversation: conversationSummary }),
  'conversation.restore': response({ conversation: conversationSummary }),
  'conversation.delete': response({ conversationId: text, deleted: { const: true } }),
  'conversation.configure': response({ conversation: conversationSummary, observation: { anyOf: [sessionObservation, { type: 'null' }] }, config: choices }),
  'conversation.settings.read': agentSettings,
  'conversation.settings.update': agentSettings,
  'conversation.settings.check': agentSettings,
  'protocol.describe': response({ apiVersion: { const: '2.0' }, schemaVersion: { const: 2 }, revision: digest, entries: array(response({ method: text, summary: text })), next: { type: ['string', 'null'] }, complete: { type: 'boolean' }, contract: response({ method: text, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, definitions: { type: 'object' }, description: text }) }, ['apiVersion', 'schemaVersion', 'revision', 'entries', 'next', 'complete']),
  'capability.list': { ...catalog, properties: { ...catalog.properties, host: contract.cliSchema }, required: [...(catalog.required ?? []), 'host'] },
  'capability.configure': response({ version: positive, enabled: array(text), receipt: response({ changeId: text, author: text, version: positive, enabled: array(text), at: text }) }),
  'skill.list': array(response({ id: text, version: text, digest, content: text })),
  'skill.read': response({ id: text, version: text, digest, content: text }),
  // The application's resource view accepts every registered kind and keeps the
  // owner's provenance/coverage as open, bounded payloads.
  'resource.register': resourceSchema, 'resource.list': artifactFacts, 'artifact.check': artifactFacts,
  'resource.read': { ...ownerResponses['resource.read'], properties: { ...ownerResponses['resource.read'].properties, resource: resourceSchema, maxReadBytes: integer } },
  'data.page': { ...ownerResponses['data.page'], properties: { ...ownerResponses['data.page'].properties, resource: resourceSchema, namespace: { type: ['string', 'null'] }, columns: array(response({ name: text, type: { enum: ['string', 'number', 'boolean'] }, nullValues: { type: 'array', items: { type: 'string' }, maxItems: 16 } })), rows: array(contract.rowSchema) } },
  'data.plot': { ...ownerResponses['data.plot'], properties: { ...ownerResponses['data.plot'].properties, resource: resourceSchema } },
  'data.compare': resourceSchema,
  'selection.set': selection,
  'object.read': response({ resource: resourceSchema, observation: { const: 'exported-snapshot' }, value: {} }),
  // Media metadata is spread from the registration, so pages/width/height are only
  // present when they were declared.
  'media.describe': response({ resource: resourceSchema, original: ref, mimeType: { enum: ['image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf'] }, pages: positive, width: { type: 'number' }, height: { type: 'number' }, rendering: { const: 'unobserved' } }, ['resource', 'original', 'mimeType', 'rendering']),
  'workspace.save': contract.workspaceSaveSchema,
  'workspace.restore': contract.workspaceRestoreSchema,
  'observation.snapshot': observationSnapshot,
  'composition.apply': structuredComposition, 'composition.undo': structuredComposition, 'view.protection.set': structuredComposition,
  'composition.read': composition, 'view.close': composition,
  'project.openFile': response({ document: ownerResponses['document.open'], viewId: text, composition: structuredComposition }),
  'interaction.selection.read': contract.selectionChannelSchema,
  'interaction.selection.set': contract.selectionChannelSchema,
  'task.map.read': taskMap, 'task.map.declare': taskMap, 'task.map.present': taskMap, 'task.map.respond': taskMap,
  'requirements.prepare': runSchema, 'action.submit': runSchema, 'action.lookup': runSchema, 'action.observe': runSchema, 'action.retry': runSchema, 'action.cancel': runSchema,
  'action.list': array(runSchema),
  'context.create': contract.contextSchema,
  'context.read': { ...contract.contextSchema, required: [...contract.contextSchema.required, 'responses'] },
  'task.routing.put': { ...routeSchemas.RouteOutput },
  'view.observe': presentationSchemas.VisibilityReceipt,
  'view.observations.read': presentationSchemas.VisibilityReadOutput,
  'workspace.observe': enhancementSchemas.PresentationReadOutput,
  'workspace.enhance': presentationSchemas.CompositionCommit,
  'capability.index': discoverySchemas.IndexOutput,
  'capability.resolve': discoverySchemas.ResolveOutput
};
responses['session.grant'].properties.profile = operations['session.grant'].properties.profile;
export const descriptions = {
  'workspace.observe': 'Assigned presenter only: bounded layout/basis/owner summary/visibility projection. No feedback, full documents or native trace. Reading starts no model or renderer.',
  'workspace.enhance': 'Assigned presenter only: conditional display emphasis/title/plain Agent note using exact current generation, witness and observation. Does not modify business resources, feedback or protection.',
  'capability.index': 'Read a small role-narrowed index of currently authorized, enabled operations and immutable Skill/contract references.',
  'capability.resolve': 'Fetch selected relevant Skills with complete owner contracts, whole objects only. Pages pin catalog/bundle/caller; knownRefs only reuse currently available immutable bodies.', ...base.descriptions,
  'document.read': 'Read the shared acknowledged buffer, including unsaved text and its version.',
  'document.edit': 'Apply conditional UTF-16 text edits to the shared buffer; keep the returned version.',
  'feedback.submit': 'Teacher browser only: freeze the original draft/anchor, prepare the committed message and retain one original-session delivery. Preserve submissionId across missing acknowledgements; stages are separate durable facts.',
  'feedback.read': 'Original business binding only: fetch one complete frozen feedback object using its original delivery/context and a stable fetchId. relatedDocumentId is a pointer: read its CURRENT version before conditional edit/save and preserve human changes. This owner-served receipt does not prove client return or understanding.',
  'feedback.status': 'Observe original delivery, exact-target fetches and explicitly linked replies. No send, session start or recovery. Keep original identities and unknown outcomes; continuation cursors pin their snapshot.',
  'task.map.read': 'Observe the task map: declared items, vocabulary, next steps, forms, pins and pending suggestions. Reading starts, resumes or reruns nothing.',
  'task.map.declare': 'Agent only: conditionally declare task items, your own kind/state vocabulary (label, tone, optional role) and the next steps you will take. Rho shows next only from this declaration and never infers it.',
  'task.map.present': 'Change a map placement or item card form, its parameters (including a subset) or the focus. Shared by the Agent and people. An Agent change to a pinned target, or within agentFormIntervalMs of its last applied form change, is merged into one pending suggestion instead of applied; Agent changes stay attributed and revertible.',
  'task.map.respond': 'Browser person only: pin or unpin what they see, revert an Agent form change (layout only, never the work), or accept/dismiss a pending suggestion.',
  'capability.configure': 'Persist the selected project plugins with a conditional version and idempotent changeId. This changes routing only; it installs no package, starts no runtime and cancels no work.',
  'skill.list': 'List the application and enabled provider Skills shipped in the selected package. Skills guide discovery but do not grant authorization.',
  'skill.read': 'Read one versioned shipped Skill after checking its digest. A stale digest requires rereading instead of applying cached instructions.',
  'action.submit': 'Execute the explicitly selected project R script snapshot and requirements. Persist operationId before delivery; identical retries retain the original Core identity. Output directory is the first R argument, followed by explicit args or frozen resource paths. Artifact paths are output-relative; completion is run-directory-relative, returned as plan.completion, so an inventory can remain beside immutable producer artifacts.',
  'binding.activity.append': 'Registered native adapter only: retain original CLI tool and artifact-ready observations. This does not execute, validate, or present artifacts.',
  'task.routing.put': 'Control plane only: conditionally assign one task and business binding to this project without starting a native session.',
  'conversation.start': 'Person at this machine only: start a conversation with the selected Claude Code or Codex Agent in this project. Rho selects the Agent plugin backend, attaches this project\'s MCP grant and records the message before sending it. Without backend or config, the person\'s saved Agent and settings are used and recorded with the conversation. A repeated changeId with the same text returns the original conversation and starts nothing.',
  'conversation.send': 'Person at this machine only: send the next message to a conversation started in Rho, which resumes the same Agent session. Refused while the previous message is being answered. A repeated changeId with the same text returns the original message.',
  'conversation.stop': 'Person at this machine only: ask the original Agent to stop answering one message. ACP cancellation is confirmed by the original prompt response; a lost connection keeps the outcome unknown. Legacy CLI conversations confirm process exit. Steps already taken stay done.',
  'conversation.permission': 'Person at this machine only: record an offered choice for a pending Agent permission request. The original request identity is retained; repeated identical choices do not respond twice.',
  'conversation.configure': 'Person at this machine only: change one setting the Agent offers (model, effort, mode…) for the next messages of a conversation started in Rho. An open session changes now; otherwise the choice is applied when the session next opens. Refused while a message is being answered.',
  'conversation.list': 'Person at this machine only: list the conversations started in Rho in this project, or those in its trash, with each one\'s Agent, last model, choices and reported usage. Reading starts nothing.',
  'conversation.trash': 'Person at this machine only: move a conversation that is not being answered to the trash. It is kept whole and not continued until restored; an idle connection to its Agent ends.',
  'conversation.restore': 'Person at this machine only: return a conversation from the trash to the project\'s conversations, within the project\'s conversation limit.',
  'conversation.delete': 'Person at this machine only: delete Rho\'s record of a conversation in the trash. The Agent\'s own session files are not touched. Repeating the request that started it is then refused.',
  'conversation.settings.read': 'Person at this machine only: read the Agent and settings chosen for new conversations and what each Agent last offered. Reading starts nothing.',
  'conversation.settings.update': 'Person at this machine only: choose the Agent and its settings for new conversations, among the values that Agent last offered. A stale expectedVersion is refused.',
  'conversation.settings.check': 'Person at this machine only: start the chosen Agent in this project to read the settings it offers, then remove that session and end the process. No message is sent; one check per Agent runs at a time.',
  'conversation.read': 'Read a conversation started in Rho: the person\'s messages, the Agent\'s visible text and tool steps, and how each message ended. Reading starts and resumes nothing.',
  'project.work.read': 'Person at this machine only: read linked Agent sessions, retained native activity identities, current referenced files and the shared notes document. Source cursors and resource versions remain independent. Does not start an Agent, collector or Host.',
  'resource.register': 'Declare scoped existing bytes and their type/schema at the supplied digest. This read and registration starts no runtime.',
  'project.runs': 'Report what this project has run and what it is running: one bounded summary per operation with its execution state, accepted time, author kind, the artifact paths its plan declared, whether each of those files is on disk now, whether the producer wrote a completion inventory, and the recorded integrity and domain states. A declaration, a file on disk and a verified artifact are separate facts. It carries no request body, no code and no output text, and starts nothing.',
  'protocol.validate': 'Check one operation body against its versioned schema without executing it: the same checks the server applies, reported with the edit each problem needs. Use it before a write whose shape is uncertain; it changes nothing and starts nothing.',
  'project.doctor': 'Report whether this project can actually do work right now: Core binary, Rscript, write access to the project and state folders, plugin selection, Host socket and unfinished runs. Each check carries the next action when it does not pass. It starts no Host and changes nothing.',
  'project.entries': 'List one level of a folder in this project: ordinary files and folders, bounded and confined to that folder, excluding owner state. The project folder lists the source folders it works in as @<sourceId> entries, which descend like any other folder. Listing reads no file contents and starts no runtime.',
  'project.openFile': 'Open one text file from the selected project as a document and place it in the person\'s own layout in one conditional step, so a person can see and edit their own source files without an Agent. Accepts a project-relative path or the @<sourceId>/<path> reference the listing returns; it executes nothing.',
  'requirements.check': 'Probe only the explicitly declared R packages with bounded base R; no Core Host or project script starts.',
  'data.compare': 'Join two explicit table versions using declared keys, namespaces, fields and join policy. Scientific comparability remains the project responsibility.',
  'object.read': 'Read a bounded exported JSON object snapshot, not live R memory.',
  'artifact.check': 'Verify the selected completion inventory and file bytes only; domain check reports remain project resources.',
  'action.export': 'Write one run as ordinary files in a new project folder (default exports/<operationId>): the script that ran, from the run\'s own record; each declared output as the run left it; and provenance.json with PROVENANCE.md, saying where each file came from and what was checked. A declared file that was not written, or no longer matches the inventory the run wrote, is named and left out. When the script has unsaved changes, unsaved must be "include" or "leave". Runs nothing and never writes into an existing folder.',
  'context.read': 'Read an explicit versioned context package. Receipt establishes a tool fetch, not proactive delivery to a conversation.',
  'binding.open': 'Bind this external session to the authenticated project scope. Conversation stays in Claude Code.'
};
// The published artifact is content-addressed, so its bytes must not move when a
// description is added or an operation is inserted. Sorting both derived maps keeps
// the artifact a function of the contract rather than of editing order.
const orderedDescriptions = Object.fromEntries(Object.entries(descriptions).sort(([a], [b]) => a.localeCompare(b)));
export const errorKinds = base.errorKinds;
export const errorSchema = base.definitions.error;
export const errorEnvelope = obj({ apiVersion: { const: '2.0' }, ok: { const: false }, error: errorSchema });
export const responseEnvelope = (method: string) => obj({ apiVersion: { const: '2.0' }, ok: { const: true }, value: responses[method] });
export const protocol = { ...base, apiVersion: '2.0', schemaVersion: 2, transport: 'HTTP JSON POST /api/v2/{operation}; GET /api/v2/events', eventTypes: [...new Set([...base.eventTypes, 'project.sources.changed', 'capability.changed', 'view.closed', 'interaction.selection.changed', 'annotation.changed', 'context.changed', 'workspace.restored', 'task.routing.changed', 'binding.native.changed', 'feedback.changed', 'task.map.changed', 'feedback.changed', 'activity.changed', 'resource.changed', 'conversation.changed'])], operations, responses, descriptions: orderedDescriptions, definitions, errorEnvelope, status: 'One versioned contract. Retained operations stay observable through the current API; requests this contract does not accept receive a typed refusal rather than a second dialect.' };
