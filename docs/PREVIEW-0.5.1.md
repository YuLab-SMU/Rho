# macOS arm64 preview 0.5.1

This is candidate 2 of the unsigned local npm tarball and WebUI. It supersedes
the retained first candidate after fixing the newly created review conversation
target, so later feedback returns to that conversation. The selected artifact is
`rho-workspace-local-0.5.1.tgz`, 274921791 bytes, with SHA-256:

```
33f4def5b10475836e11d49cfdecb5f36ccb51b99081f62cd6ace67b1617c32a
```

The local deliverables are under `work/review-evidence-implementation/delivery-051-r2/`:
tarball, `SHA256SUMS`, `composition.json`, `ACCEPTANCE.json`, `INSTALL.md`,
selected component tarballs and `example-evidence.zip`. Registry
publication, GitHub binary releases, signing and other platforms are outside this preview.

## Fixed source and component selection

| Owner | Commit |
| --- | --- |
| Application | `c90742dbd08e69c3f943ea8fc58c7c49a80cd32b` |
| Plugins | `72553eebba77a091e75cbc91cbff0354f89d31de` |
| Core | `4f5bed8631e15acad44cc86b63ea4779ab8af342` |

Both source selections were clean. The Core is the earlier accepted binary with
SHA-256 `434a92fced13595d281b1f9e2d6d49cf9fa7c8a451da08aa3c1ba86cec85eab3`; it was not rebuilt. The
composition also records Git trees, build-input/lock/browser-asset digests and
component tarball identities. Markdown 0.1.0 is a selected browser extension,
compiled into the WebUI; its source is included in the Plugins input selection.

| Runtime component | Version |
| --- | --- |
| contracts | 0.4.0 |
| documents | 0.4.7 |
| files | 0.5.0 |
| r | 0.4.1 |
| requirements | 0.4.0 |
| tables | 0.5.0 |
| media | 0.4.0 |
| charts | 0.4.0 |
| agent | 0.4.18 |
| annotations | 0.5.1 |

## Install and start

Use Node 22.22.x, Python 3, and a configured Claude Code or Codex client for Agent
conversations. R is required only for R analyses. The checks used Node 22.22.3,
Python 3.13.1 and R 4.5.2 on macOS arm64. The tarball includes its selected Core;
it downloads or replaces no runtime on startup.

```sh
shasum -a 256 -c SHA256SUMS
mkdir -p "$HOME/rho-preview-0.5.1" "$HOME/rho-projects"
npm install --prefix "$HOME/rho-preview-0.5.1" --omit=dev --ignore-scripts /absolute/path/rho-workspace-local-0.5.1.tgz
"$HOME/rho-preview-0.5.1/node_modules/.bin/rho" --root "$HOME/rho-projects" --state-dir "$HOME/.rho-preview-0.5.1" --open
```

Stop the owned launcher normally with Ctrl+C. Keep the printed private connection
files private. An unavailable R installation does not prevent native editing,
review or Agent work. Missing prerequisites are reported for the operation that
needs them. A wrong Core platform or digest is refused.

## Acceptance of this artifact

The same tarball installed outside all repositories without development source
links or Core/runtime overrides. The installed launcher used its bundled Core,
served the WebUI and exited with no owned Host left. Installation took 8.2 s,
ready 0.76 s, and the first browser render 1.32 s on this machine; these are single
observations rather than a performance benchmark.

The frozen source passed Rho 230/230 and Plugins 110/110 checks. Contract checks
passed. Frontend's 13 and Sources' eight browser checks passed. Installed review
checks cover actual R output, keyed multi-field differences, captured code,
whole-resource questions, Unicode reasons, lost question/decision responses and
original-identity retry, modal Escape/focus return, refresh, Graph focus/backlink,
service restart with the same review/result/conversation, and two direct Review
sends that keep the same newly created Agent conversation. Screenshots were
read at 1440, 1024, 768 and 390 widths.

Python and R each ran once and agreed with their Markdown report; overwriting the
scripts/report kept old captured bytes and Graph refs readable. The installed
service also retained an acknowledged dirty Unicode document across shutdown and
restart. Candidate 1’s actual macOS folder chooser returned and registered an
existing directory; its content was not edited. Candidate 2 reuses that observation
for its byte-identical picker implementation. An expected cancellation was instead
a selection, so native cancellation is unobserved. Wrong-platform and digest fault
cases were refused; the original installed composition bytes were restored. The
existing no-Core runtime path was separately checked with Core and R absent.

The candidate 2 installation completed the two-turn question, result and human
feedback loop using configured real Claude and Codex clients. Claude retained three permission records
with its default 32-choice budget; Codex retained 41 with an explicitly selected
64-choice per-turn budget. An earlier installed Codex attempt exhausted the default
32; its Rho grant scope did not change. `ACCEPTANCE.json` records the selected budgets
and results. Earlier failed attempts remain evidence. The
client models use the selected Westlake HPC route; these are client integration
checks, not a comparison of model scientific reasoning.

## Independent offline reader milestone

The installed artifact separately produced a read-only evidence package. Its
manifest and reader distinguish complete package generation from unestablished
analysis evidence completeness. The source service was closed, the project moved and browser networking disabled;
`example-evidence.zip` is a verified, independently readable example. `index.html` still showed the selected question, replies, decisions, table
and captured files at four widths. Changed bytes failed integrity verification.
Use `rho --verify-evidence /path/to/package` for inventory checks without starting
a service. The package neither restores a workspace nor reruns analysis.

## Limits and follow-up

No independent researcher trial or physical IME observation establishes usability.
The [episode](REVIEW-EVIDENCE-EPISODE.md) contains a researcher trial guide. Default
native permission retention is 32 choices per turn; a model that exceeds it needs
an explicitly selected larger `conversations.maxPermissions` budget. Captures and
output already obtained remain available. Native permissions retain the Agent's
own policy and do not authorize broader Rho access.

Windows/Linux folder choice, POSIX locks, executable discovery, packaging and
installation remain portability work. No account/cloud/team/billing, desktop shell,
public npm publication or signed release is included. Human acceptance records a
version-specific work decision; it does not establish scientific correctness.
