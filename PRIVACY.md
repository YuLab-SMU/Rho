# Rho Privacy Policy

Last updated: 2026-09-07

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

Rho does not maintain an internal Agent conversation or model-provider account
database. An external Agent platform manages its own conversations, credentials
and retention; Rho records the scientific requests and results it receives.

Code, arguments, output and diagnostics can contain private data or credentials
printed by a program. Do not assume general-purpose redaction. Review material
before sharing it, even when its output size is bounded.

## Connections and credentials

The local workbench binds to 127.0.0.1. A per-run bearer token protects its
scientific API and HTTP MCP endpoint. Keep the private launch URL and any URL
file private. CLI and stdio MCP use the local operating-system account context.

The current application does not provide model API-key settings, an SSH password
wizard or a managed-key installation workflow. SSH authentication uses the
existing connection configuration and its credential mechanism. Rho does not
copy those credentials into a new project credential store.

## Network activity

The current implementation has no Rho-owned analytics, automatic crash upload,
release update check or automatic installer download. The browser loads embedded
assets and queries the local Host; it does not load a third-party frontend CDN.

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
