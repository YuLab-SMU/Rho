# Desktop application

The desktop is a deliberately thin Tauri shell around provider-neutral
Workbench contracts.

## Backend

`desktop/src-tauri/src/main.rs` creates the composition root and registers the
current bounded commands. `application_state.rs` owns Broker-bearing state plus
one `ProjectGraphManager`; authority-bearing services and database paths are
never serialized to the renderer. Project switching commits Workspace and
Store identity first, then binds and reconciles the exact project graph. A
missing or corrupt graph is logged as `evidence_graph_unavailable` and does not
roll back the committed project switch.

`commands/authority.rs` owns bounded receipt listing and live Authority
resolution. `commands/evidence_graph.rs` separately owns graph health, Claim,
trace, gap, draft/promotion, refresh and snapshot requests. Graph renderer DTOs
contain stable Authority refs but no cached Authority status; current facts are
resolved through the independent Authority facet. The Agent frontend receives
Authority-read, Graph-read and Draft-write ports only; promotion methods are
absent from its capability object.

`commands/environment.rs` owns the typed Environment Authority health,
Workspace re-observation boundary, and the internal provider composition seam
for reviewed-plan/exact-lease apply. The renderer read port sees verified
receipt, desired/realization revisions, a pre-execution pending plan,
immutable checkpoint activity, live Workspace phase and incidents as separate
fields; it receives no apply port. The retired Toolchain
Doctor, generic package/request rendering, resource taskbar and desktop-bundled
remote helper commands are not registered. `rho.environment` has only
`Health`, `Plans`, and `Activity` modes.

The embedded LadybugDB path is currently verified for the local macOS
development target. Windows and Linux installer integration are deferred; no
cross-platform packaging claim is made by this cut.

Reconnect returns a durable snapshot, a hot cursor, and an explicit gap. It
never replays complete token history. Command results distinguish `accepted`,
`committed`, `uncertain`, and `rejected`; a transport acknowledgement is not a
success claim.

## Frontend

`desktop/ui/src/main.tsx` mounts `App`, which enters
`app/workbench/WorkbenchRoot.tsx`. Workbench capability pickers construct
stable Authority, Graph, Agent and Results ports from the application transport.
`SurfaceFrame` owns lifecycle/chrome, delegates Console rendering to
`app/console/ConsoleSurface.tsx`, and `SurfaceRouter` receives only narrow ports:

- `app/authority/`: independent Runs, Jobs, Artifacts, Approvals, Revisions and
  Environment modules reading owner receipts/projections; Environment renders
  Authority facts and live Workspace activation without generic domain data;
- `app/evidence/`: Claims, Evidence Graph, Evidence Gaps, exact Claim Trace;
- `app/agent/`: separate Goal, Current Work, Activity, Approvals, cited
  evidence, gaps and final-answer components.

Jobs are never inferred from Run request strings. If no Job owner projection is
published, `rho.jobs` says so instead of fabricating a list. Artifact identity
comes from receipts with canonical digests, not renderer interpretation of a
generic provenance flag.

The Agent workbench under `app/agent/` presents:

- Goal and provider-owned Current Work;
- bounded live Activity with cursor/gap recovery;
- exact one-use Approval effects, destination, revision, and risk;
- independent Job cards and controlled-patch reconciliation;
- revision, artifact, recovery, and policy context;
- Authority status separately from graph promotion/support status, including
  explicit ingest lag and open gaps.
- Environment Doctor context copied from Authority receipt/Workspace
  observation. Agent may inspect, explain and propose a typed apply handoff,
  but its provider capability set has no direct apply, install, shell, secret,
  re-observation, or evidence-promotion authority.

`app/jobs/` renders Rho-owned Local/OCI/SSH/Slurm truth: queue and process state,
requested versus effective resources, bounded logs, cancellation request versus
process-tree confirmation, scheduler reconciliation, and CAS artifact status.
Agent Plans and Provider sessions cannot alter Job identity or timeline.

Provider controls are generated from a neutral capability and option schema.
Unsupported Plan, resume, model, reasoning, or config controls do not exist;
there is no Provider-name branch in React. External observers display their
read-only and continuity limitations. Permission posture and data-egress policy
remain Rho settings across Provider switches.

Rust facets in `rho-ui-contract`, generated TypeScript facets under
`transport/generated/`, the Tauri command surface, and browser mock handlers
move together. Authority and Evidence Graph have separate generators and
contracts: `scripts/generate-authority-bindings.mjs` and
`scripts/generate-evidence-graph-bindings.mjs`. UI fixtures
exclude ACP methods, private reasoning, raw project payloads, host paths, and
plaintext secrets. Styles live in tokenized files under `ui/src/styles/`;
`foundation.css` only composes layers.

`desktop/dist/` is generated output, not source.
