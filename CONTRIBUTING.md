# Contributing to Rho

Describe a concrete user problem, a bounded proposed change and its verification
in an issue or pull request. Start with [Status](docs/STATUS.md),
[Rebuild](docs/REBUILD.md) and [Development](docs/DEVELOPMENT.md).
The selected tree is the new application's design skeleton, with no executable
application yet. Former implementation assets are on the published archive branches.

Keep implementation in its source owner: generic execution in Rho-core,
actual functional components, their native semantics and reusable evaluation in
Rho-plugins, application selection, assembly and presentation here. Preserve
unrelated work. Checks should prove the selected
behavior; do not restore old structure merely to satisfy historical tests.
Interaction changes follow [UI principles](docs/RHO-DESIGN.md).

## Contribution license

Unless separately agreed in writing, contributions submitted after Rho's AGPL
transition use `AGPL-3.0-only`, the terms for Rho-original source. Contributors
must have the right to provide their changes on those terms. This rule does not
revoke earlier grants or transfer copyright without a separate agreement.

Record the origin and license of any third-party code, data, media or binaries
actually introduced. Preserve required notices and review distribution obligations
for the selected payload. The archive's dependency inventory does not establish
the dependencies or licenses of a future rebuilt application.
