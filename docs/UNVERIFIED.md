# Verification scope

The current source checks are recorded in [the verification results](VERIFICATION.json)
and summarized in [Status](STATUS.md). Historical accepted combinations retain
their own scope; they do not automatically accept this changed MCP boundary.

## Corrected diagnoses

- Owner-state artifacts already had a presentation route. `artifact.check`
  supplies their registered references; `acceptance:execution` now exercises
  stdio discovery, conditional save, real R execution, direct binding, actual
  PNG decoding and refresh. Re-registering `.rho` paths remains refused.
- A browser can conditionally save its shared document. `acceptance:person`
  checks button/keyboard saves and external-write conflict preservation at
  1440, 768 and 390 pixels.
- The deterministic walkthrough shares the execution/browser journey. It does
  not establish that a model inferred the workflow from guidance. `npm run agent`
  separately passed a real Claude Code context/edit/confirmation trial.

The [local installed combination](progressive-acceptance.json) passed outside all
three checkouts: person (9 checks), execution/MCP (5) and U1 (23), with exact
artifact and protocol-shard hashes. The strengthened execution runner waits for
the actual responsive renderer before checking image decoding at each width.

## Remaining scope

| Path | Evidence still needed |
| --- | --- |
| Windows and Linux | Platform runs; the native folder picker currently targets macOS. |
| Operating-system folder dialog | A person-driven native dialog trial; automated UI checks replace the picker. |
| Autonomous scientific work through the new default MCP entry | A real model performing the scientific task and presentation; the current model trial covers context and document collaboration. |
| Full product and domain acceptance | The selected bounded journeys do not establish every scientific method or UI flow. |

## Journeys

`acceptance:matrix` runs person, execution/MCP and U1 against the source build and,
when `--install DIR` is selected, an installed package. `acceptance:walkthrough`
is an alias for the execution/MCP journey; it is not counted twice. Execution
requires one Host and one submission. Read-only UI flows require zero of each.
Disposable projects and owned Hosts isolate the checks from live user work.
