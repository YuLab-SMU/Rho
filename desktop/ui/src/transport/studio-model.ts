import type {
  LayoutBasis,
  LayoutChild,
  LayoutNode,
  SceneEdit,
  SceneState,
  StudioRuntimeSnapshot,
} from "./types";

type MutableChild = {
  child: MutableNode;
  basis: LayoutBasis;
  resizable: boolean;
  collapse_priority: number | null;
};

type MutableStack = {
  node_id: string;
  active_instance_id: string;
  instances: string[];
};

type MutableNode =
  | { kind: "container"; node_id: string; axis: "horizontal" | "vertical"; children: MutableChild[] }
  | ({ kind: "stack" } & MutableStack)
  | { kind: "surface"; node_id: string; instance_id: string };

type MutableScene = {
  scene_id: string;
  project_id: string;
  label: string;
  layout_revision: number;
  root: MutableNode;
  focused_surface_instance_id: string | null;
  utility_tray: MutableStack | null;
};

function fail(message: string): never {
  throw new Error(`Mock Studio ${message}`);
}

function findNode(node: MutableNode, nodeId: string): MutableNode | undefined {
  if (node.node_id === nodeId) return node;
  if (node.kind !== "container") return undefined;
  for (const child of node.children) {
    const found = findNode(child.child, nodeId);
    if (found != null) return found;
  }
  return undefined;
}

function collectNode(node: LayoutNode, output: Set<string>): void {
  if (node.kind === "surface") output.add(node.instance_id);
  else if (node.kind === "stack") for (const id of node.instances) output.add(id);
  else for (const child of node.children) collectNode(child.child, output);
}

export function collectSceneInstances(scene: SceneState): Set<string> {
  const output = new Set<string>();
  collectNode(scene.root, output);
  if (scene.utility_tray != null) {
    for (const id of scene.utility_tray.instances) output.add(id);
  }
  return output;
}

function extractFromNode(node: MutableNode, instanceId: string): "missing" | "keep" | "remove" {
  if (node.kind === "surface") return node.instance_id === instanceId ? "remove" : "missing";
  if (node.kind === "stack") {
    const index = node.instances.indexOf(instanceId);
    if (index < 0) return "missing";
    node.instances.splice(index, 1);
    if (node.instances.length === 0) return "remove";
    if (node.active_instance_id === instanceId) {
      node.active_instance_id = node.instances[Math.min(index, node.instances.length - 1)]!;
    }
    return "keep";
  }
  for (let index = 0; index < node.children.length; index += 1) {
    const result = extractFromNode(node.children[index]!.child, instanceId);
    if (result === "remove") node.children.splice(index, 1);
    if (result !== "missing") return "keep";
  }
  return "missing";
}

function extract(scene: MutableScene, instanceId: string, allocate: () => string): void {
  const result = extractFromNode(scene.root, instanceId);
  if (result === "remove") {
    scene.root = { kind: "container", node_id: allocate(), axis: "horizontal", children: [] };
    return;
  }
  if (result === "keep") return;
  const trayIndex = scene.utility_tray?.instances.indexOf(instanceId) ?? -1;
  if (trayIndex < 0 || scene.utility_tray == null) fail(`instance ${instanceId} is missing.`);
  scene.utility_tray.instances.splice(trayIndex, 1);
  if (scene.utility_tray.instances.length === 0) scene.utility_tray = null;
  else if (scene.utility_tray.active_instance_id === instanceId) {
    scene.utility_tray.active_instance_id =
      scene.utility_tray.instances[Math.min(trayIndex, scene.utility_tray.instances.length - 1)]!;
  }
}

function insert(
  scene: MutableScene,
  containerId: string,
  childIndex: number,
  instanceId: string,
  basis: LayoutBasis,
  allocate: () => string,
): void {
  const target = findNode(scene.root, containerId);
  if (target?.kind !== "container") fail(`container ${containerId} is missing.`);
  if (childIndex < 0 || childIndex > target.children.length) fail(`child index ${childIndex} is invalid.`);
  target.children.splice(childIndex, 0, {
    child: { kind: "surface", node_id: allocate(), instance_id: instanceId },
    basis,
    resizable: true,
    collapse_priority: null,
  });
}

