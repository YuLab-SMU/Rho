# Headless collaboration acceptance

Observed: 2026-10-16. Result: **headless collaboration accepted**. This does not
accept browser UI, native input, accessibility or a signed product release.
The [machine-readable record](backend-acceptance/v0.4.0-collaboration.json)
freezes the four installed candidates, source/tree/input/lock/package identities,
selected owners, accepted Core artifact and evidence digests. The
[protocol guide](COLLABORATION.md) defines the implemented contracts and budgets.

## Fixed composition

- Rho implementation: `3f406d346909779be49f8335af5bde4fdaf83590`.
- Plugins: `3040ef43cddaf55d15b750bc5eb558e0a0d954f9`, published on owner `main`
  before the application reference.
- Accepted public Core: `d0159da6feb01d1be9e3b4b34b67953241fedfcb`, reused without
  rebuilding. Binary SHA-256:
  `eee223026f7e0b4dd1ee14a409c023919626c4175be5728048a02af739af4ce1`.
- Environment: macOS arm64, Node `22.22.3`, npm `10.9.8`, Python 3,
  external R `4.5.2`, Claude Code `2.1.302`, MCP SDK `1.29.0`.

All packages retain version `0.4.0`; commit and artifact digests, not that version
alone, distinguish these candidates from the historical eight-owner
[0.4 baseline](PLUGIN-BOUNDARY-ACCEPTANCE.md). The current Core checkout is not
selected. No dirty build-input override was used. Later acceptance-only documents
do not replace or rebuild these fixed tarballs.

| Candidate | Physically installed owners | Result |
| --- | --- | --- |
| Full | Documents, Files, R, Requirements, Tables, Media, Charts, Agent, Annotations | Deterministic and actual Claude collaboration pass |
| Collaboration-minimal | Documents, Files, Tables, Charts, Agent, Annotations | Both collaboration variants pass without R/Requirements/Media plugins |
| Documents/Files | Documents, Files | Reduced installation, Unicode draft/export and unavailable-owner checks pass |
| Files/R | Files, R | Exported-object and unavailable-action checks pass without a Host |

Every installation is a real, non-symlink npm installation outside all source
checkouts. Each includes Contracts and only the dependencies of its selected
owners. All nine owner tarballs also pass independent installation/import with
Contracts and their declared external dependencies. Shipped operation declarations
and Skill digests are checked from the installed entries. No source-directory
fallback, hidden aggregate package, global Skill installation or registry publish
is part of this result.

## Executed checks

Source regressions were run sequentially: Plugins **14/14** and Rho **24/24** pass.
The v1 schema and fixtures remain unchanged. Checks cover declarations and Skills,
per-project capabilities, live MCP filtering, authorization/project boundaries,
conditional writes, retained receipts, composition protection/undo, scoped
selection, exact UTF-16 and stable-entity anchors, budgets and archive validation.

For both Full and Collaboration-minimal, the installed packaged acceptance script
ran twice: deterministic SDK stdio MCP and actual Claude Code. Each scenario uses
an independent HTTP human and the real shared MCP adapter, then checks owner state:

1. The Agent discovers shipped Skills, reads ordinary typed CSV and prepares a
   scatter plot, then composes code/table/plot/notes views with stable IDs.
2. The human edits the shared buffer, rearranges views, protects the table and
   submits document-range and table-entity feedback from Documents drafts.
3. The source changes after feedback preparation. The Agent fetches the frozen
   context, conditionally updates the same notes and submits explicitly linked
   replies. Server authors, fetched Skills, source snapshots and reply relations
   are asserted independently of the model's success text.
4. A service restart preserves versions/content/protection. A retained-cursor gap
   is explicit; two observation clients read matching owner snapshots. Format-3
   restore preserves acknowledged documents, feedback, replies and protection.
5. Instrumentation asserts **Host starts = 0, native dispatches = 0**, including
   restart and restore. No native operation record is created.

| Actual Claude candidate | Compose | Respond | Native counts |
| --- | --- | --- | --- |
| Full | Exit 0; 73,949 ms | Exit 0; 67,938 ms | 0 Host / 0 dispatch |
| Collaboration-minimal | Exit 0; 72,026 ms | Exit 0; 56,068 ms | 0 Host / 0 dispatch |

