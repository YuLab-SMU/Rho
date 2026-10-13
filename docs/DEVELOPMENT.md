# Developing the rebuilt application

Start with [Status](STATUS.md), [Rebuild](REBUILD.md) and
[Architecture](ARCHITECTURE.md). The selected `main` tree contains application
design and policies. There is no runnable new UI, launcher, SDK snapshot,
composition lock or application build command yet.

## Source owners

The three adjacent checkouts can remain `Rho`, `Rho-core` and `Rho-plugins`.
Each repository owns its source, dependencies, commits and checks. This repository
is the later application/composition entry; no root Cargo workspace is needed.
Read an owner's AGENTS.md before editing there.

Routine Rho changes are made, checked, committed and published directly on `main`.
Sync the organization branch before editing and use ordinary fast-forward pushes.
A review branch is used only when the user explicitly selects it. This rule does
not change the independent component repositories' workflows.

For current executable capabilities use the owners' public instructions:
[Core CLI](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/HOST-CLI.md),
[R recipe](https://github.com/YuLab-SMU/Rho-plugins/blob/main/examples/real-r-analysis/README.md)
and [evaluation plugin](https://github.com/YuLab-SMU/Rho-plugins/blob/main/plugins/agent-eval/README.md).
These consumers are independently verified. They do not constitute an application
build or require recreating a former SDK or plugin protocol.

## Select and verify one flow

1. Describe a concrete user action, actual gap, responsible owner and observable
   completion conditions. Try the existing public capability and reuse valid evidence.
2. Implement the smallest selected owner change. Existing tools default to reuse;
   do not invent shared state or adapt all old consumers to close one task.
3. Run checks for the behavior changed. Report failures, incomplete scope and science
   limits. Core/plugin owner checks and actual application composition are separate.
4. Inspect the diff, commit in its owner and check all touched repository states.
   Preserve unrelated files and ignored runtime/evidence material.

Documentation changes need local link/anchor checks, a coherent rendered batch and
inspection of all affected content. No native build is required for this source
replacement: the old runnable application is intentionally archived and the new
one is not implemented. Do not restore code merely to run retired layout tests.
Actual future UI changes need build/check commands introduced with that implementation,
representative-width behavior checks and the [interaction review](RHO-DESIGN.md).
Never run Cargo builds/tests concurrently. Verification uses disposable projects
and owned Hosts, preserving user sessions and original task identities.

## Archives and later integration

The [old baseline](https://github.com/YuLab-SMU/Rho/tree/codex/legacy-app-before-rebuild)
and [pre-clear tree](https://github.com/YuLab-SMU/Rho/tree/codex/legacy-app-before-main-reset)
retain all controlled assets. Ignored local caches, outputs and user data are not
published or removed. Consult archives only for concrete requirements or failures.
Their commands and historical acceptance are tied to those versions.

When selected, application integration must pin actual source and artifact identities,
use the declared public boundary, expose local overrides and verify the real chosen
combination. A lock, copied SDK or wrapper around an old launcher cannot establish
new integration. Do not create these mechanisms before a demonstrated need.
Publish authorized source through [Release](RELEASE.md); official distribution
remains a separate future milestone.
