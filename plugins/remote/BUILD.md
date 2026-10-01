# Build Remote tasks

This source package uses the installed Rust toolchain (1.97 or newer) and Node.js.
No toolchain or dependency is installed automatically. Assembly includes public
protocol/SDK sources and the native Process libraries; no private core code is used.

Run `node build.mjs` in the independently assembled source root. Cargo uses the
included lockfile and cached dependencies with `--locked --offline`. The executable
is `dist/rho-remote-backend`; `plugin.json` is generated from its actual contracts.
The resource and framed-RPC channels are supplied only by the activating Host.
If the default compiler is older, set `RHO_PLUGIN_CARGO`, `RUSTC` and `RUSTDOC`
to absolute executable paths from an already installed compatible toolchain.
The build reports an incompatible or missing compiler; it does not acquire one.

The default configuration has no remote target and cannot run remote work. To
activate a configured instance, provide `target.host_alias`, an absolute canonical
POSIX `target.project_root`, and optional `target.slurm_cluster`. Authentication
uses the installed OpenSSH configuration. Do not put credentials in revisions.
Activation validates local configuration and never connects to SSH.

The scripts under `tests/` exercise public RPC using disposable local fixtures.
They do not establish behavior on a real remote cluster. A missing native tool,
connection or scheduler is reported without installation or automatic replay.

Repository assembly defaults to the primary workspace's incremental native build
and copies that artifact into the standalone source package. Use the explicit
`--independent` option on `scripts/build-remote-plugin.mjs` for independent-source
compilation; `--workspace` spells the default. Both validate the same public source
closure. Inside a distributed package, `node build.mjs` still builds its own source.
