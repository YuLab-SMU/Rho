# Rho for WorkBuddy

A WorkBuddy connector, `rho-workspace`, submitted through WorkBuddy's open platform
(<https://open.workbuddy.cn/>). When a person connects it, WorkBuddy installs
`@rho-workspace/rho` with its own Node, and its Agent gets the Rho Skill in [connector/skills/rho](connector/skills/rho/SKILL.md):
open a folder with `rho open`, tell the person Rho is a page in their browser, and work through
Rho's four tools with `rho tool`. Nothing of Rho runs in WorkBuddy's cloud; there is no account.

## Why a CLI connector with a Skill

What WorkBuddy did with Rho before this package is in the
[WorkBuddy connector episode](../../docs/WORKBUDDY-CONNECTOR-EPISODE.md):

- WorkBuddy's Agent wrote Rho's MCP server into `~/.workbuddy/mcp.json` three times. WorkBuddy runs
  a server added there only after the person approves it, and a new grant changes its arguments, so
  it needs approving again; none was approved, and no conversation had Rho's tools.
- Rho's MCP server needs the path of a project's grant file in its arguments. A connector's
  `mcp.json` cannot hold a per-machine path or a placeholder in `args`.
- `rho tool` (Rho 0.5.8) gives the same four tools from the shell, in the conversation, under one
  grant per project. A CLI connector installs `rho` and carries the Skill that says so.

## Files

| File | What it is |
| --- | --- |
| [connector-meta.json](connector/connector-meta.json) | Name, descriptions and examples in Chinese and English, `source` `rho-workspace`, `type` `cli`, the connector's own `version`, and WorkBuddy 4.24.0 or later for `versionCheck` |
| [cli.json](connector/cli.json) | `init` installs `@rho-workspace/rho@latest` with a Node WorkBuddy provides in Rho's own range (`>=22.22.0 <27`); `versionCheck` reinstalls below 0.5.8; `status` is `rho --version` (Rho has no sign-in, so an installed `rho` is a connected one); `unAuth` changes nothing |
| [icon.svg](connector/icon.svg) | Rho's icon |
| [skills/rho/SKILL.md](connector/skills/rho/SKILL.md) | The Skill for WorkBuddy. The build adds the references of [skills/rho](../../skills/rho/references) beside it, so they follow Rho's own |

`connector-meta.json`'s `version` is the connector's; Rho's version is `cli.json`'s
`versionCheck.minVersion` and what npm serves as `latest`.

## Build

```sh
node adapters/workbuddy-rho/build.mjs            # → work/workbuddy-rho/rho-workspace/ and rho-workspace-1.0.0.zip
```

It checks the fields WorkBuddy's connector page requires, that `runtime.version` is Rho's
`engines.node`, that this checkout's Rho is at least `minVersion`, that `statusMatch` matches what
`rho --version` prints, that every link in the Skill reaches a packaged file, and that no file
names this machine's home folder or holds a credential. The zip has the folder `rho-workspace/` at
its root. `test/workbuddy-connector.test.mjs` runs the same build.

## Submit

Rho 0.5.8 must be on npm first: `versionCheck` asks for it, and the Skill uses `rho open` and
`rho tool`. Then, at <https://open.workbuddy.cn/>: create a **连接器** (connector), fill in the
form from `connector-meta.json`, upload the zip, and submit it for review. After approval it is
published by pressing **发布**. If the platform cannot parse the zip, write to
`openworkbuddy@tencent.com`, as its pages say; a zip whose root holds the files themselves is the
other layout to try.

Notes for the reviewer, from what the package does:

- **No `auth`.** Rho has no account. It is a local service on this machine that binds to loopback;
  a project's access is a grant file Rho writes on this machine. `status` is `rho --version`.
- **`unAuth` changes nothing.** There is no sign-in to clear. Disconnecting leaves Rho, a running
  service and the person's folders as they are; `rho --stop` stops the service.
- **What it installs.** `npm install -g @rho-workspace/rho@latest`, a public package with npm
  provenance, built from <https://github.com/YuLab-SMU/Rho> (AGPL-3.0-only). It carries a
  native Core for macOS arm64, Linux x64 and arm64, and Windows x64. R cells need R on the
  machine; Python cells need Python.
- **Network.** Installation fetches the package from the npm registry. Rho serves its page on
  `127.0.0.1` only; there is no Rho server that project data goes to. Its Agent panel drives the
  Agent client the person already has, which reaches that client's own model provider.

## Update

Change the files, raise `version` in `connector-meta.json`, build, and submit again. A Rho release
that the Skill depends on raises `minVersion` with it.
