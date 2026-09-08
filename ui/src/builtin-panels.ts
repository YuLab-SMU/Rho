/** One registry defines every built-in view's identity and placement rules. */
export const builtinPanels = {
  files: { name: "Files", renderer: "files", instances: "single", menu: true, minWidth: 180, preferredGroup: "files-group" },
  editor: { name: "Editor", renderer: "editor", instances: "single", menu: true, minWidth: 240, preferredGroup: "editor-group" },
  console: { name: "Console", renderer: "console", instances: "multiple", menu: true, minWidth: 240, preferredGroup: "console-group" },
  objects: { name: "Objects", renderer: "objects", instances: "single", menu: true, minWidth: 200, preferredGroup: "objects-group" },
  packages: { name: "Packages", renderer: "packages", instances: "single", menu: true, minWidth: 200, preferredGroup: "objects-group" },
  plots: { name: "Plots", renderer: "plots", instances: "multiple", menu: true, minWidth: 200, preferredGroup: "plots-group" },
  document: { name: "Document", renderer: "document", instances: "multiple", menu: false, minWidth: 240, preferredGroup: "editor-group" },
  viewer: { name: "Object Viewer", renderer: "viewer", instances: "multiple", menu: false, minWidth: 200, preferredGroup: "objects-group" },
} as const;

export type BuiltinPanel = keyof typeof builtinPanels;
export type BuiltinRenderer = (typeof builtinPanels)[BuiltinPanel]["renderer"];
export const isBuiltinPanel = (value: string): value is BuiltinPanel =>
  Object.hasOwn(builtinPanels, value);
export const panelNames: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(builtinPanels).filter(([, entry]) => entry.menu).map(([id, entry]) => [id, entry.name])),
);

export interface PanelInstance {
  readonly id: string;
  readonly component: BuiltinPanel;
  readonly name: string;
  readonly config?: unknown;
}
