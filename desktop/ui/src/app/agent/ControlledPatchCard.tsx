export type ControlledPatchProjection = {
  patch_id: string;
  base_project_revision: number;
  paths: string[];
  creates: number;
  replaces: number;
  deletes: number;
  renames: number;
  staged_bytes: number;
  high_risk_warnings: string[];
  sandbox_scope: string;
  state: "approval_required" | "committing" | "committed" | "reconcile_required" | "denied";
  resulting_project_revision: number | null;
  reobserve_required: boolean;
};

export function ControlledPatchCard({ patch }: { patch: ControlledPatchProjection }) {
  return (
    <article className="rho-agent-vnext__approval" aria-label="Controlled project patch">
      <header>
        <strong>Sandbox patch {patch.patch_id}</strong>
        <span className="rho-agent-vnext__status">{patch.state.replaceAll("_", " ")}</span>
      </header>
      <dl>
        <div>
          <dt>Base project revision</dt>
          <dd>{patch.base_project_revision}</dd>
        </div>
        <div>
          <dt>Exact changes</dt>
          <dd>
            +{patch.creates} ~{patch.replaces} −{patch.deletes} ↪{patch.renames}
          </dd>
        </div>
        <div>
          <dt>Staged bytes</dt>
          <dd>{patch.staged_bytes}</dd>
        </div>
        <div>
          <dt>Sandbox scope</dt>
          <dd>{patch.sandbox_scope}</dd>
        </div>
      </dl>
      <ul aria-label="Exact patch paths">
        {patch.paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      {patch.high_risk_warnings.map((warning) => (
        <p role="alert" key={warning}>
          High-risk path: {warning}
        </p>
      ))}
      {patch.state === "reconcile_required" ? (
        <p role="status">Partial project outcome requires reconciliation; all-success is not reported.</p>
      ) : null}
      {patch.state === "committed" && patch.reobserve_required ? (
        <p role="status">
          Project revision {patch.resulting_project_revision}; Agent must re-observe before another effect.
        </p>
      ) : null}
    </article>
  );
}
