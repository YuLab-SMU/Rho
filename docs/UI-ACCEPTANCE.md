# U1 installed browser shell checks

Recorded 2026-10-17. This accepts the engineering checks of the **U1 shell**, not
the full UI collaboration loop, UI protocol v1 or a released product. The V0.1
adaptation still needs user review. U2-U4 are not implemented. Historical
[headless collaboration acceptance](COLLABORATION-ACCEPTANCE.md) is unchanged.

The [machine-readable record](ui-acceptance/u1.json) freezes selected sources,
owner tarballs, browser assets, licenses, production locks, installation scenarios,
failures and limits. [Browser implementation](UI.md) documents the actual entry
and the four-stage boundary.

## Selected identities

| Item | Selected identity |
| --- | --- |
| Rho source | `e95bfbfa5eefc63b8135d3b6339434b266f7aa22` |
| Rho tree | `78d1910895a0961e452a17eea37a5315c525c668` |
| Plugins source | `e3a8e961c7f097eae27c93e8f46f4492afa517c3` |
| Plugins tree | `a3df1c7cc36fc723591804ab7b726dbd17d0b89a` |
| Accepted public Core | `d0159da6feb01d1be9e3b4b34b67953241fedfcb` |
| Core artifact SHA-256 | `eee223026f7e0b4dd1ee14a409c023919626c4175be5728048a02af739af4ce1` |
| Browser asset inventory SHA-256 | `5f5ab1d042708250088d8d7351e8bffb2fa785e1a484e01275f1215685c034ca` |
| Functional UI entries | None selected; contribution contract `0.1-draft` |

All selected build inputs are committed, with no dirty build override. Existing
uncommitted design documentation in Rho and Plugins is preserved and not selected.
Core was not rebuilt or modified. Plugins source and tree were checked against
organization `main`; the public Core commit/tree remains available remotely.
Application source publication is verified separately from installation evidence;
this record does not predeclare the result of a later push.

The dependency lock selects React/React DOM 19.3.1, Dockview/Dockview React 8.6.0,
Vite 8.3.4 and TypeScript 5.9.3. Dockview uses MIT features only. The record also
includes transitive runtime versions, the license inventory and every asset hash.
Playwright 1.64.1 is an external test driver, not a production dependency.

## Outside-checkout installations

Both assembled `@rho-workspace/local` 0.4.0 tarballs were installed with
`npm install --omit=dev --ignore-scripts` into fresh directories under
`/private/tmp/rho-ui-install-rquIOY`, outside all three source checkouts.
Each installed CLI launched the service with its digest-checked bundled Core;
the driver used the installed acceptance script and production assets.

| Combination | Tarball bytes / files | Tarball SHA-256 |
| --- | --- | --- |
| Full: nine owners plus Contracts | 6,552,148 / 3,853 | `cb2a7ac983d474d63d79edc1905f784ce8ad0cfa5b4a212fb5b00a5f2f179312` |
| Minimal: Documents, Files plus Contracts | 2,893,641 / 636 | `3fd72ca371cd8b22e484f1c0757b5eb9fcc4c45f56ebfa9ef6b9a87e7e47c6be` |

Physical package inventories match those selections. The minimal package excludes
the other seven owners, csv-parse and the MCP SDK; it does not merely hide controls.
Neither production installation requires React, Dockview, Vite or Playwright as
Node packages. Headless client/browser/contribution imports work without a DOM.

Both U1 browser builds deliberately select zero functional UI entries. Their
asset inventories match and contain no owner implementations, CodeMirror, AG Grid
or ECharts. This establishes U1 absence, not later build-time stripping of an
implemented owner UI; that still requires U2-U4 evidence.

## Executed scenarios

- Rho `npm test`: 33/33, including nine browser/security tests. These cover
  concurrent one-use pairing, project/method scope, hostile Host/Origin, wrong
  credentials, traversal/symlinks, body limits, grant persistence, revocation and
  expiry before dispatch or event delivery.
- Plugins `npm test`: 14/14. No owner source changes are selected in U1.
- Real Chrome source and both installed combinations pass pairing, Unicode
  project creation, scope rejection, actual capability discovery, unavailable
  retained views, refresh and stable-ID remote view insertion without focus theft.
