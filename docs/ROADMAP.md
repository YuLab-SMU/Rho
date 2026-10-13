# Rho product roadmap

The first delivery is a coherent intelligent workspace: natural-language action,
real code/data/graphics and freely composed views across windows. Each technical
boundary is implemented in its source owner, and the product is accepted through
one integrated user flow.

## First integrated flow

Use a disposable project and an owned resident Host. The available real R recipe
provides a concrete scientific component and retained outputs; execute new work
only when the selected behavior needs it.

1. An authorized natural-language request selects a real component action and
   opens a typed parameter interface. Agent, UI and CLI entries share the
   implementation and native conditions; managed execution carries its original
   caller/request identity.
2. Script, actual result table and interactive plot share resource provenance and
   stable selections. Sorting, filtering, missing values and numeric presentation
   preserve domain identity and meaning.
3. Dock, switch and move views to another window while native Unicode editing,
   undo, clipboard and focus work. Unsaved documents keep one buffer owner and
   external writes produce a clear save conflict.
4. Close or crash an observer, then find the original task from another view.
   Verify one native dispatch, partial/unknown result preservation and observation
   without replay. Host shutdown and native-session recovery are separate claims.
5. Display execution completion, artifact integrity and domain checking with their
   recorded scope/freshness. A model explanation remains distinct. Existing runs
   retain component version, provenance and available outputs after a View becomes
   unavailable or a component is upgraded.
6. The Agent composes a further comparison/explanation view from registered
   components, bound to the same resources and selections. Malformed, stale or
   out-of-scope invocations fail mechanically within the existing authorization.
7. Keyboard commands and appropriate assistive alternatives work. Failed popout,
   missing components and layout restore preserve drafts/results and provide
   recoverable view state without executing actions again.

This flow jointly verifies the workbench, composition and Agent experience.
Component-only checks establish their recorded scope; integration requires the
actual selected source/artifact combination and representative platform behavior.

## Implementation sequence

| Step | Owner and result |
| --- | --- |
| Consumer boundary | Components define the first Action/Resource/Selection/View contract; Rho implements its routing and composition adapter |
| Desktop and continuity | Rho implements Electron windows/layout and public Core CLI observation; the resident Host has an independent lifetime |
| Linked functionality | Editing/data/graphics components expose real resources, shared selection and document conditions |
| Agent composition | Agent component invokes those actions and produces typed catalog compositions in the same workspace |
| Integrated acceptance | Exercise the full flow, interruption/failure cases, native input and measured resource behavior |

These steps are bounded implementation units toward one acceptance target. Record
actual dependency versions and immutable identities when selecting each combination.
Maintain useful owner regressions and preserve original failure evidence.

## Resource acceptance

Measure cold start, interaction latency and steady/peak memory on representative
data and platform builds. Define configured limits for retained view/message bytes,
data pages, drawing work and component concurrency, with explicit exceeded-limit
behavior. Pass references and bounded pages across windows. Exhaustion preserves
obtained output and uncertainty without stopping unrelated user execution.

## Subsequent milestones

After the first flow, add a second functional domain to check reuse of the common
interaction boundary. Select external MCP/Agent/UI interoperability and component
publishing from actual consumer needs. Each retains resource scope, original
identity and inspectable results.

An official distribution milestone selects one accepted composition and platform.
The [release owner](RELEASE.md#official-distribution) records candidate and signed
identities, publication and installation evidence. Additional platforms and update
channels are selected with their own acceptance.
