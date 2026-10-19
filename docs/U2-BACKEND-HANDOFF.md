# U2 Documents backend handoff

Updated: 2026-10-19. This document retains the backend prerequisite contracts.
Documents and Tables now integrate the existing frontend entries and confirmed
Paper design; see [U2 UI acceptance](U2-UI-ACCEPTANCE.md). Core remains unchanged.

## Owner and wire contracts

Rho-plugins owns document state, undo, conditional save and durable receipts.
`@rho-workspace/plugin-documents/contract` exports its pure Node schemas, not a
browser runtime. Rho's wire mirror is tested for exact parity. The Node/DOM-free
`@rho-workspace/local/browser` SDK types document reads, edits, saves and the
author/history operations described below.
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
project. `document.abandonSave` releases a pending save only when disk matches
neither its write condition nor its intended content. It requires `changeId`,
`expectedRevision` and the pending `pendingRequestDigest`, writes no disk bytes and
keeps the buffer, dirty state and undo. A resumable save is refused; resume it
instead. Paired browser tabs cannot call it. The selected Paper design gives the
external Agent responsibility for explicit save/recovery calls; the frontend
does not schedule writes or need to display their internal progress.

An editor following the shared buffer binds
`{document:{kind:"live-document",documentId}}`. It supplies no version. Presence
and the registered component's document role are validated. Existing
`{documentId,version}` remains exact: new stale bindings fail, retained references
do not migrate. Protected live views remain editable; layout/binding protection
still applies. Format-3 recovery retains bindings and receipts. The v1 bridge
projects ordinary document reads into its frozen shape and refuses live layouts.

## Author undo, individual revert and Show before

The reviewed [U2 Paper handoff](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-F-0)
assigns keyboard undo to the human's own edits and individual Revert to a chosen
Claude Code edit. The new owner operations are:

| Operation | Required business input | Result |
| --- | --- | --- |
| `document.undoOwn` | `documentId`, `expectedVersion`, `expectedRevision`, `changeId` | Reverses the authenticated caller's latest complete active input group |
| `document.revert` | The same conditions plus `targetChangeId` | Reverses one active retained content change, including another author's edit |
| `document.history` | `documentId` | Bounded change summaries, authenticated authors, groups, versions/digests, explicit compensation links and retention boundary |
| `document.change.read` | `documentId`, `targetChangeId` | Exact historical before/after text, versions and digests; changes no buffer state |

Rho adds `projectId` to all HTTP requests and injects the caller identity. An
`author` supplied in a request is rejected. Display names and binding metadata do
not establish authorship. Node entries are `undoOwn(id,version,author,change)`,
`revert(id,version,targetChangeId,author,change)`, `history(id)` and
`readChange(id,targetChangeId)` under the existing serialized writer boundary.

Keyboard undo must call `undoOwn`. Legacy `document.undo` retains its global
snapshot behavior for compatibility, and browser dispatch refuses it. There is
no new redo action. Selective undo/revert adds a new acknowledged change with
`reverts` links; it does not delete or rewrite old history. Repeated delivery uses
the original receipt and conditions. A second new reversal of an already reverted
change is refused. An active compensation record may itself be explicitly
reverted; its original target then becomes active again. This is an explicit
per-change action, not a separate keyboard redo stack.

The owner composes a retained input group and maps its inverse through later net
edits using explicit UTF-16 ranges. Unrelated text is preserved. Overlapping later
edits or ambiguous insertions at the same empty boundary produce `conflict` and
retain the whole current buffer. An incomplete or partly reverted input group
is refused as a group; retained individual edits can still be inspected/reverted.
No unconfirmed browser input is rebased by this calculation.

`maxHistoryEntries` defaults to 256 and `maxHistoryEdits` to 4096 per document.
Oldest history entries are evicted above either count, with
`historyRetainedFromVersion` / history response `retainedFromVersion` marking the
first retained change version. Missing before text is reported unavailable;
older undo snapshots are not presented as invented per-author history.
`maxUndoBytes` (8 MiB) covers legacy snapshots and retained inserted/removed text.
Exhausting it rejects the mutation before acknowledgement. Historical snapshots
also obey `maxBufferBytes`. Format-3 restore validates the history's version chain,
text ranges and before/after digests while preserving original authors.

The frontend team supplies the existing design's highlight switch, Changes list,
Show before and Revert controls. Compare remains inspection only. A merge report
must refer to an actual acknowledged Agent edit. This batch supplies history and
undo contracts; external-file merging and Agent scheduling still need their actual
consumer integration and existing disk write conditions remain enforced.

## Frontend integration

Documents and Tables now export optional `./ui` entries in Rho-plugins, using
the existing frontend implementation and the confirmed Paper design. Multiple views share one browser adapter per document; Documents
remains the sole buffer/undo owner. Required behavior includes bounded serial
input, native IME, cursor/selection retention, owner undo and recovery copies.
Conflicts retain unconfirmed input and stop automatic submission without rebasing.
Credentials and recovery content must stay out of URLs and diagnostics.

Tables' frontend entry uses AG Grid Community, 200-row blocks, five cached blocks,
supported single-column sort/single typed filter and stable key/namespace
selection. Unkeyed tables stay readable without entity linking. Consume the
[owner interfaces](PLUGIN-UI-HANDOFF.md) and
[draft contribution contract](../src/ui-contract.ts); UI protocol v1 is unfrozen.

U2 pairs new tabs with only the implemented edit/history/page/selection methods.
Saving, save abandonment, global undo, composition writes and native execution
remain excluded. Session `principalId` supplies “You”; receipt authors never do.
Exact-version editors read retained owner snapshots without joining the live
adapter, and have no Changes panel. Unavailable historical text retains its
original reference instead of showing the live buffer.

See [U2 UI acceptance](U2-UI-ACCEPTANCE.md) for source/installed browser evidence
and the remaining physical macOS IME and U3/U4 gates. Browser composition uses
Chrome’s CDP IME engine; it is not a manual candidate-window claim.

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

The backend-only prerequisite used Documents owner source
[`781a0f4`](https://github.com/YuLab-SMU/Rho-plugins/commit/781a0f42c9f2ddb9db801ca135734b8103276f94),
published before this application handoff. Its 0.4.0 Documents tarball SHA-256 is
`bbf4267f9ff64b7390276cb65f38437c30c2606a5ada9edba82b2bf33c4adfe1`.
That fixed tarball passes isolated import and 14 receipt/history scenarios with
only Contracts installed alongside it. Plugins' 31 tests and Rho's 40 tests pass
with the accepted Core artifact; the new real stdio MCP/HTTP flow starts no Host
and submits no native work. This is backend source/owner evidence, not installed
U2 browser or actual-model collaboration acceptance.
