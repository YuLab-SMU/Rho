# Rho: current state and focus

Updated: 2026-10-13. Local and organization `main` contain the new application's
design skeleton after the verified merge of PR #111. The executable application
and integration have not been rebuilt. Routine Rho changes now proceed directly
on `main`.

## Current source boundary

- Rho owns application selection, assembly and presentation. The selected tree has
  16 controlled files: new architecture/rebuild/development/UI/release documents,
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
  Its former controlled implementation is on a published archive branch.
  Neither component repository is modified by this application source replacement.

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

## Selected next work

Priorities remain R batch-analysis recipes, artifact provenance/integrity/retrieval,
and reusable bounded evaluation in the plugin owner. Rscript, R packages, RDS,
manifests and ordinary file tools already support the demonstrated flow. No observed
gap requires an R-session platform, global artifact registry or Files rebuild.
Candidate improvement, development/validation/blind-test management and hillclimbing
remain unimplemented; the Core retains its own deterministic contract regressions.

The first application candidate is opening an original task, distinguishing
execution from scientific checking, inspecting/retrieving real tables and plots,
and continuing observation after disconnect. This is design; no researcher-facing
UI or integration acceptance has been delivered. New SDK/transport, installation,
discovery, Editor/Studio/Manager and replacement chat need separately demonstrated
consumer requirements. See [Rebuild](REBUILD.md) and [Architecture](ARCHITECTURE.md).

## Verification and publication

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
