# U1 installed browser shell checks

Recorded 2026-10-17. This accepts the engineering checks of the **U1 shell**, not
the full UI collaboration loop, UI protocol v1 or a released product. The V0.1
adaptation still needs user review. U2-U4 are not implemented. Historical
[headless collaboration acceptance](COLLABORATION-ACCEPTANCE.md) is unchanged.

The [machine-readable record](ui-acceptance/u1.json) freezes selected sources,
owner tarballs, browser assets, licenses, production locks, installation scenarios,
failures and limits. [Browser implementation](UI.md) documents the actual entry
and the four-stage boundary.

## First-use correction: named projects and source folders, 2026-10-22

User review rejected the path-entry sheet, the temporary preview scope and the
one-folder project model. The old seven-batch checks remain historical engineering
evidence. The correction follows the user-provided Create project reference:
a display name, Source folders and a native macOS Add folder window. Existing
folders stay in place; names do not create same-name directories. Overview adds
further sources to the same project. There is no fixed-prefix path input.

The source candidate selects Documents 0.4.2, Files 0.4.1, R 0.4.1 and
Annotations 0.4.2 (optional Documents peer compatibility). Rho passes
66/66 application checks; Plugins passes 46/46 component checks. The 12 browser
boundary tests cover selected-folder authorization, cancellation, post-dialog
revocation, project creation replay, source addition, equal filenames, retained
buffers and restart/fresh-tab visibility. Component checks perform actual source
reads, conditional saves, external-write conflicts and saved-script planning.
No model calls, scientific refits or Core changes are needed for these checks.

Local evidence is retained in `work/multisource-*` and the Plugins source-folder
regression. The first browser attempts retained failures for obsolete typed-path
expectations, focus restoration while a trigger was disabled and Dockview's
programmatic tab activation/disposed API on narrow-to-wide return. The final
Chrome 155 run passes 23 checks at all five widths, with zero Host starts/native
submissions and no page errors (`work/multisource-browser-verified/report.json`).
An initial offline assembly rejected Annotations’ old exact Documents peer;
the bounded peer declaration was updated before rebuilding.
Source-folder picks in that runner use trusted fixtures; the real local system
chooser also opened a folder outside the preview startup root during user review. Paper has separate native-folder and multi-source review drafts; prior
boards were preserved. User design acceptance remains pending. Other-platform
system dialogs, source removal after creation and broad native multi-folder
execution/installation acceptance are not claimed.

## Catalog completion and rebuilt packages: 2026-10-18

The [completion record](ui-acceptance/u1-plugin-completion.json) freezes Rho
`6598ec333366cfc2215e5bb2e50123a75c24dafc` and Plugins
`dddd9833f233380556bce823c735b6ba52b371b2`, their trees, all owner tarballs,
catalog inventory, browser assets and production locks. Selected inputs are
committed, with no dirty override. Existing local design edits are preserved and
excluded. The accepted public Core binary is reused by digest without rebuilding.
The older identities and evidence below retain their original historical scope.

Nine owner descriptors now supply icons, body descriptions, real Skill names and
descriptions, action/view descriptions, category and entry order, developer,
license, public links, external-tool use and dependency purposes. Rho renders
those fields. The catalog follows Paper's Code & data, Figures & media, Working
with your Agent and Project files order, including the order within each group.
R's read action precedes its run action.

R and Requirements observe the selected Rscript executable file without running
it. A missing executable names the limitation and who can resolve it; R still
supports exported object reads. This is not an R version/package/readiness check.
The owner fixture would write a marker if executed; no marker is created.
Source regression also reads a real exported Unicode object without Rscript.

The build freezes an introduction-only inventory for all nine owners. Reduced
packages keep those introductions without importing absent owners, adding callable
Skills, enabling operations or expanding grants. Both fixed tarballs were
installed with `npm install --omit=dev --ignore-scripts` outside the checkouts:

| Composition | Tarball SHA-256 |
| --- | --- |
| Full, nine owners plus Contracts | `ed6b5312132cab8acec6d1a4d6294f968a961ab8f0df3dccc9c4f4aae35daed0` |
| Documents/Files plus Contracts | `c977b90b4e86ceb5d3f9c5968a25bbf1fe9a3289a4188174a36720506b646999` |

