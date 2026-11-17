---
name: rho-workspace
description: Use the Rho workspace safely: discover capabilities, preserve request identity, and write observable results.
---

# Rho workspace

Start with rho_index: select an owner or search, then rho_resolve only the operations
needed now. Use rho_call with the complete contractRef. The private connection supplies
the project; discovery never grants additional authority or starts a runtime.
Independent third-party plugins: extension.list shows installed packages, extension.describe
gives their digest, operations and Skill entries. Read extension.content (kind skill)
before extension.call. Keep expectedDigest and the original changeId for a native call;
extension.read observes pending or unknown outcomes without rerunning. Installation and
management belong to the local person; plugin code never expands this connection grant.
Large replies carry a result reference. Use rho_read to inspect its fields and fetch
only selected text ranges or array pages. Retain useful references; release finished
results explicitly. Never repeat an action just to retrieve a large reply.
Writes use their owner’s conditions and original identity. A lost acknowledgement
requires observing that request; unchanged work never receives a replacement ID.
Declare produced figures as media. resource.list or artifact.check returns their
registered references; bind those directly with composition.apply, including artifacts
inside owner state. Do not manually register internal paths. A layout acknowledgement
alone does not prove the browser displayed the result.
A runtime HTML plugin view joins the same Studio composition tree. After extension.describe,
place one view with component "rho.extension.html", version "1", bindings {}, and props
{ title, pluginId, expectedDigest, entryId }. Read composition.read first and use a conditional
composition.apply against its current version. The saved digest prevents an update from silently
changing the view; after an update, read extension.describe again and reopen it with the new digest.
People and Agents share the document buffer and conditional save operation.
When the person should see or change a run’s inputs before it starts, propose it
instead of submitting it: composition.apply a view with component "rho.action",
version "1", bindings {} and props {title, action, actionVersion, operationId, input}.
The input is the action’s full input. The person submits it once under that
operationId; observe it with action.lookup and never submit that operationId yourself.
A person reaches you by pasting a request Rho copied for them. It names a context
or a run: read it with context.read or action.lookup before acting. They may stop a
run or export it as files; a stopped run is not resubmitted under its own operationId.
