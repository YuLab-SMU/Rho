---
name: rho-workspace-continuation
description: Understand and continue work in a Rho scientific workspace when joining an existing project or resuming an external task across sessions or windows.
---

Establish which project, logical R instance, native session, and Studio window the user means. On a Host exposing `runtime.instances`, use that read or the explicit window context to obtain `workspace_instance_id`; carry it on live Workspace reads and operations. Instance names are labels, not identities. Rho discovery explains available capabilities and their preconditions. Each observation has its own source, time, and completeness; an overview does not establish an atomic snapshot of the whole workspace.

Choose the evidence needed for the user's goal. A saved file, synchronized historical draft, current live draft, Console input, and captured execution text can differ. For document work, identify the explicit window and document version before interpreting or editing its contents. Multiple windows do not imply one current window.

Use the supplied capability descriptions and read references to obtain detail as needed. State unavailable modules and missing native identities as observed gaps. Do not start R merely to discover capabilities or silently substitute another session's state.

Method selection belongs to the user and external Agent. Standard Skills can inform the work without prescribing a fixed sequence. If recording a method binding, retain its source, exact resources read, and real target. An explicit exclusion or host-disabled method remains in effect until changed in its own scope.

When resuming uncertain work, preserve the external task reference and original request identities. Investigate existing receipts and operation records before deciding whether new work is needed.

Reconnecting to a live R process keeps its existing memory. Continuing a stopped instance may restore a recovery copy in its bound environment; a clean restart instead begins an empty continuation lineage. Read the actual restoration coverage and environment status before relying on old object names. A recovery copy does not replay a queue, an unconfirmed execution, or an Agent instruction. Do not start or restore an instance merely to answer a read-only question.
