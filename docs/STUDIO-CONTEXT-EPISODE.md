# What “this workspace” means to the Agent

Date: 2026-11-07. Application source after Rho 0.5.6; Core and Plugins unchanged.

## Observed failure

The person opened the empty **Workspace 3** under Studio in the shipped PA14
project and asked OpenCode, “删除这个空的workspace”. Its reply listed the project
directory's files and asked whether to delete that directory and its contents.
The screenshot showed zero views in Workspace 3 alongside a populated project.
Reading the running application reproduced that distinction without changing the
person's project, Agent or sessions.

`web/conversation.tsx` sent only the person's text. `src/conversations.ts` added
explicit frozen review references when supplied, but carried no location from
the sending tab. The Agent's working directory and project MCP connection did not
identify the Studio layout on screen. Rho also offered conditional layout edits
and closing views, but no operation for deleting a workspace layout. Session
instructions went through the ACP `systemPrompt` extension; interface context now
travels with the message itself, including on an already-open third-party session.
This does not depend on an Agent honoring that extension.

## Change and its boundary

The Agent panel sends the tab's page, Studio composition ID and observed version,
replay position, or the path of a file preview. Before acknowledging a new message,
the service freezes this location with its project identity and a bounded layout
summary: title, current version, number of views, and their IDs, components and
titles. Changed, missing and conversation-derived layouts retain those distinctions;
an unsaved derived layout does not acquire a made-up view count. The observation
is included in every located message, with a short explanation of Rho's Studio.
The person's stored text stays unchanged. Studio messages show their originating
workspace under that text.

The browser retains the location in its pending request. The request digest includes
it, and an identical retry returns the first frozen observation, even after the
person navigates or the layout changes. Another tab has its own location. Names
and paths are data, not instructions or scope grants; collecting the context reads
no named project file and starts no runtime.

`composition.delete` conditionally removes an **empty structured Studio layout**
from active lists. It preserves the layout's identity, version, receipts and undo
history in the same owner record. Nonempty, conversation and active-task layouts
are refused. It does not remove project files, shared document buffers, resources
or conversations, and stops no session. `composition.undo` restores the layout.
Recreating it uses its retained version; an old deletion request returns its old
receipt and cannot delete the new version. Format-3 archives keep deleted layouts.

The existing `workspace.maxCompositions` budget includes retained deleted identities;
the browser reuses one at its current version when making that numbered workspace
again. `conversations.maxUiContextViews` defaults to 32 and counts omitted views;
`maxUiContextBytes` defaults to 16 KiB, first dropping and counting excess view
summaries, then refusing the unsent message if its remaining context is too large.

## Real OpenCode run

The disposable project had `README.md`, `data/counts.csv`, Workspace 2 and Workspace 3,
each with zero views. A separate source service used the existing generic ACP
command `opencode acp` and OpenCode's configured `magpie/GLM-5.3-Flash` model.
No client configuration or permission policy was changed. All messages were typed
and submitted in the real browser. No Core Host or live R/Python session was started.

1. From Workspace 3, the original Chinese request made OpenCode call `rho_index`,
   `rho_resolve` and `rho_call`. In eight seconds it deleted only `workspace-3`,
   without a shell command or a permission question. The sidebar removed it, the
   current tab moved to Workspace 2, and the message retained “Studio · Workspace 3”.
2. In the same conversation, “现在这个workspace是哪个？不要修改，只说名称以及是否为空。”
   returned Workspace 2, empty with zero views, in one second and without a tool.
3. **New workspace** recreated Workspace 3 at version 3. The original Chinese
   request then deleted that new version in three seconds with one MCP call.
4. From Workspace 2, “恢复刚才删除的 Workspace 3。” restored Workspace 3 through
   `composition.undo` in six seconds. The explicit name took precedence over the
   current tab's different workspace.

The first review found that the deletion notice stayed visible after recreation
or undo. The tab now clears that notice when the same layout returns. The original
project files remained byte-identical throughout. Local evidence is retained in
`work/studio-context/`: the isolated setup, browser screenshots, API records and
check logs. The person's original PA14 project and running service were not changed.

## Verification and limits

`npm run build`, `npm run check:contracts`, and the 40 checks in the selected
conversation, Studio context, workspace, collaboration, contract and browser suites
pass. They cover frozen context on retry, changed-layout observations, the next
message's new location, deletion conditions, undo, recreated-version protection,
restart retention, dirty-buffer preservation, project scope and metadata limits.

The real-model result above establishes this OpenCode flow. Claude Code and Codex
share the message path but were not rerun with a real model for this episode.
The context is a bounded location summary, not the whole screen, a screenshot,
automatic editor selection or the contents of every view. File and selection
questions retain their existing explicit references. An Agent working wholly
outside Rho has no sending tab; this change does not invent one for it. No
independent usability claim or new npm release follows from this source change.
