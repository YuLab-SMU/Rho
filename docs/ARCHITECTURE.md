# Rho architecture

**Rho owns the operable scientific workspace. External Agents own conversation
and behavior.** Human and Agent requests reach the same domain owners and return
the same underlying facts.

## Authority and ownership

| Owner | Responsibility |
| --- | --- |
| External Agent platform | Conversation/session lifecycle, intent, planning, tool choice, model/provider settings, permission decisions and continuation |
| Host | Compose domains and adapters, own runtime lifetime, bind trusted local context and expose shared ports |
| Operation foundation | Capability registration, schema/scope validation, idempotency, state transitions and atomic commit discipline |
| Scientific domains | Interpret observations, validate domain preconditions and describe results and effects |
| Native adapters | Interact with R, files, Git, package tools, OS processes, SSH and Slurm |
| Studio | Present state and user controls; retain documents and layout independently of panel mounts |

Agent integration is a thin boundary. Rho validates mechanical constraints and
responds to requested operations; it does not infer a new goal, construct an Agent
plan, run a competing behavior loop or introduce a second approval decision.
Conversation content is not an authority source or a parallel Rho database.
The current Agent transport is MCP; ACP or other Agent adapters must follow the
same boundary. Scientific state and capabilities should be discoverable through
the shared Host, with no Agent-specific handler bypass.

## Request paths

```text
CLI / session / browser / official MCP
                  |
                 Host
          /                  \
 Operation Gateway        Query Gateway
          |                  |
      registered scientific domain handlers
          |
      domain ports -> native adapters
          |
      actual result -> CommitPlan -> SQLite transaction
```

The five shared scientific ports are `invoke`, `getOperation`, `requestCancellation`,
`querySnapshot` and cursor-based `subscribe`. A sibling `respond_input` control
replies only to an identified pending stdin request; it neither creates an
Operation nor acquires the ordinary execution lane. JSON session names use snake_case.
The browser's `/api/host` forwards them. HTTP hosting endpoints separately manage
project/R selection and application state; they do not create another scientific
operation flow. CLI/session and official MCP use the same composition root.

### Commands and results

An effectful request has one OperationId. Admission binds trusted caller/principal
identity, normalized arguments, capability, target and native preconditions.
The client supplies a client request ID; retrying the same action reuses it.
Reusing the key with different input is rejected. Project-specific operations bind
the actual project scope, rather than relying on the process working directory.

A domain handler returns a CommitPlan. The foundation commits the operation
transition, domain facts and outbox events in one transaction. Adapters do not
commit their own result databases. Terminal outcomes are immutable.

A cancellation request is a request, not proof of termination. Errors and confirmed
cancellation do not imply rollback of assignments, files or remote effects. When
effects may have occurred but the outcome cannot be confirmed, retain uncertainty
and native recovery references. Reconciliation is an explicit operation; it does
not replay the original action or rewrite its terminal result.

### Workspace execution admission

The Workspace owner holds the serial R queue. Gateway admission/idempotency runs
before enqueueing; retries do not create another queue entry. Domain execution
leases keep a request Accepted while it waits, arbitrate pending cancellation with
start, and retain the native lane until the final commit finishes. A final commit
failure pauses following work. Queue controls also fence starts until their commit
finishes. They never introduce another analysis execution or approval path.

The optional Invoke transport acceptance reply preserves the default terminal
reply. Detached edge waits do not detach accepted work from the Host. Pending
requests are not replayed on restart; existing recovery distinguishes Accepted
from possibly started work. A before-start failed/cancelled commit cannot contain
scientific facts, output or effect observations.

Read/control capacity is reserved separately from waiting Invoke calls, so a full
transport queue cannot prevent observing or answering stdin.

Input replies bind the existing session, operation, native request and caller.
They bypass the execution queue, accept one answer, and carry no journal/draft
payload. Waiting for input suspends the runtime timeout, not cancellation.
The Jupyter reaper retains only its own pipe; inherited project/journal descriptors
and other reaper pipes must not keep another Host alive.

### Queries and observations

Queries perform bounded reads with source, observation time, status and completeness.
They do not create Operations, start R, or trigger crash recovery merely to read
recorded results. Read-only access to existing operation records is distinct from
opening a writer and recovering incomplete work.

Live Workspace queries respect the execution lane. A busy response leaves R alone;
the UI can retain the previous observation with its timestamp. Object inspection
avoids forcing promises/active bindings or invoking user-defined print, format and
subset methods. Unsupported classed objects remain metadata-only.

Live package inspection belongs to Workspace because the active R session owns
its library search order, loaded namespaces and attached packages. The bounded
`workspace.packages` query reads DESCRIPTION text and existing namespace metadata
through the same idle-only lane, without loading packages or recording an Operation.
It does not substitute a separate R process's inventory for the live session.
Environment retains management/realization ownership; Studio package viewing adds
no installation or environment-selection path.

