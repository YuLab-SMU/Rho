# Files and Git owner

The public contracts and native implementation are being extracted into this
ordinary plugin. `api` owns file, directory, text, search, Git observation and patch
contracts. `backend/engine` owns the existing contained filesystem and Git adapter.
It uses the public process supervision library, without private core dependencies.
The retiring `rho-git` adapter re-exports the same implementation; it does not keep
a second copy. Existing project Operation handlers still own their integration
until the ordinary backend transport is connected.

Native reads retain normalized project roots, protected-path exclusions, bounded
pages, UTF-8 positions, hashes and native file identities. Changed or replaced text
produces typed diagnostics. Git reads and patches retain their existing command
bounds and project containment. Neither source extraction nor a query installs
software or recovers an R session.

Generate language-neutral schemas and TypeScript declarations with
`node plugins/files/generate-sdk.mjs`. The independent contract consumer is
`scripts/test-files-protocol.mjs`. `scripts/test-files-plugin-engine.mjs` copies
only the Files and process libraries outside the repository, checks dependency
containment and runs their native tests with the already-installed Rust toolchain.
It does not rebuild or restart a running Host.

This source boundary is not a completed installable package. Backend activation,
the Files view, Editor navigation and default scenario delivery remain in progress.
