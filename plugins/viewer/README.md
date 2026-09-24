# Viewer

An ordinary UI-only plugin for retained R HTML outputs. It depends on public
queries and resources, never on the Studio singleton, native R process or private
core modules. Its source identity is fixed per view. Independent instances can
show different R revisions, and original results remain readable after the
producing backend and package are removed.

The current view supports original output history, saved selection, refresh and
source inspection, including version 2 input labels verified against the original
request. Workspace layout/scenario integration and public window/focus
commands are part of the ongoing unified-plugin migration. This package does not
claim a live R web service or full Studio interaction acceptance.
