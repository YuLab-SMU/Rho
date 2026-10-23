# Unverified and dead paths

What this checkout does **not** verify, and which known paths do not work. The point
is that a gap is never mistaken for a decision, and a decision is never mistaken for
finished work.

Each entry says what is unverified, what would verify it, and what the consequence is
today. Numbers come from [the verification ledger](VERIFICATION.json) generator
(`npm run verify`) rather than from memory.

## Dead paths

A dead path is confirmed not to work. It is kept here rather than silently ignored.

| Path | What happens | What would fix it |
| --- | --- | --- |
| An Agent-produced artifact reaching a view | `r.execute` writes artifacts under `.rho/plugins/runs/...`; `resource.register` refuses owner state by design, and presentation accepts only native `artifact.ready` events, so a plot can be produced, verified with `artifact.check`, and still never shown. Recorded as `artifact-not-presentable` by `acceptance:execution`. | Decide whether an executed artifact may be presented directly (a run-bound view) or must be copied out of owner state first. Either is a permission change and needs a decision. |
| A person saving a document to disk | A tab may edit the buffer and never write it. `document.save` is not in the browser grant. The editor says so. | Grant `document.save` to the browser with the same conditional identity edits already use. This widens a reviewed boundary and needs a decision. |

## Unverified paths

These are believed to work but nothing here demonstrates it.

| Path | Why unverified | What would verify it |
| --- | --- | --- |
| Windows and Linux | `project.entries`, the folder picker and socket path limits are checked on macOS only. `native-folders.ts` refuses the picker off macOS by design. | Platform runs; the folder picker needs a native path per platform. |
| The operating-system folder dialog | Every acceptance replaces the picker with a stand-in; the real `osascript` dialog is clicked by a person. | A manual step, recorded as such. |
| Real Claude Code sessions | `test:native`, `test:feedback` and `test:presenter` drive the real adapter entries without a model. The model conversation itself is out of scope here. | The credential-gated `native-artifact-acceptance.mjs` with `RHO_NATIVE_MODEL=1`. |
| R execution on a project other than a disposable one | Execution checks use temporary projects. A live project's Host is never restarted by a check. | An owned, disposable Host on the real project with the operator's consent. |

## Widths and journeys

`acceptance:person` covers 1440, 768 and 390 in both columns of
`acceptance:matrix`; `ui-acceptance.mjs` covers 1600/1280/1024/768/390 on the source
build only. An installed build has not been run at 1600/1280/1024, and no check has
run the U1 shell journeys against an installed build.

## Keeping this honest

An entry leaves this file only when a check in the repository fails without the fix.
"Looked right when I tried it" is not evidence; a command that runs is.
