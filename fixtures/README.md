# Read-only versioned state fixtures

[v2/states.json](v2/states.json) contains ten inert states for the extracted
[v2 contract](../protocol/v2.json). Completed output comes from the ordinary R
project; partial/unknown from actual base-R execution and owned Host loss; failed
from a retained original-analysis checker failure. Each capture/projection names
its scope. No fixture is an executable request or a substitute for UI acceptance.

## Frozen v1 evidence

[states.json](v1/states.json) contains ten actual response captures or explicitly
scoped projections: empty, loading, completed, failed, partial, unknown,
unavailable, stale, conflict and limit. They conform to the same
[public protocol](../protocol/v1.json) used by HTTP clients and MCP tools.

The partial and unknown cases came from a real DESeq2 fit paused after its first
model save, followed by loss of the owned Host. Its 16,139-row output has no
completion declaration. The failed case preserves the first singleton-histogram
recipe failure. Completed output came from the repaired recipe and separate
native/arithmetic checks. Other cases were captured from real service calls.

These files are inert display/test data with `readOnly:true` and
`replay:"forbidden"`. Native journals, executable source, machine paths and
credentials are omitted. They do not establish browser input, layout or rendering
acceptance. A new v2 capture must select retained actual experiment records
explicitly with `scripts/capture-fixtures.mjs`; builds do not regenerate evidence
or overwrite the frozen v1 capture.
