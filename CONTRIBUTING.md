# Contributing to Rho

Rho is an application container for functional components. Start with
[Architecture](docs/ARCHITECTURE.md), [Roadmap](docs/ROADMAP.md),
[Status](docs/STATUS.md) and [Development](docs/DEVELOPMENT.md).
The application implementation and accepted component composition are pending.

## Make a bounded contribution

Describe the user action, observable result, proposed change and acceptance checks.
Implement the change in its source owner: Rho-core owns managed execution;
Rho-plugins owns functional components and their native semantics; Rho owns
application selection, assembly, shared interaction and presentation. Read that
owner's instructions and preserve unrelated work.

Use demonstrated public capabilities and mature tools. Keep original request
identity, partial results and unknown outcomes visible. A view's lifetime must not
silently change a task or native session. Verify behavior in the selected owner;
a component check alone does not prove an application composition.

For documents, check links and anchors, render the complete changed batch and
inspect all pages. Interaction design follows [Design](docs/DESIGN.md).
Report only checks actually executed and retain material failures and limits.

Routine Rho work is checked, committed and published directly on organization
`main`. Use a review branch when that workflow is explicitly selected. Inspect the
actual remote, account and branch before publishing; preserve commit history and
use an ordinary fast-forward push. See [Release](docs/RELEASE.md).

## Contribution license

Rho-original source uses `AGPL-3.0-only`. Unless separately agreed in writing,
new contributions are submitted on those terms. Contributors must have the right
to provide their changes. This policy does not revoke existing license grants or
transfer copyright without a separate agreement.

Record the origin and license of third-party code, data, media and binaries
actually introduced. Preserve required notices and assess distribution obligations
for the selected payload. Each independent component retains its own license.
