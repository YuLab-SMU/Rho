export const TOOLBAR_COMPONENT_IDS = [
  "project_context",
  "scene_selector",
  "command_search",
  "project_action",
  "runtime_status",
  "compose",
] as const;

export type ToolbarComponentId = (typeof TOOLBAR_COMPONENT_IDS)[number];

export interface ToolbarLayout {
  readonly version: 1;
  readonly order: readonly ToolbarComponentId[];
  readonly visible: readonly ToolbarComponentId[];
}

export type ToolbarPreferenceStatus = "default" | "clean" | "recovered" | "unavailable";

export interface ToolbarPreferenceLoad {
  readonly layout: ToolbarLayout;
  readonly status: ToolbarPreferenceStatus;
  readonly detail: string | null;
}

type ToolbarStorage = Pick<Storage, "getItem" | "setItem">;

const TOOLBAR_STORAGE_PREFIX = "rho.shell.toolbar.v1:";
const MAX_TOOLBAR_PREFERENCE_BYTES = 2_048;
const COMPONENT_IDS = new Set<string>(TOOLBAR_COMPONENT_IDS);

export function defaultToolbarLayout(): ToolbarLayout {
  return {
    version: 1,
    order: [...TOOLBAR_COMPONENT_IDS],
    visible: [],
  };
}

export function toolbarStorageKey(projectId: string): string {
  return `${TOOLBAR_STORAGE_PREFIX}${encodeURIComponent(projectId)}`;
}

function parseComponentList(value: unknown, exact: boolean): ToolbarComponentId[] | null {
  if (!Array.isArray(value) || (exact && value.length !== TOOLBAR_COMPONENT_IDS.length)) {
    return null;
  }
  const result: ToolbarComponentId[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !COMPONENT_IDS.has(item) || seen.has(item)) return null;
    seen.add(item);
    result.push(item as ToolbarComponentId);
  }
  if (exact && COMPONENT_IDS.size !== seen.size) return null;
  return result;
}

export function normalizeToolbarLayout(value: unknown): ToolbarLayout | null {
  if (typeof value !== "object" || value == null) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.version !== 1) return null;
  const order = parseComponentList(candidate.order, true);
  const visible = parseComponentList(candidate.visible, false);
  if (order == null || visible == null) return null;
  return { version: 1, order, visible };
}

export function loadToolbarLayout(
  storage: ToolbarStorage,
  projectId: string,
): ToolbarPreferenceLoad {
  let encoded: string | null;
  try {
    encoded = storage.getItem(toolbarStorageKey(projectId));
  } catch {
    return {
      layout: defaultToolbarLayout(),
      status: "unavailable",
      detail: "Toolbar settings could not be read; using the session default.",
    };
  }
  if (encoded == null) {
    return { layout: defaultToolbarLayout(), status: "default", detail: null };
  }
  if (encoded.length > MAX_TOOLBAR_PREFERENCE_BYTES) {
    return {
      layout: defaultToolbarLayout(),
      status: "recovered",
      detail: "Oversized toolbar settings were ignored and reset for this session.",
    };
  }
  try {
    const layout = normalizeToolbarLayout(JSON.parse(encoded));
    if (layout == null) throw new Error("invalid toolbar preference shape");
    return { layout, status: "clean", detail: null };
  } catch {
    return {
      layout: defaultToolbarLayout(),
      status: "recovered",
      detail: "Invalid toolbar settings were ignored and reset for this session.",
    };
  }
}

export function saveToolbarLayout(
  storage: ToolbarStorage,
  projectId: string,
  layout: ToolbarLayout,
): void {
  const normalized = normalizeToolbarLayout(layout);
  if (normalized == null) throw new Error("Toolbar settings are invalid.");
  const encoded = JSON.stringify(normalized);
  if (encoded.length > MAX_TOOLBAR_PREFERENCE_BYTES) {
    throw new Error("Toolbar settings exceed the storage budget.");
  }
  storage.setItem(toolbarStorageKey(projectId), encoded);
}

export function setToolbarComponentVisible(
  layout: ToolbarLayout,
  componentId: ToolbarComponentId,
  visible: boolean,
): ToolbarLayout {
  const current = new Set(layout.visible);
  if (visible) current.add(componentId);
  else current.delete(componentId);
  return {
    ...layout,
    visible: layout.order.filter((candidate) => current.has(candidate)),
  };
}

export function reorderToolbarComponent(
  layout: ToolbarLayout,
  sourceId: ToolbarComponentId,
  targetId: ToolbarComponentId,
  edge: "before" | "after" = "before",
): ToolbarLayout {
  if (sourceId === targetId) return layout;
  const order = layout.order.filter((candidate) => candidate !== sourceId);
  const targetIndex = order.indexOf(targetId);
  if (targetIndex < 0) return layout;
  order.splice(targetIndex + (edge === "after" ? 1 : 0), 0, sourceId);
  if (order.every((candidate, index) => candidate === layout.order[index])) return layout;
  return { ...layout, order };
}
