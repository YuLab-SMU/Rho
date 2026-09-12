# Rho Privacy Policy

Last updated: 2026-09-12

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

Native Agent platforms manage their own conversations, authentication and retention;
Rho retains their application task references, drafts and bounded observations.
Optional component assistants additionally retain user requests, fixed authorization
and model configuration references, tool receipts, bounded text events and usage in
the Application store. Model text remains distinct from scientific results. Internal
reasoning is not retained, and model-content telemetry is disabled.

Code, arguments, output and diagnostics can contain private data or credentials
printed by a program. Do not assume general-purpose redaction. Review material
before sharing it, even when its output size is bounded.

## Connections and credentials

The local workbench binds to 127.0.0.1. A per-run bearer token protects its
scientific API and HTTP MCP endpoint. Keep the private launch URL and any URL
file private. CLI and stdio MCP use the local operating-system account context.

The optional component service accepts an explicitly configured model endpoint and
an environment-variable credential reference or a key held in Host memory. Persistent
settings and conversation records contain only the reference, not the raw key.
Session keys expire when the Host ends; no native CLI authentication is discovered
or imported. Component controls require the browser credential; MCP-only credentials
cannot use them. Remote model endpoints require HTTPS, with explicit loopback HTTP
allowed for local services. Automatic model HTTP redirects and retries are disabled.

Rho does not provide an SSH password wizard or managed-key installation workflow. SSH authentication uses the
existing connection configuration and its credential mechanism. Rho does not
copy those credentials into a new project credential store.

## Network activity

The current implementation has no Rho-owned analytics, automatic crash upload,
release update check or automatic installer download. The browser loads embedded
assets and queries the local Host; it does not load a third-party frontend CDN.

An explicit component assistant request sends its prompt and needed bounded tool
observations to the selected model service. Ordinary project browsing, editing and
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
that store removes the saved drafts as well. Removing the Rho executable does not remove project files,
R libraries, browser storage or credentials managed by other tools. Git history
and external scheduler records have their own lifetimes.

## Reporting a problem

Use [GitHub private vulnerability reporting](https://github.com/YuLab-SMU/Rho/security/advisories/new)
for suspected exposure. Do not place credentials, private project contents or
unredacted diagnostics in a public Issue. The policy included with a particular
source release describes that release's Rho-owned behavior.
