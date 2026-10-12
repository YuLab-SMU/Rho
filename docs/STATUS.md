# Rho: current state and focus

Updated: 2026-10-12. This is the single current summary. The current application
source remains the former implementation; a rebuild has been selected and has
not started. See [Rebuild](REBUILD.md) for the new boundary and completion rules.

## Current repository state

- Rho owns application selection, assembly and presentation. The retained UI,
  public dependency snapshot, development scripts and composition lock use the
  former Core; they do not implement the rebuilt Core contract.
- New Rho-core has a managed execution library, durable request identity and
  facts, a resident local Host and CLI. It has no new exported SDK, HTTP/MCP
  server or old plugin lifecycle. Its current evidence and limits are in the
  [Core progress summary](../../Rho-core/docs/PROGRESS.md).
- Rho-plugins retains its old packages, domain/native sources and pinned former
  Core dependency. A new [real R consumer](../../Rho-plugins/examples/real-r-analysis/README.md)
  uses the new CLI directly, without a plugin protocol or UI prerequisite.
- Complete controlled old source is preserved locally on
  `codex/legacy-app-before-rebuild` and the plugin repository's
  `codex/legacy-plugins-before-rebuild`. Both were checked against the local HEAD
  before this task changed documents. Old source remains on main this round;
  no application/plugin rewrite, source deletion, data migration or compatibility
  implementation has begun.

## Selected real domain trial

The completed consumer uses airway / GSE52778: four paired donor cell lines,
donor-adjusted DESeq2 dexamethasone response, four leave-one-donor-out fits and
200 full-gene model-conditional count simulations. Native R ran for 562.6595
seconds (9 minutes 23 seconds), with no delay added to lengthen the task.

An independent wait client was terminated; lookup and identical submits found
the original run and R PID. One native entry, Code(0), released holding and
complete retained text were observed. Original and retrieved artifacts each
passed 12/12 independent integrity/input/arithmetic checks. Five saved models
passed 121/121 separate native observation checks; all four scientific plot
pages were inspected. The consumer's own Host shut down cleanly.

The main analysis observed 4,068 genes at BH < 0.05. Six declared response
genes were positive in the main and four donor-omission fits. Bootstrap
quantiles describe conditional count variation with fixed donors and fitted
parameters, not donor-population or clinical confidence intervals. The checker
does not independently refit DESeq2. See the domain owner's
[fact acceptance](../../Rho-plugins/examples/real-r-analysis/ACCEPTANCE.md).

Original failures remain: the first Host could not bind its socket; the next
real analysis took only about 20 seconds and its driver failed because the
checker was not ready. Later verification of those unchanged files does not
erase that failure. Preflight now checks the verification entry points. Three
altered-copy counterexamples were rejected, including a falsified BH value
whose updated digests passed integrity checks.

The trial uses a fresh disposable project and its own Host. It has not replaced
or restarted a user Host, catalog, installed preview or R session. Rscript is a
real batch R process; no claim is made about restoring interactive R memory.
The resulting public-study reanalysis is distinct from new scientific discovery,
clinical validity or acceptance of the old sixteen-package product.

## Rebuild priorities and boundaries

Two next domain responsibilities are selected: reusable R batch-analysis
recipes, and scientific artifact integrity, provenance and retrieval. Rscript,
RDS, manifests and ordinary file tools already support the demonstrated flow;
these priorities do not mandate two new packages. No observed gap requires a
new R-session platform, global artifact registry or Files rebuild. The concrete
consumer preparation-order failure was corrected in its owner.

A reusable Agent evaluation and improvement plugin is now selected in Rho-plugins.
It will organize isolated trials, evidence and candidate comparisons, invoking
domain-owned checkers; Core's deterministic contract regressions stay in Core.
The first reuse flow targets the existing Core CLI Agent cases and one R recipe's
domain checks, keeping their scored and unscored scopes distinct. Evaluation and
bounded improvement are separate actions, with development, validation and final
blind-test material. The plugin, shared entry point and application integration
are design only: no evaluation source has moved and no improvement run occurred.
See the [plugin boundary](../../Rho-plugins/docs/REBUILD.md#agent-评估与改进插件).

The application will consume actual Owner facts and selected fixed components.
It will not reimplement the scientific operation path. A new protocol edge,
public SDK, plugin installation, uniform discovery, Editor/Studio/Manager or
replacement chat is selected only for a real consumer requirement. Substantial
UI changes still require the agreed design review; this round changes no UI.

Core's 01–03 implementations were read directly on GitHub main at c34e10e.
Their former “local only” current-state claims have been corrected. The two
subsequent local Core commits remain unpublished. This task also stays local;
backups, local commits, source publication, PR merge and release are distinct.
CI remains deferred and Mac physical power-loss testing remains excluded.

## Historical evidence retained

The previous repository split established independent source ownership, selected
Files behavior and a retained external-assets application composition. Its exact
receipts remain under target/, with their original source and artifact identities;
none has been replaced by a new Core composition. The former status and tests
remain available in Git and on the archive branch.

The application main checkout contains local unpublished changes preceding this
task; the split remains a separate remote review state. Its remote tracking
branch is upstream/main; origin is a personal fork. Current publication and
backup identities were inspected rather than inferred from branch names.
Old [Architecture](ARCHITECTURE.md), [Core reduction](CORE-SIMPLIFICATION.md) and
[Workbench transfer](WORKBENCH-MIGRATION.md) documents are legacy references,
not new Core requirements or proof of new integration. The future signed-release
boundary in [Release](RELEASE.md#future-official-release-boundary) remains agreed
and unimplemented; Rho-releases is not created by this task.

## Verification and limits

The real-R trial on 2026-10-11 supplied the following evidence:

- Before edits: all three workspaces were clean; actual remotes and local branches
  were inspected. GitHub main heads were read for Core, Plugins and Rho.
- Both local archive heads and controlled root-tree inventories matched their
  respective pre-edit local source.
- Real R execution, original-request continuation, independent artifact retrieval
  checks, native model observation and three negative cases passed within the
  limits above; original failed attempts remain explicit.
- Changed document links and rendered pages were checked; retained code, SDK
  snapshots and composition lock are unchanged.
- No native/application build, Cargo suite, model reevaluation, source push,
  installation or official release was executed in that trial.

The evaluation-plugin design addition on 2026-10-12 passed local link/anchor
checks and rendered-content inspection. It adds no execution evidence: no
evaluation implementation, source migration, improvement run or application
integration was performed.
