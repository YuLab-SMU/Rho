import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rho-public-protocol-"));
try {
  // A consumer outside this checkout must not need core types or Studio's
  // bundler-specific resolution. This also catches extensionless ESM imports.
  fs.cpSync(path.join(root, "sdk/plugin-protocol"), path.join(temp, "protocol"), { recursive: true });
  const consumer = path.join(temp, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "consumer.mts"), `
import type { ActivatePlugin, WorkspacePaths, PluginManifest, RpcFrame, VisualDocument, PluginRevisionPage, PendingCancellation, UpdatePluginWindowLayout, OpenPluginWindowView, ClosePluginView, PluginViewLifecycle, SaveDocumentDraft, StageDraftChunk, DocumentDraftChunk, ListDocumentDrafts, DocumentDraftPage, ContextSearch, ContextPage, PreviewContext, ContextPreview } from "../protocol/index.js";
import type {ProjectReadCoverage,ProjectReadCoverageArguments} from "../protocol/index.js";
import type { SaveScenario, ScenarioPage, ScenarioRevisionArguments, ApplyScenario, WindowScenarioSnapshot, ResolveWindowProvider } from "../protocol/index.js";
import type { ListPluginSource, PluginSourcePage, ReadPluginSource, PluginSourceChunk, ListPluginBranches, PluginBranchPage, CheckpointPlugin, PluginCheckpoint } from "../protocol/index.js";
import type { BuildPlugin, PluginBuildResult, ProcessReport, PreviewPlugin, PluginInstancePurpose, PluginInstancesArguments } from "../protocol/index.js";
import type { CreatePluginTestProject, PluginTestProjectObservation, PluginTestProjectArguments, PluginTestOperationArguments, StopPluginTestProject, ListPluginTestProjects, PluginTestProjectPage } from "../protocol/index.js";
const testSelection: CreatePluginTestProject = { name: "Backend test", instances: {subject:{plugin:"example.plugin",revision:"revision",artifact:"artifact",configuration:{},dependencies:{}}} };
const testRead: PluginTestProjectArguments = { id: "test-one" };
const testOriginal: PluginTestOperationArguments = { ...testRead, operation_id: "original-operation" };
const testStop: StopPluginTestProject = { ...testRead, expected_version: 4 };
const testList: ListPluginTestProjects = { after: null, limit: 20 };
function testObservation(page: PluginTestProjectPage): PluginTestProjectObservation | undefined { return page.projects[0]; }
// @ts-expect-error Backend tests cannot select an existing project or session.
const borrowedTest: CreatePluginTestProject = { ...testSelection, project_root: "/analysis" };
// @ts-expect-error Stop must carry the observed lifecycle version.
const guessedStop: StopPluginTestProject = testRead;
void [testSelection,testOriginal,testStop,testList,testObservation,borrowedTest,guessedStop];
const runtimeDiscovery: PluginInstancesArguments = { after: null, limit: 20 };
const completeDiscovery: PluginInstancesArguments = { ...runtimeDiscovery, include_previews: true };
void [runtimeDiscovery, completeDiscovery];
const previewArtifact: PreviewPlugin = { revision: "revision", artifact: "artifact", alias: "preview", configuration: {}, queries: [{capability:{id:"data.read",version:1},arguments:{},data:{rows:[]}}] };
const fixturePurpose: PluginInstancePurpose = "fixture_preview";
// @ts-expect-error Fixture preview never accepts native paths or lifecycle grants.
const forgedPreview: PreviewPlugin = { ...previewArtifact, project_root: "/current-project" };
void [previewArtifact, fixturePurpose, forgedPreview];
const buildRequest: BuildPlugin = { revision: "revision", timeout_ms: 120000 };
function buildEvidence(result: PluginBuildResult): ProcessReport { return result.process; }
// @ts-expect-error A build names immutable source, never an activated instance.
const forgedBuild: BuildPlugin = { instance: "instance", timeout_ms: 120000 };
void [buildRequest, buildEvidence, forgedBuild];
const sourceList: ListPluginSource = { revision: "revision", after: null, limit: 20 };
const sourcePage: PluginSourcePage = { revision: "revision", files: {}, total: 0, next: null };
const sourceRead: ReadPluginSource = { revision: "revision", path: "main.ts", offset: 0, limit: 65536 };
const sourceChunk: PluginSourceChunk = { ...sourceRead, file: { digest: "digest", bytes: 0, executable: false }, content_base64: "", next_offset: null };
const branchList: ListPluginBranches = { plugin: "example.plugin", after: null, limit: 20 };
const branchPage: PluginBranchPage = { branches: [{ id: "branch", plugin: branchList.plugin, name: "Editing", head: "revision", origin: null }], next: null };
const sourceCheckpoint: CheckpointPlugin = { branch: "branch", expected_head: "revision", changes: {
  "main.ts": { kind: "put", content_base64: "", executable: false },
  "old.ts": { kind: "remove" },
  "restored.ts": { kind: "copy", revision: "original", path: "main.ts" },
} };
const checkedSource: PluginCheckpoint = { branch: "branch", revision: "checked", parent: "revision" };
// @ts-expect-error Source editing never accepts an output artifact as an input.
const artifactCheckpoint: CheckpointPlugin = { ...sourceCheckpoint, artifact: "artifact" };
// @ts-expect-error Byte content is explicit; text is not silently re-encoded.
const guessedEncoding: CheckpointPlugin = { ...sourceCheckpoint, changes: { "main.ts": {kind:"put",text:"code",executable:false} } };
const application: ApplyScenario = { window: "window", revision: "revision", expected_layout_version: 2, instances: {}, views: {} };
const selectedProvider: ResolveWindowProvider = { window: "window", capability: { id: "example.read", version: 1 } };
const observation: WindowScenarioSnapshot = { scenario: null, layout: { window: "window", project: "project", principal: "principal", version: 0, layout: {kind:"empty"} } };
const checkpoint: SaveScenario = { scenario: "analysis", expected_head: null, name: "Analysis", instances: {}, providers: [], layout: { kind: "empty" } };
const scenarios: ScenarioPage = { scenarios: [{ scenario: checkpoint.scenario, revision: "revision", name: checkpoint.name }], next: null };
const scenarioRead: ScenarioRevisionArguments = { revision: scenarios.scenarios[0]!.revision };
// @ts-expect-error The caller cannot choose a checkpoint's project or principal.
const foreignScenario: SaveScenario = { ...checkpoint, project: "foreign" };
const coverageInput:ProjectReadCoverageArguments={};
const coverage:ProjectReadCoverage={all_visible:false};
// @ts-expect-error Missing coverage cannot be treated as complete.
const missingCoverage:ProjectReadCoverage={};
const activation: ActivatePlugin = { revision: "revision", artifact: "artifact", target: "ui-web", alias: "editor", configuration: {} };
const selected: ActivatePlugin = { ...activation, optional_capabilities: [{ id: "language.run", version: 1 }] };
const none: Pick<PluginManifest, "optional_requires"> = {};
const optional: Pick<PluginManifest, "optional_requires"> = { optional_requires: [{ capability: selected.optional_capabilities![0]!, scopes: ["workspace.run"] }] };
// @ts-expect-error Omission is allowed; null is not an optional capability list.
const invalid: ActivatePlugin = { ...activation, optional_capabilities: null };
const paths: WorkspacePaths = { project_root: "/project", protected_paths: ["/project/records.sqlite-wal"] };
const staged: StageDraftChunk = { window: "window", draft: "draft", upload: "capture", digest: "sha256:" + "a".repeat(64), base64: "YQ==" };
const draft: SaveDocumentDraft = { window: "window", draft: "draft", upload: staged.upload, expected_version: null,
  source: { revision: "sha256:" + "b".repeat(64), contribution: "editor" }, content: { digest: staged.digest, bytes: 1, chunks: [{ digest: staged.digest, bytes: 1 }] }, metadata: { cursor: 1 } };
const part: DocumentDraftChunk = { draft: draft.draft, version: 1, digest: staged.digest, offset: 0, base64: staged.base64, next: null };
const listing: ListDocumentDrafts = { window: draft.window, source: draft.source, after: null, limit: 20 };
const drafts: DocumentDraftPage = { drafts: [{ draft: draft.draft, source: draft.source, version: 1, digest: draft.content.digest, bytes: 1, metadata: draft.metadata }], next: null };
const search: ContextSearch = { window: "window", text: "研究", after: null, limit: 20 };
const contexts: ContextPage = { items: [{ reference: { provider: { instance: "editor", plugin: "org.rho.editor", revision: draft.source.revision, artifact: "artifact" }, contribution: "documents", window: search.window, selector: { draft: draft.draft, version: 1, digest: draft.content.digest } }, title: "研究.R", description: "Synchronized text", kind: "text" }], next: null, notices: [] };
const previewRequest: PreviewContext = { reference: contexts.items[0]!.reference, inclusion: { kind: "selection" }, max_bytes: 65536 };
const preview: ContextPreview = { item: contexts.items[0]!, text: "研究", truncated: false, data: { draft_version: 1 }, resources: [] };
const close: ClosePluginView = { view: "view", mode: { kind: "retain_acknowledged", expected_version: 4 } };
const lifecycle: PluginViewLifecycle = { view: "view", state_version: 4, close: { phase: "requested", operation: "original-close" } };
const open: OpenPluginWindowView = { view: { instance: { plugin: "example.view", instance: "instance", revision: "revision", artifact: "artifact" }, contribution: "view", window: "window", configuration: {}, state: {} }, expected_layout_version: 0, group: null };
const layout: UpdatePluginWindowLayout = { window: "window", expected_version: 0, layout: { kind: "tabs", id: "group", selected: "view", views: ["view"] } };
const frame: RpcFrame = { protocol_version: 1, connection: "channel", instance: "instance",
  sequence: 1, request: "request", body: { type: "release" } };
const original: PendingCancellation = { operation_id: "original", binding: {
  capability: { id: "example.run", version: 1 }, project: "project", target: "native",
  provider: { instance: "instance", plugin: "example.plugin", revision: "sha256:" + "a".repeat(64), artifact: "sha256:" + "b".repeat(64) }
} };
const prepare: RpcFrame = { ...frame, body: { type: "prepare_pending_cancellation", data: original } };
const ready: RpcFrame = { ...frame, body: { type: "ready", data: { revision: original.binding.provider.revision, artifact: original.binding.provider.artifact } } };
const extended: RpcFrame = { ...frame, body: { type: "ready", data: { revision: original.binding.provider.revision, artifact: original.binding.provider.artifact, features: ["pending_cancellation_v1"] } } };
export function inspect(manifest: PluginManifest, visual: VisualDocument, page: PluginRevisionPage) {
  return [activation, selected, none, optional, invalid, paths, staged, draft, part, listing, drafts, search, contexts, previewRequest, preview, frame, prepare, ready, extended, layout, open, close, lifecycle, manifest.views[0]?.entrypoint, visual.nodes[visual.root], page.next];
}
`);
  execFileSync(process.execPath, [path.join(root, "ui/node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--target", "ES2022", "--rootDir", consumer, path.join(consumer, "consumer.mts")], { stdio: "inherit" });
  for (const name of ["create-plugin-test-project", "plugin-test-project-observation", "plugin-test-project-arguments", "plugin-test-operation-arguments", "stop-plugin-test-project", "list-plugin-test-projects", "plugin-test-project-page", "list-plugin-source", "plugin-source-page", "read-plugin-source", "plugin-source-chunk", "list-plugin-branches", "plugin-branch-page", "checkpoint-plugin", "plugin-checkpoint", "manifest", "archive", "rpc", "resource-transfer-request", "resource-transfer-response", "view-message", "view-close", "window-layout", "window-open-view", "context-page", "preview-context", "context-preview", "document-draft", "list-document-drafts", "document-draft-page", "save-document-draft", "scenario", "save-scenario", "scenario-page", "apply-scenario", "window-scenario-snapshot", "resolve-window-provider", "visual-document"]) {
    const schema = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema", `${name}.json`), "utf8"));
    assert.ok(schema.$schema && schema.title, `missing standalone schema: ${name}`);
    const visit = value => {
      if (!value || typeof value !== "object") return;
      if (typeof value.$ref === "string") {
        assert.ok(value.$ref === "#" || value.$ref.startsWith("#/"), `external reference in ${name}: ${value.$ref}`);
        let resolved = schema;
        for (const token of value.$ref === "#" ? [] : value.$ref.slice(2).split("/")) {
          const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
          assert.ok(resolved && Object.hasOwn(resolved, key), `unresolved reference in ${name}: ${value.$ref}`);
          resolved = resolved[key];
        }
      }
      Object.values(value).forEach(visit);
    };
    visit(schema);
  }
  const previewSchema = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/preview-plugin.json"), "utf8"));
  assert.equal(previewSchema.additionalProperties, false);
  assert.equal(previewSchema.properties.queries.maxItems, 128);
  assert.deepEqual(previewSchema.required, ["revision", "artifact", "alias", "configuration", "queries"]);
  const sourceRead = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/read-plugin-source.json"), "utf8"));
  assert.equal(sourceRead.additionalProperties, false);
  assert.equal(sourceRead.properties.limit.minimum, 1);
  assert.equal(sourceRead.properties.limit.maximum, 65536);
  const sourceCheckpoint = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/checkpoint-plugin.json"), "utf8"));
  assert.equal(sourceCheckpoint.additionalProperties, false);
  assert.deepEqual(sourceCheckpoint.required, ["branch", "expected_head", "changes"]);
  const contextSearch = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/context-search.json"), "utf8"));
  const scenarioList = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/list-scenarios.json"), "utf8"));
  assert.equal(scenarioList.additionalProperties, false);
  assert.equal(scenarioList.properties.limit.maximum, 100);
  const scenarioSave = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/save-scenario.json"), "utf8"));
  assert.equal(scenarioSave.additionalProperties, false);
  assert.equal(scenarioSave.properties.project, undefined);
  assert.equal(scenarioSave.properties.principal, undefined);
  const coverage = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/project-read-coverage.json"), "utf8"));
  assert.deepEqual(coverage.required,["all_visible"]);
  assert.equal(coverage.additionalProperties,false);
  const coverageInput = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/project-read-coverage-arguments.json"), "utf8"));
  assert.equal(coverageInput.type,"object");
  assert.deepEqual(coverageInput.properties??{},{});
  assert.equal(coverageInput.additionalProperties,false);
  assert.equal(contextSearch.additionalProperties, false);
  assert.equal(contextSearch.properties.limit.minimum, 1);
  assert.equal(contextSearch.properties.limit.maximum, 20);
  const preview = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/preview-context.json"), "utf8"));
  assert.equal(preview.properties.max_bytes.maximum, 65536);
  const paths = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/workspace-paths.json"), "utf8"));
  assert.equal(paths.additionalProperties, false);
  assert.deepEqual(paths.required, ["project_root", "protected_paths"]);
  assert.equal(paths.properties.protected_paths.maxItems, 256);
  const listing = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/list-document-drafts.json"), "utf8"));
  assert.equal(listing.additionalProperties, false);
  assert.equal(listing.properties.limit.minimum, 1);
  assert.equal(listing.properties.limit.maximum, 20);
  const draftPage = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/document-draft-page.json"), "utf8"));
  assert.equal(draftPage.properties.drafts.maxItems, 20);
  console.log("Public plugin protocol compiles in an external strict NodeNext project; standalone schemas are present.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
