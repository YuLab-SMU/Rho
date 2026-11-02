# CI on three systems and npm

Updated 2026-11-02. Upstream finished Windows ([Windows episode](WINDOWS-0.5.2-EPISODE.md)), and
the user asked to start CI on the three systems and publication to npm. They chose the package
name `@rho-workspace/rho`, an `NPM_TOKEN` secret for publishing, pushes to `main`, and CI in Rho
only: Core and the Plugins add their own later. Work ran in GitHub Actions on YuLab-SMU/Rho,
whose runners are free for a public repository on all four machines used here.

## What CI does

`components.json` selects the Core commit (`6f83226`, then `8bed8ef` after the sixth run) and the
Plugins commit (`491c440`, then `0b17877` and `90e68cf` after the third and fourth runs) the
application is built from. On every push to `main`, pull request and `v*` tag,
[`ci.yml`](../.github/workflows/ci.yml):

| Job | Runner | What it does |
| --- | --- | --- |
| Core | macos-15, ubuntu-24.04, ubuntu-24.04-arm, windows-2022 | Builds the selected Core with Rust 1.97.0, dev profile without debug info: Mach-O arm64, static musl Linux x64 and arm64, MSVC Windows x64 |
| Test | macos-15, ubuntu-24.04, windows-2022 | Builds the selected Plugins and Rho, runs Rho's suite with that platform's Core |
| Pack | ubuntu-24.04 | `pack:local` with all four Cores; checks the platforms, Linux linkage, clean inputs and commit |
| Install | all four | [`ci-install-check.mjs`](../scripts/ci-install-check.mjs): digest, offline install with an empty npm cache, the launcher, the packaged recovery and ordinary-project acceptances |
| Publish | ubuntu-24.04, environment `npm` | Only for a `v*` tag, after Test and Install: publishes the candidate that run packed |

The installed check verifies the tarball against `SHA256SUMS` and its composition, installs it
outside every checkout with `--offline` and an empty cache, and runs the `rho` shim's usage. The
launcher must report ready with its own platform's Core and copy in the shipped project, then stop:
on SIGTERM with its shutdown report, or on Windows, where a CI step cannot send Ctrl+Break, by ending
its process tree with no project open. It then runs the packaged recovery acceptance and the packaged
acceptance of Plugins' `examples/ordinary-r-project` from the installation.

The publish job checks out and builds nothing. It downloads the candidate, checks its digest, that
the package is `@rho-workspace/rho`, not private, has the tag's version and was packed from the
tagged commit, then runs `npm publish --provenance --access public` with `NPM_TOKEN`, a repository
secret that no other job names. The job's environment `npm` has no reviewer. A version with a prerelease
suffix goes to the `next` dist-tag, any other to `latest`. A candidate's composition names the run
that packed it (`build.run`).

## Before the first run

The local `main` held one commit not yet pushed, the shipped example project (`58d7b5fc`). It was
replayed over upstream's three Windows commits (`55ebc49b`); only Status conflicted, in wrapping.

- **The example appeared in every test service.** The seed treated an unset `example` as on, so
  a service composed in code also got the project, and six browser grant checks saw two projects.
  The CLI passes on or off explicitly; the service now seeds only when asked (`dfbc15a3`).
- **The example could not be packed.** The packer refuses every R file outside the kernel runner,
  to keep project recipes out, and the study's scripts are R. Files under `example/` are allowed,
  nothing else (`281be780`).
- **What a registry needs.** The staged package drops `private`, asks for public access and names
  its repository, which provenance needs; the source checkout stays private.
- **A registry install.** A Mac-only candidate published to a local Verdaccio 6.10.5 and installed
  with `npm install -g @rho-workspace/rho` fetched two things, the package document and its tarball.
  The 13 plugins arrived as folders, `rho` and `rho-ui` were linked, and the launcher ran with its
  own Core and the shipped project and stopped in order, leaving no Core. Publishing that first
  version with `--tag next` also made it `latest`.