function stackOnto(
  node: MutableNode,
  instanceId: string,
  targetId: string,
  allocate: () => string,
  position: "append" | "before" | "after" = "append",
): boolean {
  if (node.kind === "container") {
    for (const child of node.children) {
      if (stackOnto(child.child, instanceId, targetId, allocate, position)) return true;
    }
  } else if (node.kind === "stack" && node.instances.includes(targetId)) {
    const targetIndex = node.instances.indexOf(targetId);
    const insertionIndex = position === "before"
      ? targetIndex
      : position === "after"
        ? targetIndex + 1
        : node.instances.length;
    node.instances.splice(insertionIndex, 0, instanceId);
    node.active_instance_id = instanceId;
    return true;
  } else if (node.kind === "surface" && node.instance_id === targetId) {
    const stack: MutableNode = {
      kind: "stack",
      node_id: allocate(),
      active_instance_id: instanceId,
      instances: position === "before" ? [instanceId, targetId] : [targetId, instanceId],
    };
    Object.assign(node, stack);
    for (const key of Object.keys(node)) {
      if (!(key in stack)) delete (node as unknown as Record<string, unknown>)[key];
    }
    return true;
  }
  return false;
}

function normalize(node: MutableNode, allocate: () => string): void {
  if (node.kind === "container") {
    for (const child of node.children) normalize(child.child, allocate);
    node.children = node.children.filter(
      (child) => child.child.kind !== "container" || child.child.children.length > 0,
    );
  } else if (node.kind === "stack" && node.instances.length === 1) {
    const surface: MutableNode = {
      kind: "surface",
      node_id: allocate(),
      instance_id: node.instances[0]!,
    };
    Object.assign(node, surface);
    for (const key of Object.keys(node)) {
      if (!(key in surface)) delete (node as unknown as Record<string, unknown>)[key];
    }
  }
}

function prune(node: MutableNode, allowed: Set<string>): boolean {
  if (node.kind === "surface") return allowed.has(node.instance_id);
  if (node.kind === "stack") {
    node.instances = node.instances.filter((id) => allowed.has(id));
    if (node.instances.length === 0) return false;
    if (!node.instances.includes(node.active_instance_id)) node.active_instance_id = node.instances[0]!;
    return true;
  }
  node.children = node.children.filter((child) => prune(child.child, allowed));
  return true;
}

function checkScene(scene: SceneState): void {
  const ids = collectSceneInstances(scene);
  if (scene.focused_surface_instance_id != null && !ids.has(scene.focused_surface_instance_id)) {
    fail(`focus ${scene.focused_surface_instance_id} is missing.`);
  }
  let placements = 0;
  const seenNodes = new Set<string>();
  const seenInstances = new Set<string>();
  const visit = (node: LayoutNode): void => {
    if (seenNodes.has(node.node_id)) fail(`node ${node.node_id} is duplicated.`);
    seenNodes.add(node.node_id);
    if (node.kind === "container") for (const child of node.children) visit(child.child);
    else {
      const values = node.kind === "surface" ? [node.instance_id] : node.instances;
      for (const id of values) {
        placements += 1;
        if (seenInstances.has(id)) fail(`instance ${id} is duplicated.`);
        seenInstances.add(id);
      }
    }
  };
  visit(scene.root);
  if (placements > 128) fail("placement budget exceeded.");
}

