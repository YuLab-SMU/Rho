# Build Processes

Use an installed Rust 1.97 toolchain and this package's Cargo lockfile. The source
contains the process API, supervision engine, native owner, framed-RPC backend and
public plugin SDK/protocol. It has no private Host, database or scientific crate.
Assemble from the Rho checkout using `node scripts/build-process-plugin.mjs
/absolute/new/package`; inside the standalone package, run `node build.mjs`.
The build runs offline and never installs a toolchain or dependencies. Native
artifacts use `aarch64-apple-darwin` for the current delivery target.

The package contributes `process.run_local@2`, its read-only
`process.prepare_local@2` preflight and `process.status@1`. Execution requires
`project.read` and `process.run_local`; status requires `project.read`. No view or
reverse Host capability grant is needed. The Host supplies the canonical project
root separately from the empty user configuration. Preflight does not start a
process and cannot authorize another target or arbitrary preconditions.

Each accepted operation keeps its exact native target and original identity. The
owner accepts at most 16 unsettled calls and holds its execution lane until the
Host confirms the original result settlement. Status describes native scheduling;
committed scientific outcomes remain in the Host's Operation journal. Cancellation
acknowledges a request; only the native completion can confirm that work stopped.
An instance cannot release while work or settlement remains outstanding.

Execution retains bounded stdout/stderr bytes, their total sizes, truncation/EOF,
exit status and native cleanup details in a JSON `ProcessReport` resource.
`ProcessRunResult` binds that resource to the original operation and provider.
Read the bytes through public resource ports, verifying the declared digest.
The resource remains readable after release. A failed or unconfirmed report upload
returns uncertainty with its digest, native termination and bounded output prefixes;
it never re-executes the command. No native OS sandbox is claimed.

Run `python3 tests/protocol.py dist/rho-process-backend` for the independent framed
RPC fault and settlement checks. `node generate-sdk.mjs --check` checks the public
declarations. In the Rho checkout, `node plugins/process/generate-manifest.mjs
--check` checks the source manifest template; standalone builds then fill its full
source inventory. `node scripts/test-process-plugin.mjs` exercises the package
through an already-built Host in a disposable project without recompiling it.

The ordinary plugin's interrupted-instance reconciliation and SSH/Slurm capabilities
are still under implementation. The shared native recovery owner is present in
the source; its presence does not register those RPC capabilities.
