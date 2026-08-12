# Rho 0.4.0-dev.37 Source And Windows Issue #33 Acceptance Checklist

Status: active accepted Issue #33 source contract; exact protected-main source
run `31644418691` and clean-profile installed Windows run `31644429787` pass at
`7ab861b01a36313150988b1e2fa8fdc2056325d9`; all six scenarios, exact installed
identity/runtime, screenshot, and fail-closed cleanup are recorded; Issue #33
closure is GO; FT-SIGN1 Free Trial smoke integration/request, production
Windows signing, exact cross-platform candidate, human installed-candidate
acceptance, MAC5, publication, and updater mutation remain open

Date: 2026-08-12

Change class: D4 exact-source installer acceptance and single-use development
identity

Risk: R4 installer construction, installed desktop automation, evidence binding,
cleanup recovery, and strict separation from release acceptance

Closure evidence update: D0/R0 documentation-only ledger update after the
facts became true. It changes no application behavior or bytes, package
contract, schema, workflow, credential, artifact, tag, Release, or update site;
`0.4.0-dev.37` and `NEWS.md` therefore remain unchanged.

Authorization: after reviewing Issue #33 and its remaining Windows evidence
gap, the project owner instructed `尽快修复和关闭` on 2026-08-12. This
authorizes one fresh synchronized identity, bounded exact-source Windows
acceptance, ephemeral clean-runner installation, auditable evidence, protected
integration, and Issue closure only after all six scenarios pass. It does not
authorize SignPath configuration, public signing, release-candidate
construction, MAC5, publication, or updater mutation.

SP-READY1 SignPath repository readiness carries forward. A real Free Trial
organization/project/test policy now exists, and the owner's instruction
`继续，使用Free trial subscription` authorizes only FT-SIGN1 under
`docs/plans/active-2026-08-12-signpath-free-trial-smoke-spec.md`: one isolated
manual request using this checklist's exact unsigned internal-review artifact.
Its bounded evidence must keep `public_release_authorized: false`; the result
cannot become a candidate or Release asset. Owner MFA audit,
Foundation acceptance, production GitHub App/trusted-build configuration,
production two-stage Windows signing, and signed-candidate evidence remain
open.

## Exact Identity

| Field | Required value | Current evidence |
| --- | --- | --- |
| Application version | `0.4.0-dev.37` | Cargo/lock, Tauri, npm/lock, frontend mock/cache, workflow defaults, release-contract tests, roadmap, checklist, and `NEWS.md` synchronized before artifact construction |
| `rho.bridge` version | `0.1.14` | unchanged; no exported R package contract change |
| `rho.agent` version | `0.1.5` | unchanged; no exported R package contract change |
| Store schema | `12` | unchanged; no persistence migration |
| Review tag/name | `v0.4.0-dev.37` / `Rho 0.4.0-dev.37` | identity only; the Issue #33 workflow creates no tag or Release |
| Source repository | `YuLab-SMU/Rho` | authoritative integration target |
| Windows acceptance source | `7ab861b01a36313150988b1e2fa8fdc2056325d9` | exact protected `main`; source matrix and installed `app_info.commit` match |
| Release decision | Issue #33 acceptance `PASS`; Issue closure `GO`; release remains `NO-GO` | signing and all candidate/publication gates remain open |

`dev.34`, `dev.35`, and `dev.36` are historical and rejected. Run
`31633600383` consumed `dev.34` on quoted registry-path handling. Run
`31635375821` consumed `dev.35` when CDP was unavailable. Run `31641866471`
consumed `dev.36`: installer identity, installation, installed runtime, five
scenarios, screenshot, and cleanup passed, but the sixth harness waited on a
counter that `refreshProject()` does not mutate. None may be reused or
relabelled. `dev.37` was consumed by the passing exact-source artifact and is
now immutable. Any later user-visible source change or new candidate requires a
fresh identity; this evidence cannot be composed with a different commit.

## Windows Issue #33 Acceptance Contract

The dedicated workflow may build and upload one unsigned, short-lived internal
review installer. It must not create or update a tag, Release, update manifest,
download page, or publication record. It must:

1. admit only exact current protected `main` and prove checkout, Cargo version,
   installer filename, and embedded installed `app_info` version/commit agree;
2. build with the pinned GNU/Rtools/Ark path and repository-owned Issue #33
   Tauri overlay, normalize the registry install path, install silently in a
   clean profile, and launch only the resolved installed executable; Ark may use
   four checksum-before-promotion attempts, while only this workflow may request
   at most three Tauri invocations for recognized transient NSIS-tool transport
   failures after compilation; unknown, exhausted, and ordinary candidate
   failures remain single-attempt and fail closed;
3. preserve the normal window configuration and Wry security/UX flags while
   adding only a fixed loopback WebView2 debugging port to this internal flavor;
   ordinary candidate construction must remain debug-port-free;
