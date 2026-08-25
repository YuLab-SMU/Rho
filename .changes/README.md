# Change fragments

Feature worktrees record user-visible changes in one independent Markdown file
named `.changes/AM-C-NNNN.md`. The first fenced block is strict JSON:

```json
{
  "schema_version": 1,
  "record_type": "change_fragment",
  "id": "AM-C-0001",
  "work_package_id": "AM-W1-01",
  "category": "added",
  "title": "Short user-visible title"
}
```

The remaining Markdown body explains the implemented behavior in release-note
language. Categories are `added`, `improved`, or `fixed`. Internal-only changes
need no fragment. Run `node scripts/change-fragments.mjs validate`; the
integration lane may generate a deterministic candidate section with:

```text
node scripts/change-fragments.mjs compose --version 0.4.2-dev.1 --date 2026-08-25
```

Feature worktrees do not edit `NEWS.md`, lock files, or generated candidate
summaries. The integration lane reviews and composes those shared files.