- Keyboard command dialog, focus return, navigation/context drawers and
  1600/1280/1024/390 widths pass. Screenshots are inspected for clipping, overflow
  and missing glyphs; screenshot assertions alone are not design approval.
- Offline state retains the last confirmed snapshot; explicit reconnect rereads
  it. Same-origin, same-port service restart retains the browser grant and owner
  content. Browser closure does not dispatch work or create a Host socket.
- Each browser runner instruments Host-start and native-submit attempts: **0 / 0**.
  No bearer credential is placed in the URL, localStorage, static assets, reports
  or diagnostics. Only the current origin's sessionStorage retains the tab token.
- The installed `rho --pair` command issues a fresh one-time code for an explicitly
  narrowed subroot. Unicode creation works; sibling-root access and code reuse fail.
- Source and installed deterministic real stdio MCP collaboration regressions
  pass with **0 / 0** native attempts, including protection, exact anchors, linked
  replies, event gaps and format-3 restore. This is not a new real-Claude UI trial.

Independent installed native recovery also passes: real partial computation
publishes four rows; closing observation/view/Agent binding does not cancel it;
rebinding observes the original request. Injected Host loss retains original
identity, bytes and unknown outcome without replay. A separate explicit cancel
checks process-group release. These native checks do not accept a browser
execution center, and are not included in the zero-native UI path.

## U1 alignment batch 1: appearance

Recorded 2026-10-17 for source after `9cd090f4`. This batch aligns appearance
only with the spec board on Paper's "Rho · U1 补稿（代码对齐）" page. Structure,
copy and the narrow redesign are later batches. The installed tarballs and
selected identities above were not rebuilt or reselected.

- Tokens follow the board: canvas `#F7F7F5`, accent `#3A68F0`, selection
  `#E8EEFD` with `#2347B8` ink, weights 400/600 only and the 28/20/14/13/12/11
  type scale. Pairing keeps the board's 22 px title; the 390 view title uses
  the board's 18 px.
- Geometry: toolbar 44, rail 64, sidebar 232, context 330; buttons 32/r8, inputs
  r8, Dockview tabs 30/r7 on a white 48 px bar, status pill 28 fully rounded and
  panels r12. Only an observing or paired connection shows the green dot.
- Below 1280 the context drawer overlays the canvas. Below 768 (previously 700)
  navigation becomes a drawer, with 36 px hit targets and a 48 px toolbar.
- Acceptance asserts rendered weights 400/600 and accent-colored enabled primary
  buttons on pairing, home and every width, and adds 768 to 1600/1280/1024/390.
  Command-dialog focus return waits up to 2 s for Dockview to settle instead of
  reading once.

`npm run build:web` passes. `npm run test:ui` passes in Chrome 155.0.8059.84:
nine browser/security tests, then acceptance at all five widths with no document
overflow and **0 / 0** Host-start/native-submit attempts. Rho `npm test` passes
33/33 with `RHO_CORE_BINARY` set to the accepted Core artifact. Without it, eight
execution tests fail with "Required executable is unavailable"; that is an
environment precondition, not a regression. Plugins `e3a8e96` was built from a
clean `git archive` export because the local Plugins checkout carries unrelated
uncommitted work.

Screenshots under `work/ui-u1/batch1-20261017-084410` were compared with U1-01,
U1-02, U1-04 and U1-09a. Remaining differences belong to later batches: pairing
eyebrow, wordmark and state copy; the rail on pairing and below 768; the view
selector instead of tabs; unavailable-view explanation rows; and the closed
sidebar after a 390 to 1280 resize. User design acceptance is still pending.

## U1 alignment batch 2: toolbar, rail and Agent-opened tabs

Recorded 2026-10-17 for source after `a251a788`. The installed tarballs and
selected identities above were not rebuilt or reselected.

People no longer pair a browser. The user rejected a human-entered code, so
the pairing form and the U1-01/01b pairing card and failure states are not built.

- The launcher and `rho --pair` print `openUrl`, which is the service URL plus
  `#pair=<one-time code>`. With `--open`, they pass it to the platform opener.
