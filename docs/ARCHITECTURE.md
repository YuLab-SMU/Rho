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
  ├─ rho-agent-host ── first-party adapter or isolated ACP v1 observer
  ├─ rho-workspace ── authenticated serial Workspace R bridge
  ├─ rho-execution ── Local / OCI / SSH runner / Slurm
  ├─ rho-sandbox ── immutable snapshots / staging / network enforcement
  ├─ rho-secret-broker ── SecretRef / scoped injection
  ├─ rho-artifact-store ── immutable CAS / manifests / provenance
  └─ rho-store ── fresh semantic event log / rebuildable projections

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
- **Execution and schedulers** own process/job truth. Missing processes,
  disconnected SSH, daemon loss, and delayed `sacct` remain uncertain until an
  exact identity can be reconciled.
- **Artifact CAS** owns output identity. Product success requiring output is
  reported only after sealed staging bytes are SHA-256 verified and manifest
  metadata is durably committed.
- **Secret Broker** exposes references and purpose/audience/destination-bound
  leases, never serializable plaintext material.
- **React** owns presentation only. Committed states require authoritative event,
  revision, scheduler, process-tree, or CAS evidence.

## Agent boundary

`rho-agent-host` exposes one canonical Provider contract. The first-party
adapter and external ACP observer use the same logical session, turn, event,
and capability shapes. ACP wire DTOs terminate inside
`protocol/acp/v1`; private reasoning and raw frames do not enter UI or Store.
External providers are observers unless a platform/provider profile has all
sandbox guarantees plus a passing security-corpus digest. A Provider switch
changes model context, not Conversation, Job, Revision, or Artifact identity.

## Containment and controlled mutation

Agents see an immutable project-revision snapshot mounted read-only. Scratch
and staging are independent writable areas; authoritative project paths,
Workspace sockets, SQLite, CAS internals, host terminals, and secret stores are
not mounted. Canonical patches carry base revision and per-file digests. Broker
approval binds the exact patch digest, destination, expiry, and high-risk path
acknowledgements. Multi-file commits use a durable journal and report exact
applied/pending sets rather than claiming cross-file atomicity.

Network is denied unless both policy and platform enforcement admit a canonical
scheme/host/port. DNS results are pinned and checked again at connect and every
redirect. Provider-only traffic is not general sandbox network access.

## Background and remote jobs

A versioned `ExecutionSpec` provides typed IDs, argv, working-set/environment
manifests, resource requests, network posture, outputs, provenance, and retry
semantics for Local, OCI, SSH, and Slurm adapters. Commands are never Agent
shell strings. `rho-runner` authenticates bounded requests, verifies the same
spec digest, journals operation markers, and survives duplicate requests.
Remote bytes move by leased digest manifests and resumable checked chunks, not
mutable project synchronization. SSH is transport only; Slurm owns scheduler
lifecycle.

## Main code areas

| Owner | Source |
| --- | --- |
| Canonical contracts | `crates/rho-protocol` |
| Semantic events and projections | `crates/rho-store` |
| Capability, policy, Broker, commits | `crates/rho-control-plane` |
| Provider runtime / ACP / supervision | `crates/rho-agent-host` |
| Hot bounded stream | `crates/rho-event-hub` |
| Workspace R revision bridge | `crates/rho-workspace`, `r/rho.bridge` |
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
