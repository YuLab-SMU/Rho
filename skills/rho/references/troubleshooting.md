# When something fails

Find the symptom, check the cause, then act. When a symptom is not listed, read what Rho
printed: refusals name their rule and usually what to do next.

## Install and start

| Symptom | Cause | Do |
| --- | --- | --- |
| `npm install -g` fails with `EACCES` | The global prefix belongs to root | Offer the options in [install](install.md#install); do not `sudo` yourself |
| `EBADENGINE` warning | Node outside `>=22.22.0 <27` | Install a supported Node, then reinstall |
| `rho` with no flags prints usage and exits 2 | Version 0.5.3 or earlier | Use `--root` and `--state-dir` |
| "Rho is already running for <state> at <url>"; on 0.5.3 and earlier, exit 1 with a stack trace ending "Another Rho service holds <state>" | A service already holds that state folder | Use its address: the url printed, or `url` in `<state>/connection.json`. Do not start another; stop the first only with the person's agreement |
| The `nohup` start left no `{"ready":…}` line in the log | Still starting, or it failed | Wait a few seconds and read the whole log. Its last lines say why |
| A start is refused with a port named | `--port N` is in use by another program | Choose another port, or leave `--port` out |
| A start fails naming the platforms the package carries | The package has no Core for this machine | Run on a platform it names, or name a Core binary with `--core` (outside the package's digest check) |
| Socket path error for a long project path (macOS) | The managed Host socket path is limited to 103 bytes | Only managed runs need it. Use a shorter projects path if they are needed |

## Connecting

| Symptom | Cause | Do |
| --- | --- | --- |
| `--grant` says "Rho is not running at <url>" | The service is stopped, or this is another state folder | Start it with the same `--state-dir`, then grant again |
| The new session has no `rho_*` tools | It was opened before the MCP entry was added, or in another folder (Claude Code's local scope) | `claude mcp list` in the project folder; add it there; open a new session |
| The tools exist but every call fails to connect | Rho restarted on a new port (0.5.3 and earlier), or Node or Rho moved | Grant again, add the entry again if the `connectionFile` changed, open a new session ([connect](connect.md#after-a-restart)) |
| `unauthorized` | The operation is outside this project's grant | Tell the person which one. A grant covers one project |

## Calling tools

| Symptom | Cause | Do |
| --- | --- | --- |
| `rho_read` → `invalid` | `ref` missing or wrong; it lives at `result.ref` in the call's reply | Copy `result.ref` exactly |
| `rho_read` → `not_found` "Result field is unavailable" | A guessed path | Read the parent path and pick from its entries ([tools](tools.md#4-rho_read-walk-a-result-reference-by-the-paths-it-gives-you)) |
| `rho_read` → `not_found` "This result is unavailable in this connection" | Released, evicted, or from another connection | Observe the original request (for a cell, `kernel.read` with its `cellId`); never run it again for a new reference |
| `rho_call` → `invalid` | The input does not match this version's schema | Read the resolved contract; check inputs that later versions added (such as `interpreter`) |
| `stale` | A version moved since you read it | Read again, retry with the current version |
| A call's reply was lost or came back unknown | Transport or wait limit | Resend with the same `changeId`. It returns the original result and never runs twice |

## Notebook

| Symptom | Cause | Do |
| --- | --- | --- |
| A cell still `running` after the call returned | It outlived `waitMs` | `kernel.read {"cellId":…}` later, or resend the same `changeId`. Do not start a duplicate |
| A cell does not end | Long or hung code | `kernel.interrupt {"cellId":…}`; the session and values stay |
| `limit`: too many cells waiting | `maxQueued` (16) | Wait for or interrupt the running cell |
| The session reads `rho-closed`, values are gone | Rho was restarted | Rebuild from the scripts. A running cell then reads `unknown` and a waiting one `not-run`; nothing reruns by itself |
| R session does not start | `Rscript` not found, or `jsonlite` missing | `startup.rscript` in the log shows which R; install `jsonlite`, or start Rho with `--rscript` |
| A figure save stalls | Seen once with `ggsave` in a long session | Interrupt; use `png()`, `print(p)` and `dev.off()` |
| `interpreter` refused | The session was started with another program, or the person ran cells in it | Ask the person to stop that session first |

## Conversations in Rho's Agent panel

| Symptom | Cause | Do |
| --- | --- | --- |
| A turn stopped at the Agent's limit | The Agent client's own step cap; Rho sets none by default since 0.5.3 | "Continue unfinished work" (0.5.3 and later); earlier, Continue and restate what is left |
| Many permission prompts | The Agent client's mode | Since 0.5.3, new Claude sessions start in Auto. The mode is the person's choice; never answer prompts on their behalf |
| The page lost the conversation after closing a tab | 0.5.2 and earlier had no conversation addresses | Since 0.5.3 the list row opens it and the address names it |
