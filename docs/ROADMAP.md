# Rho product roadmap

The first release is an npm-distributed local WebUI: natural-language action,
real code/data/graphics and arranged views within one browser window. A local
Rho service reaches Core through its public CLI. Native desktop clients follow
later and reuse the component and execution boundaries.

The [first-release task list](WEBUI-FIRST.md) owns task IDs, priorities,
dependencies, owners and observable completion conditions. The
[backend plan](BACKEND-FIRST.md) sequences the required headless implementation
before independent UI development. The
[design checklist](DESIGN-PRIORITIES.md) owns interaction-design deliverables.
The headless service, shared state, real analysis and continuity are implemented;
[backend acceptance](BACKEND-ACCEPTANCE.md) records their actual checks. Browser
implementation and integrated product acceptance remain pending.

## First integrated flow

Use a disposable project and an owned resident Host. Select one actual Agent
adapter, one supported OS/architecture and browser baseline, and explicit Core,
R and component versions before implementation acceptance. The available real R
recipe supplies a reference analysis and retained outputs; choose its exact inputs
and expected outputs in the accepted composition. A component evaluation is not
the product Agent connection.

The two slices below are required for the first release. A working npm startup
and dependency check are exercised early; final installation acceptance then
repeats the whole flow from the built package in a clean environment.

### Slice A: first analysis with an actual Agent

1. Install the npm package, start the local service, open the WebUI and create or
   open a project. Actual startup faults provide diagnostics; scientific dependency
   checks belong to a selected action inside the project, preserving the project choice.
2. Configure and test the selected Agent adapter, bind it to the project and make
   its available actions and resource scope visible. The chosen adapter determines
   the supported external client and its actual interface; conversation remains
   in that client while Rho binds context, actions and results.
3. An authorized natural-language request reaches a real component action and
   opens a typed parameter interface bound to actual inputs. The user can inspect
   and change parameters directly. Agent, UI and supported CLI entries share the
   component implementation and conditions; already authorized work receives no
   additional Rho approval.
4. Execute once with a persisted original caller/request identity. Open the
   script, actual result table and interactive plot on owner-provided resources.
   Sorting/filtering and linked selection preserve stable domain identity.
5. Inspect execution completion, artifact integrity, domain checks and Agent
   explanation as separate facts with their scope and freshness. Export actual
   artifacts with their provenance, then reopen the project and inspect retained
   runs and outputs without rerunning them.

### Slice B: human-Agent handoff and continuity

1. Select code, a table entity or a plot mark and pass an explicit resource/version
   reference to the Agent. The interface distinguishes saved content from the
   current unsaved buffer and makes the supplied context inspectable.
2. The Agent acts through the same component actions and document buffer as the
   user. Its edits are visible and reviewable; the user continues editing and can
   undo. Concurrent external writes or stale references produce a clear conflict
   rather than silently overwriting newer work.
3. Switch tabs, split and rearrange views, then restore the layout within one
   browser window. Preserve one logical buffer owner, undo, selection and focus.
   Use keyboard commands, actual Unicode IME and clipboard with accessible
   alternatives to dragging and graphical selections.
4. A failing analysis offers an Agent repair entry containing the actual error
   and resource reference. A corrected analysis is deliberately new work with a
   new request identity; observing or reconnecting to the failed run is not.
5. Lose a submit acknowledgement, disconnect or refresh the browser, and find
   the original task. Verify one native dispatch, retained partial output and an
   honest unknown state when the outcome cannot be established. Browser/view
   closure, cancellation request, confirmed native stop and Host shutdown have
   separate effects.
6. The Agent composes one further comparison or explanation view from registered
   components bound to the same resources and selections. Malformed, stale and
   out-of-scope invocations fail mechanically. Unavailable components retain
   inspectable resource/output references and do not replay actions.

The two slices verify workbench behavior, component composition and Agent
interaction together. Component-only checks establish their recorded scope;
integration requires the actual selected source/artifact combination. Native
desktop windows are not a condition of this browser release.

## Implementation sequence

| Step | Owner and result |
| --- | --- |
| Scope and public contracts | BP-01 selects the actual external Agent, platform/runtime and real case; the owners define versioned actions, resources, documents, errors and events |
| Installable backend foundation | BP-02 builds the npm launcher, authenticated local service, project scope and public Core CLI adapter without a browser shell dependency |
| Real analysis and shared state | BP-03/BP-04 deliver project-action dependency checks, real analysis, shared document state and external Agent handoff; document work can proceed in parallel |
| Data, composition and backend acceptance | BP-05/BP-06 verify real data/selection, typed composition descriptions, continuity, export/recovery and installation through headless clients |
| Independent UI implementation | UI consumes the tested contracts and fixtures to implement component views, shell/layout and the actual browser interaction without duplicating backend state |
| Package acceptance | Rho verifies both slices, export/reopen, installation, failure cases, input/accessibility and resource behavior on the supported composition |

Reuse the R1–R14 design for backend scenarios without waiting for UI implementation.
Backend acceptance does not establish browser interaction or product release acceptance.
The selected Node/MCP/R versions, immutable source/artifact identities and headless
results are recorded in [backend acceptance](BACKEND-ACCEPTANCE.md). Browser library
versions and the complete product composition still require selection and acceptance.
Keep original failure evidence and distinguish a designed flow from a tested one.

## Resource acceptance

Measure cold start, interaction latency and steady/peak memory on representative
data and the supported platform/browser. Define configured limits for rendered
logs, retained messages, data pages, drawing work and component concurrency with
explicit exceeded-limit behavior. Use references and bounded pages across views.
Exhaustion preserves obtained output and uncertainty without stopping unrelated
execution or creating a new request identity. The task list records release gates;
threshold values are selected with the implementation and measurement environment.

## Subsequent milestones

P1 work improves the accepted browser flow: additional Agent adapters, richer
view catalogs, advanced terminal functionality and additional platforms/channels
are selected from actual consumer needs. Each addition requires its own checks;
having an npm installer alone does not establish platform support.

The later desktop milestone adds Electron/native windows, cross-window movement,
menus, file associations and system integration to the accepted WebUI foundation.
Browser multi-window work is also deferred by scope, not declared impossible.

An official signed-distribution milestone separately selects a platform and
installation format. The [release owner](RELEASE.md#official-distribution)
records candidate and signed identities, publication and installation evidence.
It is not selected merely by choosing npm for the first release. Additional
platforms and automatic-update channels retain their own acceptance.
