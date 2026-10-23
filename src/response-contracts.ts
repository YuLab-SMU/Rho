// Application response contracts.
//
// Every schema here describes a value the service actually returns today. They are
// authored in Rho because Rho owns the operation that produces them (runs, layout,
// selections, task map, capability catalog, workspace archive). Component results
// keep their owner's contract and are not restated here.
//
// Rules used throughout:
// - A fact the service always sets is required. A fact that depends on a branch
//   (a routed task, a format-3 archive, a confirmed cancellation) stays optional.
// - `additionalProperties: true` marks genuinely additive payloads (Core's native
//   view, tabular rows, provenance, the Agent's own vocabulary). Those keep an
//   explicit value type and size/shape bounds instead of an unbounded record.
// - Nothing here adds a default, coerces a value or widens an owner schema.
import { objectSchema as obj, text, refSchema as ref, version } from '@rho-workspace/plugin-contracts';

const identity = { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$' };
const integer = { type: 'integer', minimum: 0 };
const positive = { type: 'integer', minimum: 1 };
const timestamp = { type: 'string', format: 'date-time' };
const digest = version;
const nullableDigest = { anyOf: [digest, { type: 'null' }] };
const scalar = { type: ['string', 'number', 'boolean', 'null'] };
const scalarRow = { type: 'object', additionalProperties: scalar };

// A table cell or row is user data: its keys are the declared columns, its values
// the declared types. Open by key, closed by value.
export const rowSchema = scalarRow;

export const receiptSchema = obj({ changeId: identity, requestDigest: digest, version: positive, author: text, at: timestamp });

// --- Core-facing values -----------------------------------------------------
// Rho does not own the native run view; it passes Core's reply through unchanged.
// The schema names the fields Rho reads and allows the owner to add more, so a
// future Core release is additive rather than a contract violation.
export const streamInfoSchema = obj({ retained_bytes: integer, observed_bytes: integer, limit_bytes: integer, eof: { type: 'boolean' }, retention_error: { anyOf: [text, { type: 'null' }] }, truncated: { type: 'boolean' } });
export const exitSchema = { oneOf: [
  obj({ Code: integer }, ['Code']),
  obj({ Signal: integer }, ['Signal']),
  obj({ Unknown: text }, ['Unknown'])
] };
export const runStatusSchema = { anyOf: [
  { const: 'Starting' },
  obj({ NotStarted: obj({ reason: text }) }, ['NotStarted']),
  obj({ Running: obj({ pid: integer, spawned_at: text }) }, ['Running']),
  obj({ Finished: obj({ pid: integer, spawned_at: text, exit: exitSchema, exit_observed_at: text, group_released: { type: 'boolean' } }) }, ['Finished']),
  obj({ Detached: obj({ dispatched_at: text, pid: { anyOf: [integer, { type: 'null' }] }, spawned_at: { anyOf: [text, { type: 'null' }] }, present: { type: 'boolean' }, observed_at: text }) }, ['Detached']),
  obj({ Gone: obj({ pid: { anyOf: [integer, { type: 'null' }] }, spawned_at: { anyOf: [text, { type: 'null' }] }, evidence: text, observed_at: text, group_released: { type: 'boolean' } }) }, ['Gone'])
] };
export const nativeRunSchema = { ...obj({
  request_id: text, run_id: text, terminal: { type: 'boolean' }, held: { type: 'boolean' }, status: runStatusSchema,
  // Core owns these payloads. Rho names the parts it reads (streams, status,
  // request) and passes the rest through as bounded JSON, so a Core release that
  // adds or reshapes retention facts does not require a Rho-side contract copy.
  cancel: {}, stdout: streamInfoSchema, stderr: streamInfoSchema,
  unsaved: {}, retention: {}, accepted_at: {},
  // Rho reads the stream/status facts; `request` and `record` are Core's own
  // payloads, so they stay optional here rather than being restated.
  request: obj({ executor: text, workdir: text, workdir_resolved: text, args: { type: 'array', items: { type: 'string' }, maxItems: 64 }, code_sha256: digest, code_bytes: integer }),
  record: { type: 'object' }
}, ['request_id', 'run_id', 'terminal', 'status', 'stdout', 'stderr']), additionalProperties: true };
export const cliSchema = obj({ exitCode: { type: 'integer', minimum: 0, maximum: 4 }, reply: { type: 'object', additionalProperties: true } });

// --- Requirements and checks ------------------------------------------------
export const requirementSchema = obj({ package: text, source: { enum: ['cran', 'bioconductor'] }, minimumVersion: text }, ['package', 'source']);
export const checkSchema = obj({
  requirements: { type: 'array', items: requirementSchema, maxItems: 64 },
  checkedAt: timestamp,
  environment: obj({ rscript: text, libraryPaths: { type: 'array', items: text, maxItems: 64 } }),
  native: { oneOf: [obj({ probe: { const: 'unknown' }, reason: text }), obj({ probe: { const: 'checked' }, R: text, packages: { type: 'array', items: obj({ package: text, status: { enum: ['present', 'missing'] }, version: { anyOf: [text, { type: 'null' }] } }), maxItems: 64 } })] },
  status: { enum: ['present', 'missing', 'unknown'] },
  checkId: digest
});

// --- Retained execution -----------------------------------------------------
// A plan records what will run (or ran) without keeping the code in the reply: the
// code digest is returned, the code itself is dropped by `publicOperation`.
export const planSourceSchema = { anyOf: [
  obj({ kind: { const: 'disk' }, path: text, sha256: digest, inputs: { type: 'array', items: ref, maxItems: 64 }, artifacts: { type: 'array', maxItems: 128 }, completion: { anyOf: [text, { type: 'null' }] }, requirements: { type: 'array', items: requirementSchema, maxItems: 64 } }),
  obj({ kind: { const: 'buffer' }, documentId: digest, version: positive, path: text, dirty: { type: 'boolean' }, sha256: digest, inputs: { type: 'array', items: ref, maxItems: 64 }, artifacts: { type: 'array', maxItems: 128 }, completion: { anyOf: [text, { type: 'null' }] }, requirements: { type: 'array', items: requirementSchema, maxItems: 64 } }),
  obj({ kind: { const: 'dependency-preparation' }, requirements: { type: 'array', items: requirementSchema, maxItems: 64 }, library: text, before: checkSchema }),
  // A retained run from an earlier descriptor keeps its own recorded source. The
  // kind stays open so historical runs remain observable, with bounded openness.
  obj({ kind: { type: 'string', minLength: 1, maxLength: 64 } }, ['kind'])
] };
export const integrityReportSchema = { ...obj({
  state: { enum: ['unchecked', 'declared', 'incomplete', 'verified', 'not-applicable'] },
  missing: { type: 'array', items: text, maxItems: 512 },
  unavailable: { type: 'array', items: obj({ path: text, kind: text, reason: text }), maxItems: 512 },
  completionDeclaration: { enum: ['present', 'absent'] },
  files: integer, checkedAt: timestamp, manifestDigest: digest
}, ['state']), additionalProperties: true };
export const domainReportSchema = { ...obj({ state: { enum: ['unchecked', 'checked'] }, scope: text, detail: { type: 'object' } }, ['state']), additionalProperties: true };
export const cancellationSchema = obj({ requestedAt: timestamp, cli: cliSchema, confirmation: text });

// --- Selections -------------------------------------------------------------
export const selectionValueSchema = { oneOf: [
  obj({ document: obj({ documentId: text, version: positive, from: integer, to: integer }) }),
  obj({ resource: ref, entities: { type: 'array', items: text, minItems: 1, maxItems: 1024 } }),
  { type: 'null' }
] };
const scopeSchema = { oneOf: [obj({ kind: { const: 'caller' } }), obj({ kind: { enum: ['view', 'shared'] }, id: identity })] };
// An unseen channel answers with the projection but no receipts yet, so the
// receipt parts stay optional while the versioned identity stays required.
export const selectionChannelSchema = obj({
  key: digest, scope: scopeSchema, version: integer, selection: selectionValueSchema,
  author: text, receipts: { type: 'array', items: receiptSchema, maxItems: 256 }, retainedFromVersion: positive, receipt: receiptSchema
}, ['key', 'scope', 'version', 'selection']);

// --- Contexts ---------------------------------------------------------------
const contextResponseSchema = obj({ annotationId: identity, state: { enum: ['explicit-linked-response', 'no-linked-response', 'unavailable'] }, messageIds: { type: 'array', items: text, maxItems: 128 } });
// A context is an explicit, versioned package. What it carries depends on what the
// caller selected: exactly one of document/region/resource/annotations is present.
export const contextSchema = { ...obj({
  contextId: digest, projectId: identity, principal: text, at: timestamp, requestDigest: digest,
  delivery: { enum: ['not-fetched', 'tool-fetched'] }, preparation: { enum: ['prepared'] },
  changeId: identity, version: positive,
  fetchedBy: text, fetchedAt: timestamp,
  feedbackTarget: obj({ principal: text, bindingId: digest, externalSessionId: identity }),
  responses: { type: 'array', items: contextResponseSchema, maxItems: 128 },
  annotations: { type: 'array', maxItems: 128 },
  document: obj({ source: obj({ kind: { const: 'buffer' }, documentId: text, version: positive, path: text, dirty: { type: 'boolean' } }), sha256: digest, from: integer, to: integer, text: { type: 'string' } }),
  region: obj({ page: positive, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, units: { enum: ['pixels', 'points'] }, resource: ref, mapping: { const: 'original-media-coordinates' } }),
  resource: obj({
    reference: ref, metadata: { type: 'object', additionalProperties: true },
    rows: { type: 'array', items: scalarRow, maxItems: 512 },
    offset: integer, nextOffset: integer, more: { type: 'boolean' },
    encoding: { enum: ['utf8', 'base64'] }, text: { type: 'string' }, data: { type: 'string' }
  })
}, ['contextId', 'projectId', 'principal', 'at', 'delivery']), additionalProperties: true };

// --- Task map ---------------------------------------------------------------
const word = { type: 'string', minLength: 1, maxLength: 64 };
const term = obj({ label: { type: 'string', minLength: 1, maxLength: 80 }, tone: text, role: text, icon: text, description: { type: 'string', maxLength: 240 } }, ['label']);
// A presentation record and the earlier record it replaced share this summary. The
// parameters are the form's own vocabulary, so they are open values bounded by count.
// Form parameters are the Agent's or a person's own vocabulary (a subset, a filter,
// a scale). Any JSON value is allowed; the bound is on how many keys there are.
const formParams = { type: 'object', maxProperties: 16, additionalProperties: {} };
const presentationRecordSummarySchema = obj({ form: text, params: formParams, author: text, human: { type: 'boolean' } }, ['form', 'params', 'author', 'human']);
export const taskMapStateSchema = { ...obj({
  format: { const: 'rho.task-map/1' },
  version: integer,
  question: { anyOf: [{ type: 'string', maxLength: 240 }, { type: 'null' }] },
  compositionId: { anyOf: [identity, { type: 'null' }] },
  // Declared vocabulary terms. A null term in the *input* deletes an entry, so a
  // stored term is always a term.
  vocabulary: obj({ kinds: { type: 'object', maxProperties: 64, additionalProperties: term }, states: { type: 'object', maxProperties: 64, additionalProperties: term } }, ['kinds', 'states']),
  items: { type: 'array', maxItems: 256, items: obj({ id: identity, kind: word, state: word, title: { type: 'string', maxLength: 160 }, group: { type: 'string', maxLength: 60 }, summary: { type: 'string', maxLength: 280 }, lines: { type: 'array', maxItems: 12, items: obj({ label: { type: 'string', maxLength: 40 }, text: { type: 'string', maxLength: 280 }, tone: text, judgment: { type: 'boolean' } }, ['text']) }, progress: obj({ done: integer, total: positive, unit: { type: 'string', maxLength: 24 } }, ['done']), view: identity, from: { type: 'array', items: identity, maxItems: 16 }, author: text, at: timestamp }, ['id', 'kind', 'state', 'title', 'author', 'at']) },
  next: { type: 'array', items: identity, maxItems: 256 },
  focus: { anyOf: [{ ...obj({ item: identity, author: text, human: { type: 'boolean' }, at: timestamp }), additionalProperties: true }, { type: 'null' }] },
  lastAgentFormAt: { anyOf: [timestamp, { type: 'null' }] },
  // Every applied or suggested form change names the change that produced it, so the
// receipt and the record can be matched by a person or the Agent.
  presentation: { type: 'object', maxProperties: 256, additionalProperties: obj({ form: text, params: formParams, author: text, human: { type: 'boolean' }, at: timestamp, changeId: identity, reason: text, suggestedBy: text, previous: { anyOf: [presentationRecordSummarySchema, { type: 'null' }] }, pinned: obj({ by: text, at: timestamp }) }, ['form', 'params', 'author', 'human', 'at', 'changeId']) },
  suggestions: { type: 'array', maxItems: 64, items: obj({ id: identity, target: text, form: text, params: formParams, author: text, at: timestamp, reason: text, cause: { enum: ['pinned', 'budget'] }, merged: integer }, ['id', 'target', 'form', 'params', 'author', 'at', 'cause', 'merged']) },
  receipts: { type: 'array', maxItems: 256, items: { ...obj({ changeId: identity, requestDigest: digest, kind: { enum: ['declare', 'present', 'respond'] }, author: text, version: positive, at: timestamp, outcome: { type: 'object', additionalProperties: true } }, ['changeId', 'requestDigest', 'kind', 'author', 'version', 'at']) } },
  retainedFromVersion: positive,
  limits: obj({ agentFormIntervalMs: integer }, ['agentFormIntervalMs'])
}, ['format', 'version', 'vocabulary', 'items', 'next', 'presentation', 'suggestions', 'receipts', 'retainedFromVersion', 'lastAgentFormAt', 'focus', 'question', 'compositionId']), additionalProperties: true };

// --- Capability catalog -----------------------------------------------------
// Owner-authored display hints, carried through unchanged. They never assert
// authorization or availability; those are separate facts in the same entry.
const nativeAvailabilitySchema = { ...obj({ state: { enum: ['present', 'missing', 'unknown'] }, tool: text, scope: text, checkedAt: timestamp, methods: { type: 'array', items: text, maxItems: 32 }, title: text, body: text }, ['state', 'tool', 'scope', 'checkedAt', 'methods']), additionalProperties: true };
export const entryPresentationSchema = { ...obj({
  displayName: text, description: text, order: { type: 'number' }, readOnly: { type: 'boolean' }, runsCode: { type: 'boolean' }
}, []), additionalProperties: true };
export const pluginPresentationSchema = { ...entryPresentationSchema, properties: { ...entryPresentationSchema.properties,
  icon: obj({ background: text, color: text, paths: { type: 'array', items: text, maxItems: 32 }, dots: { type: 'array', maxItems: 32, items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, text: text }, ['background', 'color']), tagline: text, category: text, categoryOrder: { type: 'number' },
  examplePrompts: { type: 'array', items: text, maxItems: 16 }, viewNote: text, developer: text, license: text,
  links: { type: 'array', maxItems: 16, items: obj({ label: text, url: text }, ['label', 'url']) },
  dependencies: { type: 'array', maxItems: 16, items: obj({ pluginId: text, purpose: text }, ['pluginId', 'purpose']) }, uses: text } };
export const capabilityCatalogSchema = { ...obj({
  version: text,
  configuration: obj({ version: integer, enabled: { type: 'array', items: text, maxItems: 32 }, retainedReceipts: integer, retainedFromVersion: positive, maxReceipts: integer }, ['version', 'enabled']),
  plugins: { type: 'array', maxItems: 16, items: { ...obj({ id: text, package: text, version: text, requires: { type: 'array', items: text }, selected: { type: 'boolean' }, packagePresent: { type: 'boolean' }, projectEnabled: { type: 'boolean' }, dependenciesSatisfied: { type: 'boolean' }, uiRenderable: { type: 'boolean' }, state: { enum: ['available', 'unavailable'] }, reason: text, missing: { type: 'array', items: text },
    // The catalog also carries the owner's own presentation/listing hints and its
    // bounded native availability; those are owner vocabulary, so they stay open.
    // A reduced installation lists fewer entries, so each listing section is optional.
    listing: obj({
      skills: { type: 'array', maxItems: 64, items: { ...obj({ id: text, version: text, digest: digest, presentation: entryPresentationSchema }, ['id', 'version', 'digest']), additionalProperties: true } },
      actions: { type: 'array', maxItems: 64, items: { ...obj({ presentation: entryPresentationSchema }), additionalProperties: true } },
      views: { type: 'array', maxItems: 64, items: { ...obj({ id: text, version: text, ui: text, presentation: entryPresentationSchema }, ['id', 'version', 'ui']), additionalProperties: true } }
    }, []),
    presentation: pluginPresentationSchema,
    nativeAvailability: nativeAvailabilitySchema,
  }, ['id', 'package', 'selected', 'packagePresent', 'state']), additionalProperties: true } },
  operations: { type: 'array', maxItems: 256, items: { ...obj({ method: text, owner: text, packagePresent: { type: 'boolean' }, projectEnabled: { type: 'boolean' }, dependenciesSatisfied: { type: 'boolean' }, authorized: { type: 'boolean' }, state: { enum: ['available', 'unavailable'] }, presentation: entryPresentationSchema }, ['method', 'authorized', 'state']), additionalProperties: true } },
  actions: { type: 'array', maxItems: 64, items: { ...obj({ id: text, version: text, owner: text, pluginId: text, requires: { type: 'array', items: text }, inputSchema: { type: 'object' }, presentation: entryPresentationSchema }, ['id', 'version']), additionalProperties: true } },
  unavailableActions: { type: 'array', maxItems: 64, items: { ...obj({ id: text, version: text, owner: text, pluginId: text, requires: { type: 'array', items: text }, inputSchema: { type: 'object' }, presentation: entryPresentationSchema, state: { const: 'unavailable' }, missing: { type: 'array', items: text } }, ['id', 'version', 'missing']), additionalProperties: true } },
  components: { type: 'array', maxItems: 64, items: { ...obj({ id: text, version: text, owner: text, pluginId: text, ui: text, bindings: { type: 'object', additionalProperties: text }, propsSchema: { type: 'object' }, presentation: entryPresentationSchema }, ['id', 'version', 'ui', 'bindings']), additionalProperties: true } },
  capabilities: { type: 'array', items: text },
  skills: { type: 'array', maxItems: 64, items: { ...obj({ id: text, version: text, digest: digest, content: { type: 'string' }, presentation: entryPresentationSchema }, ['id', 'version', 'digest']), additionalProperties: true } },
  // The Agent owner contributes its own context description only when it is loaded.
  agent: { type: 'object' }
}, ['version', 'configuration', 'plugins', 'operations', 'actions', 'components']), additionalProperties: true };

// --- Layout -----------------------------------------------------------------
const groupPresentation = obj({ mode: { enum: ['tabs', 'split'] }, axis: { enum: ['horizontal', 'vertical'] }, weights: { type: 'array', items: { type: 'number' }, maxItems: 32 } }, ['mode']);
const viewSchema = obj({ id: identity, component: text, version: text, props: { type: 'object' }, bindings: { type: 'object', additionalProperties: { anyOf: [ref, obj({ documentId: digest, version: positive }), obj({ kind: { const: 'live-document' }, documentId: digest })] } }, selection: { type: 'array', items: text, maxItems: 1000 }, presentation: obj({ emphasis: { enum: ['normal', 'highlight'] } }), protected: { type: 'boolean' } }, ['id', 'component', 'version', 'props', 'bindings']);
const availabilitySchema = obj({ state: { enum: ['entry-installed', 'unavailable'] }, visibility: { const: 'unobserved' }, reason: text }, ['state']);
export const nodeSchema = { oneOf: [
  obj({ id: identity, kind: { const: 'group' }, children: { type: 'array', items: identity, maxItems: 256 }, presentation: groupPresentation }, ['id', 'kind', 'children']),
  { ...viewSchema, properties: { ...viewSchema.properties, kind: { const: 'view' } }, required: [...viewSchema.required, 'kind'] }
] };
export const compositionReceiptSchema = obj({ changeId: identity, author: text, version: positive, requestDigest: digest, at: timestamp, kind: { enum: ['apply', 'undo', 'protect'] } });
const historyEntry = obj({ version: positive, snapshot: obj({ rootId: identity, nodes: { type: 'array', items: nodeSchema, maxItems: 256 } }) }, ['version', 'snapshot']);
export const witnessSchema = { ...obj({
  witnessId: digest, projectId: identity, taskId: identity, compositionId: identity, compositionVersion: positive,
  sourceEvent: { type: 'object', additionalProperties: true }, policyRef: digest,
  views: { type: 'array', maxItems: 32, items: obj({ viewId: identity, component: text, componentVersion: text, resource: ref }, ['viewId', 'resource']) },
  dataValidation: obj({ integrity: { const: 'hash-verified' }, shape: { const: 'typed-table-read' }, domain: { const: 'not-judged' } }),
  at: timestamp
}, ['witnessId', 'projectId', 'taskId', 'compositionId', 'compositionVersion', 'views']) };
export const structuredCompositionSchema = { ...obj({
  format: { const: 'rho.composition/1' }, compositionId: identity, rootId: identity,
  nodes: { type: 'array', items: nodeSchema, maxItems: 256 },
  views: { type: 'array', items: viewSchema, maxItems: 32 },
  availability: { type: 'object', additionalProperties: availabilitySchema },
  version: positive, author: text, acknowledgedAt: timestamp,
  history: { type: 'array', items: historyEntry, maxItems: 256 },
  receipts: { type: 'array', items: { ...obj({ changeId: identity, requestDigest: digest, version: positive, author: text, at: timestamp, kind: { enum: ['apply', 'undo', 'protect', 'close'] } }, ['changeId', 'author', 'version', 'at']) }, maxItems: 256 },
  retainedFromVersion: positive, undoRetainedFromVersion: positive,
  receipt: compositionReceiptSchema,
  witness: { anyOf: [witnessSchema, { type: 'null' }] }, witnessState: { enum: ['retained', 'expired', 'pending'] },
  commitVersion: positive, currentVersion: positive
// A committed layout always records these facts; the witness fields are added only
// when the task has a routed presenter.
}, ['format', 'compositionId', 'rootId', 'nodes', 'views', 'availability', 'version', 'author', 'acknowledgedAt', 'history', 'receipts', 'retainedFromVersion', 'undoRetainedFromVersion', 'receipt']) };
export const legacyCompositionSchema = obj({ compositionId: identity, version: positive, views: { type: 'array', items: viewSchema, maxItems: 32 }, layout: { type: 'object' }, availability: { type: 'object' }, acknowledgedAt: timestamp }, ['compositionId', 'version', 'views']);

// --- Workspace archive ------------------------------------------------------
export const workspaceSaveSchema = { ...obj({
  schemaVersion: { enum: [1, 2, 3] }, sourceProjectId: identity, acknowledgedAt: timestamp,
  documents: { type: 'array', maxItems: 64 },
  resources: { type: 'array', maxItems: 1024 },
  compositions: { type: 'array', maxItems: 64 },
  selection: { anyOf: [{ type: 'object' }, { type: 'null' }] },
  capabilities: obj({ schemaVersion: { const: 1 }, version: integer, enabled: { type: 'array', items: text }, receipts: { type: 'array', items: { type: 'object' } } }),
  interactions: { type: 'array', items: selectionChannelSchema, maxItems: 128 },
  annotations: { type: 'array', maxItems: 128 },
  contexts: { type: 'array', maxItems: 128, items: obj({ contextId: digest, context: { type: 'object' } }, ['contextId', 'context']) }
}, ['schemaVersion', 'sourceProjectId', 'acknowledgedAt', 'documents', 'resources', 'compositions', 'selection']), additionalProperties: true };
const restoreState = { enum: ['available', 'conflict', 'unavailable', 'missing'] };
export const workspaceRestoreSchema = { ...obj({
  sourceProjectId: identity, execution: { const: 'not-replayed' }, retainedArchive: text,
  documents: { type: 'array', maxItems: 64, items: { ...obj({ documentId: digest, state: restoreState, owner: text }, ['documentId', 'state']), additionalProperties: true } },
  resources: { type: 'array', maxItems: 1024, items: { ...obj({ resource: ref, state: restoreState, owner: text }, ['state']), additionalProperties: true } },
  compositions: { type: 'array', maxItems: 64, items: { ...obj({ compositionId: identity, state: restoreState, views: integer }, ['compositionId', 'state']), additionalProperties: true } },
  selection: { ...obj({ state: restoreState, reference: { type: ['object', 'null'] }, reason: text }, ['state']) },
  capabilities: obj({ state: restoreState, missing: { type: 'array', items: text } }),
  interactions: { type: 'array', items: obj({ key: digest, state: restoreState }, ['key', 'state']) },
  // An unavailable entry names the owner it needs, so a person can see which
  // component is absent instead of only that something was not restored.
  annotations: { type: 'array', items: obj({ annotationId: identity, state: restoreState, owner: text }, ['annotationId', 'state']) },
  contexts: { type: 'array', items: obj({ contextId: digest, state: restoreState, owner: text }, ['contextId', 'state']) }
}, ['sourceProjectId', 'execution', 'documents', 'resources', 'compositions']), additionalProperties: true };

// --- Observation ------------------------------------------------------------
// A selected project keeps the facts the state owner records; everything beyond the
// identity/root/open time is optional because it depends on how it was opened.
// A source folder is one of the folders a workspace project was created from.
export const sourceFolderSchema = obj({ id: identity, root: text, name: text }, ['id', 'root', 'name']);
export const projectSummarySchema = { ...obj({ id: identity, root: text, openedAt: timestamp, name: text, sources: { type: 'array', maxItems: 32, items: sourceFolderSchema }, workspace: { type: 'boolean' }, nativeSelected: { type: 'boolean' } }, ['id', 'root', 'openedAt']), additionalProperties: true };
export const projectRecordSchema = { ...obj({ id: identity, root: text, openedAt: timestamp, name: text, workspace: { type: 'boolean' }, nativeSelected: { type: 'boolean' }, visibilityRoot: text, sources: { type: 'array', maxItems: 32, items: sourceFolderSchema }, creation: obj({ id: identity, digest: digest, author: text }) }, ['id', 'root', 'openedAt']), additionalProperties: true };
export const documentSummaryResponseSchema = { ...obj({ id: digest, path: text, version: positive, revision: integer, diskDigest: nullableDigest, dirty: { type: 'boolean' }, author: text, acknowledgedAt: timestamp, bytes: integer }, ['id', 'path', 'version', 'dirty', 'author', 'acknowledgedAt']), additionalProperties: true };
export const presentationStateSchema = obj({ taskId: identity, pending: { anyOf: [{ ...obj({ resource: ref, sourceEventId: text, reason: text, at: timestamp }) }, { type: 'null' }] }, witnesses: { type: 'array', items: witnessSchema, maxItems: 32 } }, ['taskId', 'witnesses']);
// A routed task always reports all six facts; the three references may be null when
// no target binding, draft document or related document has been selected yet.
export const feedbackConfigurationSchema = obj({ taskId: identity, compositionId: identity, taskVersion: positive, targetBindingId: { anyOf: [digest, { type: 'null' }] }, draftDocumentId: { anyOf: [digest, { type: 'null' }] }, relatedDocumentId: { anyOf: [digest, { type: 'null' }] } }, ['taskId', 'compositionId', 'taskVersion', 'targetBindingId', 'draftDocumentId', 'relatedDocumentId']);
export const bindingSchema = { ...obj({ id: digest, projectId: identity, principal: text, externalSessionId: identity, adapter: { const: 'claude-code-mcp' }, status: { enum: ['connected', 'disconnected'] }, at: timestamp, attachment: obj({ adapterRegistrationId: identity, taskId: identity, role: { enum: ['business', 'presentation'] }, transportCapabilities: { type: 'object' } }) }, ['id', 'projectId', 'principal', 'externalSessionId', 'adapter', 'status', 'at']), additionalProperties: true };
// A limit report names the protected resource, its configured value and grouped
// owner limits. Values are numbers; a group (documents, resources, r) is a nested
// map of the same kind.
export const limitReportSchema = { type: 'object', maxProperties: 64, additionalProperties: { anyOf: [{ type: 'number' }, { type: 'object', maxProperties: 32, additionalProperties: { type: 'number' } }] } };

// Outcomes are owner vocabulary; they are open by key and bounded by size. This is
// the one place a task-map receipt carries a shape this application does not fix.
export const taskMapReceiptField = { type: 'object', maxProperties: 16, additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } };
