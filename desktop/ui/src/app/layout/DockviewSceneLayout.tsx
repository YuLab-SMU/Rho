import {
  DockviewDefaultTab,
  DockviewReact,
  Orientation,
  themeLight,
} from "dockview-react";
import type {
  DockviewApi,
  IDockviewHeaderActionsProps,
  DockviewLayoutMutationEvent,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
  SerializedDockview,
  SerializedGridObject,
} from "dockview-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import type {
  LayoutAxis,
  LayoutBasis,
  LayoutChild,
  LayoutNode,
  SceneEdit,
  StudioRuntimeSnapshot,
  SurfaceInstance,
} from "../../transport";
import { surfaceDisplayLabel } from "../surface-ux";

const PANEL_COMPONENT = "rho-surface";
const PANEL_TAB_COMPONENT = "rho-surface-tab";
const CONSOLE_SURFACE_ID = "rho.console";
const MINIMUM_PANE_EXTENT = 56;

interface DockviewSurfaceParams {
  readonly instanceId: string;
  readonly paneNodeId: string;
  readonly paneMemberCount: number;
}

interface SerializedGroupState {
  readonly id: string;
  readonly views: string[];
  readonly activeView?: string;
  readonly hideHeader?: boolean;
}

type SerializedNode = SerializedGridObject<SerializedGroupState>;

interface DockviewSceneLayoutProps {
  readonly node: LayoutNode;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly studio: StudioRuntimeSnapshot;
  readonly commit: (edit: SceneEdit) => Promise<boolean> | boolean | void;
  readonly allocateLayoutNodeId: () => string;
  readonly surfaceView: (
    instance: SurfaceInstance,
    embedded?: boolean,
    nodeId?: string,
    paneMemberCount?: number,
    gestureOwner?: "rho" | "dockview",
  ) => ReactNode;
}

interface RenderContextValue {
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly surfaceView: DockviewSceneLayoutProps["surfaceView"];
  readonly close: (instanceId: string) => void;
}

const RenderContext = createContext<RenderContextValue | null>(null);

function useRenderContext(): RenderContextValue {
  const value = useContext(RenderContext);
  if (value == null) throw new Error("Dockview Surface rendered outside the Rho Scene adapter.");
  return value;
}

function DockviewSurface({ params, api }: IDockviewPanelProps<DockviewSurfaceParams>) {
  const { instances, surfaceView } = useRenderContext();
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    let disposed = false;
    setVisible(api.isVisible);
    const subscription = api.onDidVisibilityChange(({ isVisible }) => {
      if (isVisible) setVisible(true);
      else queueMicrotask(() => {
        if (!disposed && !api.isVisible) setVisible(false);
      });
    });
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [api]);
  if (!visible) return null;
  const instance = instances.get(params.instanceId);
  return instance == null
    ? <div className="rho-missing-surface">Unavailable Surface {params.instanceId}</div>
    : surfaceView(instance, false, params.paneNodeId, params.paneMemberCount, "dockview");
}

function DockviewSurfaceTab(props: IDockviewPanelHeaderProps<DockviewSurfaceParams>) {
  const { close } = useRenderContext();
  return <DockviewDefaultTab
    {...props}
    data-rho-pane-node-id={props.params.paneNodeId}
    data-rho-tab-instance-id={props.params.instanceId}
    closeActionOverride={() => close(props.params.instanceId)}
  />;
}

function DockviewSurfaceHeaderActions({ activePanel }: IDockviewHeaderActionsProps) {
  if (activePanel == null) return null;
  return <div
    className="rho-dockview-surface-actions-host"
    data-rho-surface-actions-host={activePanel.id}
  />;
}

const dockviewComponents = { [PANEL_COMPONENT]: DockviewSurface };
const dockviewTabComponents = { [PANEL_TAB_COMPONENT]: DockviewSurfaceTab };

function nodeInstanceIds(node: LayoutNode): string[] {
  if (node.kind === "surface") return [node.instance_id];
  if (node.kind === "stack") return [...node.instances];
  return node.children.flatMap(({ child }) => nodeInstanceIds(child));
}

function signature(instanceIds: readonly string[]): string {
  return [...instanceIds].sort().join("\u001f");
}

function nodeSignature(node: LayoutNode): string {
  return signature(nodeInstanceIds(node));
}