- The page redeems the fragment code through the unchanged pair endpoint, then
  removes it from the address bar before rendering.
- Without a link, the page says "Open Rho from your Agent". A reused link says
  "This link has already been used". There is no input.
- The pair result now includes the principal root, which the context panel
  shows as Folder.
- A rejected credential returns the tab to the not-connected page. Scope and
  network failures keep the session.

Toolbar, rail and context follow U1-04, U1-07 and U1-08:

- The wordmark appears only on the not-connected card.
- Location is "project / layout" plus a Read-only chip, "Home" or "Plugins".
- The status reads "Up to date 10:24", "Offline last read 10:24" or
  "Connecting", with "last read" when there was an earlier read. Below 768 only
  the dot shows; the words stay for assistive technology.
- The context toggle is an icon, and the shortcut shows ⌘K on macOS.
- Projects is highlighted inside a project and Plugins on the catalog.
- The context panel has Connection, This tab and Agents sections.
- Commands are grouped Go to, View, Connection and This tab, with Show/Hide verbs
  and the Claude Code footer. Search input and the offline banner remain batch 5.
- "Unpair this tab" is now "Disconnect this tab". It sits in the context panel
  and in Commands. A confirmation dialog appears first; Escape cancels and
  returns focus to the button that opened it.
- Below 768 the layout name is hidden. The two-line narrow title remains batch 6.

`npm run build:web` passes on the committed tree (built in a clean worktree), with browser asset inventory SHA-256 `3f5ab4e49b67d15936ced0bf88f20e4bf715f616bc561372b936963e7c228c38`.
`npm run test:ui` passes in Chrome 155.0.8059.84: nine browser/security tests,
then acceptance at 1600/1280/1024/768/390 with no document overflow and **0 / 0**
Host-start/native-submit attempts. The new assertions cover:

- `openUrl` shape and fragment removal
- an operator `--pair` link connecting one tab and refusing a second
- toolbar location and rail `aria-current`
- the three status texts, with the in-progress state held by delaying one snapshot
- disconnect confirmation from Commands and from context, cancelled with Escape
  and focus returned
- a confirmed disconnect clearing tab storage

Rho `npm test` passes 36/36 with `RHO_CORE_BINARY` set to the accepted Core
artifact. With a stub `open` on `PATH`, `--open` on the launcher and on
`--pair` each invoked the opener with exactly `openUrl`. No real browser was
opened. Linux and Windows openers are not verified.

Screenshots under `work/ui-u1/batch2-staged-20261017-114223` were compared with U1-04,
U1-07, U1-08 and U1-09a:

- status: `status-online/offline/connecting-1280`
- `context-*` at all five widths
- `disconnect-confirm-1600`, `not-connected-1600`, `link-used-1600` and
  `disconnected-1280`

Remaining differences:

- Folder shows the absolute root, not `~/projects`; the browser cannot know the
  home directory.
- The offline banner copy, the command search input and the view selector belong
  to later batches.
- Home still says "paired root"; batch 3 replaces that copy.
- The not-connected card has no board yet.

User design acceptance is still pending.

## U1 alignment batch 3: home

Recorded 2026-10-17 for source after `5172d0e3`. The installed tarballs and
selected identities above were not rebuilt or reselected.

The home follows U1-02, U1-03 and U1-03b:

- With projects, the title is "Welcome back" and Open folder… and New project
  sit beside it. Without projects, the title is "Welcome to Rho" and both
  actions appear only in the empty panel.
- Rows show the folder name, its location and when it was added: "Today at
  12:07", "Yesterday" or "Oct 9". The full date and time are in the tooltip.
  The newest project comes first.
- New project and Open folder open a 480-wide sheet. Focus starts in its field
  and Tab or Shift+Tab stays inside. Escape or a backdrop click closes it and
  returns focus to the button that opened it. It cannot close while a request is
  in flight.
- Open folder shows the tab's folder as a fixed prefix. A pasted full path
  inside it keeps only the relative part.
- Each refusal names the next step:
  - an existing name offers Open existing
  - a missing folder offers Create it
  - a "/" in a name offers Use Open folder
  - a path outside the folder asks the Agent to open Rho for a folder that
    includes it, and Open stays disabled
