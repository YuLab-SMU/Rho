# Rho skills

Rho ships two kinds of Agent Skills.

- `rho/SKILL.md` is the integration Skill an Agent installs to learn how to connect to a Rho service.
- `rho/operations/*/SKILL.md` are the immutable operation Skills that describe how to use Rho's shared workspace, person file access, long analyses, task maps and browser checks.

Every operation Skill has YAML frontmatter with a lowercase hyphenated `name` and one-line `description`, an H1 title, and the instructions an Agent follows. The file is the source of truth. The TypeScript declaration keeps only the public id, version, operation metadata, examples, failure recipes and verification command, and loads the body from this file. The served digest is computed from that body.

The selected Rho-plugins packages use the same layout under each package's `skills/` directory. Their `SKILL.md` files are included in the npm package and loaded at runtime; a build or package check therefore fails when a declared Skill is not shipped.

Project Skills have a different owner and lifecycle. They live in a user's `.claude/skills/<name>/SKILL.md`, are changed through the `skills.*` operations, and record the person's methods and the evidence for each change. Shipped operation Skills are immutable package guidance. An Agent reads both when the task needs both kinds of context.

To add an operation Skill, create its `SKILL.md` beside the owning module, bind that module to `readSkillFile(new URL('../skills/<name>/SKILL.md', import.meta.url))`, keep the machine-readable metadata beside the declaration, then run the owner build, Skill source tests and package check.