function scenePanelTitles(
  node: LayoutNode,
  instances: ReadonlyMap<string, SurfaceInstance>,
): ReadonlyMap<string, string> {
  const instanceIds = nodeInstanceIds(node);
  const consoleCount = instanceIds.filter((instanceId) =>
    instances.get(instanceId)?.surface_id === CONSOLE_SURFACE_ID
  ).length;
  let consoleOrdinal = 0;
  return new Map(instanceIds.map((instanceId) => {
    const instance = instances.get(instanceId);
    if (instance == null) return [instanceId, instanceId] as const;
    const label = surfaceDisplayLabel(instance.surface_id);
    if (instance.surface_id !== CONSOLE_SURFACE_ID || consoleCount < 2) {
      return [instanceId, label] as const;
    }
    consoleOrdinal += 1;
    return [instanceId, `${label} · ${consoleOrdinal}`] as const;
  }));
}

function basisExtent(basis: LayoutBasis): number {
  switch (basis.kind) {
    case "fixed": return Math.max(MINIMUM_PANE_EXTENT, basis.logical_pixels);
    case "intrinsic": return 176;
    case "minmax": return Math.max(
      basis.min_logical_pixels,
      Math.min(basis.max_logical_pixels, basis.weight * 176),
    );
    case "fraction": return Math.max(MINIMUM_PANE_EXTENT, basis.weight * 176);
    case "auto": return 176;
  }
}

function minimumExtent(basis: LayoutBasis): number {
  switch (basis.kind) {
    case "intrinsic": return 48;
    case "fixed": return basis.logical_pixels;
    case "minmax": return basis.min_logical_pixels;
    case "auto":
    case "fraction": return 176;
  }
}

function axisOrientation(axis: LayoutAxis): Orientation {
  return axis === "horizontal" ? Orientation.HORIZONTAL : Orientation.VERTICAL;
}

function oppositeAxis(axis: LayoutAxis): LayoutAxis {
  return axis === "horizontal" ? "vertical" : "horizontal";
}

function paneGroupId(node: Extract<LayoutNode, { kind: "surface" | "stack" }>): string {
  return `rho-pane:${node.node_id}`;
}

function serializePane(
  node: Extract<LayoutNode, { kind: "surface" | "stack" }>,
  instances: ReadonlyMap<string, SurfaceInstance>,
  titles: ReadonlyMap<string, string>,
  panels: SerializedDockview["panels"],
  size?: number,
): SerializedNode {
  const views = node.kind === "surface" ? [node.instance_id] : [...node.instances];
  for (const instanceId of views) {
    const instance = instances.get(instanceId);
    panels[instanceId] = {
      id: instanceId,
      contentComponent: PANEL_COMPONENT,
      tabComponent: PANEL_TAB_COMPONENT,
      title: titles.get(instanceId) ?? (instance == null
        ? instanceId
        : surfaceDisplayLabel(instance.surface_id)),
      renderer: "onlyWhenVisible",
      params: {
        instanceId,
        paneNodeId: node.node_id,
        paneMemberCount: views.length,
      } satisfies DockviewSurfaceParams,
      minimumWidth: MINIMUM_PANE_EXTENT,
      minimumHeight: MINIMUM_PANE_EXTENT,
    };
  }
  return {
    type: "leaf",
    data: {
      id: paneGroupId(node),
      views,
      activeView: node.kind === "stack" ? node.active_instance_id : node.instance_id,
      hideHeader: false,
    },
    ...(size == null ? {} : { size }),
  };
}

function serializeNode(
  node: LayoutNode,
  impliedAxis: LayoutAxis,
  instances: ReadonlyMap<string, SurfaceInstance>,
  titles: ReadonlyMap<string, string>,
  panels: SerializedDockview["panels"],
  size?: number,
): SerializedNode {
  if (node.kind !== "container") return serializePane(node, instances, titles, panels, size);
  const branch: SerializedNode = {
    type: "branch",
    data: node.children.map((child) => serializeNode(
      child.child,
      oppositeAxis(node.axis),
      instances,
      titles,
      panels,
      basisExtent(child.basis),
    )),
    ...(size == null ? {} : { size }),
  };
  if (node.axis === impliedAxis) return branch;
  // Dockview alternates split orientation at each grid depth. A transparent
  // unary branch preserves a legal Rho tree that repeats the parent axis.
  return { type: "branch", data: [branch], ...(size == null ? {} : { size }) };
}

/**
 * Creates Dockview's transient render model from the authoritative Rho Scene.
 * The result is deliberately never returned to a persistence boundary.
 */
