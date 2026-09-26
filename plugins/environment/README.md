# Environment native owner

The public `api` and native `backend/owner` own the existing Environment data,
pak/renv execution, verification, native recovery and staged-material lifecycle.
The R helpers travel with this source. Dependencies are public/plugin-owned Process
libraries; this owner does not import private core modules or maintain a journal.

The retiring Host adapter delegates to this same implementation. It converts native
uncertainty and confirmed cancellation into the core operation port. Scoped source
authorization, live-library retention and authoritative commits remain the caller's
responsibility. Native observations read previously established configuration and
bounded files; they do not start R or test namespace loading.

Ordinary RPC contributions and installable package assembly are still in progress.
This directory is not yet an installable plugin revision. Existing explicit
Environment operations are being migrated; package inspection stays read-only.

From the repository, run `cargo test -p rho-environment-api -p
rho-environment-owner --lib --locked` for focused storage/observation checks.
`node scripts/test-environment-plugin-owner.mjs` assembles six public/plugin crates
outside the checkout and runs those checks with the installed required toolchain,
locked dependencies and offline resolution. It starts no R runtime. The existing
`node scripts/test-environment.mjs` covers real R through the retiring Host in
disposable projects and isolated libraries, using already installed prerequisites.
