import type { AgentTurnEvent, LayoutNode } from "../../transport";

export interface AgentStudioPresentation {
  readonly title: string;
  readonly code_paths: readonly string[];
  readonly execution_id: string | null;
  readonly plot_id: string | null;
  readonly show_plots: boolean;
  readonly show_environment: boolean;
}

export interface AgentStudioPresentationEvent {
  readonly event: AgentTurnEvent;
  readonly presentation: AgentStudioPresentation;
}

export interface AgentStudioPresentationInstances {
  readonly source: readonly string[];
  readonly history: string | null;
  readonly plots: string | null;
  readonly environment: string | null;
}

const MAX_TITLE_LENGTH = 96;
const MAX_PATH_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_CODE_PATHS = 3;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function parsedRecord(value: string | null): Readonly<Record<string, unknown>> | null {
  if (value == null) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function boundedOptionalId(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_ID_LENGTH ? normalized : undefined;
}

function normalizedProjectPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (
    path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes("\\") ||
    path.startsWith("/") || /^[A-Za-z]:/u.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) return null;
  return path;
}

export function parseAgentStudioPresentation(
  event: AgentTurnEvent,
): AgentStudioPresentationEvent | null {
  if (event.event_type !== "tool.call_completed" || event.tool !== "present_in_studio") {
    return null;
  }
  let value = parsedRecord(event.body);
  if (value?.kind !== "rho.studio_presentation") {
    const details = parsedRecord(event.details_json);
    const argumentsValue = details?.success === true ? record(details.arguments) : null;
    value = argumentsValue == null
      ? null
      : { kind: "rho.studio_presentation", ...argumentsValue };
  }
  if (value?.kind !== "rho.studio_presentation" || typeof value.title !== "string") return null;
  const title = value.title.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) return null;
  const rawCodePaths = value.code_paths == null ? [] : value.code_paths;
  if (!Array.isArray(rawCodePaths) || rawCodePaths.length > MAX_CODE_PATHS) return null;
  const codePaths = rawCodePaths.map(normalizedProjectPath);
  if (codePaths.some((path) => path == null)) return null;
  const executionId = boundedOptionalId(value.execution_id);
  const plotId = boundedOptionalId(value.plot_id);
  if (executionId === undefined || plotId === undefined) return null;
  const showPlots = value.show_plots === true;
  const showEnvironment = value.show_environment === true;
  if (
    codePaths.length === 0 && executionId == null && plotId == null &&
    !showPlots && !showEnvironment
  ) return null;
  return {
    event,
    presentation: {
      title,
      code_paths: codePaths as readonly string[],
      execution_id: executionId,
      plot_id: plotId,
      show_plots: showPlots || plotId != null,
      show_environment: showEnvironment,
    },
  };
}

export function agentStudioPresentationKey(turnId: string, eventId: number): string {
  return `${turnId}:${eventId}`;
}

function surfaceNode(instanceId: string, allocateNodeId: () => string): LayoutNode {
  return { kind: "surface", node_id: allocateNodeId(), instance_id: instanceId };
}

function layoutChild(child: LayoutNode, weight: number) {
  return {
    child,
    basis: { kind: "fraction" as const, weight },
    resizable: true,
    collapse_priority: null,
  };
}

function column(instanceIds: readonly string[], allocateNodeId: () => string): LayoutNode {
  if (instanceIds.length === 1) return surfaceNode(instanceIds[0]!, allocateNodeId);
  return {
    kind: "container",
    node_id: allocateNodeId(),
    axis: "vertical",
    children: instanceIds.map((instanceId) => layoutChild(
      surfaceNode(instanceId, allocateNodeId),
      1,
    )),
  };
}

export function buildAgentStudioPresentationLayout(
  instances: AgentStudioPresentationInstances,
  allocateNodeId: () => string,
): LayoutNode {
  const primary = [...instances.source, ...(instances.history == null ? [] : [instances.history])];
  const results = [instances.plots, instances.environment]
    .filter((instanceId): instanceId is string => instanceId != null);
  if (primary.length === 0 && results.length === 0) {
    throw new Error("Studio presentation has no admitted Surface instances.");
  }
  if (primary.length === 0 || results.length === 0) {
    const only = primary.length > 0 ? primary : results;
    return {
      kind: "container",
      node_id: allocateNodeId(),
      axis: "vertical",
      children: only.map((instanceId) => layoutChild(
        surfaceNode(instanceId, allocateNodeId),
        1,
      )),
    };
  }
  return {
    kind: "container",
    node_id: allocateNodeId(),
    axis: "horizontal",
    children: [
      layoutChild(column(primary, allocateNodeId), 3),
      layoutChild(column(results, allocateNodeId), 2),
    ],
  };
}
