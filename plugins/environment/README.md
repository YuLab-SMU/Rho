# Environment plugin

The package owns the public Environment data, the sole native pak/renv execution
and recovery implementation, and an ordinary process backend. The R helpers travel
with the source. It imports only public/plugin libraries and maintains no journal.
The core Operation mechanism retains and commits its reports and original outcomes.

`environment.status@1` observes configured activity. The initial version-2 RPC
contributions provide `environment.plan`, `environment.realize`, `environment.verify`,
`environment.reconcile`, `environment.refresh`, `environment.observe` and
`environment.library`. Material contributions add `environment.retention`,
`environment.cleanup_status`, `environment.cleanup`, `environment.restore_cleanup`
and `environment.purge_cleanup`; each
operation has its declared preflight query. Activation stays disconnected unless an
existing Rscript executable is explicitly configured. Activation, preflight and
inventory queries never start R or test namespace loading. Refresh is an explicit
operation that establishes cached native configuration for later inventory reads.
This is separate from read-only Workspace package inspection.

`environment.library@2` qualifies a successful original realization, its report,
current library digest, exact provider and R installation without starting R.
An ordinary R provider can explicitly select that observation for a new session.
R delegates native `environment.verify@2` before launch; the core retains both
original Operations and their causal link. Releasing this Environment provider
does not end an existing R session or change its selected library.

Full reports use bounded resource references, preserving owner, digest and size.
Realization, verification and selected-library observation require an original
successful result from this project and principal. Reconciliation accepts a
terminal original attempt and preserves its outcome without replaying work.
`operation.get` and `resources.read` are explicit Host grants, including reads
from previous instances. No raw path, resource identifier or copied native marker
alone authorizes work.

Material inspection requires explicit optional grants for `operation.project_coverage`,
`plugins.project_coverage`, `operation.list_recent`, `operation.events_checkpoint`,
`plugins.instances` and `plugins.inspect`. Projects with R providers also require
`r.session` and `r.snapshot`. Coverage requires `project.references.read`; no grant
is implied by preinstallation. Missing visibility, busy or disconnected R providers,
partial native usage or changing records retain the material. Bounded observations
cover successful plan inputs, realized libraries and every recorded R provider.
An unsupported scientific/recovery contract also retains material.

Only failed or cancelled original staging can be quarantined. All actions re-read
the admitted source chain and check the exact preview fingerprint, native process
absence and owned directories. Quarantine status also accepts the original
unconfirmed quarantine; this does not promote its outcome. Restore and purge check
both the original and quarantine paths, even when the original path is absent.

Successful ordinary R captures and reconciled copies protect the library paths,
loaded namespace paths and selected Environment library in their retained public
manifest. Environment asks `r.checkpoint@1` to qualify the original copy and its
control history; it never reads R private archives. A logically deleted copy no
longer protects graph dependencies, including when disk cleanup remains pending.
Missing payload bytes alone do not remove protection. Incomplete dependencies,
unknown contract versions and inaccessible history retain material. Unsuccessful
captures remain protected until `r.capture_attempt@1` qualifies a successful disposal
for the exact original capture, confirmed owner release and current absence of
both graph and staging files. Missing files or an uncertain disposal do not suffice. An uncertain pin/delete or resolution attempt also retains material until
`r.checkpoint_control@1` confirms an exact committed resolution of that original
request. This does not rewrite its outcome or retire a still-live copy.

Select optional `r.checkpoint@1`, `r.checkpoint_control@1` and
`r.capture_attempt@1` grants in addition to the reference grants. The
R reader itself needs `operation.get`, `operation.list_recent`, `resources.read`
and `operation.project_coverage`; capture disposal observations also need
`plugins.instance`. The exact active original provider is preferred;
after release, a unique active supported reader can observe the retained copy.
When several replacements exist, configure `checkpoint_reader` with an exact
`InstanceRef`. An unavailable explicit reader never falls back silently. An active
unstarted reader works without starting R or requiring the native capture helper.

The scan is an observation, not a lease on external references. Changes preserve
original Operations and report resources, and do not replay installation or undo
scientific effects. Material actions do not support confirmed cancellation.

A configured instance holds a cooperative lock on its exact material directory.
Another instance can reopen that directory after release; concurrent instances
use independent directories. Native work retains its lane until the matching
Operation settlement, and unconfirmed output transfer preserves uncertainty.
Closing a view does not release this service. These are lifecycle guarantees,
not an OS sandbox for native code.

See [BUILD.md](BUILD.md) for independent source assembly, prerequisites and builds.
Public TypeScript declarations and JSON schemas are generated into `sdk/`.
The shipped `tests/protocol.py` exercises the actual framed executable without R.
`node scripts/test-environment-plugin.mjs` uses an independently assembled package
and an unchanged, already built Host in disposable projects and libraries.
It requires installed R, pak, renv, ps and jsonlite; it never installs tools.
Add `--r-references` with `RHO_R_PLUGIN_PACKAGE` and `RHO_ARK` to exercise native
library and loaded-namespace protection through an ordinary R provider.
Add `--checkpoint-references` and `RHO_CHECKPOINT_HELPER` to also verify retained
namespace dependencies after session release, pure replacement reads, explicit reader
selection when alternatives exist, uncertain deletion and resolution attempts,
protection of unpublished captures, lost disposal confirmation and explicit
completion with original records preserved, and retirement before
material quarantine, restore and purge.

The fixed Host adapter and its `test-environment.mjs` runner are retired. Current
native integration uses the ordinary Environment/R/Agent suites above and retained
packages. Unresolved recovery controls and captures without confirmed disposal
remain retained. Retired fixed-composition tests do not count as current package
acceptance; see the repository Status page for verified behavior and limits.
