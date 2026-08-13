# Plugin System Design

Status: proposed integration design; implementation not authorized

Date: 2026-08-11

Scope: a declaration-driven plugin system for Rho. A plugin packages one or
more operations, each of which turns user- or Agent-supplied parameters into
executable R code that runs through the existing run/provenance pipeline.

Cross-reviewed against:

- `docs/implementation/implemented-wp4-project-skills-interface.md` (the skills
  trust model and manifest discipline are reused, not replaced);
- `docs/design/proposed-2026-07-26-public-workbench-protocol-cli-mcp-design.md`
  (the MCP direction is an external read-only protocol; plugins are an internal
  executable extension and are a distinct surface);
- `docs/plans/active-2026-08-06-user-directory-first-start-spec.md` (the global
  plugin root reuses the existing user-data-directory convention);
- `docs/plans/active-2026-08-07-project-skills-discovery-and-tree-repair-spec.md`
  (project-level discovery and trust for `.rho/` content).

Implementation entry rule: no product-code work begins before explicit
authorization. This document defines the design; each work package must be
separately authorized with a focused handoff and its own acceptance gate.

## Summary

Rho already has two extension surfaces: skills (read-only domain knowledge fed
to the Agent) and MCP (an external read-only protocol). This design adds a
third: plugins, which are executable operations with user-facing UI.

The core idea: a plugin is not arbitrary executable code. It is a declaration
of an operation — a parameter schema plus an R code template. Parameters are
filled, the template is rendered into real R code, and that code runs through
the same run/provenance pipeline as hand-written or Agent-written code. UI and
Agent share one schema, so a human clicking a form and an Agent filling
parameters produce the same kind of run evidence.

This makes "界面化操作 → 生成代码 → 可重复" a mechanical guarantee, not a
slogan. Every operation call leaves a visible, auditable, reproducible code
record.

## Goals

This proposal will:

- let users and plugins package one or more operations as a self-contained zip;
- define an operation as a parameter schema plus an R code template;
- render the parameter schema into both a UI form and an Agent-callable tool
  from one source of truth;
- run rendered code through the existing propose/approve → run → provenance
  pipeline, with no new execution bypass;
- install plugins globally (user data directory) and per project (`.rho/`);
- distinguish trust: globally installed plugins are trusted after explicit
  user confirmation; project plugins are always untrusted;
- keep skills and plugins as distinct, complementary surfaces.

## Non-Goals

This proposal does not authorize:

- native executable plugins (Rust/WASM/subprocess) with filesystem or network
  access;
- plugins discovering or referencing external skills; plugins ship their own
  skills inside the zip;
- a public plugin marketplace, remote plugin download, or automatic plugin
  update;
- a separate error channel for execution failures; rendered-code errors reuse
  the existing run/Problems pipeline;
- any change to the Workbench Protocol, persistence schema, approval lanes,
  project identity, or scientific execution authority.

## Decisions Recorded With The Project Owner (2026-08-11)

1. **Operation-first.** A plugin's primary unit is the operation; UI is derived
   from the operation's schema, not hand-written.
2. **Declarative action.** The operation action is a parameter schema plus an R
   code template; not native executable code.
3. **Parameter type set.** `string`, `number`, `boolean`, `enum`, `file`,
   `dataframe`, `color` cover the first version. `dataframe` and `color` were
   added on request for ggtree-style scenarios.
4. **Execution reuses the existing pipeline.** Plugin-generated code goes
   through the same approval path as hand-written and Agent-written code.
5. **Global and project scopes.** Global plugins live under the user data
   directory; project plugins live under `.rho/plugins/`.
6. **Trust is layered.** Globally installed plugins become `trusted` only after
   explicit user confirmation at install; project plugins are always
   `untrusted`. The approval path stays unified across both.
7. **Plugins ship their own skills.** A plugin embeds its skills inside the zip
   and never discovers external skills.
8. **Install-time trust refusal degrades to untrusted.** A user who declines
   the trust confirmation still installs the plugin as `untrusted` and may
   promote it later.

