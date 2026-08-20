# Rho Privacy Policy

Last updated: 2026-08-15

Rho is a local-first desktop workbench for R. Rho does not include first-party
analytics, advertising, background telemetry, or automatic crash-report upload.
It does not require a Rho account and it does not automatically upload a
project to YuLab-SMU.

This policy describes Rho's own behavior. A model Provider, package repository,
website, or program that you choose to use has its own terms and privacy
practices.

## Data kept on your computer

Rho works with files in the project directory you select. Project source,
scientific data, plots, rendered outputs, and other project artifacts remain in
that project unless you explicitly run code or choose an operation that sends
them elsewhere.

Rho also keeps local application data needed to restore and explain work. This
can include project roots, window and panel state, open documents, Provider and
model metadata, capability routes, Agent conversations and events, approvals,
runs, evidence and output metadata, environment snapshots, and diagnostic logs.
The exact local records depend on which features you use.

Diagnostic logs and support text can contain filesystem paths, software
versions, bounded error text, command output, stdout, or stderr. Rho redacts
recognized credential patterns at its owned boundaries, but no automatic
redaction can recognize every sensitive value. Review diagnostics before you
copy or share them.

## API keys and credentials

API keys saved through Model settings are stored in the operating system
credential store—Apple Keychain on macOS and Windows Credential Manager on
Windows—not in the project or repository. Rho does not display a stored key
again.

For an explicit model operation, Rho retrieves the selected key and sends it
only to the endpoint configured for that Provider. A custom Base URL changes
who receives the request and therefore changes the trust boundary. Verify the
scheme, host, organization, and privacy terms before using a custom Base URL.
Do not place credentials in a Base URL, project file, Issue, or diagnostic.

## When Rho can access the network

After local startup becomes ready, Rho automatically contacts the fixed Rho
update service once to check for a newer signed release. The check does not add
project content, Provider settings, or credentials. It does expose ordinary
HTTPS metadata such as IP address, time, TLS/HTTP headers, and user agent to the
service and its hosting providers.

For a supported installed build, a newer release is downloaded from its
published GitHub Release and installed automatically after signature
verification. Manual **Check for Updates** remains a retry path. That download exposes
ordinary HTTPS metadata to GitHub Releases and intervening network providers,
but does not include project content, Provider settings, or credentials.

Other network-capable operations occur only after a corresponding user action:

- importing a Provider's model list or testing a Provider connection contacts
  the selected default or custom endpoint;
- sending an Agent request contacts the routed model Provider and can include
  the prompt, selected or attached project context, tool results, and model
  options needed for that turn;
- resolving a DOI sends that DOI to the Crossref API;
- installing, updating, restoring, or otherwise operating on R packages can
  contact the package repositories shown by the environment workflow after the
  applicable user request, preview, or approval;
- R code, Agent-approved tools, shell commands, packages, and external programs
  can access destinations determined by that code or program; and
- opening the Rho website, source repository, release page, documentation, or
  another external link opens the system browser after a user action.

Rho cannot control what user code, third-party R packages, external tools, or a
configured model Provider transmit. Inspect code, previews, Provider settings,
and approval details before running them. Provider responses and retention are
governed by the selected Provider.

The Rho download/update website does not include Rho-owned analytics or
advertising scripts. GitHub Pages, GitHub Releases, network operators, and
other infrastructure providers can still receive normal request metadata.

## Retention and deletion

Project files and outputs remain until you remove them from the project. Local
Rho records remain until they are removed through an available Rho action or by
deleting the relevant application data. A Provider removal workflow can delete
its stored key; you can also manage credentials with the operating system.

Deleting a visible history item may preserve bounded audit, provenance, or
recovery metadata where the interface says so. Uninstalling Rho does not
necessarily remove project files, R libraries, Rho application data, logs, or
operating-system credential-store entries. Back up important work and review
the relevant Rho and operating-system storage before deletion.

## Security and support

Report a suspected vulnerability through
[GitHub private vulnerability reporting](https://github.com/YuLab-SMU/Rho/security/advisories/new).
Do not put API keys, private project content, personal information, or
unredacted diagnostics in a public Issue.

Policy changes are reviewed in the public source repository. The version of
this file included with a Rho source release describes that release's Rho-owned
behavior.
