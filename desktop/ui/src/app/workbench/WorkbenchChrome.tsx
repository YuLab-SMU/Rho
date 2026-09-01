import type { LayoutNode, SurfaceInstance } from "../../transport";
import {
  surfaceDisplayLabel,
  surfaceUxProfile,
} from "../surface-ux";

export function layoutInstanceIds(node: LayoutNode): string[] {
  switch (node.kind) {
    case "surface": return [node.instance_id];
    case "stack": return [...node.instances];
    case "container": return node.children.flatMap((child) => layoutInstanceIds(child.child));
  }
}

export function surfaceRailGlyph(surfaceId: string): string {
  switch (surfaceId) {
    case "rho.navigator": return "N";
    case "rho.file-source": return "R";
    case "rho.file-preview": return "P";
    case "rho.console": return ">_";
    case "rho.runtimes": return "R+";
    case "rho.plots": return "▧";
    case "rho.runs": return "↺";
    case "rho.jobs": return "◷";
    case "rho.artifacts": return "◇";
    case "rho.approvals": return "✓";
    case "rho.revisions": return "#";
    case "rho.claims": return "C";
    case "rho.evidence-graph": return "⌘";
    case "rho.evidence-gaps": return "△";
    case "rho.claim-trace": return "T";
    case "rho.agent": return "✦";
    case "rho.environment": return "◉";
    case "rho.git": return "⑂";
    default: return surfaceDisplayLabel(surfaceId).slice(0, 1).toUpperCase();
  }
}

export function surfaceToolHints(surfaceId: string): readonly string[] {
  switch (surfaceId) {
    case "rho.file-source": return ["Run the current expression from the Source toolbar", "Save or reload from the component header"];
    case "rho.console": return ["Return runs code", "Shift+Return inserts a new line"];
    case "rho.runtimes": return ["Create isolated auxiliary R processes", "Use separate Runtimes for concurrent executions"];
    case "rho.navigator": return ["Switch between Files and History", "Search the current project tree"];
    case "rho.plots": return ["Browse current and historical project plots", "Use exact Plot links from Console or History"];
    case "rho.environment": return ["Inspect Authority health, exact plans, activity, and incidents"];
    default: return [surfaceUxProfile(surfaceId).primaryTask];
  }
}

export function LayoutMiniMap({ node, instances, focusedInstanceId }: {
  readonly node: LayoutNode;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly focusedInstanceId: string | null;
}) {
  if (node.kind === "surface") {
    const instance = instances.get(node.instance_id);
    return <span
      className="rho-layout-mini-surface"
      data-focused={node.instance_id === focusedInstanceId || undefined}
      title={instance == null ? node.instance_id : surfaceDisplayLabel(instance.surface_id)}
    >{instance == null ? "?" : surfaceRailGlyph(instance.surface_id)}</span>;
  }
  if (node.kind === "stack") {
    return <span className="rho-layout-mini-stack">{node.instances.slice(0, 4).map((instanceId) => {
      const instance = instances.get(instanceId);
      return <span data-focused={instanceId === focusedInstanceId || undefined} key={instanceId}>
        {instance == null ? "?" : surfaceRailGlyph(instance.surface_id)}
      </span>;
    })}</span>;
  }
  return <span className={"rho-layout-mini-container rho-layout-mini-" + node.axis}>
    {node.children.map((child) => <LayoutMiniMap
      node={child.child}
      instances={instances}
      focusedInstanceId={focusedInstanceId}
      key={child.child.node_id}
    />)}
  </span>;
}
