import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import type {
  LayoutAxis,
  LayoutBasis,
  LayoutChild,
  LayoutNode,
  SceneEdit,
  StudioRuntimeSnapshot,
  SurfaceInstance,
} from "../../transport";
import { residualSpaceRecipient } from "../layout-rendering";
import type { StudioPointerDragController } from "../StudioPointerDrag";
import { surfaceDisplayLabel } from "../surface-ux";

interface TreeProps {
  readonly node: LayoutNode;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly studio: StudioRuntimeSnapshot;
  readonly commit: (edit: SceneEdit) => void;
  readonly studioDrag: StudioPointerDragController;
  readonly surfaceView: (
    instance: SurfaceInstance,
    embedded?: boolean,
    nodeId?: string,
    paneMemberCount?: number,
  ) => ReactNode;
}

function basisStyle(basis: LayoutBasis, axis: LayoutAxis): CSSProperties {
  switch (basis.kind) {
    case "auto": return { flex: "1 1 auto" };
    case "intrinsic": return { flex: "0 0 auto" };
    case "fixed": return { flex: `0 0 ${basis.logical_pixels}px` };
    case "fraction": return { flex: `${basis.weight} 1 0` };
    case "minmax":
      return {
        flex: `${basis.weight} 1 0`,
        ...(axis === "horizontal"
          ? {
              minWidth: `${basis.min_logical_pixels}px`,
              maxWidth: `${basis.max_logical_pixels}px`,
            }
          : {
              minHeight: `${basis.min_logical_pixels}px`,
              maxHeight: `${basis.max_logical_pixels}px`,
            }),
      };
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

function useContainerExtent(axis: LayoutAxis) {
  const ref = useRef<HTMLDivElement>(null);
  const [extent, setExtent] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = ref.current;
    if (element == null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) {
        setExtent(axis === "horizontal" ? entry.contentRect.width : entry.contentRect.height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [axis]);
  return { ref, extent };
}

interface ResizeHandleProps {
  readonly axis: LayoutAxis;
  readonly containerId: string;
  readonly beforeIndex: number;
  readonly commit: (edit: SceneEdit) => void;
}

function ResizeHandle({ axis, containerId, beforeIndex, commit }: ResizeHandleProps) {
  const handle = useRef<HTMLButtonElement>(null);
  const [logicalValue, setLogicalValue] = useState<number | null>(null);
  const [logicalMaximum, setLogicalMaximum] = useState<number | null>(null);
  const drag = useRef<{
    start: number;
    before: number;
    after: number;
    pending: number;
    frame: number | null;
    beforeElement: HTMLElement;
    afterElement: HTMLElement;
  } | null>(null);

  const preview = () => {
    const current = drag.current;
    if (current == null) return;
    current.frame = null;
    const before = Math.max(56, current.before + current.pending);
    const after = Math.max(56, current.after - (before - current.before));
    current.beforeElement.style.flex = `0 0 ${before}px`;
    current.afterElement.style.flex = `0 0 ${after}px`;
  };
  const boundaryEdit = (before: number, after: number): SceneEdit => ({
    kind: "resize_boundary",
    container_node_id: containerId,
    before_child_index: beforeIndex,
    before_basis: { kind: "fixed", logical_pixels: Math.max(56, Math.round(before)) },
    after_basis: { kind: "fixed", logical_pixels: Math.max(56, Math.round(after)) },
  });
  const extentOf = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return axis === "horizontal" ? rect.width : rect.height;
  };

  return (
    <button
      ref={handle}
      className={`rho-resize-handle rho-resize-${axis}`}
      type="button"
      role="separator"
      aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemin={56}
      aria-valuemax={logicalMaximum == null ? undefined : Math.round(logicalMaximum)}
      aria-valuenow={logicalValue == null ? undefined : Math.round(logicalValue)}
      aria-valuetext={logicalValue == null
        ? "Focus to measure this boundary"
        : `${Math.round(logicalValue)} logical pixels before the boundary`}
      aria-label={`Resize boundary ${beforeIndex + 1}`}
      onFocus={() => {
        const beforeElement = handle.current?.previousElementSibling as HTMLElement | null;
        const afterElement = handle.current?.nextElementSibling as HTMLElement | null;
        if (beforeElement != null && afterElement != null) {
          const before = extentOf(beforeElement);
          const after = extentOf(afterElement);
          setLogicalValue(before);
          setLogicalMaximum(Math.max(56, before + after - 56));
        }
      }}
      onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
        const beforeElement = event.currentTarget.previousElementSibling as HTMLElement | null;
        const afterElement = event.currentTarget.nextElementSibling as HTMLElement | null;
        if (beforeElement == null || afterElement == null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          start: axis === "horizontal" ? event.clientX : event.clientY,
          before: extentOf(beforeElement),
          after: extentOf(afterElement),
          pending: 0,
          frame: null,
          beforeElement,
          afterElement,
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current == null) return;
        current.pending = (axis === "horizontal" ? event.clientX : event.clientY) - current.start;
        if (current.frame == null) current.frame = requestAnimationFrame(preview);
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (current == null) return;
        if (current.frame != null) cancelAnimationFrame(current.frame);
        preview();
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const before = extentOf(current.beforeElement);
        const after = extentOf(current.afterElement);
        setLogicalValue(before);
        setLogicalMaximum(Math.max(56, before + after - 56));
        commit(boundaryEdit(before, after));
      }}
      onPointerCancel={(event) => {
        const current = drag.current;
        if (current == null) return;
        if (current.frame != null) cancelAnimationFrame(current.frame);
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onKeyDown={(event) => {
        const beforeElement = event.currentTarget.previousElementSibling as HTMLElement | null;
        const afterElement = event.currentTarget.nextElementSibling as HTMLElement | null;
        if (beforeElement == null || afterElement == null) return;
        const before = extentOf(beforeElement);
        const after = extentOf(afterElement);
        const step = event.shiftKey ? 64 : 16;
        const delta = event.key === "Home" ? -before + 56
          : event.key === "End" ? after - 56
          : event.key === "PageUp" ? -64
          : event.key === "PageDown" ? 64
          : axis === "horizontal"
            ? event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0
            : event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        if (delta === 0) return;
        event.preventDefault();
        const clamped = Math.max(-before + 56, Math.min(after - 56, delta));
        const nextBefore = before + clamped;
        setLogicalValue(nextBefore);
        setLogicalMaximum(Math.max(56, before + after - 56));
        commit(boundaryEdit(nextBefore, after - clamped));
      }}
    ><span aria-hidden="true" /></button>
  );
}

function layoutNodeDisplayLabel(
  node: LayoutNode,
  instances: ReadonlyMap<string, SurfaceInstance>,
): string {
  if (node.kind === "surface") {
    const instance = instances.get(node.instance_id);
    return instance == null ? "component" : surfaceDisplayLabel(instance.surface_id);
  }
  if (node.kind === "stack") {
    const instance = instances.get(node.active_instance_id)
      ?? node.instances.map((instanceId) => instances.get(instanceId))
        .find((candidate) => candidate != null);
    return instance == null ? "component stack" : surfaceDisplayLabel(instance.surface_id);
  }
  const labels = [...new Set(
    node.children.map(({ child }) => layoutNodeDisplayLabel(child, instances)),
  )];
  if (labels.length === 0) return "components";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} + ${labels[1]}`;
  return `${labels[0]} + ${labels.length - 1} more`;
}

export function LayoutTree({
  node,
  instances,
  studio,
  commit,
  studioDrag,
  surfaceView,
}: TreeProps) {
  if (node.kind === "surface") {
    const instance = instances.get(node.instance_id);
    return instance == null
      ? <div className="rho-missing-surface">Unavailable Surface {node.instance_id}</div>
      : surfaceView(instance, false, node.node_id);
  }
  if (node.kind === "stack") {
    const rawLabels = node.instances.map((id) =>
      instances.get(id) == null ? id : surfaceDisplayLabel(instances.get(id)!.surface_id)
    );
    const duplicateLabels = new Set(
      rawLabels.filter((label, index) => rawLabels.indexOf(label) !== index),
    );
    const ordinals = new Map<string, number>();
    const tabLabels = rawLabels.map((label) => {
      if (!duplicateLabels.has(label)) return label;
      const ordinal = (ordinals.get(label) ?? 0) + 1;
      ordinals.set(label, ordinal);
      return `${label} · ${ordinal}`;
    });
    return (
      <section className="rho-stack" data-node-id={node.node_id}>
        <div className="rho-stack-tabs" role="tablist" aria-label="Surface stack">
          {node.instances.map((id, index) => {
            const label = tabLabels[index]!;
            return (
              <div
                className="rho-stack-tab"
                data-studio-tab-node-id={node.node_id}
                data-studio-tab-instance-id={id}
                data-studio-drop-label={label}
                data-drop-position={studioDrag.visual?.target?.nodeId === node.node_id &&
                  studioDrag.visual.target.instanceId === id &&
                  studioDrag.visual.target.zone.startsWith("tab-")
                  ? studioDrag.visual.target.zone.replace("tab-", "")
                  : undefined}
                key={id}
              >
                <button
                  id={`${node.node_id}:${id}:tab`}
                  type="button"
                  role="tab"
                  aria-controls={`${node.node_id}:${id}:panel`}
                  aria-selected={id === node.active_instance_id}
                  tabIndex={id === node.active_instance_id ? 0 : -1}
                  data-studio-drag-source={id}
                  onPointerDown={(event) => studioDrag.begin(event, id, label)}
                  onClick={(event) => {
                    if (studioDrag.consumeSuppressedClick(event.currentTarget)) return;
                    commit({
                      kind: "set_stack_active",
                      stack_node_id: node.node_id,
                      instance_id: id,
                    });
                  }}
                  onKeyDown={(event) => {
                    const current = node.instances.indexOf(id);
                    const next = event.key === "Home" ? 0
                      : event.key === "End" ? node.instances.length - 1
                      : event.key === "ArrowLeft"
                        ? (current - 1 + node.instances.length) % node.instances.length
                        : event.key === "ArrowRight"
                          ? (current + 1) % node.instances.length
                          : current;
                    if (next === current) return;
                    event.preventDefault();
                    const instanceId = node.instances[next];
                    if (instanceId == null) return;
                    commit({
                      kind: "set_stack_active",
                      stack_node_id: node.node_id,
                      instance_id: instanceId,
                    });
                    event.currentTarget.parentElement?.parentElement
                      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]
                      ?.focus();
                  }}
                >{label}</button>
                <button
                  type="button"
                  className="rho-stack-tab-close"
                  aria-label={`Close ${label}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    commit({ kind: "close_surface_placement", instance_id: id });
                  }}
                >×</button>
              </div>
            );
          })}
        </div>
        <div className="rho-stack-panes">
          <div
            id={`${node.node_id}:${node.active_instance_id}:panel`}
            className="rho-stack-pane"
            role="tabpanel"
            aria-labelledby={`${node.node_id}:${node.active_instance_id}:tab`}
          >
            {instances.get(node.active_instance_id) == null
              ? <div>Unavailable Surface {node.active_instance_id}</div>
              : surfaceView(
                  instances.get(node.active_instance_id)!,
                  false,
                  node.node_id,
                  node.instances.length,
                )}
          </div>
        </div>
      </section>
    );
  }
  return (
    <AdaptiveContainer
      node={node}
      instances={instances}
      studio={studio}
      commit={commit}
      studioDrag={studioDrag}
      surfaceView={surfaceView}
    />
  );
}