4. repeat the five original scenarios: Agent-refresh focus, non-Agent Run
   refresh/execution focus, automatic Agent edit plus external reload focus,
   Runs pointer activation during replacement, and older Console reading
   position while output is appended;
5. repeat EDITOR-VIEWPORT-R1 by opening `analysis.R`, placing its cursor near the
   end, scrolling Monaco upward, opening `watch.md` as a clean background
   document without changing the active editor, and externally changing
   `watch.md`; acceptance waits for both its actual reloaded saved content and
   a higher project revision, then proves `analysis.R` remains active and its
   Monaco scroll position, visible range, and cursor are unchanged;
6. never use `projectRefreshSequence` as watcher proof: `refreshProject()` does
   not mutate that project-lifecycle counter, so such a predicate is
   unsatisfiable even when watcher reload succeeds;
7. fail closed on assertions, timeout, identity mismatch, malformed registry
   paths, missing installed runtime, build-tree executable, screenshot failure,
   or incomplete cleanup; always stop the app, run the registered uninstaller,
   verify executable/registry removal, and upload bounded JSON, screenshot,
   installer hash, and logs.

The automation may seed bounded Agent/Run presentation records through CDP for
deterministic timing, but it must use shipped rendering/focus helpers, real
Workspace R execution, the real project watcher, real Monaco, and the installed
Tauri bridge. Browser/mock mode and source-only assertions cannot satisfy this
gate.

## Acceptance And Closure

Issue #33 may close only when, on the same exact upstream commit:

- focused frontend regression, JavaScript syntax, and the protected
  macOS/Windows stable/MSRV source matrix pass;
- the installed Windows workflow reports all six scenarios `PASS`, records the
  installed executable, version, commit, installer SHA-256, screenshot, and
  cleanup, and uploads machine-readable evidence;
- this checklist, the active Issue #33 specification, and cross-review ledger
  record exact run, commit, artifact, hashes, and result; and
- the closing Issue comment distinguishes product-defect closure from Windows
  signing, release-candidate, human installed acceptance, MAC5, and publication.

Automation can close the reproduced product defect after exact-source installed
verification, but it cannot replace the human workflow in
`test/acceptance-project/MANUAL-ACCEPTANCE.md` or satisfy a future signed exact-
candidate gate.

## Exact Acceptance Evidence

- Protected-main source run
  [`31644418691`](https://github.com/YuLab-SMU/Rho/actions/runs/31644418691)
  passed macOS and Windows on Rust stable and `1.88.0` at exact commit
  `7ab861b01a36313150988b1e2fa8fdc2056325d9`.
- Installed run
  [`31644429787`](https://github.com/YuLab-SMU/Rho/actions/runs/31644429787)
  passed in 13m35s at the same commit. Artifact `9160516935`, named
  `rho-0.4.0-dev.37-issue33-windows-installed-7ab861b01a36313150988b1e2fa8fdc2056325d9-31644429787`,
  contains the installer, machine-readable acceptance/install/cleanup records,
  startup log, acceptance summary, and screenshot.
- `Rho_0.4.0-dev.37_x64-setup.exe` is 18,315,177 bytes with SHA-256
  `a8fa9ad2628590c9c12e176f22930d971fd8d2572dc606b52b55e38abb41bda6`.
  The resolved installed executable at
  `C:\Users\runneradmin\AppData\Local\Rho\rho-desktop.exe` is 50,478,631
  bytes with SHA-256
  `69bc24e5190ecceebddd8b0d9ea0eaac7f4e33bfed6eda43ded30a262dd05376`;
  installed Ark is present, and embedded version/commit/platform are
  `0.4.0-dev.37`, the exact commit above, and `windows-x86_64`.
- `agent_refresh_focus`, `run_refresh_and_execution_focus`,
  `automatic_edit_and_external_reload_focus`, `runs_pointer_activation`,
  `console_reading_position`, and `monaco_watcher_viewport` all report `PASS`.
  In the sixth scenario the real watcher reloads the marker, project revision
  advances `3 -> 4`, `analysis.R` remains active, visible start remains line 1,
  and the cursor remains line 242.
- `installed.png` is 107,402 bytes with SHA-256
  `3b36b5bc604f3fe16790146117d8e541e82e00ccbbe22110eb0baa2d72fa2faf`.
  Independent download verification reproduced both installer and screenshot
  hashes. Cleanup reports exit code 0 and verifies both the installed
  executable and uninstall registry entry were removed.
- No tag, GitHub Release, update manifest, public download, signing claim, or
  candidate acceptance was created by this workflow.

## Current Decision

`GO` to close Issue #33 as an exact-source installed product defect.
`GO` only for the isolated FT-SIGN1 Free Trial smoke request after its source
package passes protected integration. `NO-GO` for SignPath production signing,
exact candidate construction, human installed-candidate acceptance, MAC5,
publication, and updater mutation.
