import type { ReactNode } from "react";
import { builtinPanels } from "./builtin-panels";
import type { BuiltinRenderer, PanelInstance } from "./builtin-panels";
import { DocumentPanel, EditorHub } from "./panels/editor-panel";
import { FilesPanel, ObjectsPanel, ObjectViewer } from "./panels/resource-panels";
import { PackagesPanel } from "./panels/packages-panel";
import { ConsolePanel } from "./panels/console-panel";
import { PlotPanel } from "./panels/plot-panel";
import { AgentArea } from "./panels/component-agent-panel";
import type { ComponentAgentProfile } from "./generated/ComponentAgentProfile";
import { withRuntimeView } from "./context";

const renderers: Record<BuiltinRenderer, (view: PanelInstance) => ReactNode> = {
  files: () => <FilesPanel />,
  editor: () => <EditorHub />,
  console: (view) => <ConsolePanel viewId={view.id} />,
  objects: () => <ObjectsPanel />,
  packages: () => <PackagesPanel />,
  plots: (view) => <PlotPanel viewId={view.id} />,
  agent: (view) => <AgentArea viewId={view.id} />,
  document: (view) => <DocumentPanel documentId={view.id} />,
  viewer: (view) => <ObjectViewer name={String((view.config as { name?: string } | undefined)?.name ?? "")} viewId={view.id} path={(view.config as { path?: import("./generated/ObjectPathElement").ObjectPathElement[] } | undefined)?.path} />,
};

export const componentProfile = (component: string): ComponentAgentProfile | undefined => ({ objects: "objects", viewer: "objects", packages: "packages", plots: "plots", document: "documents", editor: "documents", console: "workspace", files: "project" } as Partial<Record<string, ComponentAgentProfile>>)[component];
export function renderBuiltinPanel(view: PanelInstance): ReactNode {
  return withRuntimeView(view.id, renderers[builtinPanels[view.component].renderer](view));
}