All four model phases use the installed MCP adapter and Claude Code `2.1.302`.
Each phase has a 600-second timeout and a 24-turn limit. Model unavailability or
failure is a failed run, never substituted with a scripted response.

A supplemental installed HTTP/SSE driver also passes: two separately authenticated
live observers converge after a Unicode edit; publication failure forces both to
resnapshot acknowledged content; retained scoped credentials reconnect after
restart; an actual HTTP cursor-gap rejection causes snapshot-first recovery. An
injected writable-backlog metric exercises subscription termination at its byte
limit over a real HTTP stream. This is a deterministic boundary check, not a
kernel/socket slow-reader performance benchmark. Host/native counts remain zero.

## Separate native branch

`test/native-collaboration.test.mjs` passes in the source suite and against the
installed Full candidate, using a new disposable project and an owned Host. The
external driver changes only imports to installed absolute module URLs; both
driver digests are recorded. It asserts:

- One explicit `r.execute` produces exactly one native dispatch and one entry in
  the script's output file.
- Closing its code view does not cancel the task. Repeated submission retains
  the same Core request identity and adds no dispatch.
- Killing only the owned Host leaves the original operation `unknown`; delivery
  of the same request does not create or execute a replacement.
- The retained owned R process group is cleaned up. No user Host/session is
  restarted or stopped.

Native execution is not evidence of the collaboration path and is not included
in its zero-dispatch count.

## Recovery evidence and limits

Format 3 is explicitly selected. Existing format-1/2 readers remain; lossy exports
to older formats fail. Missing owners and conflicting content are reported with
the source archive retained. Restore imports no credentials/grants, installs no
plugin and replays no native task. A hash-valid archive containing an invalid
reply relationship is rejected before any document import; owner restore also
rejects malformed relationships without replacing its existing state.

Restore is not one cross-owner filesystem transaction. A later operational I/O
or budget failure can leave earlier successful imports in place; keep the source
archive, inspect owner facts and reconcile explicitly. No universal rollback or
crash-atomic multi-owner import is claimed. Existing native crash/continuity and
external-write tests retain their own scope; this run is not an exhaustive
fault/performance campaign.

Development failures remain recorded locally: an early SDK resolver used a
symlink location instead of its real package path; a concurrent Plugins rebuild
temporarily removed linked declarations; additional tests exposed acceptance of a
malformed reply archive. Fresh sequential regressions pass after
those fixes. Supplemental observation-driver attempts also failed with an invalid
undo-group ID and a synthetic corked-response assertion; the final driver uses a
valid ID and an explicitly injected backlog metric. Those failed attempts are not
counted as passes or represented as realistic network-load evidence.

## Local evidence and reproduction

Ignored `work/collaboration-candidate-*` directories retain the fixed tarballs and
composition inventories. `work/collaboration-install-locations.json` locates the
external installations and their `trial-deterministic/report.json` and
`trial-agent/report.json`. Source test logs and installed-run logs use the
`work/collaboration-` prefix. The published JSON contains sanitized projections
and hashes; private connection files, credentials and raw model transcripts stay
local and are not published.

From a new directory outside the checkouts, with the selected Node and Claude
clients available, install one exact candidate and run its packaged driver:

```sh
npm install --ignore-scripts --no-audit --no-fund /absolute/candidate.tgz
PACKAGE="$PWD/node_modules/@rho-workspace/local"
env -u RHO_PACKAGE_ROOT -u RHO_CORE_BINARY \
  node "$PACKAGE/scripts/collaboration-acceptance.mjs" "$PWD/trial-scripted"
env -u RHO_PACKAGE_ROOT -u RHO_CORE_BINARY RHO_COLLAB_MODEL=1 \
  node "$PACKAGE/scripts/collaboration-acceptance.mjs" "$PWD/trial-agent"
```

The final conclusion is limited to **headless collaboration accepted**. Browser
rendering, input/accessibility, native windows, remote multi-user operation,
model-loop hosting, npm registry publication and signing remain unaccepted or out
of scope. The existing uncommitted design work is not part of the accepted build.
