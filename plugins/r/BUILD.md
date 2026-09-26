# Build the R backend package

The repository source is assembled with `node scripts/build-r-plugin.mjs DEST`.
Use a new destination outside the repository. The assembly includes the complete
R API, engine, backend, public Environment/Process contracts, Rust SDK/protocol, pinned Jet source and licenses,
a standalone Cargo workspace and dependency lock. No private core crate is used.
The manifest source inventory is generated from these exact files.
The package's `sdk/` directory contains public R TypeScript declarations and JSON
Schemas. `node generate-sdk.mjs` regenerates these and the versioned manifest
contracts from the R API; `node generate-sdk.mjs --check` verifies them. These
commands invoke Cargo and must run serially with other builds or checks.

Inside that self-contained directory run `node build.mjs`. It uses the existing
Rust 1.97 toolchain and cached locked dependencies, and writes `dist/rho-r-backend`.
It never installs a compiler, dependencies, R, Ark or packages. The supported
native delivery target is Apple Silicon macOS. Build failures remain visible.

Snapshot/import the directory with the ordinary `rho plugins` developer commands.
Activate it with explicit canonical `ark` and `r_home` paths. Observe `r.session`,
invoke `r.create_session`, then copy its exact session to `r.execute` or
`r.snapshot`. Every invocation uses the normal provider binding and original
Operation. Activation and queries do not launch R. Different revision instances
own different native sessions. When `r.session.input` is present, use the transient
`r.respond_input` control with its exact session, original Operation and request
IDs, a fresh reply ID and the answer. Set the provider binding's target to that
same session. Answers are limited to 65,536 UTF-8 bytes without NUL. Read the pending
request after a lost acknowledgement; a submitted answer cannot be repeated.
Control transport does not record the answer; ordinary non-password native input
can still be echoed by R into its output. Queries and input remain available for
explicit bindings while release waits on accepted work; new executions are refused.
The backend acknowledges Host-only original-Operation settlement through the public
protocol. A returned native report alone is not proof of core journal commit.
`r.console` observes the existing queue using `expected_session` copied from
`r.session.queue_target`. This identity exists even before session creation;
queries and controls do not create R. The queue admits at most 33 original
operations, in received order. `accepting` describes native queue capacity only;
Host lifecycle and granted scopes still govern admission. A native result blocks later execution until the
Host confirms the original journal commit. Failed, cancelled and uncertain runs
leave a pause; their partial effects remain visible in the original result.

Use `r.pause_queue` / `r.resume_queue` as transient controls. Set the binding target
and `session_id` to the observed queue target, and copy the exact `pause_id` (null
when currently unpaused). Optional `only_operation_ids` must cover all accepted
work and the operation that caused the pause. Pause lets the current run finish;
resume cannot bypass a result in `awaiting_commit`. Resolve such a result through
original Operation commit recovery, then observe and resume the queue. Cancelling
a waiting `r.execute` item confirms `started:false` and preserves its original
cancellation result. Controls and queue observations remain available during draining.
Session creation
retains its existing unsupported-cancellation contract; it can be paused before
starting and resumed through the unstarted queue target.

`r.create_session@2` selects an original Environment realization using an exact
`environment.library@2` provider binding. At R activation, explicitly select its
three optional grants: `environment.library@2`, `environment.verify@2` and
`resources.read@1`. Default R session creation remains available without those
grants or any Environment provider. Preflight reads and pins the original library,
provider, digest and configured R installation without launching R. The explicit
creation operation delegates native verification through the same provider and
records that child Operation and report. Only a confirmed, unchanged selection
can launch the new native session. The native R installation is checked again.
Existing sessions retain their original binding across provider replacement.
Failed or unconfirmed verification never starts R and never triggers automatic
re-verification; inspect the original creation and its causally linked child.
Verification and native-launch uncertainty remain distinct in `r.session`.
The shipped `python3 tests/environment_protocol.py dist/rho-r-backend` checks
the actual executable with fake R/Ark paths: bounded/reversed Host replies,
grant refusal, failed or lost verification, no replay, settlement and EOF cleanup.
It must not start either native executable. Cross-plugin native acceptance from
the checkout is `scripts/test-r-environment.mjs`; select independently assembled
R and Environment packages and the already installed R/Ark as documented in the
project's Testing SOP. It uses disposable sessions and an unchanged Host binary.

`r.execute@2` adds the original `run` object with code, source labels and optional
Console output mode; it keeps the code-only `r.execute@1` contract available for
existing consumers. The source is retained in queue observations and the terminal
result. These labels do not attest to a Host-synchronized document capture.
`r.check_code` checks completeness only in an existing idle session.
`r.output_events` reads the original append-only output log while execution or
stdin waits continue. Pages keep exact sequence cursors, gaps and truncation, and
are bounded by both event count and encoded bytes. They never imply completion;
inspect the original Operation for that. See [public contracts](sdk/README.md).

Release confirms native shutdown and keeps original resource bytes. The ordinary
Viewer package can read retained HTML. Console and inspection views consume the
public contracts; captured document execution and checkpoints still need integration.