Both installed catalogs pass all nine detail pages, 27 actual clipboard copies,
focus return, missing-metadata fallback and 1600/1280/1024/768/390 widths. The
minimal installation physically omits the other seven owners, csv-parse and the
MCP SDK; every absent owner reports Not part of this installation and has no
project-use claim or callable entry. The full installation additionally passes
the missing-Rscript state and the whole existing U1 browser acceptance flow.
Every browser run records zero Host-start and native-submit attempts.

Rho's staged tree passes `npm test` 36/36 and `test:ui` browser/security 9/9 plus
the acceptance flow. Plugins passes 17/17 and all nine isolated owner imports.
Initial failures are retained: the first owner run exposed the finite Contracts
export guard; the first Rho run had no selected Core executable. After correcting
the guard and selecting the accepted binary, the checks pass. Neither failure is
counted as a pass.

Screenshot inspection covers all nine detail pages and their Information sections,
catalog/detail top and bottom at five widths, partial native availability and an
actual absent-owner detail. Text wraps, SVG/text icons, dependency buttons, links
and the narrow Information stack remain legible without overlap or horizontal
overflow. Evidence is retained under `work/ui-u1/plugin-completion-*`. Paper's
U1 rules, R detail and missing-Rscript copy are updated. Documentation links and
rendered pages are checked as a coherent batch.

This completes the implementation and installed U1 catalog checks. User design
acceptance remains pending; functional renderers, U2-U4 and signed/registry
distribution are not accepted by these checks. No user installation is replaced.

## Original selected identities

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

## U1 alignment batch 4: inside a project

Recorded 2026-10-17 for source after `b1047ede`. The installed tarballs and
selected identities above were not rebuilt or reselected.

The project follows U1-04 and U1-05:

- The sidebar lists Overview, then Layouts with each layout's view count ("None
  saved yet" when there is none), then Content with Documents and Files and
  their counts. "Retained operations" appears only when there are some.
- The overview shows the project name, its location and when it was added. With
  no layout it says "No saved layout yet"; once a layout exists it lists layouts
  instead. Documents and Files are tables with readable states such as "Unsaved
  changes", "Can't be read" or "Last seen 1.2 MB". A layout saved elsewhere
  appears in the overview and sidebar without moving the reader away.
- Layout views are Dockview tabs with an icon for what each view shows. The
  select remains below 768 until batch 6.
- An unavailable view is titled "This view can't be shown here yet". It says
  what it Shows, what it Needs and what is In this build, and that the content
  is untouched and nothing was installed or rerun. About opens the view's plugin
  with "Back to" the project, which returns to the same layout. View, component
  and binding identifiers appear only in View reference.
- The main area shows no JSON or code blocks.

The Paper spec board records these rules under 项目内, including two
differences from the boards: the subtitle says "added" because the service
records when a project was added, and the overview lists layouts when there are
some.

`npm run build:web` passes on the staged tree exported outside the checkout,
with browser asset inventory SHA-256 `94b00870e5f5061509f56dd0ee476c8102a4f2a003ba20d505a82f9dc2af5922`.
`npm run test:ui` passes there in Chrome 155.0.8059.84: nine browser/security
tests, then acceptance with **0 / 0** Host-start/native-submit attempts. The new
assertions cover:

- the project title, Overview as the current row, "None saved yet", no
  "Retained operations" row and the Documents 0 / Files 0 sections
- no `pre` or `code` element and no JSON text in the main area, at all five
  widths for the overview and the unavailable layout
- Files in the sidebar focusing the Files section
- a layout created by the operator appearing in the overview without moving the
  reader, then opening from the sidebar with "1 view"
- Shows / Needs / In this build, the document line "notes 中文.md · version N ·
  unsaved changes", and the document ID hidden until View reference opens
- a remote second view arriving as a tab, the sidebar changing to "2 views" and
  focus staying on View reference
- About opening the plugin and "Back to notes 中文" returning to the layout

Rho `npm test` passes 36/36 on the same staged tree with `RHO_CORE_BINARY` set
to the accepted Core artifact.

Screenshots under `work/ui-u1/batch4-staged-20261017-125516` were compared with
U1-04 and U1-05: `overview-*` and `layout-unavailable-*` at all five widths and
`workspace-*` and `context-*` with one view.

Remaining differences:

- The test folder is under `/tmp`, so the sidebar location wraps to two lines.
- The test project has no registered files, so the Files table and its states
  are not in the screenshots. The empty sentence is shown instead.
- Below 768 the view select and the rail remain until batch 6.

User design acceptance is still pending.

## U1 alignment batch 5: disconnect and commands