- **A socket path under the temporary folder.** A Unix Host's socket lies under its project, and
  macOS's temporary folder nearly fills the 104-byte limit, so recovery refused to run there. The
  installed check works under `/tmp`, as a person's `~/rho-projects` would.

## First run

Run [41368453930](https://github.com/YuLab-SMU/Rho/actions/runs/41368453930) on `ef39961d`. The
four Cores built and the candidate packed: `rho-workspace-rho-0.5.2.tgz`, 25,032,105 bytes, 5,250
files, SHA-256 `39bd3349…`, with Cores of 6,765,888 (darwin-arm64), 7,092,880 (linux-arm64, static),
7,009,512 (linux-x64, static) and 4,616,192 bytes (win32-x64). It was the first single tarball for
all four platforms. The installation passed on macOS, Linux x64 and Linux arm64; the suite did not:

| Test | Result | Cause |
| --- | --- | --- |
| macOS | 274/277, one failure | The several-faults doctor check took Claude Code and Codex from PATH; the runner has neither, so it also saw the agents warning |
| Linux x64 | Cancelled after 21 minutes, 33 tests reported | The browser tests chose folders under `/private/tmp`, which only macOS has. Four failed with a service still open, so the file never ended |
| Windows | 233/277, 30 failures, 13 skipped, MCP v2 cancelled | 16 tests made folders under the literal `/tmp`, which Node reads as `\tmp` on the current drive; the runner had none. Every R run was refused as having unknown dependencies. The runner's account writes in a folder denied to it |

The Linux hang was reproduced on Debian 12 arm64 with `/private` hidden under an empty tmpfs:
four ENOENT failures, then the file ran to its timeout. A full run there found one more failure:
Debian's R 4.2.2, like Ubuntu 24.04's R 4.3.3, has no `tools::sha256sum`, which the export test's
script uses. The fixes (`0bb2fec3`): Unix keeps `/tmp` for short socket paths and Windows takes its
temporary folder; the browser tests use `/tmp` as the system resolves it; the doctor fixture has
stand-in clients; the write-denial checks confirm the denial or skip with that reason; the test job
installs the current R everywhere.

## Second run

Run [41371381748](https://github.com/YuLab-SMU/Rho/actions/runs/41371381748) on `0bb2fec3`:

| Platform | Suite | Installed check |
| --- | --- | --- |
| macOS arm64 | 275/277, 2 skipped | Install 10.4 s, ready 0.9 s, orderly stop, recovery 7, ordinary project 7 |
| Linux x64 | 275/277, 2 skipped | Install 10.8 s, ready 1.0 s, orderly stop, recovery 7, ordinary project 7 |
| Linux arm64 | Not run | Install 7.5 s, ready 0.8 s, orderly stop, recovery 7, ordinary project 7 |
| Windows x64 | 250/277, 11 failures, 15 skipped, MCP v2 cancelled | Install 98 s, ready 1.8 s, ended; recovery refused |

Candidate `7b9daba5…`, 25,032,136 bytes. Linux x64 is a real x86_64 machine here, where the
[platforms episode](PLATFORMS-0.5.2-EPISODE.md) had only Rosetta. The Windows failures are every
test that runs R through Core, refused before it starts, and MCP v2 at its 30 s limit.

`setup-r` put Rtools first on PATH, which also made its MSYS bash the shell of every later step
(`C:\rtools45\usr\bin\bash.EXE`). Rho compiles no R packages, so Rtools stays installed but off PATH
(`1694fec1`), and CI prints the R dependency probe on Windows, once as is and once with Rtools first
on PATH.

## Third run

Run [41372069322](https://github.com/YuLab-SMU/Rho/actions/runs/41372069322) on `1694fec1`. macOS and
Linux x64 again passed 275/277 and the installation passed on the three Unix machines; Windows
failed as before, with Git's bash as the shell. The probe showed the cause, the same with Rtools
first on PATH or not:

| Expression given to `Rscript.exe --vanilla -e` (R 4.6.2 ucrt) | Exit | Printed |
| --- | --- | --- |
| `cat("R\t", R.version.string, "\n", sep="")` | 0 | `R\tR version 4.6.2 (2026-10-29 ucrt)\r\n` |
| `.libPaths(…)` then the same `cat` on the next line | 0 | Nothing |

Rscript ran only the first line and reported success. Requirements, which owns the probe, read
the empty answer as unknown, and Rho refused every managed R run on unknown dependencies. Upstream's
Windows machine had R 4.5.1, where the multi-line probe worked. With the user's agreement, Plugins
`0b17877` (Requirements 0.4.1) sends the probe as one line of statements and splits its output on
CRLF; the R version Windows reported had kept a carriage return. Rho selects that commit (`6aa5c8e6`).
Whether 4.6.0 and 4.6.1 behave like 4.6.2 was not checked.

## Fourth run

Run [41373192099](https://github.com/YuLab-SMU/Rho/actions/runs/41373192099) on `6aa5c8e6`. On
Windows the probe checked R 4.6.2, and the suite went from 11 failures to 2 (259/277, 15 skipped,
MCP v2 cancelled). macOS and Linux x64 passed 275/277 again. Pack refused its inputs as changed:
the build regenerates `src/contracts/owners.generated.ts` with each plugin's package version, and
the pin had been committed before a rebuild. The two Windows failures:

- **A Host started through cmd.exe runs R in a path cmd treats specially.** The project is named
  `a & b ^ %OS% !OS! (1) 中文 🧬`, and the one-line probe named that path; Rscript again printed
  nothing and exited 0. Plugins `90e68cf` (Requirements 0.4.2) makes the expression fixed text and
  checked package names, and hands R the library path as `RHO_R_LIBRARY`. On macOS a package in a
  project library under such a path is found.
- **A run whose Host stopped answering reads as unknown.** The test passed; removing its folder
  right after its processes ended failed with EBUSY. Removal now retries.

The test job now runs `check:contracts` before the suite, so a stale generated file fails there by
name (`5d8b936c`). In one local macOS run after these changes, an ACP conversation test failed once
under load (`changed` of undefined) and passed alone and in every other run.

## Fifth run

Run [41374734720](https://github.com/YuLab-SMU/Rho/actions/runs/41374734720) on `5d8b936c`, with Plugins
`90e68cf`. The candidate is `ec6bee9c…`, 25,033,065 bytes, 5,250 files. Every platform installed it
and passed its packaged acceptances:

| Platform | Suite | Offline install | Ready | Stop | Recovery | Ordinary project |
| --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | 275/277, 2 skipped | 12.1 s | 1.3 s | In order | 7 | 7 |
| Linux x64 | 274/277, 2 skipped, MCP v2 cancelled | 9.3 s | 0.9 s | In order | 7 | 7 |
| Linux arm64 | Not run | 8.5 s | 0.8 s | In order | 7 | 7 |
| Windows x64 | 260/277, 15 skipped, MCP v2 cancelled, 1 failure | 179 s | 1.2 s | Ended | 7 | 7 |

The probe now accepts the cmd-special path, and the run starts. R then ends abnormally: Core reports
it finished with a negative exit code, a Windows status such as a crash would give, and Rho's
contract, which requires a code of 0 or more, rejects the reply. Upstream's R 4.5.1 ran this test.
What R 4.6.2 does in that folder, and whether Rho's contract should carry Windows status codes,
were not examined. MCP v2 passed on Linux in runs 2 to 4 and was cancelled in this one.

## Sixth run and a Windows diagnosis

Run [41375803891](https://github.com/YuLab-SMU/Rho/actions/runs/41375803891) on `64d73550` passed
275/277 on macOS and Linux x64 and installed on all four platforms. Windows had three failures: the
cmd-special path, MCP v2 at 30 s, and "a repair is a new identity", which took 47 to 48 s there
against about 2 s on macOS and passed its 60 s limit this time. A diagnosis workflow on a temporary
branch (runs [41377127229](https://github.com/YuLab-SMU/Rho/actions/runs/41377127229) and
[41378118954](https://github.com/YuLab-SMU/Rho/actions/runs/41378118954), windows-2022) separated
the causes:

- **R and `%OS%`.** Node alone ran `Rscript --vanilla` on a script in folders named with each
  character cmd treats specially. R 4.5.1 and 4.6.2 both ended with `0xC0000005`, an access
  violation, when the script's absolute path held `%OS%`. They ran normally with `&`, `^`, `!OS!`,
  `(1)`, Chinese and an emoji, and with a relative path in the `%OS%` folder. Core gives R the
  script's absolute path, so R ends the same way in such a project under Rho; Core reports
  `Code(-1073741819)`. Where R misreads the path was not found. Upstream's R 4.5.1 ran the test on
  their own machine.
- **Rho's contract.** Rho's schema of Core's exit required a code of 0 or more. Core reports an
  i32, and a Windows process ended by an NTSTATUS reads negative, so the service's reply failed the
  contract it publishes. The code now keeps Core's whole range. The test runs R in a project
  without `%` and checks its working folder; in a project whose path holds `%OS%` it checks that
  the Host found the folder as named and that the run's state follows R's code.
- **Core's Windows output.** Through Rho's service, R writing 200 `message()` lines took 3.1 to
  3.4 s on Windows and 2000 lines 20 to 35 s, against 0.2 s on macOS. Once a lookup waited 20 s and
  Rho read the running run as unknown. Core's Windows reader gets each write as its own read, and
  each was committed alone: a blob, its sync and the record. Core `5333181` commits the bytes
  queued since the last drain together, at most one blob chunk at a time
  ([Core record](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/work/CORE-20261102-01.md)).
  Its new regression failed on the old pump at the 512-chunk limit after 25.9 s and passed in
  0.5 s. With that Core on the runner, 2000 lines took 0.32 s, the repair test 2.1 s alone and MCP
  v2 22.4 s alone. Core's full regression suite was not run on Windows.
- **MCP v2.** Alone with the old Core it took 28.7 and 30.0 s on the runner. Its limit is now 90 s.

`components.json` selects Core `8bed8ef`, the fix and its record.

## Publication

Nothing has been published. A `v*` tag needs:

1. The npm organization `rho-workspace`, owned by the account that will own the package.
2. A granular access token that can publish to that organization's packages without a one-time
   password, stored as the repository secret `NPM_TOKEN` of YuLab-SMU/Rho. The user added the secret
   on 2026-11-02 and chose no reviewer: the `npm` environment, which GitHub creates for the first
   publish job, holds nothing back. Whether the organization exists and the token can publish there
   is not visible from GitHub; the first publication shows it.
3. The version in `package.json`, pushed, and that commit tagged `v<version>`.

The tag's run builds, tests, packs and installs as any other, then publishes the candidate it
tested. The 0.5.2 candidates recorded earlier were never published, and a version cannot be
published twice.

## Not done

- A run in which every job passes. Run 5 fails on the two items below.
- Publication, a GitHub Release, signing.
- Rho's suite on Linux arm64; only the installation runs there.
- Real Agent conversations in CI. The suite uses stand-ins; on Windows the 11 stand-ins written as
  Unix scripts are skipped.
- An orderly stop of the installed launcher on Windows in CI.
- Core's and the Plugins' own CI on three systems.

## Open items

- In a project whose path holds `%OS%`, R run by Core on Windows ends with `0xC0000005`, as R does
  there when started directly. Whether Core should hand R a path it reads safely is not decided.
- The offline install takes 94 to 179 s on the Windows runner against 5 to 12 s elsewhere.
- `engines` names Node 22 only. A person with Node 24 installs with npm's engine warning; no
  installation on Node 24 has been checked.
- The candidate digest changes with every commit, since the composition names the commit; whether
  the same commit packs to the same bytes has not been checked.
