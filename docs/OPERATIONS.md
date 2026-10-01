# Running Rho locally

The existing installed previews and retained historical bundles are separate from
this new source organization. Do not replace a running Host or assume an old
binary contains the new capabilities. R memory belongs to its existing session.

## Development application

Build the application and explicitly selected components through dev.mjs; inspect
node dev.mjs status and node dev.mjs verify first. Start with:

```sh
node dev.mjs run /absolute/project
```

This selects the retained core binary and target/app-assets. It uses a separate
catalog under target/development and prepares a local copy of the application-owned
R example for the Open Rho Demo action. It does not import plugins, activate
providers, install R packages or start R. Omitting the project displays the picker.
Use --local explicitly to run an uncommitted or off-lock retained core.

The core prints a private loopback URL. Navigate directly; never send its token to
search or save it in tracked files. Client HTML/JS/CSS updates can be refreshed
without a core rebuild or process replacement. Plugin instances continue to use
immutable artifacts until explicitly replaced. Backend replacement can end R memory.

## Plugin packages

The plugin-set.mjs utility operates on exact built artifacts through the public
core CLI. A composed set can be imported explicitly:

```sh
node /absolute/composition/plugins/plugin-set.mjs install \
  --rho /absolute/composition/rho --set /absolute/composition/plugins \
  --database /absolute/catalog.sqlite
```

Import does not activate a provider or create a workspace. Select instances and
scopes through public Host capabilities or an installed Manager view. Launch with
the same database. Removed packages are not silently reinstalled at startup.

For an assembled application:

```sh
/absolute/composition/rho --database /absolute/catalog.sqlite \
  --project /absolute/project workbench --assets /absolute/composition/assets
```

R and Ark are explicit existing installations selected by the R plugin. Plugin
queries do not start R. Read original Operation records after interrupted work;
never replay effects to guess whether they succeeded. Cancellation request,
confirmed cancellation, shutdown and rollback are distinct outcomes.

## Existing work

Before starting another writer for the same project, inspect the existing Host,
selected project and ongoing work. Never reuse a PID, port or token without
checking. Preserve acknowledged drafts/layout/history and retain uncertain results.
A browser refresh cannot add Host capabilities; a new Host cannot restore arbitrary
R memory. Restarting or replacing a user's runtime needs existing authorization.
