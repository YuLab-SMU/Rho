# U2 Documents backend handoff

Updated: 2026-10-19. This batch supplies backend prerequisites. Documents and
Tables UI await the frontend team. No interface, editor, input adapter or layout
is built here. Core and the U1 browser grant ceiling are unchanged.

## Owner and wire contracts

Rho-plugins owns document state, undo, conditional save and durable receipts.
`@rho-workspace/plugin-documents/contract` exports its pure Node schemas, not a
browser runtime. Rho's wire mirror is tested for exact parity. The Node/DOM-free
`@rho-workspace/local/browser` SDK types `document.open/read/edit/undo/save`.
SDK types grant no permission: paired tabs still permit U1 reads only, without
document mutations or `document.open`. `session.grant` remains operator-only.
Direct Node embeddings must serialize mutations under the project writer lease;
Rho already serializes HTTP and MCP operations at that boundary.

`version` remains the content version: edit and undo advance it; save does not.
The new document-local `revision` advances on every acknowledged edit, undo or
save, including legacy calls. There is no global resource revision. This prevents
expired save receipts from authorizing another save at the same content version.

Read the full document before writing. Identified mutations provide both
`changeId` and `expectedRevision`, plus existing content/disk conditions:

```json
{
  "projectId": "PROJECT_ID",
  "documentId": "DOCUMENT_SHA256_ID",
  "expectedVersion": 2,
  "expectedRevision": 1,
  "changeId": "tab-edit-unique-id",
  "undoGroup": "typing-group-id",
  "edits": [{ "from": 0, "to": 0, "insert": "中文 🧬\n" }]
}
```

This is an edit request shape; substitute observed identities and conditions.
Save also requires the observed `expectedDiskDigest`, possibly null. Undo has no
redo equivalent. Node methods accept optional final `{changeId,expectedRevision}`
after the author; old calls remain valid. HTTP rejects either field without the
other. Any future browser write grant also requires both fields at dispatch.

Retain the exact request before first delivery. Retry preserves method, caller,
document, edits, undo group, disk condition and expected numbers. Changed reuse
conflicts. A duplicate returns current document state plus the original `receipt`;
its version/revision may precede the current buffer. Never infer old text from a
receipt or replace current text with a historical version.

`document.read` returns `revision`, `receipts` and `retainedFromRevision`.
`documents.maxReceipts` defaults to 256 per document; acknowledgements evict oldest
receipts above that count, preserving content and undo. An expired original
request fails its original revision condition. Missing receipts are not proof
that a request never ran. Legacy buffers/archives get empty receipts and initial
revision from content version; historical receipts are not invented.

## Save uncertainty and live bindings

Documents persists `pendingSave` before replacing disk bytes. After interruption,
reads expose this fact without running a mutation. Other mutations wait for an
explicit identical save retry. If disk already matches intended content, retry
finalizes metadata without replacing the file again. If disk still matches the
original condition, that explicit retry may complete the original save. Different
bytes conflict, retaining confirmed buffer and pending intent. The digest check
plus atomic replacement is not filesystem CAS against outside writers.

An archive with an unresolved save reports a document conflict on restore and
retains the original source reference; it does not execute that save in another
project. Abandoning a permanently conflicting pending save is not implemented in
this batch.

An editor following the shared buffer binds
`{document:{kind:"live-document",documentId}}`. It supplies no version. Presence
and the registered component's document role are validated. Existing
`{documentId,version}` remains exact: new stale bindings fail, retained references
do not migrate. Protected live views remain editable; layout/binding protection
still applies. Format-3 recovery retains bindings and receipts. The v1 bridge
projects ordinary document reads into its frozen shape and refuses live layouts.

## Frontend delivery before integration

The frontend team supplies the agreed Documents design and optional `./ui` entry
in Rho-plugins. Multiple views share one browser adapter per document; Documents
remains the sole buffer/undo owner. Required behavior includes bounded serial
input, native IME, cursor/selection retention, owner undo and recovery copies.
Conflicts retain unconfirmed input and stop automatic submission without rebasing.
Credentials and recovery content must stay out of URLs and diagnostics.

Tables' frontend entry uses AG Grid Community, 200-row blocks, five cached blocks,
supported single-column sort/single typed filter and stable key/namespace
selection. Unkeyed tables stay readable without entity linking. Consume the
[owner interfaces](PLUGIN-UI-HANDOFF.md) and
[draft contribution contract](../src/ui-contract.ts); UI protocol v1 is unfrozen.

After frontend delivery, review those actual entries, enable only required
browser operations and accept the installed dual-editor flow, real Chinese IME,
clipboard, conflicts, table identity, widths and accessibility. Until then the U1
shell retains unavailable renderers and its read-only browser ceiling.

## Verification scope

Owner tests cover lost replies, identity conflicts, clean-save receipt expiry,
interrupted replacement, outside writes, legacy state and Unicode/budget refusal.
Application tests exercise HTTP schemas, concurrent retries, lost Fetch replies,
service restart, live/exact/protected bindings, v1 projection and format-3 restore.
New application scenarios require zero instrumented Host-start/native-submit
attempts. SDK mutation transport uses an operator test credential; it does not
establish browser editing or input acceptance.

Run Rho-plugins `npm test`, then Rho `npm test` with the accepted Core artifact.
After building, the focused checks are
`node --test test/document-u2.test.mjs test/capabilities.test.mjs`.
Isolated owner imports check the headless package without React/DOM. Executed
counts and remaining work are recorded in [Status](STATUS.md).

The selected Documents owner source is
[`af6f634`](https://github.com/YuLab-SMU/Rho-plugins/commit/af6f634196fa8ae63a762ccdea050f0f30e224ff),
published before this application handoff. The 0.4.0 Documents tarball SHA-256 is
`a42e4c112f3304ca70eefc62c9ad5bca7f97ac109c25d896636123ddfac463d2`.
That fixed tarball passes isolated import and all six receipt/recovery scenarios,
with only Contracts installed alongside it. Rho's 38 tests and Plugins' 23 tests
pass. This is backend source/owner evidence, not an installed U2 browser candidate.