export function applySceneEdit(
  sceneInput: SceneState,
  edit: SceneEdit,
  allocate: () => string,
): SceneState {
  const scene = structuredClone(sceneInput) as MutableScene;
  const placed = collectSceneInstances(sceneInput);
  switch (edit.kind) {
    case "insert_surface":
      if (placed.has(edit.instance_id)) fail(`instance ${edit.instance_id} is already placed.`);
      insert(scene, edit.target_container_node_id, edit.child_index, edit.instance_id, edit.basis, allocate);
      break;
    case "move_surface":
      extract(scene, edit.instance_id, allocate);
      insert(scene, edit.target_container_node_id, edit.child_index, edit.instance_id, edit.basis, allocate);
      break;
    case "stack_surface": {
      if (edit.instance_id === edit.target_instance_id) fail("a Surface cannot stack onto itself.");
      extract(scene, edit.instance_id, allocate);
      const inRoot = stackOnto(scene.root, edit.instance_id, edit.target_instance_id, allocate);
      const inTray = scene.utility_tray?.instances.includes(edit.target_instance_id) ?? false;
      if (inTray && scene.utility_tray != null) {
        scene.utility_tray.instances.push(edit.instance_id);
        scene.utility_tray.active_instance_id = edit.instance_id;
      } else if (!inRoot) fail(`target instance ${edit.target_instance_id} is missing.`);
      break;
    }
    case "unstack_surface": {
      const nodeStacked = (node: LayoutNode): boolean =>
        node.kind === "stack"
          ? node.instances.includes(edit.instance_id)
          : node.kind === "container" && node.children.some((child) => nodeStacked(child.child));
      if (!nodeStacked(scene.root) && !(scene.utility_tray?.instances.includes(edit.instance_id) ?? false)) {
        fail(`instance ${edit.instance_id} is not stacked.`);
      }
      extract(scene, edit.instance_id, allocate);
      insert(scene, edit.target_container_node_id, edit.child_index, edit.instance_id, edit.basis, allocate);
      break;
    }
    case "close_surface_placement":
      extract(scene, edit.instance_id, allocate);
      if (scene.focused_surface_instance_id === edit.instance_id) scene.focused_surface_instance_id = null;
      break;
    case "resize_boundary": {
      const container = findNode(scene.root, edit.container_node_id);
      if (container?.kind !== "container") fail(`container ${edit.container_node_id} is missing.`);
      const before = container.children[edit.before_child_index];
      const after = container.children[edit.before_child_index + 1];
      if (before == null || after == null || !before.resizable || !after.resizable) {
        fail("boundary must separate two resizable children.");
      }
      before.basis = edit.before_basis;
      after.basis = edit.after_basis;
      break;
    }
    case "set_child_basis":
    case "set_collapse_priority": {
      const container = findNode(scene.root, edit.container_node_id);
      if (container?.kind !== "container") fail(`container ${edit.container_node_id} is missing.`);
      const child = container.children[edit.child_index];
      if (child == null) fail(`child index ${edit.child_index} is invalid.`);
      if (edit.kind === "set_child_basis") child.basis = edit.basis;
      else child.collapse_priority = edit.collapse_priority;
      break;
    }
    case "set_container_axis": {
      const container = findNode(scene.root, edit.container_node_id);
      if (container?.kind !== "container") fail(`container ${edit.container_node_id} is missing.`);
      container.axis = edit.axis;
      break;
    }
    case "set_stack_active": {
      const node = findNode(scene.root, edit.stack_node_id);
      const stack = node?.kind === "stack" ? node : scene.utility_tray?.node_id === edit.stack_node_id ? scene.utility_tray : null;
      if (stack == null || !stack.instances.includes(edit.instance_id)) fail("active Stack instance is missing.");
      stack.active_instance_id = edit.instance_id;
      break;
    }
    case "set_focus": scene.focused_surface_instance_id = edit.instance_id; break;
    case "normalize": normalize(scene.root, allocate); break;
    case "distribute_container": {
      const container = findNode(scene.root, edit.container_node_id);
      if (container?.kind !== "container") fail(`container ${edit.container_node_id} is missing.`);
      for (const child of container.children) {
        if (child.resizable) child.basis = { kind: "fraction", weight: 1 };
      }
      break;
    }
    case "replace_root": scene.root = structuredClone(edit.root) as MutableNode; break;
  }
  scene.layout_revision += 1;
  checkScene(scene);
  return scene;
}