function AdaptiveContainer({ node, instances, studio, commit, studioDrag, surfaceView }:
  TreeProps & { readonly node: Extract<LayoutNode, { kind: "container" }> }) {
  const { ref, extent } = useContainerExtent(node.axis);
  const [forcedOpen, setForcedOpen] = useState<ReadonlySet<number>>(() => new Set());
  const candidates = node.children
    .map((child, index) => ({ child, index }))
    .filter(({ child, index }) => child.collapse_priority != null && !forcedOpen.has(index))
    .sort((left, right) =>
      (left.child.collapse_priority ?? 65_535) -
      (right.child.collapse_priority ?? 65_535)
    );
  let desired = node.children.reduce((sum, child) => sum + minimumExtent(child.basis), 0);
  const collapsed = new Set<number>();
  for (const candidate of candidates) {
    if (desired <= extent) break;
    collapsed.add(candidate.index);
    desired -= minimumExtent(candidate.child.basis);
  }
  const visibleCount = node.children.length - collapsed.size;
  const residualRecipient = residualSpaceRecipient(node.children, collapsed);
  return (
    <section
      ref={ref}
      className={`rho-layout-container rho-axis-${node.axis}`}
      data-node-id={node.node_id}
      data-layout-revision={studio.scene.layout_revision}
    >
      {node.children.map((child, index) => {
        const isCollapsed = collapsed.has(index);
        const next = node.children[index + 1];
        const showHandle = !isCollapsed && next != null && !collapsed.has(index + 1) &&
          child.resizable && next.resizable && visibleCount > 1;
        return (
          <ContainerChild
            key={child.child.node_id}
            child={child}
            index={index}
            collapsed={isCollapsed}
            axis={node.axis}
            receivesResidualSpace={index === residualRecipient}
            handle={showHandle
              ? <ResizeHandle
                  axis={node.axis}
                  containerId={node.node_id}
                  beforeIndex={index}
                  commit={commit}
                />
              : null}
          >
            <LayoutTree
              node={child.child}
              instances={instances}
              studio={studio}
              commit={commit}
              studioDrag={studioDrag}
              surfaceView={surfaceView}
            />
          </ContainerChild>
        );
      })}
      {collapsed.size > 0 && (
        <nav className="rho-collapse-rail" aria-label="Hidden components">
          {[...collapsed].map((index) => {
            const child = node.children[index]!;
            const label = layoutNodeDisplayLabel(child.child, instances);
            return <button
              type="button"
              className="rho-collapse-restore"
              aria-label={`Show collapsed ${label}`}
              title={`Show ${label}`}
              key={child.child.node_id}
              onClick={() => setForcedOpen((current) => new Set([...current, index]))}
            ><span aria-hidden="true">＋</span><span>Show {label}</span></button>;
          })}
        </nav>
      )}
    </section>
  );
}