Recorded 2026-10-17 for source after `f7cfe82a`. The installed tarballs and
selected identities above were not rebuilt or reselected.

Disconnection and commands follow U1-07 and U1-08:

- When Rho can't be reached, a grey notice above the layout says "Can't reach
  Rho. You're seeing what was read at HH:MM." with a Reconnect button. Views,
  tabs and the sidebar keep what was read.
- Reconnect reads again and starts nothing. While it runs the notice says
  "Reconnecting." and the button is disabled. The last failure is shown under
  Context & access, next to "Offline since HH:MM".
- The command palette opens with focus in a "Type a command" filter. Commands
  are grouped as Go to, View, Connection and This tab. The footer says
  "Commands only. To ask about your work, use Claude Code." with ↑↓ and ↵ hints.
- Show and Hide follow the current state of project navigation and context.
  Refresh and Reconnect say they read again and start nothing.
- Text that matches no command shows "No command matches" and Enter runs
  nothing.

Two defects were found and fixed:

- A palette closed by running a command could close again if it was reopened
  before the browser delivered the close event. The palette now ignores a close
  event that arrives after it reopened.
- After the window narrowed and widened again, the two views came back as two
  side-by-side groups in reverse order. They now return as tabs of one group in
  layout order.

The Paper spec board records these rules under 断线与命令.

`npm run build:web` passes on the staged tree exported outside the checkout,
with browser asset inventory SHA-256 `46347fc621043f28d383d0fc86c50bf74cca9480e4ee868334277c965212d18d`.
`npm run test:ui` passes there in Chrome 155.0.8059.84: nine browser/security
tests, then acceptance with **0 / 0** Host-start/native-submit attempts. The new
assertions cover:

- focus in the filter, the placeholder, group headings, every command label and
  the footer
- arrow keys wrapping from the first to the last command, and Enter running the
  selected one
- "Show context & access" opening the panel and the next palette offering
  "Hide context & access"
- a typed question matching no command, showing the empty text, and Enter
  leaving the palette open
- the offline notice text, the retained tabs and views, and Reconnect in the
  palette while offline
- "Offline since HH:MM" with the last failure under Context & access
- Reconnect showing "Reconnecting." with the button disabled, then Up to date
  with the notice gone
- every request Reconnect made being a read: `project.list`, observation reads,
  the event stream, `capability.list` and `composition.read`
- after the narrow widths, one view group with the tabs "Shared notes" then
  "Second view"

Rho `npm test` passes 36/36 on the same staged tree with `RHO_CORE_BINARY` set
to the accepted Core artifact.

Screenshots under `work/ui-u1/batch5-staged-20261017-131223` were compared with
U1-07 and U1-08: `commands-*` and `offline-*` at all five widths,
`status-offline-1280`, `status-connecting-1280` and `offline-context-1440`.

Remaining differences:

- The test folder is under `/tmp`, so the sidebar location wraps to two lines.
- Below 768 the view select and the rail remain until batch 6.

User design acceptance is still pending.

## U1 alignment batch 6: narrow widths

Recorded 2026-10-17 for source after `3b19ac7b`. The installed tarballs and
selected identities above were not rebuilt or reselected.

Below 768 the shell follows U1-09a, U1-09b and U1-09c:

- There is no rail or sidebar. The toolbar is 48 high. Its first line is the
  layout name (the project name on the overview) and its second line is the
  project, or "Overview", followed by "Read-only". The status is a dot, and the
  Commands button is not shown. Toolbar targets are 36 pixels.
- The left button opens a navigation drawer on every page. It has a "Rho"
  header with a close button, Home / Projects / Plugins, the project's
  Overview, Layouts and Content when a project is shown, and Commands at the
  bottom. Rows are 40 high. A choice closes the drawer. Commands closes the
  drawer and opens the palette, which returns focus to the navigation button.
- Context & access opens as a bottom sheet with a handle and Done, holding the
  Connection, This tab and Agents sections.
- The drawer and the sheet are modal. Tab and Shift+Tab stay inside, and
  Escape, the backdrop or their own button closes them and returns focus to
  the button that opened them.
- Views are tabs instead of a select. Arrow keys, Home and End move between
  them and show the view.
- An unavailable view stacks Shows, Needs and In this build, with a full-width
  About button above View reference.

The Paper spec board records these rules under 窄屏, including three choices
the boards do not show: the drawer on Home has no project section, the overview
says "Overview · Read-only", and the sheet leaves out the footnote.