export type StudioDropZone =
  | "center"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "tab-before"
  | "tab-after";

export interface StudioDropTarget {
  /** The pane node (surface or stack) that received the drop. */
  readonly nodeId: string;
  /** Representative instance of the pane (active tab for stacks). */
  readonly instanceId: string;
  readonly zone: StudioDropZone;
}

export interface StudioInstancePlacement {
  readonly nodeId: string;
  readonly kind: "surface" | "stack" | "utility";
  readonly active: boolean;
}

function findInstancePlacement(node: LayoutNode, instanceId: string): StudioInstancePlacement | null {
  if (node.kind === "surface") {
    return node.instance_id === instanceId
      ? { nodeId: node.node_id, kind: "surface", active: true }
      : null;
  }
  if (node.kind === "stack") {
    return node.instances.includes(instanceId)
      ? {
          nodeId: node.node_id,
          kind: "stack",
          active: node.active_instance_id === instanceId,
        }
      : null;
  }
  for (const child of node.children) {
    const found = findInstancePlacement(child.child, instanceId);
    if (found != null) return found;
  }
  return null;
}

export function findStudioInstancePlacement(
  scene: SceneState,
  instanceId: string,
): StudioInstancePlacement | null {
  const root = findInstancePlacement(scene.root, instanceId);
  if (root != null) return root;
  if (scene.utility_tray?.instances.includes(instanceId) === true) {
    return {
      nodeId: scene.utility_tray.node_id,
      kind: "utility",
      active: scene.utility_tray.active_instance_id === instanceId,
    };
  }
  return null;
}

function findParentChild(
  node: MutableNode,
  nodeId: string,
): { container: Extract<MutableNode, { kind: "container" }>; index: number } | null {
  if (node.kind !== "container") return null;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]!;
    if (child.child.node_id === nodeId) {
      return { container: node as Extract<MutableNode, { kind: "container" }>, index };
    }
    const found = findParentChild(child.child, nodeId);
    if (found != null) return found;
  }
  return null;
}

/**
 * Computes the Scene after a pointer drag-and-drop. Center stacks onto the
 * target pane; edges split toward that edge, inserting into the parent
 * container when its axis matches or wrapping the target in a new split
 * otherwise. Returns null for no-ops and invalid targets. The result is
 * intended for one atomic `replace_root` edit.
 */