## Core Abstraction: The Operation

An operation is a project-scoped declaration under `.rho/plugins/` or a
globally installed declaration under the user data directory. A plugin package
contains one `manifest.json` plus one or more operations plus optional
resources (R scripts, README, icon, example data) and embedded skills.

Illustrative operation:

```json
{
  "id": "ggtree-circular",
  "title": "环形进化树",
  "description": "用 ggtree 画环形布局树，可加 tip 注释。用户想画圆形树时用。",
  "parameters": [
    { "name": "tree_file", "type": "file", "label": "树文件", "required": true },
    { "name": "layout", "type": "enum", "choices": ["circular", "rectangular"], "default": "circular" },
    { "name": "tip_label", "type": "boolean", "label": "显示 tip 标签", "default": true }
  ],
  "template": "ggtree(read.tree({{tree_file}})) + layout_{{layout}}() + geom_tiplab()"
}
```

Rules:

- the parameter schema is the single source of truth for both the UI form and
  the Agent tool definition;
- the template uses `{{name}}` placeholders that are rendered from parameters;
- rendering is a bounded, escaping substitution, never arbitrary code
  evaluation.

### Parameter Types

| Type | UI control | Rendered into template as |
| --- | --- | --- |
| `string` | text input | quoted string |
| `number` | numeric input with bounds | numeric literal |
| `boolean` | switch | `TRUE` / `FALSE` |
| `enum` | dropdown | literal choice |
| `file` | file picker | project-normalized path |
| `dataframe` | dropdown of environment objects | variable name (not contents) |
| `color` | color picker | color value |

`dataframe` renders the variable name, not a data snapshot, so generated code
stays readable and reproducible. `file` renders a project-normalized path under
the existing `project_root` rule.

## Component Breakdown

Four components. The first three are new thin layers; the fourth is reuse.

```text
.plio/plugins/ (and global plugins dir) — manifest.json + operations + resources
        |
   [1] Discovery — reuse the skills trust model (directory/symlink/size limits)
        |
   [2] Schema engine — one schema → UI form + Agent tool definition
        |
   [3] Template — safe parameter substitution → R code
        |
   [4] Execution — existing propose/approve → run → provenance (zero new code)
```

1. **Discovery** scans the plugin root and validates schema, size, and symlinks
   using the same trust model as skills (`untrusted_project_content` for
   project plugins).
2. **Schema engine** is the only dual-output component: one parameter schema
   maps to UI form controls and to an Agent tool definition.
3. **Template** performs escaping, bounded substitution of parameter values
   into the R template.
4. **Execution** is reuse. Plugin-generated code runs the same
   propose/approve → run → provenance path as all other code.

## Data Flow

UI and Agent converge at the template step and share one pipeline thereafter.

```text
[UI path]    user selects operation → form fills parameters (7 types → controls)
                                          |
                                          +→ [Template] → R code
                                          |                 |
[Agent path] Agent selects operation → fills parameters →  |
                                                            v
                                     [propose → approve → run → provenance]
                                                            |
                                     plot → Outputs; code → run record
```

Rules:

- the convergence point is the template; both paths produce "a filled R code
  string", then run identically;
- trust marks affect only the Agent side: `trusted` global operations are
  exposed as Agent-callable tools; `untrusted` project operations carry the
  `untrusted_project_content` warning and require explicit confirmation before
  Agent invocation;
- the UI side does not distinguish trust; a user clicking in the interface is
  already an explicit intent.

## Trust Model

| Scope | Location | Trust | Promotion |
| --- | --- | --- | --- |
| Global | `<user-data-dir>/plugins/<name>/` | `trusted` after install confirmation | install-time only |
| Project | `.rho/plugins/` | `untrusted` always | none |

The approval path stays unified: trusted and untrusted plugins both render code
into the same propose/approve → run → provenance pipeline. Trust affects only
whether the Agent may invoke an operation automatically and how the injected
context is labeled.

