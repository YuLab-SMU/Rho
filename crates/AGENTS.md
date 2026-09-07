# Rho components

Read [current focus](../docs/STATUS.md) and the relevant
[architecture constraints](../docs/ARCHITECTURE.md) before changing a component.
The root Cargo workspace is the single production workspace.

Edges call Host ports. Domains own scientific meaning and define native ports;
adapters implement them. Effectful requests share Operation admission, idempotency
and atomic commit discipline. Queries do not start R or trigger recovery merely
to read a result. The R adapter uses third-party Jet under `vendor/jet`.

Keep native identities, owner-specific preconditions, project containment and
caller/principal visibility. Preserve uncertainty after unconfirmed effects.
A stop request is not confirmed cancellation or rollback. Do not introduce a
parallel result database, global scientific revision counter, conversation loop
or Agent approval model.

Use the closest relevant test, then affected broader gates from
[Development](../docs/DEVELOPMENT.md). Cargo invocations share `target/`; run only
one build/test/check at a time. Real Ark/R acceptance is separate from ordinary
Cargo tests; ignored checks are not passes.

Maintain constraints in code/tests and explain durable ownership in Architecture.
Update Status only when current behavior, focus or verification changes. Git
retains implementation history.
