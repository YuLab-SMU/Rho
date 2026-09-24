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
own different native sessions. Release requests confirmed native shutdown and
keeps original resource bytes. This package currently provides the first native
vertical slice; full Console controls, checkpoints, packages/help and Viewer UI
migration are still being implemented.