- "Open another project…" in Commands returns home with focus on the newest
  project. After a project opens, focus moves to the workspace.
- The home no longer mentions a paired root or pairing.

Service changes:

- The pair result adds `rootLabel`: the folder relative to the user's home, such
  as `~/projects`, or the absolute path outside home. Requests still use
  root-relative paths.
- `project.create` on an existing folder returns `conflict` instead of a storage
  error and never adopts the folder.

The Paper boards were changed to match before commit:

- The U1-02 list heading "Recent / Last opened" is now "Projects / Added". The
  service records when a project was added, not when it was last opened; this
  answers open question d.
- U1-03b ④ asks the Agent instead of asking for a code. New states ⑤ (missing
  folder, Create it) and ⑥ ("/" in a name, Use Open folder) were added, and the
  spec board records the home rules.

`npm run build:web` passes on the staged tree exported outside the checkout,
with browser asset inventory SHA-256 `a08287afe555a049a8c462f89cb862ddeee4e5328393d61215f23e4b1218b653`.
`npm run test:ui` passes there in Chrome 155.0.8059.84: nine browser/security
tests, now with create `conflict`, open `not_found` and the `~/` label, then
acceptance with **0 / 0** Host-start/native-submit attempts. The new assertions
cover:

- empty-home copy, both actions only in its panel and no pairing text
- focus in the sheet field, six Tab/Shift+Tab presses staying inside, and
  Escape and backdrop closing with focus returned
- the outside and missing-folder messages with their next actions, and a pasted
  full path reduced to `missing`
- the "/" check, the create preview, and Enter creating `notes 中文` with focus
  moved to the workspace
- row name, location, "Added Today at HH:MM" and a dated tooltip
- an existing name offering Open existing, which opens the same project without
  registering another
- "Open another project…" focusing the newest row

Rho `npm test` passes 36/36 on the same staged tree with `RHO_CORE_BINARY` set
to the accepted Core artifact.

Screenshots under `work/ui-u1/batch3-staged-20261017-121432` were compared with
U1-02, U1-03 and U1-03b:

- `home-empty-*`, `home-*` and `sheet-new-*` at all five widths
- `sheet-open-1600`, `sheet-open-outside-1600`, `sheet-open-missing-1600` and
  `sheet-exists-1280`

Remaining differences:

- The test folder is under `/tmp`, so screenshots show an absolute path instead
  of `~/projects`. The service test covers the `~/` form.
- "Added" is not "Last opened". Showing the last open needs the service to
  record opens.
- Below 768 a row keeps the time beside a wrapped path. The narrow home has no
  board yet; narrow layouts are batch 6.
- Tabs connected before this change show the absolute folder until the Agent
  opens a new link.

User design acceptance is still pending.

## Evidence and limits

Local ignored evidence is under `work/ui-u1`: fixed full/minimal composition
records and tarballs, installation inventory, browser reports/screenshots, source
test output, installed MCP/native regressions and pairing-CLI checks. The tracked
JSON includes report digests without pairing codes or bearer values. Initial
failed trials are retained: Unicode schema, native Fetch receiver, Dockview
exports/events, accessible picker labels and test locator/Host-driver mistakes.

Documentation link/anchor checking and rendered publication-index inspection
cover the changed coherent batch. The UI takes its compact visual language from
Paper's Rho experience V0.1, not the rejected Main app / Composable shell. The
added U1 board is an adaptation for review, not an approval record.

Verified environment: macOS arm64, Node 22.22.3, npm 10.9.8, Python 3.13.1,
Chrome 155.0.8059.84 and external R 4.5.2 for the separate native regression.
The requested Chrome 154 baseline is not installed or verified.

Still pending: Documents/Tables renderers and change receipts, real native
editor IME/clipboard, conditional Dockview geometry and browser protection,
actual browser/Claude Code shared editing, chart/entity selection, feedback/context
and explicit-reply UI, browser archive recovery, heavy-view budgets, complete
accessibility/performance acceptance and UI protocol v1. No npm registry
publication, signing, desktop client or other-platform acceptance is claimed.
