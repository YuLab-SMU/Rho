# Build the R backend package

The repository source is assembled with `node scripts/build-r-plugin.mjs DEST`.
Use a new destination outside the repository. The assembly includes the complete
R API, engine, backend, public Rust SDK/protocol, pinned Jet source and licenses,
a standalone Cargo workspace and dependency lock. No private core crate is used.
The manifest source inventory is generated from these exact files.

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
Release confirms native shutdown and keeps original resource bytes. Queue controls,
checkpoints, packages/help and Viewer UI migration are still being implemented.