Paginated summaries come from the journal. Runtime output logs contain ordered,
bounded observations and media references; they do not determine execution outcome.
A missing output event is not itself execution failure. Output storage has an
independent owner port, so historical media queries also work in a project-only
Host. Media is addressed by
OperationId and output sequence, with original bytes checked against the reference.

## Native identities and concurrency

Git owns commits and index state; the filesystem owns current bytes; R owns its
live session; native environment locks describe dependencies; Slurm owns jobs.
Rho uses their identities and relevant digests instead of a global scientific
revision counter. Application-state version tokens only coordinate UI writes.

Host startup acquires an OS lease on the canonical project's `.rho/next-host.lock`
and an exclusive journal writer lock. A second database cannot create a second Host
for the same project. Lock-file existence does not prove liveness. Accepted work
retains the Host and project lease after an edge disconnects.

Host-managed Workspace, Project, Environment and process operations share the
appropriate execution lane. External editors/processes are not locked by it.
MCP sessions retain their selected Host; active work and MCP references prevent
project/R switching. A new project lease is reserved before ending the old session.
R candidates are validated before teardown; failed restart reports unavailable R
and preserves file access where possible, without claiming memory was restored.

## Persistence and recovery

| Material | Meaning |
| --- | --- |
| Operation journal | Accepted requests, immutable outcomes, committed domain facts and outbox events |
| Application SQLite store | Drafts, layouts, view positions, recent projects, preferences and unconfirmed request identities; outside scientific history |
| Runtime output files | Bounded text/display observations and original media associated with an Operation |
| Native recovery material | Process markers, receipts, staging paths and job identities needed to reconcile uncertain effects |

Draft writes use version preconditions. Concurrent windows cannot silently overwrite
one another. Acknowledgement loss requires checking the original request/state.
Restart restores synchronized application state, not R memory or the previous
in-memory editor undo stack. Reopening a view never reruns an operation.

Environment realizations use isolated libraries, verification receipts and explicit
activation in a new R session. Cleanup is explicit and reference-aware. Successful,
uncertain, active or unobservable materials are protected; quarantine and restoration
are separate from permanent purge. Native process reconciliation checks current
ownership observations instead of trusting an old PID. Scheduler reconciliation
uses native job identity and never treats a lost connection as proof of job failure.

## Studio model

AppShell handles project entry, navigation, commands, settings and runtime status.
LayoutHost manages panel instances and geometry through FlexLayout. Panels consume
a shared Studio model; HostClient owns network requests and event consumption.
Documents retain CodeMirror state outside component lifetime. Layout changes cannot
trigger execution or discard drafts. A panel rendering failure stays within that panel.

Save uses `project.apply_patch` and the original file digest. Only a returned
filesystem digest matching the captured content confirms the save; edits made
while saving remain dirty. Run File saves and verifies its captured text before
submitting that exact text. Formatting applies automatically only if the document
still matches the request; otherwise it offers comparison.

Frontend DTOs are generated from Rust contracts. Vite produces the embedded assets
from `ui/`; the browser does not load a frontend CDN. Dynamic editor/component
styles use a CSP nonce. SVG is loaded as an image; HTML/widgets are not injected
into the Studio document. Resource indicators use known native process observations.

Product interaction proposals are in [RHO-DESIGN.md](RHO-DESIGN.md). Their desired
behavior must not be confused with the implemented baseline or the open issues in
[STUDIO-FEEDBACK.md](STUDIO-FEEDBACK.md).

## Source map and dependency direction

| Location | Role |
| --- | --- |
| `crates/contract` | Wire identities and DTOs, including generated TypeScript sources |
| `crates/operation` | Operation and Query gateways, handler/journal ports and commit discipline |
| `crates/workspace`, `project`, `environment`, `execution` | Scientific owners and native port definitions |
| `crates/adapters/` | SQLite, Git, R, package, process and SSH/Slurm implementations |
| `crates/host` | Concrete composition and runtime configuration |
| `crates/cli`, `mcp`, `workbench` | Transport and application entry points |
| `r/bridge`, `r/environment` | Native R execution, bounded observation and environment helpers |
| `ui/src`, `scripts/` | Studio models/views and reproducible development/verification tools |

Dependencies flow from edges to Host, from adapters to domains, from domains to
Operation, and from Operation to contract. Domains do not import their concrete
adapters; contract does not depend on native runtime or transport libraries.
[The architecture check](../scripts/check-architecture.mjs) enforces the allowed
production dependencies. Exact public schemas come from the live capability registry.

## Execution boundary

The local workbench uses loopback binding, bearer authentication, Host/Origin checks,
bounded requests and restricted assets. Project-relative paths, host-owned data,
symbolic-link containment and reference integrity are validated at execution/read
boundaries. Caller/principal visibility and project scope follow each port's contract.

Native R, package scripts and commands run with the user's OS privileges. Process
supervision and recovery markers are not an adversarial filesystem/network sandbox.
Credentials remain with their existing provider; Rho does not create an Agent
credential or approval store. See [PRIVACY.md](../PRIVACY.md) and
[SECURITY.md](../SECURITY.md) for data handling and reporting.
