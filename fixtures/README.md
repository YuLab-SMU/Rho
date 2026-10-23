# Read-only state fixtures

[states.json](states.json) contains eleven inert states for the
[served contract](../protocol/index.json): empty, loading, completed, failed,
partial, unknown, unavailable, stale, conflict, limit and partial-retained.
Completed output comes from the ordinary R project; partial/unknown from actual
base-R execution and owned Host loss; failed from a retained original-analysis
checker failure. Each capture/projection names its scope. No fixture is an
executable request or a substitute for UI acceptance.

`partial-retained` is the retained original DESeq2 observation: the first fit was
paused after its first model save and the owned Host was lost, leaving a
16,139-row table with no completion declaration. It is re-read through the
current contract rather than kept as a second dialect, which is why its state
name records that it is retained evidence.

States from the repair path came from the repaired recipe and separate
native/arithmetic checks; the remaining cases were captured from real service
calls.

These files are inert display/test data with `readOnly:true` and
`replay:"forbidden"`. Native journals, executable source, machine paths and
credentials are omitted. They do not establish browser input, layout or rendering
acceptance. A new capture must select retained actual experiment records
explicitly with `scripts/capture-fixtures.mjs`; builds do not regenerate evidence
or overwrite the retained capture.