`npm run build:web` passes on the staged tree exported outside the checkout,
with browser asset inventory SHA-256 `307fa1ed3877a3c534ca9aa4904bee787c3ec642ec86b2d1fead96b27101d465`.
`npm run test:ui` passes there in Chrome 155.0.8059.84: nine browser/security
tests, then acceptance with **0 / 0** Host-start/native-submit attempts. The new
assertions cover, at 390:

- no visible rail, no sidebar, a 48-pixel toolbar, the two location lines, no
  visible Commands button and toolbar buttons at least 36 high
- the drawer's header, sections, current rows and Commands, its buttons at
  least 36 high, focus kept inside for Tab and Shift+Tab, and Escape returning
  focus to the navigation button
- Commands in the drawer opening the palette with "Show navigation", and
  Escape returning focus to the navigation button
- choosing Overview and then the layout closing the drawer each time
- on Home, the drawer with Home current and no project section
- the context sheet anchored to the bottom at full width with three sections,
  focus kept inside, and Done and Escape returning focus to its button
- the view tabs "Shared notes" and "Second view", no select, ArrowRight and
  Home changing the shown view, and the panel labelled by the selected tab

Rho `npm test` passes 36/36 on the same staged tree with `RHO_CORE_BINARY` set
to the accepted Core artifact.

Screenshots under `work/ui-u1/batch6-staged-20261017-132357` were compared with U1-09a, U1-09b and U1-09c:
`navigation-390`, `context-390`, `tabs-390`, and the 390 screenshots of home,
overview, offline, commands and the unavailable layout. The 768 screenshots
still show the rail and sidebar.

Remaining differences:

- The test folder is under `/tmp`, so the project location is longer than on
  the boards.
- The sheet's height follows its content; the board shows a taller sheet.

User design acceptance is still pending.

## U1 alignment batch 7a: plugin naming and states

Recorded 2026-10-17 for source after `14851c7a`. The installed tarballs and
selected identities above were not rebuilt or reselected.

Plugins follows U1-06c:

- A usable plugin shows no state. The detail page shows "Installed" with a
  check, or "Not installed".
- A plugin that can't be used gives one reason and who can change it:
  - "Not part of this installation": Rho on this machine was installed without
    it; reinstalling with the full plugin set adds it.
  - "Needs X": a plugin it needs isn't part of this installation.
  - "Off in project": Claude Code can't use it in this project; whoever runs Rho
    can turn it on.
  - "Waiting for X": it needs X, which is off in the project, with About X.
- Catalog cards show the reason in place of the tagline. Plugins that are not
  part of this installation form a "Not installed" group, last.
- No Capabilities wording, Present / Enabled / Satisfied flags or method names
  appear. The unused `.capability` styles are removed.

Opening a card focused its title, but going back moved focus to the card one
frame later. `test:ui:plugins` checks focus at once and already failed at
`14851c7a`. Focus now returns in the same update.

The Paper spec board records these rules under 插件状态, including two
differences from U1-06c. The waiting text says "Charts needs Tables" because
descriptors don't say what a plugin uses another for. The board's "can't run
scripts on this machine" state has no catalog field yet and is not shown.

`npm run build:web` passes on the staged tree exported outside the checkout,
with browser asset inventory SHA-256 `9a42e3ea8e72c8d4dce31ffac6274bcdcc60b703f351679886e44c852aaf742b`.
`npm run test:ui` passes there in Chrome 155.0.8059.84: nine browser/security
tests, then acceptance with **0 / 0** Host-start/native-submit attempts.
`npm run test:ui:plugins` passes on the same tree with 0 / 0 attempts. The new
`test:ui` assertions cover:

- no "capabilit", Present, Enabled or Satisfied text, and none of the catalog's
  method names, on the catalog and on each detail page visited
- no state line on any card while every plugin is usable
- with Tables turned off for the project by the operator: Tables "Off in notes
  中文", Charts "Waiting for Tables", and no other state line
- Charts' detail with "Installed", "Waiting for Tables" and "Charts needs
  Tables, which is off in notes 中文."
- About Tables opening Tables with "Off in notes 中文" and who can turn it on
- turning Tables back on removing the notice and the card states

Rho `npm test` passes 36/36 on the same staged tree with `RHO_CORE_BINARY` set
to the accepted Core artifact.