export function computeStudioDrop(
  sceneInput: SceneState,
  dragInstanceId: string,
  target: StudioDropTarget,
  allocate: () => string,
): SceneState | null {
  if (!collectSceneInstances(sceneInput).has(dragInstanceId)) return null;
  const scene = structuredClone(sceneInput) as MutableScene;
  const targetNode = findNode(scene.root, target.nodeId);
  const targetContainsInstance = targetNode?.kind === "surface"
    ? targetNode.instance_id === target.instanceId
    : targetNode?.kind === "stack"
      ? targetNode.instances.includes(target.instanceId)
      : false;
  if (!targetContainsInstance) return null;
  const tabDrop = target.zone === "tab-before" || target.zone === "tab-after";
  if (tabDrop && targetNode?.kind !== "stack") return null;
  if (dragInstanceId === target.instanceId && (target.zone === "center" || tabDrop)) return null;
  if (dragInstanceId === target.instanceId && targetNode?.kind === "surface") return null;
  if (tabDrop && targetNode?.kind === "stack" && targetNode.instances.includes(dragInstanceId)) {
    const sourceIndex = targetNode.instances.indexOf(dragInstanceId);
    const targetIndex = targetNode.instances.indexOf(target.instanceId);
    if (
      (target.zone === "tab-before" && sourceIndex === targetIndex - 1) ||
      (target.zone === "tab-after" && sourceIndex === targetIndex + 1)
    ) return null;
  }
  const rootBefore = JSON.stringify(scene.root);
  if (target.zone === "center" || tabDrop) {
    extract(scene, dragInstanceId, allocate);
    const position = target.zone === "tab-before"
      ? "before"
      : target.zone === "tab-after"
        ? "after"
        : "append";
    if (!stackOnto(scene.root, dragInstanceId, target.instanceId, allocate, position)) return null;
    normalize(scene.root, allocate);
    checkScene(scene);
    if (JSON.stringify(scene.root) === rootBefore) return null;
    return scene;
  }
  const axis: "horizontal" | "vertical" = target.zone === "left" || target.zone === "right"
    ? "horizontal"
    : "vertical";
  const before = target.zone === "left" || target.zone === "top";
  const dragChild: MutableChild = {
    child: { kind: "surface", node_id: allocate(), instance_id: dragInstanceId },
    basis: { kind: "fraction", weight: 1 },
    resizable: true,
    collapse_priority: null,
  };
  const anchor = findParentChild(scene.root, target.nodeId);
  if (anchor == null) {
    // The target pane is the root itself: wrap it in a new split root.
    if (scene.root.node_id !== target.nodeId) return null;
    extract(scene, dragInstanceId, allocate);
    const oldRoot = scene.root;
    scene.root = {
      kind: "container",
      node_id: allocate(),
      axis,
      children: before
        ? [dragChild, { child: oldRoot, basis: { kind: "fraction", weight: 1 }, resizable: true, collapse_priority: null }]
        : [{ child: oldRoot, basis: { kind: "fraction", weight: 1 }, resizable: true, collapse_priority: null }, dragChild],
    };
  } else {
    const { container } = anchor;
    extract(scene, dragInstanceId, allocate);
    const targetIndex = container.children.findIndex((child) => child.child.node_id === target.nodeId);
    if (targetIndex < 0) return null;
    if (container.axis === axis) {
      container.children.splice(before ? targetIndex : targetIndex + 1, 0, dragChild);
    } else {
      const outer = container.children[targetIndex]!;
      const targetChild: MutableChild = {
        child: outer.child,
        basis: { kind: "fraction", weight: 1 },
        resizable: outer.resizable,
        collapse_priority: outer.collapse_priority,
      };
      const wrapper: MutableNode = {
        kind: "container",
        node_id: allocate(),
        axis,
        children: before ? [dragChild, targetChild] : [targetChild, dragChild],
      };
      container.children[targetIndex] = { ...outer, child: wrapper };
    }
  }
  normalize(scene.root, allocate);
  checkScene(scene);
  if (JSON.stringify(scene.root) === rootBefore) return null;
  return scene;
}

function nodeContainsInstance(node: MutableNode, instanceId: string): boolean {
  if (node.kind === "surface") return node.instance_id === instanceId;
  if (node.kind === "stack") return node.instances.includes(instanceId);
  return node.children.some((child) => nodeContainsInstance(child.child, instanceId));
}

function findContainingChild(
  node: MutableNode,
  instanceId: string,
): { container: Extract<MutableNode, { kind: "container" }>; child: MutableChild } | null {
  if (node.kind !== "container") return null;
  for (const child of node.children) {
    if (nodeContainsInstance(child.child, instanceId)) {
      const nested = findContainingChild(child.child, instanceId);
      return nested ?? { container: node, child };
    }
  }
  return null;
}

/**
 * Places one required Surface directly below the pane that contains the
 * invoking Surface. Unlike pointer drag, the required instance may be
 * currently unplaced. The result is sized as a focused 7:3 work/support pair
 * and is intended for one ordinary `replace_root` edit.
 */
