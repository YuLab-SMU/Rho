# Contract and call-boundary acceptance

What was actually executed for the contract, type and call-boundary work, on which
identities, and what it does not establish. [Status](STATUS.md) summarises; this page
keeps the observations and their limits.

## Identities

| Item | Identity |
| --- | --- |
| Application source | `YuLab-SMU/Rho` `480ac6f5d65f7d44b6c0c2617c2531670b30d772` (tree `b63e0b31…`) |
| Component source | `YuLab-SMU/Rho-plugins` `18252d2ddc5250845402a13098e9eb467156cbbf` |
| Core binary | `YuLab-SMU/Rho-core` `ebe351043e74529ccf49960c0b07c805d1e50c07`, unchanged |
| Packed artifact | `rho-workspace-local-0.4.0.tgz`, SHA-256 `35400ccfdd64bf2b27410d0b7ec3749ca8b815729b8308f0bd53f9cae1d6dd6a`, 4,048 files |
| Platform | macOS arm64, Node 22.22.3, R 4.5.2, Chrome 155.0.8059.84 |

The artifact was assembled by `npm run pack:local` from the committed sources above;
no working-tree changes were included.

## Source and installed columns

`scripts/matrix.mjs --install …` ran three journeys against a source build and against
a copy of the packed artifact installed outside the checkouts
(`npm install --offline` of the tarball). Every row passed:

| Journey | Source | Installed | Observed |
| --- | --- | --- | --- |
| person (`person-files-acceptance`) | passed | passed | 9 checks: shell loads at 1440/768/390 without horizontal overflow, the real folder is listed, a subfolder opens, button and keyboard save real Unicode bytes at all three widths, a refreshed tab reads the saved document, another writer updates the tab through the owner revision, an external disk write refuses save and preserves both disk and buffer, the tab stays refused parent paths, registration and execution, no page errors |
| execution/MCP (`execution-acceptance`) | passed | passed | 5 checks: four-tool discovery resolves, edits and conditionally saves through stdio MCP; the original request completes through observation with no resubmission; `artifact.check` returns a verified owner-state reference that binds directly; the browser decodes the real 640×420 PNG with owner-sized 4096-byte pages at three widths; refresh renders the same version without CSP errors or new native execution. Exactly one Host start and one native dispatch, zero model calls |
| U1 (`ui-acceptance`) | passed | passed | 23 checks across 1600/1280/1024/768/390, zero Host starts and zero native dispatches |

The installed copy's own artifact was checked directly: all 86 packaged operation
files matched their recorded byte count and SHA-256, the shared definitions file
matched, and the installed service reported the same 86 operations,
`apiVersion 2.0`, `schemaVersion 2` and nine selected owners.

## Recovery, with a real Host and R

`scripts/recovery-acceptance.mjs` on a disposable project passed 7 checks:

- a real partial snapshot has four observed rows and no completion declaration;
- the concurrent-action limit rejects new work while preserving the original request;
- closing observation, the view and the external binding does not cancel the analysis;
- rebinding observes the original task without submitting it;
- Host loss retains partial data, the original identity, an unknown outcome and an
  unconfirmed cancellation;
- the partial export restores bytes and provenance without starting a Host;
- an explicit cancel acknowledgement and an independently observed process-group
  release remain separate facts.

Its R fixture previously could not run at all: the producer now pre-creates the
declared output directory, so the fixture's `stopifnot(dir.create(out))` returned
false and aborted before writing any artifact. The fixture tolerates an existing
directory now, which is what makes the observations above real rather than assumed.
The fix is in the acceptance script, not in the component.

## Collaboration

`scripts/collaboration-acceptance.mjs` passed its five phases over real stdio MCP and
HTTP with zero Host starts: HTTP human and stdio Agent; shared documents, composition
and protection; both anchor owners with explicit replies; restart with an event gap
and two observers; and a format-3 restore against installed owners. The model-driven
variant (`RHO_COLLAB_MODEL=1`) was not run.

## Not executed

- The scientific `install-acceptance.mjs` flows. They require two external example
  projects (an ordinary analysis and the original paired analysis) that are not
  present in this environment, so no scientific domain claim is made here.
- The model-driven collaboration variant, and any acceptance that depends on a live
  external model session.
- npm registry publication and signing. Distribution belongs to a separately selected
  signed-release milestone; this work published source commits only.

## What this does and does not show

It shows the published commits build, pass their source checks, pack into an
installable artifact whose recorded hashes verify, and complete the person, execution,
recovery, collaboration and UI journeys both from source and from that installed copy.

It does not show inventory-wide scientific correctness, other platforms, signed or
registry distribution, or that every adapter and Skill behaves as documented outside
the paths exercised above.
