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
