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
  for (const name of ["manifest", "archive", "rpc", "resource-transfer-request", "resource-transfer-response", "view-message", "view-close", "window-layout", "window-open-view", "context-page", "preview-context", "context-preview", "document-draft", "list-document-drafts", "document-draft-page", "save-document-draft", "scenario", "visual-document"]) {
    const schema = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema", `${name}.json`), "utf8"));
    assert.ok(schema.$schema && schema.$defs, `missing standalone schema: ${name}`);
  }
  const contextSearch = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema/context-search.json"), "utf8"));
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
