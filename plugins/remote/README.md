# Remote tasks

SSH execution and Slurm native ownership live here. The public `api` and
`backend/owner` use only public protocol and package-owned Process API/supervision
libraries. They have no private core imports, journal, background connection,
automatic resubmission or installed-package mutation.

The ordinary `org.rho.remote` package supplies SSH operations and Slurm submission,
observation, reconciliation and cancellation through the public framed-RPC SDK.
Its default target is disconnected. Explicit instance configuration freezes the
host alias, remote project and optional cluster; activation does not start SSH.
There is no UI contribution. The retiring SSH adapter delegates to the same native
owner until the fixed composition is removed.

The Host supplies admitted original operation identities and alone commits facts.
The backend serializes native work until the exact core settlement arrives. It
reads original submissions through a scoped `operation.get` grant and verifies
their original provider binding and target before preparing recovery. Replacement
instances retain that old binding rather than replacing the source. The owner checks the configured
host/root/cluster and exact observed job reference. A submitted cancellation request
does not confirm terminal cancellation. SSH EOF, timeout and local transport
cancellation do not confirm that remote work stopped. Missing or ambiguous
scheduler observations remain unresolved.

Remote command output is a retained resource with its owner, size and digest. A
missing resource acknowledgement preserves an uncertain result and bounded output
prefixes, without replay. A cancellation before native start can be confirmed;
stopping an active local SSH transport cannot confirm that remote work stopped.
Slurm request acceptance and native job state remain separate observations.

From the repository, `node scripts/build-remote-plugin.mjs /absolute/new/package`
assembles seven public/plugin Rust crates and builds offline outside the checkout.
All first-party sources, lockfile and [build instructions](BUILD.md) travel with
the package. Rebuild with `node build.mjs` in that standalone directory.
Generate declarations and manifest with `node plugins/remote/generate-sdk.mjs`
and `node plugins/remote/generate-manifest.mjs`; both accept `--check`.

Run `node tests/protocol.mjs /absolute/package/dist/rho-remote-backend` from the
package to exercise framed-RPC failures, cancellation, source reads and settlement.
From the repository, `RHO_REMOTE_PLUGIN_PACKAGE=/absolute/package node
scripts/test-remote-plugin.mjs` exercises ordinary installation and capabilities
through an already-built Host and verifies that its binary stays unchanged.
`node scripts/test-remote-plugin-types.mjs` compiles a standalone public consumer.

Run `node scripts/test-remote-plugin-owner.mjs` from the repository to assemble
the five public/plugin libraries into a temporary independent workspace, test
them and exercise local fake SSH/Slurm executables. The copied workspace uses
the included lockfile, offline dependency resolution and locked builds, with the
existing Rust toolchain and cache. The checks never connect to a real cluster.
