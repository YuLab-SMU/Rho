# Skills map

Rho's Skill guidance is now organized as actual Agent Skill packages. A Skill is an on-demand workflow file with a name, a one-line description, an H1 title and instructions that an Agent can follow in a fresh session. The file is versioned with the owner that implements the workflow and is included in the package that serves it.

## Source layout

| Owner | Source | What it teaches | Lifecycle |
| --- | --- | --- | --- |
| Rho | [`skills/rho/SKILL.md`](../skills/rho/SKILL.md) | Install Rho, connect an Agent and use the shared workspace | Installed integration Skill |
| Rho | [`skills/rho/operations/`](../skills/rho/operations/) | Workspace discovery, person file access, interruption-safe analysis, task maps and browser checks | Immutable operation Skills served by `skill.list` and `skill.read` |
| Rho-plugins | `../Rho-plugins/plugins/<plugin>/skills/*/SKILL.md` | The workflow for each selected functional plugin, such as documents, tables, R/Python sessions, figures and feedback | Immutable plugin Skills loaded from the selected package |
| Project | `.claude/skills/<name>/SKILL.md` in the project | The person's methods, conventions, decisions and lessons for this project | Mutable project Skill with recorded changes and undo |

The package source is the canonical body. TypeScript declarations supply the operation id, version, required operations, examples, failure recipes, verification command and presentation metadata. At build time the module reads its neighboring `SKILL.md`, validates its frontmatter and computes the digest from the body. A missing, malformed or unshipped file is a build or package defect.

## Rho operation catalog

| Skill id | File | Use it when |
| --- | --- | --- |
| `rho.workspace` | `skills/rho/operations/rho-workspace/SKILL.md` | An Agent is discovering Rho operations, composing views or preserving request identity |
| `rho.person-files` | `skills/rho/operations/rho-person-files/SKILL.md` | A person needs to browse or open files from the selected project folder |
| `rho.analysis-run` | `skills/rho/operations/rho-analysis-run/SKILL.md` | An analysis must survive a stopped turn and leave outputs and uncertainty readable |
| `rho.task-map` | `skills/rho/operations/rho-task-map/SKILL.md` | An Agent needs to show the whole task, evidence and next step to a person |
| `rho.screen-check` | `skills/rho/operations/rho-screen-check/SKILL.md` | A real browser check must inspect visible states, input, failure and recovery |

Plugin Skills follow the same id-to-file convention: `documents.workspace`, `files.workspace`, `r.workspace`, `requirements.workspace`, `tables.workspace`, `media.workspace`, `charts.workspace`, `agent.workspace`, `agent.feedback`, `agent.presentation`, `annotations.workspace`, `console.workspace`, `kernel.session`, `figures.read` and `skills.project` each have a package-local `SKILL.md` under `Rho-plugins/plugins/<owner>/skills/`.

## How the layers work together

`skill.list` and `skill.read` expose immutable operation Skills that are available in the selected application and plugin composition. They guide discovery and execution; they do not grant authorization. `skills.list`, `skills.read`, `skills.change` and `skills.undo` operate on the project's mutable `.claude/skills` files and their change journal. A layered connection receives the exact operation Skill references needed by `rho_resolve`; a browser or operator can read the same Skill explicitly.

The ownership boundary stays explicit. Rho owns application workflows and their package files. Rho-plugins owns plugin workflows and their package files. The project owns project Skills. The source module, the served declaration, the packaged file and the verification run must agree before a Skill is considered ready.