function ContainerChild({ child, index, collapsed, axis, receivesResidualSpace, handle, children }:
  {
    readonly child: LayoutChild;
    readonly index: number;
    readonly collapsed: boolean;
    readonly axis: LayoutAxis;
    readonly receivesResidualSpace: boolean;
    readonly handle: ReactNode;
    readonly children: ReactNode;
  }) {
  return (
    <>
      <div
        className={`rho-layout-child ${collapsed ? "rho-layout-child-collapsed" : ""}`}
        data-child-index={index}
        data-collapse-priority={child.collapse_priority ?? undefined}
        data-residual-space={receivesResidualSpace || undefined}
        style={collapsed
          ? { flex: "0 0 0", minWidth: 0, minHeight: 0 }
          : {
              ...basisStyle(child.basis, axis),
              ...(receivesResidualSpace && child.basis.kind === "fixed"
                ? { flexGrow: 1 }
                : {}),
            }}
      >{children}</div>
      {handle}
    </>
  );
}

export function NodeOutline({
  node,
  commit,
}: {
  readonly node: LayoutNode;
  readonly commit: (edit: SceneEdit) => void;
}) {
  if (node.kind === "surface") return <code>{node.instance_id}</code>;
  if (node.kind === "stack") {
    return <span><strong>Stack</strong> <small>{node.instances.length} tabs</small></span>;
  }
  return (
    <div>
      <div className="rho-outline-row">
        <strong>{node.axis === "horizontal" ? "Row" : "Column"}</strong>
        <button type="button" onClick={() => commit({
          kind: "set_container_axis",
          container_node_id: node.node_id,
          axis: node.axis === "horizontal" ? "vertical" : "horizontal",
        })}>Flip</button>
        <button type="button" onClick={() => commit({
          kind: "distribute_container",
          container_node_id: node.node_id,
        })}>Equalize</button>
      </div>
      <ol>{node.children.map((child, index) => (
        <li key={child.child.node_id}>
          <div className="rho-child-policy">
            <span>{child.basis.kind}</span>
            <span>{child.collapse_priority == null
              ? "always open"
              : `collapse P${child.collapse_priority}`}</span>
            {child.collapse_priority == null ? (
              <button type="button" onClick={() => commit({
                kind: "set_collapse_priority",
                container_node_id: node.node_id,
                child_index: index,
                collapse_priority: 1,
              })}>Adaptive</button>
            ) : (
              <>
                <button type="button" onClick={() => commit({
                  kind: "set_collapse_priority",
                  container_node_id: node.node_id,
                  child_index: index,
                  collapse_priority: Math.min(65_535, child.collapse_priority! + 1),
                })}>Later</button>
                <button type="button" onClick={() => commit({
                  kind: "set_collapse_priority",
                  container_node_id: node.node_id,
                  child_index: index,
                  collapse_priority: null,
                })}>Pin</button>
              </>
            )}
          </div>
          <NodeOutline node={child.child} commit={commit} />
        </li>
      ))}</ol>
    </div>
  );
}

export function findLayoutPlacement(
  node: LayoutNode,
  instanceId: string,
):
  | { readonly kind: "surface" }
  | { readonly kind: "stack"; readonly nodeId: string; readonly active: boolean }
  | null {
  if (node.kind === "surface") {
    return node.instance_id === instanceId ? { kind: "surface" } : null;
  }
  if (node.kind === "stack") {
    return node.instances.includes(instanceId)
      ? { kind: "stack", nodeId: node.node_id, active: node.active_instance_id === instanceId }
      : null;
  }
  for (const child of node.children) {
    const placement = findLayoutPlacement(child.child, instanceId);
    if (placement != null) return placement;
  }
  return null;
}
