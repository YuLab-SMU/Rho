# Versioned release notes

Every newly constructed Rho GitHub Release must have one reviewed Markdown
file named after its exact tag:

```text
.github/release-notes/v<version>.md
```

For example, application version `1.2.3` uses
`.github/release-notes/v1.2.3.md`.

The first line is a short plain-text summary used by both GitHub Releases and
the Rho Update Site. Follow it with a blank line and one or more `##` sections:

```markdown
Rho improves project recovery and makes release verification clearer.

## Fixed

- Restored project state is validated before it is shown.

## Verification

- Windows and macOS installers passed their exact candidate gates.
```

Review and commit this file together with the version metadata before running
candidate mode. Do not add claims for behavior or acceptance that is not part
of that exact candidate. After publication, the tag and GitHub Release retain
the record; the development branch does not accumulate old release notes.