Screenshots under `work/ui-u1/batch7a-staged-20261017-133557` were compared with U1-06c: `plugins-1280`,
`plugins-bottom-1280`, `plugins-states-1280`, `plugin-waiting-1280` and
`plugin-off-1280`. They replace `capabilities-1280` and
`capabilities-bottom-1280`. Plugin page screenshots are under
`work/plugin-ui/batch7a-staged-20261017-133557`.

Remaining differences:

- Plugins use one generic symbol; descriptors have no icon.
- "Not part of this installation" was not exercised, because the acceptance
  installation has every plugin. A plugin that isn't loaded has no descriptor,
  so its name falls back to its ID.

User design acceptance is still pending.

## U1 alignment batch 7b: plugin catalog and detail

Recorded 2026-10-17 for source after `c42b2925`. The installed tarballs and
selected identities above were not rebuilt or reselected.

Plugins follows U1-06, U1-06b and U1-06d with copy from plugin descriptors:

- Plugins has its own sidebar: "Plugins", "N installed on this machine", All
  plugins, then each installed plugin. Only one row is current. The rail
  highlights Plugins on the catalog and on a plugin's page.
- The catalog says "Plugins let Claude Code work with your code, data and
  figures, and let you see that work here." Cards are 68 high with the
  tagline in regular weight.
- A plugin's page has a large symbol, its name and tagline, and Installed. Its
  example prompts sit in a tinted panel with Copy buttons and "Copy one and ask
  Claude Code." Then come "What Claude Code can do with it", with Reads and
  Runs code markers, Views with a count and "Not in this build yet", and
  Information.
- Information starts with "In project": on, off, or on but waiting. Then come
  the plugins it works with as links, category, version and package.
- The toolbar shows "Plugins › name". Plugins returns to the catalog and
  focuses the card the plugin was opened from. Below 768 the page also has All
  plugins, because the sidebar is in the drawer.
- About from a project shows that project's state and "Back to project", which
  returns to the same layout.

The Paper spec board records these rules under 插件详情, including what is not
shown because descriptors don't provide it: a description paragraph, Skills,
descriptions of actions and views, plugin icons, Uses, Developer, License,
Source, Privacy, and why one plugin works with another. Catalog and group order
follow the installation's order.

`npm run build:web` passes on the staged tree exported outside the checkout,
with browser asset inventory SHA-256 `caab1eebb88df71764f44056a2e86a0b8db5b649383ddd3e6259fdead2db7404`.
`npm run test:ui` passes there in Chrome 155.0.8059.84: nine browser/security
tests, then acceptance with **0 / 0** Host-start/native-submit attempts.
`npm run test:ui:plugins` passes on the same tree with 0 / 0 attempts, reading
action and view names from their new place and going back through All plugins.
The new `test:ui` assertions cover:

- About from the project: the plugin current in the Plugin navigation sidebar,
  Plugins current in the rail, "Plugins" and the name in the toolbar, and "In
  notes 中文" with "On. Claude Code can use it in this project."
- the catalog subtitle, All plugins current, "9 installed on this machine" and
  every plugin under Installed
- Charts with Tables off: the three section headings, the prompt note, "On, but
  waiting for Tables." and Tables under Works with
- Tables while off: "Off. Claude Code can't use it in this project."
- Tables turned back on: "On. Claude Code can use it in this project.", All
  plugins visible at all five widths, and "Tables" over "Plugins" at 390
- the toolbar's Plugins returning to the catalog with focus on the Tables card

Rho `npm test` passes 36/36 on the same staged tree with `RHO_CORE_BINARY` set
to the accepted Core artifact.

Screenshots under `work/ui-u1/batch7b-staged-20261017-134523` were compared with U1-06, U1-06b and U1-06d:
`plugins-1280`, `plugin-about-1280`, `plugin-waiting-1280`, `plugin-off-1280`
and `plugin-detail-*` at all five widths. Every plugin's page at 1600 and the
catalog and detail at five widths are under `work/plugin-ui/batch7b-staged-20261017-134523`.

Remaining differences:

- Descriptors provide no icon, description, Skills, entry descriptions,
  developer, license or links, so those parts of U1-06b are not shown. The
  example prompts keep the quotation marks the descriptors include.
- Groups appear in installation order (Code & data, Project files, Figures &
  media, Working with your Agent), not the board's order.
- There is no "…" menu next to Installed; the board doesn't say what it holds.

All seven batches of the U1 alignment plan are implemented. User design
acceptance is still pending.

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