Install-time trust refusal degrades the global plugin to `untrusted`; the user
may promote it later from the plugin list. The plugin list is the management
surface for install, enable/disable, trust promotion, and uninstall.

## Plugin Versus Skills Boundary

Skills and plugins are complementary, not interchangeable.

| Dimension | Skill | Plugin |
| --- | --- | --- |
| Nature | read-only domain knowledge | executable operation |
| Output | context (enters prompt) | code + run + output |
| Executable code | forbidden (`.R`/`.py`/`.sh` rejected) | the R template is the core |
| Interaction | no UI, no parameters | form UI + parameter schema |
| Audience | Agent only | human and Agent |
| Trust | project-level, always untrusted | global trusted / project untrusted |
| Reproducibility | none (affects thinking only) | yes (code enters run/provenance) |

A skill cannot produce a run; a plugin can. Reproducibility is carried by the
plugin, never by the skill.

The two are complementary: a skill governs "how to think" (domain judgment,
parameter guidance), a plugin governs "what to do" (a clickable, callable
operation). The ideal shape is one plugin shipping one skill: the operation is
the action, the skill is the guidance for when and how to use it.

A plugin embeds its own skills inside the zip and never discovers external
skills. This keeps trust self-consistent: a skill and its operation share one
package, one trust mark, one lifecycle. Project-level `.rho/skills/` remains an
independent layer for project-authored, project-scoped context; the two layers
coexist without referencing each other.

## Error Handling

Errors are layered by ownership; the plugin introduces no new execution error
channel.

```text
[Install/load]  corrupt zip, invalid manifest, invalid schema, unmatched
                placeholders, symlink, out-of-root, oversized
                → plugin system error: "which plugin + which field + why"
                → fail-closed and isolated: one bad plugin is disabled,
                  never crashes the workbench or other plugins

[Call]          missing required, enum out of range, number out of bounds,
                missing file, missing dataframe variable
                → form-level red marks; user fixes before execution; no run

[Execution]     rendered R code fails
                → existing run/Problems pipeline; zero plugin-specific handling
```

Rules:

- execution errors do not belong to the plugin system; a failed rendered script
  behaves exactly like failed hand-written code, with run, Problems, and
  traceback intact;
- install/load is fail-closed and isolated;
- call-level errors are intercepted at fill time.

## Testing Strategy

Layered tests aligned to components. Two assertions are load-bearing.

```text
[Discovery]      reuse skills negative fixtures: invalid JSON, oversized
                 manifest, symlink, out-of-root
                 new: invalid schema (unknown type, empty template, unmatched
                 placeholders); isolation (bad plugin does not break others)

[Schema engine]  7 types → control / Agent tool mapping correct
                 single source of truth: UI and Agent definitions match

[Template]       ★ injection safety: hostile R in a parameter is treated as a
                 string, never executed
                 ★ 7 types render correctly (dataframe→name, file→path,
                 color→value)
                 unmatched/missing placeholder → error

[Trust model]    trusted global plugin: Agent may auto-invoke
                 untrusted project plugin: Agent needs confirmation + label
                 degraded install: refusal → untrusted → later promotion

[End-to-end]     ★ UI path and Agent path each complete, asserting "rendered
                 code entered the run record" — not "a plot appeared"
```

Three required invariants:

1. **Template injection is the security-critical point.** The template is the
   only place external content becomes executable code; it must have dedicated
   injection-attack tests.
2. **Reproducibility is the value-critical point.** End-to-end acceptance
   asserts the rendered code is in the run record. A plot without a code record
   is a black box and fails the design.
3. **Discovery reuses the skills negative fixtures.** The trust model is
   structurally identical, so the test assets are shared, not duplicated.

## Version, Documentation, And Release State

This document remains `proposed`. It changes no application version, R package
version, `NEWS.md`, or release status. Implementation may not start before this
contract is renamed to `active-` and each work package receives a focused,
authorized handoff with its own acceptance gate.
