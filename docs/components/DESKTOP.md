# Desktop application

The desktop is a deliberately thin Tauri shell around provider-neutral
Workbench contracts.

## Backend

`desktop/src-tauri/src/main.rs` creates the clean composition root and registers
only current Workbench and Jobs commands. `application_state.rs` owns the
Broker-bearing state; authority-bearing services are never serialized to the
renderer. Commands under `commands/agent/` and `commands/jobs/` authenticate
and validate bounded request envelopes, delegate through the current port, and
validate the response. They do not copy policy or Provider state machines.

Reconnect returns a durable snapshot, a hot cursor, and an explicit gap. It
never replays complete token history. Command results distinguish `accepted`,
`committed`, `uncertain`, and `rejected`; a transport acknowledgement is not a
success claim.

## Frontend

`desktop/ui/src/main.tsx` mounts the current `App`. The Agent workbench under
`app/agent/` presents:

- Goal and provider-owned Current Work;
- bounded live Activity with cursor/gap recovery;
- exact one-use Approval effects, destination, revision, and risk;
- independent Job cards and controlled-patch reconciliation;
- revision, artifact, recovery, and policy context.

`app/jobs/` renders Rho-owned Local/OCI/SSH/Slurm truth: queue and process state,
requested versus effective resources, bounded logs, cancellation request versus
process-tree confirmation, scheduler reconciliation, and CAS artifact status.
Agent Plans and Provider sessions cannot alter Job identity or timeline.

Provider controls are generated from a neutral capability and option schema.
Unsupported Plan, resume, model, reasoning, or config controls do not exist;
there is no Provider-name branch in React. External observers display their
read-only and continuity limitations. Permission posture and data-egress policy
remain Rho settings across Provider switches.

Rust facets in `rho-ui-contract`, TypeScript contracts under `contracts/`, the
Tauri command surface, and browser mock handlers move together. UI fixtures
exclude ACP methods, private reasoning, raw project payloads, host paths, and
plaintext secrets. Styles live in tokenized files under `ui/src/styles/`;
`foundation.css` only composes layers.

`desktop/dist/` is generated output, not source.
