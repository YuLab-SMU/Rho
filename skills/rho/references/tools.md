# Calling Rho's tools without guessing

Four MCP tools reach the project you were granted. The pattern is always the same: index,
resolve, call, read. The shapes below are real replies from Rho 0.5.3.

## 1. `rho_index`: what may be done

```json
rho_index {}
→ {"ok":true,"value":{"catalogRef":"0c7e…","groups":[{"owner":"kernel","operations":13,"name":"Notebook","summary":"A live R session and a live Python session…"}, …]}}

rho_index {"owner":"kernel"}            # or {"search":"table"}
→ {"ok":true,"value":{"catalogRef":"0c7e…","entries":[{"id":"kernel.run","summary":"…","contractRef":"cd85…","skillRefs":["…"]}, …],"next":null}}
```

When `next` is not null, continue with `{"owner":"kernel","cursor":<next>}`. Keep the
`catalogRef` and the `contractRef` of each operation you will use.

## 2. `rho_resolve`: the contract and the owner's own guidance

```json
rho_resolve {"catalogRef":"0c7e…","selected":["kernel.run","kernel.read"]}
→ {"ok":true,"value":{"items":[{"kind":"skill","content":{"id":"rho.workspace",…}},
                              {"kind":"skill","content":{"id":"kernel.session",…}},
                              {"kind":"contract",…"kernel.run"…}, …],"next":null}}
```

A selection can come back in pages. When `next` is not null, call again with the same
`selected`, `"cursor":<next>` and `"knownRefs"` listing the `ref`s you already hold.

Read the `skill` items. They are the owners' rules for these operations. The `contract` items
hold the full input schema. Check the schema for which inputs this version accepts: later
versions add some, such as the Notebook's `interpreter`. Resolve once per operation per
session. If your context lost a contract, resolve it again; do not index again.

## 3. `rho_call`: one operation

```json
rho_call {"operation":"kernel.run","contractRef":"cd85…",
          "input":{"language":"r","code":"nrow(x)","purpose":"Count rows","changeId":"count-rows","waitMs":30000}}
```

A small reply comes inline:

```json
{"ok":true,"value":{"cell":{"cellId":"k-c00c…","state":"done","outputs":[{"kind":"stdout","text":"[1] 200\n"}],"defined":[],"used":["x"],"files":[]},"session":{…,"variables":[…]}}}
```

A reply over 16 KiB (raise it with `maxBytes`, up to 65536) comes back as a **result
reference**. The reference is at `result.ref`, not inside `value`:

```json
{"ok":true,"result":{"ref":"bd3e…","bytes":75081,"type":"object","length":3},"complete":false}
```

Do not call the operation again to see the reply. A write that comes back as a reference has
already happened.

## 4. `rho_read`: walk a result reference by the paths it gives you

Start with no `path`. Every entry in the reply carries its exact `path`; descend by copying it.

```json
rho_read {"ref":"bd3e…"}
→ entries: [{"key":"apiVersion","path":"/apiVersion"}, {"key":"ok","path":"/ok"}, {"key":"value","path":"/value","type":"object","length":2}]

rho_read {"ref":"bd3e…","path":"/value"}
→ entries: [{"key":"cell","path":"/value/cell"}, {"key":"session","path":"/value/session"}]

rho_read {"ref":"bd3e…","path":"/value/cell/state"}
→ {"value":"done"}

rho_read {"ref":"bd3e…","path":"/value/cell/outputs/0/text"}
→ {"length":70893,"offset":0,"next":15437,"complete":false,"value":"row 1 …"}
```

- Text arrives in pages of up to 16 KiB (`maxBytes` up to 65536). Continue with
  `"offset":<next>`. Offsets count UTF-16 units.
- A container lists `limit` entries at a time. Continue with `"offset":<next>`.
- `{"ref":"…","release":true}` frees a result you are done with. Reading it afterwards answers
  `not_found`.
- Paths differ by operation. `kernel.run` puts one cell at `/value/cell`, while `kernel.read`
  lists cells at `/value/cells/<i>`. That is why you read the parent first.

In the five reproductions this skill comes from, Agents guessed paths such as `/cells`,
`/cells/0` and `/value/cell/state` before finding the right one, and their transcripts count up
to 11 refused calls in one analysis. Reading the parent costs one call.

## Errors

Errors read `{"ok":false,"error":{"kind":…,"message":…,"continuation":…}}`.

| `kind` | Meaning | Do |
| --- | --- | --- |
| `invalid` | The input does not match the schema, or `ref` is missing or not a reference | Read the contract's input schema. For `rho_read`, copy `result.ref` exactly |
| `not_found` ("Result field is unavailable") | That path does not exist in this reply | Read the parent path and pick from its entries |
| `not_found` ("This result is unavailable in this connection") | The reference was released or evicted, or belongs to another connection | Observe the original request (for a cell, `kernel.read` with its `cellId`). Never run it again to get a new reference |
| `unauthorized` | Not in this project's grant | Tell the person which operation was refused. Do not look for another way in |
| `stale` | A version changed since you read it | Read the owner's record again and retry with the current version. Keep the `changeId` only for the same request |
| `limit` | A named budget was reached | Report the budget's name. Wait, interrupt, or narrow the request |

## Identities

Writes carry a `changeId` (cells, document edits, task maps, skills). The same `changeId` from
the same caller returns the original result and never runs twice. When a reply is lost or comes
back unknown, resend the same request with the same `changeId` to find out what happened. Give
new work a new `changeId`.

## What is in the default grant (0.5.3, 82 operations)

`rho_index {}` is the authority, because grants and versions differ. As a map:

| Owner | For | Main operations |
| --- | --- | --- |
| `kernel` (Notebook) | Live R and Python sessions shared with the person | `kernel.run`, `kernel.read`, `kernel.inspect`, `kernel.interrupt`, `kernel.plot`; servers: `kernel.places`, `kernel.place.set`, `kernel.place.check`, `kernel.servers`, `kernel.server.skill` |
| `documents` | Editing a file the person also has open, with shared undo and conditional save | `document.open`, `document.read`, `document.edit`, `document.save`, `document.undoOwn` |
| `files` | Registering and checking outputs and their bytes | `resource.list`, `resource.read`, `resource.register`, `artifact.check` |
| `tables`, `charts`, `media` | Typed tables with stable row keys, scatter charts, images and PDFs | `data.page`, `data.compare`, `selection.set`; `data.plot`; `media.describe` |
| `skills` | The project's own skills in `.claude/skills/` | `skills.list`, `skills.read`, `skills.change`, `skills.undo` |
| `rho` | Folder entries, the person's layout and selection, the task map, managed runs | `project.entries`, `composition.apply`, `interaction.selection.read`, `task.map.declare`, `task.map.read`, `observation.snapshot`, `action.lookup`, `action.output` |
| `agent`, `annotations` | Requests and comments the person sent you from Rho | `context.read`, `feedback.read`, `annotation.list`, `annotation.read`, `annotation.reply` |
| `r`, `requirements` | Managed R runs of a saved script with declared inputs and outputs (needs Core, bundled in the npm package) | `action.submit`, `object.read`, `requirements.check` |
| `console` | Commands the person ran from Rho's Console | `console.list`, `console.output` |
