# BH4-B Retention Policy Quotas And Defaults Spec

Status: accepted
Date: 2026-07-29
Scope: BH4-B retention policy quotas, defaults, and prune order

## Goal

Replace the boolean `RetentionPolicySnapshot` with a typed `RetentionPolicy`
struct that carries concrete numeric limits and a default value. The policy
becomes reviewable, testable, and directly usable when BH4-C starts enforcing
it.

## Rules

1. The `RetentionPolicy` type lives in `rho-store` and is exported for Tauri
   and test consumers.
2. Every numeric limit is `Option<i64>` so "no limit" is explicit.
3. `prune_order` is a string (`"oldest_first"`) to allow future order variants
   without a schema migration.
4. `auto_prune_enabled` remains `false` by default; enforcement stays in BH4-C.
5. Defaults are:
   - `max_plot_history_rows`: 200
   - `max_plot_payload_bytes`: 50 MB
   - `max_artifact_record_rows`: 500
   - `max_artifact_metadata_bytes`: 100 MB
   - `prune_order`: `"oldest_first"`
   - `auto_prune_enabled`: `false`

## Out of scope

- automatic enforcement of quotas
- per-project configuration or persistence of policy overrides
- schema changes or migration

## 2026-08-24 Runtime-output extension

The authorized
[`Runtime output and Agent context closed-loop contract`](../plans/active-2026-08-24-runtime-output-agent-context-closed-loop-spec.md)
adds Runtime-output retention fields without changing BH4 action semantics:

- `max_runtime_output_bytes_per_execution`: 128 MiB;
- `runtime_output_project_warning_bytes`: 1 GiB;
- `max_runtime_execution_rows`: 5,000;
- `auto_prune_enabled`: still `false` by default; and
- each numeric field supports an explicit unlimited value through the same
  optional-value convention.

Reaching an execution capture limit creates a durable tombstone and truthful
`partial` output state; it does not change successful scientific execution
into failure and does not silently delete earlier payload. A project warning is
non-blocking. `Start new transcript`, `Prune output payload`, and `Delete
execution record` remain distinct actions. The accepted defaults above stay
unchanged until schema v15 and all new readers/mutations land together.

## Verification

- `cargo test -p rho-store summarizes_retention_by_project_and_session_scope`
- `cargo test -p rho-store prunes_plot_payloads_with_project_and_session_tombstones`
- `node --check desktop/dist/app.js`

## Related

- [`active-2026-07-29-bh4-retention-privacy-artifact-lifecycle-handoff.md`](../plans/active-2026-07-29-bh4-retention-privacy-artifact-lifecycle-handoff.md)
- [`active-2026-07-29-bh4-b-project-retention-summary-and-policy-snapshot-spec.md`](active-2026-07-29-bh4-b-project-retention-summary-and-policy-snapshot-spec.md)
- [`active-2026-07-29-bh4-b-plot-payload-prune-tombstone-spec.md`](active-2026-07-29-bh4-b-plot-payload-prune-tombstone-spec.md)