export function sceneToDockview(
  node: LayoutNode,
  instances: ReadonlyMap<string, SurfaceInstance>,
  viewport: { readonly width: number; readonly height: number } = { width: 1_200, height: 800 },
): SerializedDockview | null {
  if (nodeInstanceIds(node).length === 0) return null;
  const panels: SerializedDockview["panels"] = {};
  const rootAxis = node.kind === "container" ? node.axis : "horizontal";
  const root = serializeNode(node, rootAxis, instances, scenePanelTitles(node, instances), panels);
  return {
    grid: {
      root,
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height)),
      orientation: axisOrientation(rootAxis),
    },
    panels,
  };
}

interface IndexedChildPolicy {
  readonly parentNodeId: string;
  readonly child: LayoutChild;
  readonly signature: string;
}

class ScenePolicyIndex {
  readonly #nodes = new Map<string, LayoutNode[]>();
  readonly #children = new Map<string, IndexedChildPolicy[]>();
  readonly #claimedNodeIds = new Set<string>();
  readonly #claimedChildren = new Set<LayoutChild>();

  constructor(root: LayoutNode) {
    this.#visit(root);
  }

  #visit(node: LayoutNode): void {
    const key = `${node.kind}:${nodeSignature(node)}`;
    this.#nodes.set(key, [...(this.#nodes.get(key) ?? []), node]);
    if (node.kind !== "container") return;
    for (const child of node.children) {
      const childSignature = nodeSignature(child.child);
      const indexed = { parentNodeId: node.node_id, child, signature: childSignature };
      this.#children.set(childSignature, [...(this.#children.get(childSignature) ?? []), indexed]);
      this.#visit(child.child);
    }
  }

  peekNode(kind: LayoutNode["kind"], instanceSignature: string): LayoutNode | undefined {
    return this.#nodes.get(`${kind}:${instanceSignature}`)?.find(
      (node) => !this.#claimedNodeIds.has(node.node_id),
    );
  }

  claimNode(kind: LayoutNode["kind"], instanceSignature: string): LayoutNode | undefined {
    const node = this.peekNode(kind, instanceSignature);
    if (node != null) this.#claimedNodeIds.add(node.node_id);
    return node;
  }

  claimChild(instanceSignature: string, parentNodeId?: string): LayoutChild | undefined {
    const candidates = this.#children.get(instanceSignature) ?? [];
    const candidate = candidates.find(({ parentNodeId: candidateParent, child }) =>
      !this.#claimedChildren.has(child) && candidateParent === parentNodeId
    ) ?? candidates.find(({ child }) => !this.#claimedChildren.has(child));
    if (candidate != null) this.#claimedChildren.add(candidate.child);
    return candidate?.child;
  }
}

function serializedNodeIds(node: SerializedNode): string[] {
  if (node.type === "leaf") return [...(node.data as SerializedGroupState).views];
  return (node.data as SerializedNode[]).flatMap(serializedNodeIds);
}

function validateDockviewState(serialized: SerializedDockview, authority: LayoutNode): void {
  if ((serialized.floatingGroups?.length ?? 0) > 0 || (serialized.popoutGroups?.length ?? 0) > 0) {
    throw new Error("Rho Scene does not accept floating or popout Dockview groups.");
  }
  const authorityIds = new Set(nodeInstanceIds(authority));
  const renderedIds = serializedNodeIds(serialized.grid.root as SerializedNode);
  const seen = new Set<string>();
  for (const instanceId of renderedIds) {
    if (!authorityIds.has(instanceId)) {
      throw new Error(`Dockview introduced unknown Surface ${instanceId}.`);
    }
    if (seen.has(instanceId)) {
      throw new Error(`Dockview duplicated Surface ${instanceId}.`);
    }
    seen.add(instanceId);
  }
  if (seen.size !== authorityIds.size) {
    throw new Error("Dockview omitted an authoritative Surface placement.");
  }
}

function sizeBasis(size: number | undefined): LayoutBasis {
  return { kind: "fixed", logical_pixels: Math.max(MINIMUM_PANE_EXTENT, Math.round(size ?? 176)) };
}

function orientationAxis(orientation: Orientation): LayoutAxis {
  return orientation === Orientation.HORIZONTAL ? "horizontal" : "vertical";
}

