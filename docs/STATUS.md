# Rho: current state and focus

Updated: 2026-10-13. Local and organization `main` contain the new application's
design after the verified merge of PR #111. The user has now selected the broader
functional-component model and a joint workbench/Agent/multi-window direction.
The executable application and integration have not been rebuilt. This update
changes documents only. Routine Rho changes proceed directly on `main`.

## Current source boundary

- Rho is the application container and owns selection, assembly, window/layout
  coordination and presentation. The selected tree contains design documents,
  repository instructions, license, contribution/privacy/security policies and
  existing Code Owner governance. There is no UI, SDK snapshot, lock, launcher,
  build entry or old scientific example in this tree.
- Both the [original app archive](https://github.com/YuLab-SMU/Rho/tree/codex/legacy-app-before-rebuild)
  and [complete pre-clear snapshot](https://github.com/YuLab-SMU/Rho/tree/codex/legacy-app-before-main-reset)
  are published and verified. All 460 removed entries match the latter's Git
  content identities and modes; four updated historical documents are included.
  Ignored evidence, caches, runtime and user data remain local and unchanged.
- [Rho-core](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/PROGRESS.md) provides
  managed execution, durable request identity/facts, a resident Host and CLI.
  It has no new SDK, HTTP/MCP edge or former plugin lifecycle.
- [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/STATUS.md)
  main contains the selected evaluation plugin, real R recipe and current policies.
  Its design now covers any actual functional component, with optional CLI,
  Skills, MCP and UI entries; scientific/evaluation consumers are its implemented
  subset, not its entire scope.
  Its former controlled implementation is on a published archive branch.
  The application source replacement did not modify either component. The current
  coordinated document selection also updates Rho-plugins; Core remains unchanged.

## Existing component evidence and its limits

The [real R consumer](https://github.com/YuLab-SMU/Rho-plugins/blob/main/examples/real-r-analysis/README.md)
uses airway/GSE52778, four donor pairs, DESeq2, four donor-omission fits and 200
full-gene conditional simulations. Actual native execution took 9 minutes 23 seconds.
An interrupted wait resumed observation of the same run/PID with one native entry.
Original and retrieved artifacts each passed 12/12 independent checks; five saved
models passed 121/121 native observations. Three altered-copy counterexamples
were rejected. See [acceptance](https://github.com/YuLab-SMU/Rho-plugins/blob/main/examples/real-r-analysis/ACCEPTANCE.md).

Original failures remain: an initial Host socket bind failure, then a roughly
20-second analysis whose driver failed because its checker was not prepared.
Later checks of unchanged outputs do not erase those failures. Conditional simulation
quantiles hold donors and fitted parameters fixed; they are not donor-population or
clinical intervals. The checker does not independently refit DESeq2. Rscript is a
batch process, not recovered interactive R memory or autonomous scientific discovery.

The [evaluation plugin](https://github.com/YuLab-SMU/Rho-plugins/blob/main/plugins/agent-eval/ACCEPTANCE.md)
migration passed 43 regressions, eight real CLI baseline cases, six optional library
cases and one real-model execute trial. Original model evidence remains 15/16,
including the residual unauthorized command-combination failure. Exported plugin
source and a copied public binary worked without private Core source or the old SDK.
These are prior component checks, reused here without rerunning the model or R analysis.
They do not establish a new application composition.

## Selected design and next work

Priorities remain R batch-analysis recipes, artifact provenance/integrity/retrieval,
and reusable bounded evaluation in the plugin owner. Rscript, R packages, RDS,
manifests and ordinary file tools already support the demonstrated flow. No observed
gap requires an R-session platform, global artifact registry or Files rebuild.
Candidate improvement, development/validation/blind-test management and hillclimbing
remain unimplemented; the Core retains its own deterministic contract regressions.

Rho-core is the completed execution foundation for this selection; Rho is the
application container and plugins own actual functionality. Shared action/resource/
selection/view semantics connect optional entries without a second execution path
or a global scientific revision. Editing buffers, native facts, Agent sessions and
window layout retain distinct owners and lifetimes.

The selected main direction is Electron, React/TypeScript, Vite and Dockview;
plugin UI starts with CodeMirror 6, AG Grid Community, ECharts and a json-render
catalog. Independent HTML can use MCP Apps when needed; other interoperability
and packaging boundaries remain optional. No dependencies, schema, loader, bridge
or running composition have been implemented or pinned by this document change.

The first application flow jointly exercises natural-language action, a typed
parameter interface, script/real table/plot context, stable selection, movable views/
multiple windows and continued observation of the original task without replay.
It must preserve unsaved content and distinguish execution from domain checking.
There is no researcher-facing UI, native-input, performance or integration acceptance
yet. See [Technology stack and joint acceptance](TECHSTACK.md),
[Rebuild](REBUILD.md) and [Architecture](ARCHITECTURE.md). New transport, installation,
discovery or compatibility machinery still needs its selected consumer requirement.

## Verification and publication

The 2026-10-13 architecture selection passed local links/anchors and rendered-page
inspection of all changed documents in the two selected owners. This verifies
documents only; no application build or behavior checks were run.

The source replacement verifies remote archive heads/trees, exact archived identities
of removed files, retained governance/license files, local document links/anchors
and rendered changed content. The former runnable UI is deliberately archived;
there is no new application to build or behavior suite to run. Old composition
receipts keep their original meaning and remain in ignored local evidence.

The source-replacement PR is merged; the organization merge commit retains the
selected source commits and the existing upstream history. Its tree matches the
verified 16-file replacement, and local main has fast-forwarded to that merge.

The user selected direct main work for Rho on 2026-10-13. The main ruleset no longer
requires a PR; active protection against force pushes and deletion remains, with
no bypass actors added. Routine Rho changes are checked, committed and published
directly on main; review branches need an explicitly selected workflow. Component
repository rules are unchanged. Source publication does not establish binary
delivery, installation, application integration or an official release.

CI remains deferred; Mac physical power-loss testing remains excluded. The
[future signed-distribution boundary](RELEASE.md#future-official-release-boundary)
is agreed and unimplemented; Rho-releases has not been created.
