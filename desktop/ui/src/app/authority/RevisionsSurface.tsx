import { useCallback } from "react";

import type { AuthorityProjectPort } from "../workbench/authorityPorts";
import { AuthorityList } from "./AuthorityList";

export function RevisionsSurface({ transport }: { readonly transport: AuthorityProjectPort }) {
  const load = useCallback(async () => [await transport.loadSnapshot()], [transport]);
  return <AuthorityList
    title="Revisions"
    load={load}
    empty="No project revision is available."
    render={(snapshot) => <article key={snapshot.snapshot_revision}>
      <strong>Project revision {snapshot.context.project_revision}</strong>
      <span>workspace: {snapshot.context.workspace_health}</span>
      <small>UI snapshot {snapshot.snapshot_revision}</small>
    </article>}
  />;
}
