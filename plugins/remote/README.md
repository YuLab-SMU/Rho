# Remote native owner

SSH execution and Slurm native ownership live here. The public `api` and
`backend/owner` use only public protocol and package-owned Process API/supervision
libraries. They have no private core imports, journal, background connection,
automatic resubmission or installed-package mutation.

The retiring SSH adapter delegates to this owner. Ordinary framed-RPC package
assembly and contributions are the next integration step; this source directory
is not yet an installable plugin revision.

The caller supplies an admitted original operation identity. It must authorize
the source, serialize scheduler work and commit the resulting scientific evidence
through the authoritative operation port. The native owner checks the configured
host/root/cluster and exact observed job reference. A submitted cancellation request
does not confirm terminal cancellation. SSH EOF, timeout and local transport
cancellation do not confirm that remote work stopped. Missing or ambiguous
scheduler observations remain unresolved.

Run `node scripts/test-remote-plugin-owner.mjs` from the repository to assemble
the five public/plugin libraries into a temporary independent workspace, test
them and exercise local fake SSH/Slurm executables. The copied workspace uses
the included lockfile, offline dependency resolution and locked builds, with the
existing Rust toolchain and cache. The checks never connect to a real cluster.
