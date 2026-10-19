# U2 editor and table browser evidence

This batch finishes the existing frontend implementation against the confirmed
[U2 Paper design](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-F-0).
It does not redesign the UI or accept the U3/U4 collaboration loop. The earlier
[headless acceptance](COLLABORATION-ACCEPTANCE.md) and
[U1 evidence](UI-ACCEPTANCE.md) retain their own scope.

## Checks and selected composition

Source checks pass: Rho-plugins `npm test` **40/40**; Rho `npm test` **40/40**,
using the accepted public Core binary. The current browser and package results
are recorded below after their actual runs; no package is a registry release.

The contribution entry remains **0.1-draft**. Documents and Tables use optional
`./ui` exports over component **0.2.0**, package **0.4.0**. React/React DOM
**19.3.1**, CodeMirror State **6.7.6**, View **6.43.13**, AG Grid Community/React
**36.2.0**, Dockview **8.6.0**, TypeScript **5.9.3** and Vite **8.3.4** are locked.
React, CodeMirror, AG Grid Community and Dockview retain their MIT licenses.
No AG Grid Enterprise or Dockview Enterprise functionality is selected.

`dist/web/composition.json` freezes owner entry digests, exact dependency versions
and licenses plus every asset hash. `vendor/composition.json` additionally records
application/plugin commits and trees, selected owner tarballs, Core bytes/digest
and the production lock. Core is reused by accepted digest, never rebuilt here.

## Browser scenario

`npm run acceptance:ui:u2` executes against source or `RHO_PACKAGE_ROOT`, with the
external driver selected using `RHO_UI_PLAYWRIGHT_MODULE`. It creates disposable
projects and scopes browser/Agent credentials through the actual local service.
No operator credential reaches the page, URL, static assets or report.

- Two live editor views share acknowledged Unicode text and one serial adapter.
  A deliberately lost response retries the original edit identity exactly once
  at the owner. Keyboard undo changes only this tab’s input, while Changes reads
  exact before text and reverts an individual Agent edit.
- Chrome CDP IME composition sends no intermediate change; committing Chinese
  text and pasting Unicode through the real browser clipboard reach Documents.
  A conflicting remote change keeps unsent composition in a copy and stops
  automatic submission. No OT/CRDT or silent rebase is added.
- Exact bindings show their retained version with no Changes panel. Already read
  exact text stays unchanged; after refresh outside retained history, the view
  reports unavailable and retains the original binding instead of live text.
- Typed numeric sorting and filtering use 200-row requests. Removing the filter
  restores the complete row count. Stable keys/resource versions survive filter,
  sort and cache changes; unkeyed tables remain readable without entity linking.
- The eight-heavy-view limit preserves existing buffers and shows a limit state
  for another retained reference. Over-budget input keeps earlier text.
- External Agent save uses the current disk condition. A later outside write
  conflicts without replacing the confirmed buffer. Refresh, disconnect/reconnect
  and service restart reuse the same browser session and confirmed content.
- Real Chrome runs at **1600, 1280, 1024 and 390 px**. Screenshots are inspected for
  clipping and overlap, with keyboard access and narrow single-panel behavior.
  Instrumented Host-start and native-submit counts must both remain **0**.

## Executed results

Source browser checks pass in Chrome **155.0.8059.84** at all four widths,
including retained/expired exact versions, eight-view refusal and narrow selection
restoration. Host starts **0**, native submissions **0**; no page errors or AG Grid
console errors. The existing U1 browser regression also passes at its five widths
with **0 / 0** native attempts. Reports and inspected screenshots are retained in
`work/u2-ui-closeout/browser-final/` and `u1-verified/`.

All **nine** fixed owner tarballs pass independent installation/import with no
React, React DOM, CodeMirror or AG Grid dependencies. Owner source is
[`2b39d93`](https://github.com/YuLab-SMU/Rho-plugins/commit/2b39d932f2ed220e64b0048ce702a2434bad2930).
Assembled application package checks remain pending final verification.

The checks found and fixed: author inference from receipts; pinned live text;
missing recovery notifications; a stale filtered end-row count; omitted AG Grid
Row API/Cell Style modules; and missing selection restoration after remount; and input arriving during a stale
undo. The latter now keeps a recovery copy and cannot resume submission on
composition end.
Early failed reports remain in the evidence directory; only the runs above count
as passes.

## Limits and follow-up

The actual browser is **Chrome 155.0.8059.84** on macOS arm64, Node **22.22.3**;
Chrome 154 is not installed. CDP exercises Chrome’s real composition engine;
physical macOS Chinese candidate-window input still needs a manual trial.
The browser scenario uses a scoped external Agent transport, not an actual model
conversation. Real Claude Code UI collaboration, conditional Dockview writes,
Charts/Annotations/contexts and archive browser recovery remain U3/U4 gates.

The external-file merge report in Paper needs an actual Agent merge acknowledgement
and provenance before being shown. This implementation does not infer a merge
from any file event or ordinary edit. Saves/recovery remain explicitly controlled
by the external Agent; the frontend adds no timer or fake save progress.
Unconfirmed copies are memory local to the tab; browser closure only guarantees
confirmed owner content. No full accessibility, product or signed-release
acceptance is inferred from this batch.
