# Build the Environment plugin

The standalone package contains the Environment API, RPC backend and native owner,
the Process API/engine/recovery library, the public backend SDK and protocol,
first-party R helpers, a Cargo lockfile and these build instructions.
It imports no private Rho modules and owns no operation journal.

Use an already installed Rust 1.97 or newer toolchain and Node.js. Run
`node build.mjs` inside the assembled source package. It builds locked dependencies
offline; missing tools or cached dependencies are diagnostics, not authorization
to download or install them. `RHO_PLUGIN_CARGO` can name the installed Cargo binary.
`RUSTC` and `RUSTDOC` can select the matching installed compiler tools.

The build writes `dist/rho-environment-backend` and the complete source manifest.
It does not activate the package, start R, install R packages or modify a scenario.
The native backend is trusted local code, without an OS sandbox claim.

From the Rho checkout, `node scripts/build-environment-plugin.mjs /absolute/new/package`
assembles the eight public/plugin Rust packages outside the checkout before
building. In that source package, use `cargo test -p rho-environment-api -p
rho-environment-backend --lib --locked --offline` for focused validation.
The manifest and TypeScript/schema exporters run through `generate-manifest.mjs`
and `generate-sdk.mjs`; each supports `--check`.

Native operations require an existing Rscript and the existing pak, renv, ps and
jsonlite prerequisites. Configure the exact installed Rscript path. Activation and
queries never launch R; `environment.refresh@2` explicitly establishes configuration.
A configured backend exclusively owns its material directory until release. Select
an existing `storage_root` to reopen retained material after its former owner exits;
another live owner cannot share that directory. New instances can use independent
material directories concurrently. Read original operation receipts before recovery.

Reports use bounded, digest-verified resources. Source reports from a previous
instance use the explicitly granted `resources.read` Host query under the current
caller and project; a report reference is not authority. The same rule applies to
`operation.get`. Failed acknowledgement never authorizes automatic re-execution.

This package's initial RPC contributions cover configuration, planning, realization,
verification, native recovery, inventory and pure library qualification. The
ordinary R package can explicitly select the original realization and delegate
verification before launch. Material inspection and quarantine/restore/purge use
the optional public reference grants described in README.md. The ordinary R
provider must be available when selecting its read grants at activation; it may
remain unstarted. Missing or incomplete reference observations retain materials.
Recovery-reference protection is still being migrated, so the package does not
yet replace the entire Environment feature. Successful and uncertain original
attempts stay retained.
