# Rho application architecture

This is the agreed ownership and application design. The selected tree has no
new executable application, exported SDK dependency, lock or assembly tooling.
See [Status](STATUS.md) for implementation and verification.

## Three source owners

| Owner | Current responsibility | Application relationship |
| --- | --- | --- |
| [Rho-core](https://github.com/YuLab-SMU/Rho-core) | Generic managed execution, original request identity, durable facts, resident Host and CLI | Use the supported public capability and its declared guarantees |
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) | Scientific recipes, native conditions, artifacts and domain checks; reusable Agent evaluation | Consume domain results and evaluation evidence from their actual owner |
| Rho | Application selection, assembly and presentation | Select verified components and present their facts; integration remains pending |

The current Core has no new SDK, HTTP/MCP edge or former plugin-package contract.
Scientific and evaluation consumers already use its CLI without a UI prerequisite.
Their success does not implement application assembly or a new plugin framework.
The Core's deterministic regressions remain in Core. Model trials, scoring and
candidate-improvement experiments belong to the evaluation plugin; scientific
checkers stay with their domain owner.

## Execution and scientific truth

Keep the original request, caller/project visibility, native identity and result
when observation is interrupted. Reconnecting observes the same task. Execution
completion, artifact integrity and scientific checks are separate facts. Preserve
partial results, unknown outcomes, checks' scope and failures; a single score or
exit code cannot establish all of them. The real R consumer supplies the selected
example and its [acceptance limits](https://github.com/YuLab-SMU/Rho-plugins/blob/main/examples/real-r-analysis/ACCEPTANCE.md).

Rho does not implement another scientific execution path. Domain owners interpret
R models, input conditions, numerical results and recovery. Queries are bounded
observations and do not start or recover runtimes. Models and retrieved content
cannot expand existing authorization. Agent-authorized work receives mechanical
identity, scope and native-condition checks without another Rho approval.
There is no global scientific revision or promise to roll back native side effects.

## First application candidate

The first candidate user action is to open an original task, see its execution
state and domain-check state, inspect or retrieve its real tables/plots, and find
the same task after observation disconnects. This is selected design, not an
implemented UI or researcher acceptance result.

Present the owners' actual facts and limitations. Layout, focus and views belong
to the application; files, scientific resources and task identity retain their
owners. Use the [UI principles](RHO-DESIGN.md) when an interaction slice is selected.

New transport, SDK, installation, discovery, Editor/Studio/Manager or chat capability
requires a demonstrated consumer gap. Reuse Rscript, R packages, RDS, manifests,
ordinary files and Git where sufficient. Old subsystem maps do not select all
former features, content migration or compatibility layers.

## Composition and distribution

Keep independent source repositories, with Rho as the later application development
and composition entry. No root Cargo workspace or alternate maintenance copy is
introduced. Other owners may remain incompatible while their bounded work proceeds.
Only an explicitly selected integration chooses fixed source/artifact identities,
public dependencies, visible local overrides and acceptance of that combination.
Those mechanisms have not been reimplemented in this tree.

A source push does not build, install or prove an application. The future
Rho-releases boundary owns promotion and signed distribution of an accepted
composition; it is selected for implementation only at the first official signed
release milestone. See [Release](RELEASE.md#future-official-release-boundary).