export function computeStudioEmergence(
  sceneInput: SceneState,
  requiredInstanceId: string,
  invokingInstanceId: string,
  allocate: () => string,
): SceneState | null {
  if (requiredInstanceId === invokingInstanceId) return null;
  const invokingPlacement = findStudioInstancePlacement(sceneInput, invokingInstanceId);
  if (invokingPlacement == null || invokingPlacement.kind === "utility") return null;

  const seeded = structuredClone(sceneInput) as MutableScene;
  if (findStudioInstancePlacement(sceneInput, requiredInstanceId) == null) {
    if (seeded.utility_tray == null) {
      seeded.utility_tray = {
        node_id: allocate(),
        active_instance_id: requiredInstanceId,
        instances: [requiredInstanceId],
      };
    } else {
      seeded.utility_tray.instances.push(requiredInstanceId);
      seeded.utility_tray.active_instance_id = requiredInstanceId;
    }
  }

  const next = computeStudioDrop(seeded, requiredInstanceId, {
    nodeId: invokingPlacement.nodeId,
    instanceId: invokingInstanceId,
    zone: "bottom",
  }, allocate);
  if (next == null) return null;

  const mutable = next as MutableScene;
  const required = findContainingChild(mutable.root, requiredInstanceId);
  const invoking = findContainingChild(mutable.root, invokingInstanceId);
  if (required == null || invoking == null || required.container !== invoking.container) return null;
  required.child.basis = {
    kind: "minmax",
    min_logical_pixels: 160,
    max_logical_pixels: 1_400,
    weight: 3,
  };
  invoking.child.basis = { kind: "fraction", weight: 7 };
  checkScene(mutable);
  return mutable;
}

export function reconcileStudio(
  snapshotInput: StudioRuntimeSnapshot,
  availableIds: readonly string[],
  allocate: () => string,
): StudioRuntimeSnapshot {
  const snapshot = structuredClone(snapshotInput);
  const scene = structuredClone(snapshot.scene) as MutableScene;
  const allowed = new Set(availableIds);
  const beforeScene = JSON.stringify(scene);
  if (!prune(scene.root, allowed)) {
    scene.root = { kind: "container", node_id: allocate(), axis: "horizontal", children: [] };
  }
  if (scene.utility_tray != null) {
    scene.utility_tray.instances = scene.utility_tray.instances.filter((id) => allowed.has(id));
    if (scene.utility_tray.instances.length === 0) scene.utility_tray = null;
    else if (!scene.utility_tray.instances.includes(scene.utility_tray.active_instance_id)) {
      scene.utility_tray.active_instance_id = scene.utility_tray.instances[0]!;
    }
  }
  if (scene.focused_surface_instance_id != null && !allowed.has(scene.focused_surface_instance_id)) {
    scene.focused_surface_instance_id = null;
  }
  normalize(scene.root, allocate);
  const sceneChanged = beforeScene !== JSON.stringify(scene);
  if (sceneChanged) scene.layout_revision += 1;
  const placed = collectSceneInstances(scene);
  const unplaced = availableIds.filter((id) => !placed.has(id)).sort();
  const availabilityChanged = JSON.stringify(unplaced) !== JSON.stringify(snapshot.unplaced_instance_ids);
  return {
    ...snapshot,
    snapshot_revision: snapshot.snapshot_revision + (sceneChanged || availabilityChanged ? 1 : 0),
    scene,
    unplaced_instance_ids: unplaced,
    can_undo: sceneChanged ? false : snapshot.can_undo,
    can_redo: sceneChanged ? false : snapshot.can_redo,
  };
}

export function layoutBasisStyle(basis: LayoutBasis): Readonly<Record<string, string | number>> {
  switch (basis.kind) {
    case "auto": return { flex: "1 1 auto" };
    case "intrinsic": return { flex: "0 0 auto" };
    case "fixed": return { flex: `0 0 ${basis.logical_pixels}px` };
    case "fraction": return { flex: `${basis.weight} 1 0` };
    case "minmax": return {
      flex: `${basis.weight} 1 0`,
      minWidth: `${basis.min_logical_pixels}px`,
      maxWidth: `${basis.max_logical_pixels}px`,
    };
  }
}

export function childAt(node: LayoutNode, index: number): LayoutChild | undefined {
  return node.kind === "container" ? node.children[index] : undefined;
}