function deserializeNode(
  node: SerializedNode,
  axis: LayoutAxis,
  index: ScenePolicyIndex,
  allocate: () => string,
  mode: "structure" | "resize",
): LayoutNode {
  const ids = serializedNodeIds(node);
  const instanceSignature = signature(ids);
  if (node.type === "leaf") {
    const group = node.data as SerializedGroupState;
    if (group.views.length === 0) throw new Error("Dockview produced an empty pane group.");
    if (group.views.length === 1) {
      const existingStack = index.peekNode("stack", instanceSignature);
      if (existingStack?.kind === "stack") {
        index.claimNode("stack", instanceSignature);
        return {
          kind: "stack",
          node_id: existingStack.node_id,
          instances: [...group.views],
          active_instance_id: group.views[0]!,
        };
      }
      const existing = index.claimNode("surface", instanceSignature);
      return {
        kind: "surface",
        node_id: existing?.node_id ?? allocate(),
        instance_id: group.views[0]!,
      };
    }
    const existing = index.claimNode("stack", instanceSignature);
    return {
      kind: "stack",
      node_id: existing?.node_id ?? allocate(),
      instances: [...group.views],
      active_instance_id: group.activeView != null && group.views.includes(group.activeView)
        ? group.activeView
        : group.views[0]!,
    };
  }

  const children = node.data as SerializedNode[];
  if (children.length === 0) {
    return { kind: "container", node_id: allocate(), axis, children: [] };
  }
  const matchingContainer = index.peekNode("container", instanceSignature);
  if (children.length === 1 && (matchingContainer?.kind !== "container" || matchingContainer.axis !== axis)) {
    // Drop the transparent orientation shim emitted by sceneToDockview.
    return deserializeNode(children[0]!, oppositeAxis(axis), index, allocate, mode);
  }
  const existing = index.claimNode("container", instanceSignature);
  const nodeId = existing?.kind === "container" && existing.axis === axis
    ? existing.node_id
    : allocate();
  return {
    kind: "container",
    node_id: nodeId,
    axis,
    children: children.map((serializedChild) => {
      const childSignature = signature(serializedNodeIds(serializedChild));
      const policy = index.claimChild(childSignature, nodeId);
      return {
        child: deserializeNode(serializedChild, oppositeAxis(axis), index, allocate, mode),
        basis: mode === "resize" ? sizeBasis(serializedChild.size) : policy?.basis ?? { kind: "fraction", weight: 1 },
        resizable: policy?.resizable ?? true,
        collapse_priority: policy?.collapse_priority ?? null,
      };
    }),
  };
}

/** Converts a settled Dockview gesture into a candidate Rho root. */
export function dockviewToScene(
  serialized: SerializedDockview,
  authority: LayoutNode,
  allocate: () => string,
  mode: "structure" | "resize" = "structure",
): LayoutNode {
  validateDockviewState(serialized, authority);
  return deserializeNode(
    serialized.grid.root as SerializedNode,
    orientationAxis(serialized.grid.orientation),
    new ScenePolicyIndex(authority),
    allocate,
    mode,
  );
}

function findStack(node: LayoutNode, instanceId: string): Extract<LayoutNode, { kind: "stack" }> | null {
  if (node.kind === "stack") return node.instances.includes(instanceId) ? node : null;
  if (node.kind === "surface") return null;
  for (const child of node.children) {
    const found = findStack(child.child, instanceId);
    if (found != null) return found;
  }
  return null;
}

