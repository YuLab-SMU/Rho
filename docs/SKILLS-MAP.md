# Skills in Rho

Agent Skills are reusable, on-demand workflow instructions. They tell an Agent how to use
the tools it already has; they do not register a tool, grant permission or replace an
`AGENTS.md`/`CLAUDE.md` instruction that is always active. Rho uses the word Skill for a few
related payloads, so the source and delivery channel have to be named together.

## The model

Rho has four Skill sources and several delivery channels:

| Source | What it contains | Owner | Mutable? | How it is read |
| --- | --- | --- | --- | --- |
| Application | Rho-wide operation guides such as `rho.workspace` and `rho.person-files` | Rho | No | `skill.list` gives a manifest; `skill.read` gives the body; `rho_resolve` may include an exact `skillRef` |
| Selected plugin | Guidance for one plugin, such as Tables or the Notebook | Rho-plugins | No | The same `skill.list` / `skill.read` pair, filtered by the selected package and caller; an operation's `rho_resolve` bundle may include it |
| Project | The methods and conventions chosen for one project | The project and its person | Yes | `.claude/skills/<name>/SKILL.md`, managed through `skills.list`, `skills.read`, `skills.change` and `skills.undo` |
| External environment | A server's setup and usage rules | The person's server manager | Outside Rho | `kernel.servers` lists bindings and `kernel.server.skill` reads one bound file |

Third-party packages are a separate package source. Their declared `SKILL.md` is read through
`extension.describe` followed by `extension.content { kind: "skill" }`; it is not silently
registered as a project Skill. When Rho starts a Claude Code session, selected plugin entries
may also be materialized into an immutable local Claude plugin directory. That directory is a
delivery mechanism for the selected package guides, not another source of truth.

The published `skills/rho/SKILL.md` is different again: it is the integration Skill installed
into an Agent's own global or project Skill directory. It teaches an Agent how to install,
connect to and use Rho from outside a Rho session. It is not the `rho.workspace` operation
guide served by `skill.read`.

## Rho's shipped guides

The application and plugin declarations are operation guides, not project files. Their
manifest now says:

```json
{
  "kind": "operation-guide",
  "scope": "application | plugin",
  "owner": "rho or a plugin id",
  "mutable": false,
  "delivery": "rho"
}
```

`skill.list` and the Skill portion of `capability.list`/`observation.snapshot` return those
manifests only. The body is fetched by `skill.read` after the caller selects an id and can pin
its digest. This keeps routine observations bounded and makes the list/read split real. A
resolved operation still carries the complete guide it needs, with the same immutable digest.

These guides explain a capability; they never widen the caller's grant. Authorization and
availability are checked when the operation is resolved and called. A guide can describe a
failure or an unavailable dependency, but a successful `skill.read` is not proof that the
operation is available.

## Project Skills

Project Skills are the only Rho Skill source that grows from work in a project. Each file is
an ordinary `SKILL.md` under `.claude/skills/<name>/`. The file's SHA-256 digest is its version.
`skills.change` writes a complete next file only when the caller supplies the version it read;
the journal keeps the author, reason, evidence and before/after versions. An edit made by an
editor, Git or an Agent's own file tools is reported as outside Rho before Rho overwrites it.
`skills.undo` is itself a journaled change and refuses to overwrite a newer outside edit.

The project Skill contract is deliberately separate from shipped operation guides:

| Operation family | Resource | Purpose |
| --- | --- | --- |
| `skill.list` / `skill.read` | Package declarations | Discover and read immutable Rho/plugin operation guides |
| `skills.list` / `skills.read` | Project files | Observe project conventions and their history |
| `skills.change` / `skills.undo` | Project files and journal | Change or restore project conventions with concurrency checks |

Claude Code may discover the project folder through its own harness when a native session loads
the project's settings. Rho's layered sessions do not rely on that implicit loading: they receive
the relevant project operation guide through `rho_index`/`rho_resolve` and read project files with
`skills.list`/`skills.read`. Other Agents must use the project operations. A project Skill guides
work; it cannot grant access to a file, server, runtime or operation.

## What is not a Skill

Studio layout is a composition contract (`composition.read`/`composition.apply`) plus the
current `uiContext`; Graph is derived from project notes and recorded work. Neither is a Skill
registry. The `studio-*` names in Rho's layout code describe an internal layout projection and
do not refer to Agent Skills.

## Limits and failure behavior

| Resource | Current limit | When exceeded |
| --- | --- | --- |
| One project Skill file | 32 KiB | The change is refused and the previous file remains |
| Project Skill count | 24 | The new Skill is refused |
| Project change journal | 1,000 retained changes | The oldest records are dropped after the named retention boundary |
| One server-bound Skill read | 256 KiB | The read is refused; the server file is unchanged |
| One third-party Skill entry | 512 KiB | The package content is refused or the previous package selection is retained |
| Claude session plugin | 32 Skills, 64 KiB each | Session assembly is refused before a directory is selected |
| One resolved discovery page | 64 KiB profile | The complete item is preserved but execution is unavailable until it fits |

Limits protect different resources. They are not interchangeable quotas and a limit refusal
never turns into an automatic retry under a new identity.

## Recommended Agent path

1. Use `rho_index` and `rho_resolve` to select the operation; read the returned operation guide
   and exact contract before calling it.
2. For project-specific conventions, call `skills.list`, then `skills.read` for the guides
   that apply. Follow them without treating them as authorization.
3. For a third-party package, read `extension.describe`, then the selected Skill content at its
   expected digest before `extension.call`.
4. For a remote place, read `kernel.servers` and the server's bound Skill before naming or
   checking the place.
5. Re-read a body when its digest is stale. Observe an unknown action by its original identity;
   do not rerun it to recover a Skill or a large response.

The observed project-Skill carry-over case and its limits are recorded in
[Project skills](SKILLS-EPISODE.md). Plugin and package boundaries are described in
[Third-party plugins](THIRD-PARTY-PLUGINS.md), and the current browser presentation is in
[Frontend](FRONTEND.md).
