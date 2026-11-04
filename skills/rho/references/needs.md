# What Rho offers for a need

Native tools stay normal. Use Rho where it gives the person something they would not get
otherwise: seeing the work as it happens, stepping in, and coming back to it later. Find each
operation with `rho_index` and read its contract with `rho_resolve` before the first call.

| The person wants to… | Use | First step |
| --- | --- | --- |
| watch an analysis as it runs, and run cells themselves | The Notebook's shared R and Python sessions | `kernel.run` ([analysis](analysis.md)) |
| know what you are doing and why, without reading the chat | A notes section in `project-notes.md`, kept current | Write it before the first cell ([analysis](analysis.md#before-the-first-cell)) |
| see the whole task and its parts at a glance | The task map: your own items, kinds and states, progress from real counts | `task.map.declare` when you start, again as work moves; resolve it to get its skill |
| have the same file open and edit it with you | Documents: one shared buffer, undo per author, conditional save | `document.open`, then `document.edit` and `document.save` with the versions you read. Your own file tools are fine for files nobody has open. When the person has the file open, edit through the shared buffer, so their unsaved text and undo stay intact |
| see a figure or table next to the code | A layout of views | `resource.list` or `artifact.check` gives the reference; `composition.apply` places the view. A layout reply does not prove the screen showed it |
| check a run's inputs before it starts | A proposed action the person submits | `composition.apply` a `rho.action` view (the `rho.workspace` skill from `rho_resolve` gives its exact props); then `action.lookup`. Never submit that `operationId` yourself |
| answer a question they asked from inside Rho | A request copied from Rho names a context or a run | `context.read` or `action.lookup` first, then act |
| comment on a code range or a table row | Annotations, bound to the exact version | `annotation.list`, `annotation.read`, `annotation.reply` |
| page or compare large tables by stable keys | Tables with declared column types and row keys | `data.page`, `data.compare` |
| keep how this project is done for the next Agent | The project's skills in `.claude/skills/<name>/SKILL.md` | `skills.list` and `skills.read` before working. `skills.change` when the person corrects a method or a failure's cause is found: their words, one-sentence reason, evidence. Never record results there |
| run on a lab server | Notebook places over `ssh` or `serverctl` | `kernel.servers` and `kernel.server.skill` first (the server's own rules), then `kernel.place.set`, `kernel.place.check`, and `kernel.run` with `place` |
| use project-specific Python packages | A virtual environment in the project | See [analysis](analysis.md#python) |
| have a run that is recorded, can be stopped, and outlives a restart | A managed R run of a saved script with declared requirements and outputs (Core is bundled in the npm package) | `requirements.check`, then `action.submit`; observe with `action.lookup` and `action.output`. Choose it only for that need, not by default |
| keep or hand over the evidence | Workspace export; evidence package | `workspace.export`; `rho --verify-evidence PATH` checks a package read-only |

## Choosing the Agent's place

- The person wants to talk to the Agent **inside Rho** (they read replies next to the files, and
  ask about a result on its answer board): they start the conversation in Rho's Agent panel.
  Nothing to connect.
- The person **already works in a terminal Agent**: connect that Agent to the project
  ([connect](connect.md)). Rho shows its activity and results. Conversation stays in the
  terminal.

Either way, the person works on the same project. Rho shows which Agent did what.