function displayLabel(node: LayoutNode, instances: ReadonlyMap<string, SurfaceInstance>): string {
  if (node.kind === "surface") {
    const instance = instances.get(node.instance_id);
    return instance == null ? "component" : surfaceDisplayLabel(instance.surface_id);
  }
  if (node.kind === "stack") {
    const instance = instances.get(node.active_instance_id)
      ?? node.instances.map((instanceId) => instances.get(instanceId)).find((candidate) => candidate != null);
    return instance == null ? "component stack" : surfaceDisplayLabel(instance.surface_id);
  }
  const labels = [...new Set(node.children.map(({ child }) => displayLabel(child, instances)))];
  if (labels.length === 0) return "components";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} + ${labels[1]}`;
  return `${labels[0]} + ${labels.length - 1} more`;
}

interface CollapsedRegion {
  readonly key: string;
  readonly instanceIds: readonly string[];
  readonly label: string;
}

function childAllocations(children: readonly LayoutChild[], extent: number): number[] {
  const desired = children.map(({ basis }) => basisExtent(basis));
  const total = desired.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return desired;
  const scale = extent / total;
  return desired.map((value) => Math.max(MINIMUM_PANE_EXTENT, value * scale));
}

/** Computes Rho's view-only adaptive collapse without changing Scene truth. */
export function adaptiveCollapsedRegions(
  node: LayoutNode,
  instances: ReadonlyMap<string, SurfaceInstance>,
  viewport: { readonly width: number; readonly height: number },
  forcedOpen: ReadonlySet<string> = new Set(),
): readonly CollapsedRegion[] {
  const output: CollapsedRegion[] = [];
  const visit = (current: LayoutNode, width: number, height: number): void => {
    if (current.kind !== "container") return;
    const extent = current.axis === "horizontal" ? width : height;
    const candidates = current.children
      .map((child, childIndex) => ({ child, childIndex }))
      .filter(({ child }) => child.collapse_priority != null)
      .sort((left, right) =>
        (left.child.collapse_priority ?? 65_535) - (right.child.collapse_priority ?? 65_535)
      );
    let desired = current.children.reduce((sum, child) => sum + minimumExtent(child.basis), 0);
    const collapsed = new Set<number>();
    for (const { child, childIndex } of candidates) {
      const key = `${current.node_id}:${child.child.node_id}`;
      if (forcedOpen.has(key) || desired <= extent) continue;
      collapsed.add(childIndex);
      desired -= minimumExtent(child.basis);
      output.push({
        key,
        instanceIds: nodeInstanceIds(child.child),
        label: displayLabel(child.child, instances),
      });
    }
    const allocations = childAllocations(current.children, extent);
    current.children.forEach((child, childIndex) => {
      if (collapsed.has(childIndex)) return;
      const childWidth = current.axis === "horizontal" ? allocations[childIndex]! : width;
      const childHeight = current.axis === "vertical" ? allocations[childIndex]! : height;
      visit(child.child, childWidth, childHeight);
    });
  };
  visit(node, viewport.width, viewport.height);
  return output;
}

function serializedBranches(root: SerializedNode): SerializedNode[] {
  if (root.type === "leaf") return [];
  const children = root.data as SerializedNode[];
  return [
    ...(children.length > 1 ? [root] : []),
    ...children.flatMap(serializedBranches),
  ];
}

/** Applies one accessible keyboard step to a Dockview sash model. */
export function resizeDockviewBoundary(
  serialized: SerializedDockview,
  branchIndex: number,
  boundaryIndex: number,
  delta: number,
): SerializedDockview | null {
  const clone = structuredClone(serialized);
  const branch = serializedBranches(clone.grid.root as SerializedNode)[branchIndex];
  if (branch?.type !== "branch") return null;
  const children = branch.data as SerializedNode[];
  const before = children[boundaryIndex];
  const after = children[boundaryIndex + 1];
  if (before == null || after == null) return null;
  const beforeSize = Math.max(MINIMUM_PANE_EXTENT, before.size ?? 176);
  const afterSize = Math.max(MINIMUM_PANE_EXTENT, after.size ?? 176);
  const applied = Math.max(-beforeSize + MINIMUM_PANE_EXTENT, Math.min(afterSize - MINIMUM_PANE_EXTENT, delta));
  if (applied === 0) return null;
  before.size = beforeSize + applied;
  after.size = afterSize - applied;
  return clone;
}

function decorateSashes(element: HTMLElement): void {
  const splits = [...element.querySelectorAll<HTMLElement>(".dv-split-view-container")].filter(
    (split) => split.querySelector(":scope > .dv-sash-container > .dv-sash") != null,
  );
  splits.forEach((split, branchIndex) => {
    const horizontal = split.classList.contains("dv-horizontal");
    split.querySelectorAll<HTMLElement>(":scope > .dv-sash-container > .dv-sash")
      .forEach((sash, boundaryIndex) => {
        sash.tabIndex = 0;
        sash.setAttribute("role", "separator");
        sash.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
        sash.setAttribute("aria-valuemin", String(MINIMUM_PANE_EXTENT));
        sash.setAttribute("aria-label", `Resize boundary ${boundaryIndex + 1}`);
        sash.dataset.rhoDockviewBranch = String(branchIndex);
        sash.dataset.rhoDockviewBoundary = String(boundaryIndex);
      });
  });
}

function pointerSash(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(".dv-sash") : null;
}

function sceneResizeBoundary(
  root: LayoutNode,
  branchIndex: number,
  boundaryIndex: number,
  delta: number,
): SceneEdit | null {
  const containers: Array<Extract<LayoutNode, { kind: "container" }>> = [];
  const visit = (node: LayoutNode) => {
    if (node.kind !== "container") return;
    if (node.children.length > 1) containers.push(node);
    node.children.forEach(({ child }) => visit(child));
  };
  visit(root);
  const container = containers[branchIndex];
  const before = container?.children[boundaryIndex];
  const after = container?.children[boundaryIndex + 1];
  if (container == null || before == null || after == null || !before.resizable || !after.resizable) {
    return null;
  }
  const beforeSize = basisExtent(before.basis);
  const afterSize = basisExtent(after.basis);
  const applied = Math.max(-beforeSize + MINIMUM_PANE_EXTENT, Math.min(afterSize - MINIMUM_PANE_EXTENT, delta));
  if (applied === 0) return null;
  return {
    kind: "resize_boundary",
    container_node_id: container.node_id,
    before_child_index: boundaryIndex,
    before_basis: sizeBasis(beforeSize + applied),
    after_basis: sizeBasis(afterSize - applied),
  };
}

export function DockviewSceneLayout(props: DockviewSceneLayoutProps) {
  const { commit, instances, studio, surfaceView } = props;
  const authorityKey = useMemo(() => JSON.stringify(props.node), [props.node]);
  const hostRef = useRef<HTMLElement>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const subscriptionsRef = useRef<Array<{ dispose(): void }>>([]);
  const latestRef = useRef(props);
  latestRef.current = props;
  const syncingRef = useRef(false);
  const resizeGestureRef = useRef<HTMLElement | null>(null);
  const measuredViewportRef = useRef<{ readonly width: number; readonly height: number } | null>(null);
  const [forcedOpen, setForcedOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<readonly CollapsedRegion[]>([]);
  const forcedOpenRef = useRef(forcedOpen);
  forcedOpenRef.current = forcedOpen;

  const viewport = useCallback(() => {
    if (measuredViewportRef.current != null) return measuredViewportRef.current;
    const rect = hostRef.current?.getBoundingClientRect();
    return {
      width: rect != null && rect.width > 0 ? rect.width : 3_000,
      height: rect != null && rect.height > 0 ? rect.height : 2_000,
    };
  }, []);

  const refreshAdaptiveCollapse = useCallback(() => {
    const api = apiRef.current;
    const current = latestRef.current;
    if (api == null) return;
    const regions = adaptiveCollapsedRegions(
      current.node,
      current.instances,
      viewport(),
      forcedOpenRef.current,
    );
    const hiddenIds = new Set(regions.flatMap(({ instanceIds }) => instanceIds));
    syncingRef.current = true;
    try {
      for (const group of api.groups) {
        const visible = group.panels.some((panel) => !hiddenIds.has(panel.id));
        if (group.api.isVisible !== visible) group.api.setVisible(visible);
      }
    } finally {
      syncingRef.current = false;
    }
    setCollapsed(regions);
  }, [viewport]);

  const loadAuthority = useCallback(() => {
    const api = apiRef.current;
    const current = latestRef.current;
    if (api == null) return;
    const serialized = sceneToDockview(current.node, current.instances, viewport());
    syncingRef.current = true;
    try {
      if (serialized == null) api.clear();
      else api.fromJSON(serialized, { reuseExistingPanels: true });
    } finally {
      syncingRef.current = false;
    }
    if (hostRef.current != null) decorateSashes(hostRef.current);
    refreshAdaptiveCollapse();
  }, [refreshAdaptiveCollapse, viewport]);

  const commitSerialized = useCallback((
    serialized: SerializedDockview,
    mode: "structure" | "resize",
  ) => {
    const current = latestRef.current;
    let root: LayoutNode;
    try {
      root = dockviewToScene(serialized, current.node, current.allocateLayoutNodeId, mode);
    } catch {
      loadAuthority();
      return;
    }
    void Promise.resolve(current.commit({ kind: "replace_root", root })).then((accepted) => {
      if (accepted === false) loadAuthority();
    });
  }, [loadAuthority]);

  const replaceFromDockview = useCallback((mode: "structure" | "resize") => {
    const api = apiRef.current;
    if (api == null || syncingRef.current) return;
    commitSerialized(api.toJSON(), mode);
  }, [commitSerialized]);

  const onStructuralMutation = useCallback((event: DockviewLayoutMutationEvent) => {
    if (event.origin === "user") replaceFromDockview("structure");
  }, [replaceFromDockview]);

  const onReady = useCallback(({ api }: { api: DockviewApi }) => {
    subscriptionsRef.current.splice(0).forEach((subscription) => subscription.dispose());
    apiRef.current = api;
    subscriptionsRef.current = [
      api.onDidMutateLayout(onStructuralMutation),
      api.onDidActivePanelChange((event) => {
        if (event.origin !== "user" || event.panel == null) return;
        const current = latestRef.current;
        const stack = findStack(current.node, event.panel.id);
        if (stack == null || stack.active_instance_id === event.panel.id) return;
        void current.commit({
          kind: "set_stack_active",
          stack_node_id: stack.node_id,
          instance_id: event.panel.id,
        });
      }),
      api.onDidLayoutChange(() => {
        if (hostRef.current != null) decorateSashes(hostRef.current);
      }),
    ];
    loadAuthority();
  }, [loadAuthority, onStructuralMutation]);

  useEffect(() => () => {
    subscriptionsRef.current.splice(0).forEach((subscription) => subscription.dispose());
    apiRef.current = null;
  }, []);

  useEffect(() => {
    loadAuthority();
  }, [authorityKey, loadAuthority, studio.project_id]);

  useEffect(() => {
    const host = hostRef.current;
    if (host == null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        measuredViewportRef.current = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        };
      }
      refreshAdaptiveCollapse();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [refreshAdaptiveCollapse]);

  useEffect(() => refreshAdaptiveCollapse(), [forcedOpen, refreshAdaptiveCollapse]);

  const renderContext = useMemo<RenderContextValue>(() => ({
    instances,
    surfaceView,
    close: (instanceId) => { void commit({ kind: "close_surface_placement", instance_id: instanceId }); },
  }), [commit, instances, surfaceView]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const sash = pointerSash(event.target);
    if (sash == null) return;
    const horizontal = sash.getAttribute("aria-orientation") === "vertical";
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === "Home" ? -Number.MAX_SAFE_INTEGER
      : event.key === "End" ? Number.MAX_SAFE_INTEGER
      : event.key === "PageUp" ? -64
      : event.key === "PageDown" ? 64
      : horizontal
        ? event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0
        : event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (delta === 0) return;
    event.preventDefault();
    const api = apiRef.current;
    const branchIndex = Number(sash.dataset.rhoDockviewBranch);
    const boundaryIndex = Number(sash.dataset.rhoDockviewBoundary);
    if (api == null || !Number.isInteger(branchIndex) || !Number.isInteger(boundaryIndex)) return;
    const edit = sceneResizeBoundary(latestRef.current.node, branchIndex, boundaryIndex, delta);
    if (edit != null) void latestRef.current.commit(edit);
  };

  return (
    <RenderContext.Provider value={renderContext}>
      <section
        ref={hostRef}
        className="rho-dockview-scene"
        data-layout-revision={studio.scene.layout_revision}
        onPointerDownCapture={(event) => { resizeGestureRef.current = pointerSash(event.target); }}
        onPointerUpCapture={(event) => {
          if (resizeGestureRef.current == null) return;
          resizeGestureRef.current = null;
          if (pointerSash(event.target) != null) replaceFromDockview("resize");
        }}
        onPointerCancelCapture={() => { resizeGestureRef.current = null; }}
        onKeyDownCapture={onKeyDown}
      >
        <DockviewReact
          components={dockviewComponents}
          tabComponents={dockviewTabComponents}
          defaultTabComponent={DockviewSurfaceTab}
          rightHeaderActionsComponent={DockviewSurfaceHeaderActions}
          theme={themeLight}
          disableAutoResizing={typeof ResizeObserver === "undefined"}
          disableFloatingGroups
          dndStrategy="pointer"
          onReady={onReady}
        />
        {collapsed.length > 0 && (
          <nav className="rho-collapse-rail" aria-label="Hidden components">
            {collapsed.map((region) => (
              <button
                type="button"
                className="rho-collapse-restore"
                aria-label={`Show collapsed ${region.label}`}
                title={`Show ${region.label}`}
                key={region.key}
                onClick={() => setForcedOpen((current) => new Set([...current, region.key]))}
              ><span aria-hidden="true">＋</span><span>Show {region.label}</span></button>
            ))}
          </nav>
        )}
      </section>
    </RenderContext.Provider>
  );
}
