# Rho Privacy Policy

Last updated: 2026-09-14

This page describes the current CLI, Studio and MCP entry points.

## Local data

Rho operates on the project directory you select. Its SQLite journal records
Operations, caller/correlation identities, inputs, outcomes, domain facts and
events. Inputs can include R code or command arguments. Runtime directories
can contain stdout/stderr, conditions, output files, package plans, isolated
libraries and recovery material. The selected database and runtime paths are
described in the [operator guide](docs/OPERATIONS.md).

A separate local SQLite application store holds Studio drafts, layouts, view
positions, recent projects, preferences and unconfirmed request identities. Draft
synchronization does not overwrite project files. The browser uses session storage
for the current local access token. Closing a page does not cancel accepted work;
reconnection queries the original request and retry is explicit.

Native Agent platforms manage their own conversations, authentication, retention
and independent runtime lifecycle. They are responsible for their answers and image
interpretation. Rho is responsible for connection identity, protocol delivery and its
own permission, draft, receipt and recovery records; it retains bounded native status
and usage observations without presenting unreported values as zero. Rho does not
independently certify third-party Agent capabilities or answer quality.
Optional component assistants additionally retain user requests, fixed authorization
and model configuration references, tool receipts, bounded text events and usage in
the Application store. The frozen task intent includes an exact excerpt of the
original request and finite action/target references. Permission decisions retain
the original action identity. Uploaded UTF-8 text, PNG and JPEG files are stored as
Application assets with scoped identities and hashes, separately from text history;
user uploads are not labeled as scientific outputs. Model text remains distinct
from scientific results. Internal reasoning is not retained, and model-content telemetry is disabled. Ordinary Rho
follow-ups include a bounded selection of saved prior requests, answers and owner
references when sent to the configured model; old grants are not carried as new
authorization, and raw tool-result JSON and binary bytes are not duplicated into
that conversation summary.

Code, arguments, output and diagnostics can contain private data or credentials
printed by a program. Do not assume general-purpose redaction. Review material
before sharing it, even when its output size is bounded.

## Connections and credentials

The local workbench binds to 127.0.0.1. A per-run bearer token protects its
scientific API and HTTP MCP endpoint. Keep the private launch URL and any URL
file private. CLI and stdio MCP use the local operating-system account context.

Rho accepts an explicitly configured model endpoint. Saving an API key writes the
raw value to the user's local `rho/model-credentials.json` configuration file, outside
the selected project. On macOS this is under `~/Library/Application Support`; Windows
uses `%APPDATA%`; Linux uses `$XDG_CONFIG_HOME` or `~/.config`. Rho uses ordinary file
permissions and atomic replacement; the JSON file is not encrypted by Rho. Project
settings, conversations, synchronized drafts and diagnostics retain only the key
reference and availability, not its value. Keys survive Host/application restarts
until explicitly removed. Accepted work retains its captured credential if the
setting is later replaced or removed.
Replacing settings retains older credential versions because another saved
configuration can still reference them. Remove key deletes the selected credential;
Rho does not scan other Application databases to infer which versions are unused.

An environment-variable reference remains optional. Existing Session references
still point to Host memory and become unavailable when that Host ends; Rho does not
import native CLI authentication to replace them. Component controls require the
browser credential; MCP-only credentials cannot use them. Remote model endpoints
require HTTPS, with explicit loopback HTTP allowed for local services. Automatic
model HTTP redirects and retries are disabled.

Managed external Agent connections have task-specific callers and private transport
credentials. Reconnection replaces the transport credential without rewriting the
caller's existing scientific records. Taking over an idle task changes its controller
without recreating the native session or its MCP credential. Older tasks that used a shared caller retain
that namespace, and Rho reports unavailable per-task attribution rather than
inferring which historic operations belong to them.

Rho does not provide an SSH password wizard or managed-key installation workflow. SSH authentication uses the
existing connection configuration and its credential mechanism. Rho does not
copy those credentials into a new project credential store.

## Network activity

The current implementation has no Rho-owned analytics, automatic crash upload,
release update check or automatic installer download. The browser loads embedded
assets and queries the local Host; it does not load a third-party frontend CDN.

An explicit Rho request sends its prompt, selected sources and uploaded attachments,
plus needed bounded tool observations, to the selected model service. Uploading a
file to the local Host alone does not send it to the model. Connection/image Tests
use labeled synthetic content. Ordinary project browsing, editing and
disabled/unconfigured assistant discovery do not invoke a model. Provider-side
processing, billing and retention follow that service's terms; local Stop does not
prove the remote request was withdrawn. Current implementation stages and verification
limits are listed in [Status](docs/STATUS.md).

Requested package operations, Git/SSH commands, R code and other programs can
contact external systems. Rho's native execution uses the user's OS permissions;
it is not a filesystem or network sandbox. Code can start further processes or
network activity. External Agent platforms, package repositories, connection
tools and programs have their own data handling and privacy practices.

## Retention and removal

Project files, recorded Operations and runtime outputs remain in their selected
locations until removed. Environment material cleanup is explicit and protects
the references and active use it can observe; it is not a general sweep of all
outputs. See the operator guide for its quarantine, restore and purge behavior.

Stop the relevant Host before manually removing its application databases or
runtime directory. Synchronized drafts live in the application store, so deleting
that store removes saved drafts and its retained attachments as well. Rho model keys
are in a separate user configuration file; removing the application database or
executable does not remove them. Use the key removal control for the selected Rho
connection. Removing the executable also leaves project files, R libraries, browser
storage and credentials managed by other tools. Git history and external scheduler
records have their own lifetimes.

## Reporting a problem

Use [GitHub private vulnerability reporting](https://github.com/YuLab-SMU/Rho/security/advisories/new)
for suspected exposure. Do not place credentials, private project contents or
unredacted diagnostics in a public Issue. The policy included with a particular
source release describes that release's Rho-owned behavior.
