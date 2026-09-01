# Architecture

Rho is a local-first scientific workbench with one durable authority path and
separate interactive, Agent, and background-job planes.

```text
React Workbench (Goal / Activity / Approval / Jobs)
  │ versioned provider-neutral contracts
  ▼
Tauri admission commands ── rho-control-plane Broker
  │                            ├─ deterministic policy / information flow
  │                            ├─ exact one-use approval leases
  │                            └─ capability registry
  ├─ rho-acp-client ── client for external ACP Agents; no Agent implementation
  ├─ rho-workspace ── authenticated serial Workspace R bridge
  ├─ rho-environment ── Runtime / Library / Profile / immutable plan semantics
  ├─ rho-execution ── Local / OCI / SSH runner / Slurm
  ├─ rho-sandbox ── immutable snapshots / staging / network enforcement
  ├─ rho-secret-broker ── SecretRef / scoped injection
  ├─ rho-artifact-store ── immutable CAS / manifests / provenance
  ├─ rho-store ── authority events / projections / receipt feed
  └─ rho-evidence-graph ── project-local LadybugDB claim graph / gaps / traces

remote: framed SSH → digest-pinned rho-runner → Slurm → remote CAS
```

## Truth and authority

- **Broker admission is the sole effect ingress.** Provider permission hints,
  transport acknowledgements, UI state, and model claims are not authority.
- **Workspace R** owns the single live scientific state. Every admitted
  evaluation is serialized and returns a revision-aware terminal observation;
  failed or uncertain arbitrary evaluation can advance the state revision.
- **Semantic Store** owns durable events and projections. It has one fresh
  schema fingerprint and no migration, compatibility read, or dual-write path.
  Store contains no claim/support tables. Its trigger-backed receipt log exposes
  bounded changes only after the corresponding authority mutation commits.
- **Evidence Graph** owns recorded claims, links, promotion history, graph
  snapshots, and deterministic gaps in `<project>/.rho/evidence.lbdb`. It can
  cache bounded Authority observations internally for reconciliation, but its
  renderer projection exposes only stable refs and graph-owned semantics.
  Current Run, Artifact, Approval and Revision facts are independently resolved
  from their owners. Sidecar failure does not change an authority result.
- **Execution and schedulers** own process/job truth. Missing processes,
  disconnected SSH, daemon loss, and delayed `sacct` remain uncertain until an
  exact identity can be reconciled.
- **Environment realization** separates desired state from observed
  realization. Materialized immutable plans bind exact artifacts, Runtime,
  ordered LibraryStack target, RepositoryProfile and ExecutionProfile
  identities and are persisted for review before approval. Store accepts an
  apply only with the matching Broker lease, commits a binding only with a
  successful verification receipt, and keeps live Workspace execution blocked
  through restart/re-observation or an open PackageIncident.
- **Artifact CAS** owns output identity. Product success requiring output is
  reported only after sealed staging bytes are SHA-256 verified and manifest
  metadata is durably committed.
- **Secret Broker** exposes references and purpose/audience/destination-bound
  leases, never serializable plaintext material.
- **React** owns presentation only. Workbench composition joins independent
  Authority observations with graph refs. Authority modules never import the
  graph; Evidence modules have no Authority mutation; Agent receives reads plus
  draft-only graph writes. Committed states require authoritative event,
  revision, scheduler, process-tree, or CAS evidence.

## Agent boundary

`rho-acp-client` speaks the standard Agent Client Protocol to external Agents
such as Codex ACP or Claude Code ACP. Rho does not implement their model loop,
tool harness, planning, or session runtime. Private reasoning and raw frames do
not enter UI or Store. External Agents work only inside disposable project
snapshots; a Provider permission response is never Rho authority. A Provider
switch changes Agent context, not Conversation, Job, Revision, or Artifact
identity.

## Containment and controlled mutation

Agents see an immutable project-revision snapshot mounted read-only. Scratch
and staging are independent writable areas; authoritative project paths,
Workspace sockets, Store SQLite, the LadybugDB sidecar, CAS internals, host
terminals, and secret stores are not mounted. Canonical patches carry base
revision and per-file digests. Broker
approval binds the exact patch digest, destination, expiry, and high-risk path
acknowledgements. Multi-file commits use a durable journal and report exact
applied/pending sets rather than claiming cross-file atomicity.

Network is denied unless both policy and platform enforcement admit a canonical
scheme/host/port. DNS results are pinned and checked again at connect and every
redirect. Provider-only traffic is not general sandbox network access.

## Background and remote jobs

A versioned `ExecutionSpec` provides typed IDs, argv, working-set/environment
manifests, exact Environment receipt/Profile refs, resource requests, network
posture, outputs, provenance, and retry semantics for Local, OCI, SSH, and
Slurm adapters. Commands are never Agent shell strings. `rho-runner`
authenticates bounded requests, verifies the same spec and staging-manifest
digests plus every leased CAS byte, journals operation markers, and survives
duplicate requests.
Remote bytes move by leased digest manifests and resumable checked chunks, not
mutable project synchronization. SSH is transport only; Slurm owns scheduler
lifecycle.

## Main code areas

| Owner | Source |
| --- | --- |
| Canonical contracts | `crates/rho-protocol` |
| Semantic events and projections | `crates/rho-store` |
| Claims, graph links, gaps, traces and snapshots | `crates/rho-evidence-graph` |
| Capability, policy, Broker, commits | `crates/rho-control-plane` |
| External ACP client boundary | `crates/rho-acp-client` |
| Hot bounded stream | `crates/rho-event-hub` |
| Workspace R revision bridge | `crates/rho-workspace`, `r/rho.bridge` |
| Environment realization | `crates/rho-environment`, `r/rho.environment` |
| Local/OCI/SSH/Slurm execution | `crates/rho-execution`, `crates/rho-runner` |
| Snapshot, staging, process and network sandbox | `crates/rho-sandbox` |
| Secrets | `crates/rho-secret-broker` |
| Artifacts and transfer | `crates/rho-artifact-store` |
| Desktop contracts and UI | `crates/rho-ui-contract`, `desktop/` |
| First-party R adapter | `r/rho.agent` |
| Telemetry | `crates/rho-telemetry` |
| Extension runtime and authoring | `crates/rho-extension-runtime`, `crates/rho-plugin-dev` |
| Public observer tools | `crates/rho-cli`, `crates/rho-mcp` |

The generated [source index](SOURCE-INDEX.md) maps these paths to executable
checks.
