import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { projectConsoleEvents } from "../app/console-output";
import { projectLabel } from "./normalize";
import { applySceneEdit, collectSceneInstances, reconcileStudio } from "./studio-model";
import { applyVibePageMutation, exportVibePage } from "./vibe-model";
import type {
  AgentApprovalDecisionRequest,
  AgentConversationSummary,
  AgentContextCapacityRequest,
  AgentLlmCredentialRevealView,
  AgentLlmSettingsView,
  AgentMode,
  AgentRuntimeDiagnostics,
  AgentTurnDetail,
  AgentTurnEvent,
  AgentTurnSummary,
  AppInfo,
  DomainSurfaceData,
  CheckResult,
  CheckResultRequest,
  CheckRunRequest,
  LayoutChild,
  OpenSurfaceRequest,
  PluginSurfaceDocument,
  PluginSurfaceDocumentRequest,
  PluginSurfaceDocumentView,
  PluginSurfaceEventRequest,
  PluginSurfaceEventResult,
  ProjectSwitchResponse,
  ProjectUiProfileSnapshot,
  ResourceBinding,
  ResourceContent,
  ResourceDeleteRequest,
  ResourceDescriptor,
  ResourceDraftRequest,
  ResourceReadRequest,
  ResourceRegistrySnapshot,
  ResourceReloadRequest,
  ResourceRenameRequest,
  ResourceResolveRequest,
  ResourceSaveRequest,
  ResourceTarget,
  RuntimeAttachmentRequest,
  RuntimeBinding,
  RuntimeCreateRequest,
  RuntimeDescriptor,
  RuntimeDetachRequest,
  RuntimeExecuteRequest,
  RuntimeExecution,
  RuntimeExecutionCursor,
  RuntimeExecutionStartResponse,
  RuntimeOutputChunk,
  RuntimeOutputEvent,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RuntimeOutputPageRequest,
  RuntimeOutputReference,
  RuntimeOutputSearchRequest,
  RuntimeOutputSearchResult,
  RuntimeOutputPolicyUpdate,
  RuntimeOutputPolicyView,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
  SetUiSelectionRequest,
  SurfaceInstance,
  SurfaceFactoryRegistration,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  SurfaceInstanceSpec,
  SceneEditRequest,
  SceneState,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
  UpdateSurfaceRequest,
  UiKernelSnapshot,
  UiKernelTransport,
  UiProfileRevisionRequest,
  UiProfileSceneLabelRequest,
  UiProfileSceneTargetRequest,
  UiProfileSelectPageRequest,
  UiProfileSelectSceneRequest,
  UiProfileSetModeRequest,
  VibePageExportRequest,
  VibePageMutationRequest,
  VibePage,
  VibeSection,
  Unsubscribe,
  WorkspacePreparation,
  WorkspacePreparationProgress,
  WorkspacePreparationProgressListener,
} from "./types";
import { MODEL_CAPABILITY_NAMES } from "./agent-settings";
import type { AgentTurnEventFrame } from "./agent-events";
import { INVALIDATION_TOPICS } from "./invalidation-contract";
import type { EvidenceClaim } from "./evidence";
import type {
  ArtifactRecordSummary,
  PlotArtifactSummary,
  ProblemSummary,
  RunSummary,
} from "./history";
import type { WorkbenchProjection } from "./workbench-projection";

export const MOCK_INVALIDATION_TOPICS = INVALIDATION_TOPICS;

const generatedSnapshot = fixture.kernel_snapshot as unknown as UiKernelSnapshot;
// Small inline PNG so the mock Plots gallery exercises the real thumbnail path.
const MOCK_PLOT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAACNUlEQVR4nO3c7W3CMBSFYfOxyJUyAqt0A7bgd7dgg67CApGQ7iRIlRIpCokpKbaPfe3z/kIVpehpemOHqLu+7x1L39E5JyKAn9RyqrrP/R5aidCgCA2K0KAIDYrQoAgNitCgCA2K0MAtOAuv+/4aH9wvP94n8IiOqbx4PI/Qoa1lvdaEBkVoUDwZft50Hf9wPs2/7j0fEjqIWFU3rjoIHeQ79cp3itChxBsjdFrfqaahu9eDNSJx69Dd83ZutI7u2zp059vOPa63FMRNQ3tLRDzGnSGoRqEfw5T410I4sBahZTjjza1TK7c4oyXZuuLv2jqiJZNyW9CST7khaMmq3Aq05FZuAloKUK4fWspQrhxailGuGVpKUq4WWgpTrhNaylOuEFqKVK4NWkpVxl1U6t7d9lC3MuiI7jbcbFm3MgJ6482WdSvXMKPFgnI2aBmK8jomlJOfDEeIw/pmy4vHeiPWNHmmz6LKV3bO7fq+T/FvJOavqapvVx3r9+DlW8z3x/VmQllV40MviMNfZP3bmgf4XDU8VY08OmINTX3+9nHOLEaQraKdDOczN/qfsw45y+2jE6cTua+mhIm5EQcaQ+yVNaQctLyLctL7IFu+QdC5iE13rHgzZgZ6scvggZwEenFt09Z+18yqY70HO5xPFSxmM2b+MqmVCJ0V2vQezNgRbXcPZm95R9+IcUaDIjQoQoMiNChCgyI0KEKDIjQoQoMiNChCgyI0KEKDIjTwMik/CXTp+wUUsf2F+KI8owAAAABJRU5ErkJggg==";
const generatedSurfaces =
  fixture.surface_runtime_snapshot as unknown as SurfaceRuntimeSnapshot;
const generatedStudio =
  fixture.studio_runtime_snapshot as unknown as StudioRuntimeSnapshot;
const generatedRuntimes =
  fixture.runtime_registry_snapshot as unknown as RuntimeRegistrySnapshot;
const generatedResources =
  fixture.resource_registry_snapshot as unknown as ResourceRegistrySnapshot;
const generatedProfile =
  fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;

const STARTUP_PROGRESS_TEXT_BYTE_LIMIT = 512;
const utf8Encoder = new TextEncoder();

function wellFormedProgressText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value.slice(index, index + 2);
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index];
    }
  }
  return result;
}

function boundedProgressText(value: string): string {
  const normalized = wellFormedProgressText(value);
  if (utf8Encoder.encode(normalized).byteLength <= STARTUP_PROGRESS_TEXT_BYTE_LIMIT) {
    return normalized;
  }
  const suffix = "…";
  const budget = STARTUP_PROGRESS_TEXT_BYTE_LIMIT - utf8Encoder.encode(suffix).byteLength;
  let bounded = "";
  let byteLength = 0;
  for (const character of normalized) {
    const characterBytes = utf8Encoder.encode(character).byteLength;
    if (byteLength + characterBytes > budget) break;
    bounded += character;
    byteLength += characterBytes;
  }
  return `${bounded}${suffix}`;
}

function emitPreparationProgress(
  listener: WorkspacePreparationProgressListener | undefined,
  snapshot: WorkspacePreparationProgress,
) {
  if (listener == null) return;
  try {
    listener(Object.freeze(snapshot));
  } catch {
    // Browser/mock progress is observational, matching the Tauri boundary.
  }
}

function copySnapshot(snapshot: UiKernelSnapshot): UiKernelSnapshot {
  return structuredClone(snapshot);
}

function copySurfaces(snapshot: SurfaceRuntimeSnapshot): SurfaceRuntimeSnapshot {
  return structuredClone(snapshot);
}

function copyStudio(snapshot: StudioRuntimeSnapshot): StudioRuntimeSnapshot {
  return structuredClone(snapshot);
}

function copyRuntimes(snapshot: RuntimeRegistrySnapshot): RuntimeRegistrySnapshot {
  return structuredClone(snapshot);
}

function copyResources(snapshot: ResourceRegistrySnapshot): ResourceRegistrySnapshot {
  return structuredClone(snapshot);
}

function copyProfile(snapshot: ProjectUiProfileSnapshot): ProjectUiProfileSnapshot {
  return structuredClone(snapshot);
}

export interface MockUiKernelTransport extends UiKernelTransport {
  publish(snapshot: UiKernelSnapshot): void;
  publishSurfaces(snapshot: SurfaceRuntimeSnapshot): void;
  publishStudio(snapshot: StudioRuntimeSnapshot): void;
  publishRuntimes(snapshot: RuntimeRegistrySnapshot): void;
  publishResources(snapshot: ResourceRegistrySnapshot): void;
  publishUiProfile(snapshot: ProjectUiProfileSnapshot): void;
  queueRuntimeEvents(events: readonly RuntimeOutputEvent[]): void;
  emitAgentTurnEvent(frame: AgentTurnEventFrame): void;
}

export function createMockUiKernelTransport(
  searchInput: string | URLSearchParams = "",
): MockUiKernelTransport {
  const search =
    typeof searchInput === "string" ? new URLSearchParams(searchInput) : searchInput;
  const requestedStartupFrame = search.get("startup_frame");
  const startupFrame = [
    "runtime-active",
    "workspace-active",
    "project-active",
    "project-attention",
  ].includes(requestedStartupFrame ?? "")
    ? requestedStartupFrame
    : null;
  const scenarioTrace = {
    runtimeExecuteAttempts: [] as Array<{ readonly code: string; readonly sourcePath: string | null }>,
    runtimeExecuteSuccesses: 0,
    runtimeExecuteRejections: 0,
    invalidations: [] as string[],
  };
  const queuedRuntimeEvents: Array<readonly RuntimeOutputEvent[]> = [];
  if (search.has("scenario_trace")) {
    Object.defineProperty(globalThis, "__RHO_RSR_SCENARIO_TRACE__", {
      configurable: true,
      value: scenarioTrace,
    });
  }
  const invalidationRules = search.getAll("invalidation");
  const heldInvalidations = new Map<string, () => void>();
  const emitInvalidation = (topic: string, emit: () => void) => {
    scenarioTrace.invalidations.push(topic);
    if (invalidationRules.includes(`drop:${topic}`)) return;
    const reorder = invalidationRules.find((rule) => rule.startsWith("reorder:"))?.split(":");
    if (reorder?.length === 3 && reorder[1] === topic) {
      heldInvalidations.set(topic, emit);
      return;
    }
    if (reorder?.length === 3 && reorder[2] === topic) {
      emit();
      const held = heldInvalidations.get(reorder[1]!);
      heldInvalidations.delete(reorder[1]!);
      held?.();
      return;
    }
    const delayRule = invalidationRules.find((rule) => rule.startsWith(`delay:${topic}:`));
    if (delayRule != null) {
      const milliseconds = Math.max(1, Math.min(2_000, Number(delayRule.split(":")[2] ?? "1")));
      setTimeout(emit, milliseconds);
      return;
    }
    emit();
    if (invalidationRules.includes(`duplicate:${topic}`)) queueMicrotask(emit);
  };
  const snapshot = copySnapshot(generatedSnapshot);
  const agentRuntimeReady = search.get("agent_runtime") === "ready";
  if (agentRuntimeReady) {
    (snapshot.health as {
      agent: { state: string; label: string; detail: string | null };
    }).agent = {
      state: "ready",
      label: "Agent runtime ready",
      detail: null,
    };
    (snapshot.context as { agent_health: string }).agent_health = "ready";
  }
  const requestedProject = search.get("project");
  if (requestedProject != null && requestedProject.length > 0) {
    const project = snapshot.project as {
      display_path: string;
      display_label: string;
    };
    project.display_path = requestedProject;
    project.display_label = projectLabel(requestedProject);
  }
  let current = snapshot;
  let surfaces = copySurfaces(generatedSurfaces);
  let studio = copyStudio(generatedStudio);
  let runtimes = copyRuntimes(generatedRuntimes);
  let resources = copyResources(generatedResources);
  let profile = copyProfile(generatedProfile);
  const firstPartyFactorySpecs = [
    ["rho.agent", "Agent", [["conversation", "Conversation"], ["activity", "Activity"], ["composer", "Composer"]], false],
    ["rho.settings", "Settings", [["settings", "Settings"]], false],
    ["rho.environment", "Environment", [["toolchains", "Toolchains"], ["packages", "Packages"], ["requests", "Requests"]], false],
    ["rho.navigator", "Navigator", [["files", "Files"], ["runs", "History"]], false],
    ["rho.evidence", "Evidence", [["claims", "Claims"]], false],
    ["rho.git", "Git", [["changes", "Changes"], ["history", "History"]], false],
    ["rho.runs", "History", [["history", "History"]], false],
    ["rho.problems", "Problems", [["list", "List"]], true],
    ["rho.plots", "Plots", [["gallery", "Gallery"], ["single", "Single"]], false],
    ["rho.logs", "Logs", [["stream", "Stream"]], true],
    ["rho.render-jobs", "Render jobs", [["queue", "Queue"]], false],
    ["rho.help", "Help", [["context", "Context"], ["search", "Search"]], false],
  ] as const;
  for (const [surfaceId, label, modes, strip] of firstPartyFactorySpecs) {
    if (surfaces.catalog.factories.some((factory) => factory.definition.surface_id === surfaceId)) continue;
    const factory: SurfaceFactoryRegistration = {
      definition: {
        surface_id: surfaceId,
        contract_major: 1,
        label,
        purpose: surfaceId === "rho.settings"
          ? "Configure trusted application capabilities through bounded first-party modules."
          : `Render ${label} as an independently placeable project Surface.`,
        renderer_kind: "trusted_host",
        scope: surfaceId === "rho.settings" ? "application" : "project",
        instance_policy: surfaceId === "rho.settings" ? "singleton" : "multi_instance",
        instance_quota_class: strip ? "strip" : "standard",
        resource_kinds: [],
        modes: modes.map(([modeId, modeLabel]) => ({
          mode_id: modeId,
          label: modeLabel,
          interaction_kind: modeId === "history" || modeId === "claims" || modeId === "gallery" || modeId === "stream" || modeId === "activity" ? "read_only" as const : "interactive" as const,
        })),
        sizing_hints: {
          min_inline: strip ? 120 : 220,
          min_block: strip ? 28 : 120,
          ideal_inline: strip ? 320 : 560,
          ideal_block: strip ? 40 : 420,
          max_inline: null,
          max_block: strip ? 72 : null,
          stretch_inline: true,
          stretch_block: !strip,
          presentation_classes: strip ? ["strip"] : ["full", "compact"],
        },
        accepted_contexts: surfaceId === "rho.settings"
          ? ["application", "project"]
          : ["project", "selection", "vibe"],
        commands: [],
        origin: { kind: "application", component_id: surfaceId },
      },
      activation_generation: 1,
    };
    (surfaces.catalog.factories as unknown as SurfaceFactoryRegistration[]).push(factory);
  }
  const mockAgentInstance: SurfaceInstance = {
    instance_id: "instance:agent-shared",
    surface_id: "rho.agent",
    project_id: surfaces.project_id,
    origin: { kind: "application", component_id: "rho.agent" },
    activation_generation: 1,
    surface_revision: 1,
    mode_id: "conversation",
    resource_binding: null,
    runtime_binding: null,
    view_group_id: null,
    view_state: { conversation_id: "agent-conversation:mock-shared", mode: "ask", composer: "", auto_approve: false },
    lifecycle_state: "active",
  };
  (surfaces.catalog.instances as unknown as SurfaceInstance[]).push(mockAgentInstance);
  (profile.profile.surface_instance_specs as unknown as SurfaceInstanceSpec[]).push({
    instance_id: mockAgentInstance.instance_id,
    surface_id: mockAgentInstance.surface_id,
    origin: mockAgentInstance.origin,
    mode_id: mockAgentInstance.mode_id,
    resource_binding: null,
    runtime_attachment_intent: null,
    view_group_id: null,
    view_state: mockAgentInstance.view_state,
  });
  const activeMockScene = profile.profile.studio_scenes.find(
    (scene) => scene.scene_id === profile.profile.active_studio_scene_id,
  );
  const contextStack = studio.scene.root.kind === "container"
    ? studio.scene.root.children.map((child) => child.child).find((child) => child.kind === "stack")
    : null;
  if (contextStack?.kind === "stack") {
    (contextStack.instances as unknown as string[]).unshift(mockAgentInstance.instance_id);
    (contextStack as { active_instance_id: string }).active_instance_id = mockAgentInstance.instance_id;
  }
  if (activeMockScene != null) {
    (activeMockScene as { root: SceneState["root"] }).root = structuredClone(studio.scene.root);
  }
  if (search.get("mode") === "vibe") {
    (profile.profile as { active_mode: "studio" | "vibe" }).active_mode = "vibe";
  }
  if (search.get("vibe") === "information-flow") {
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    );
    if (page != null) {
      const sections: VibeSection[] = [{
        section_id: "section:vibe-scientific-question",
        heading: "问题与方法边界",
        layout: { kind: "flow" },
        blocks: [{
          block_id: "block:vibe-scientific-question",
          content: {
            kind: "rich_text",
            document: {
              blocks: [{
                kind: "paragraph",
                content: [{
                  text: "在 6 位 donor 的单细胞转录组中，比较 cluster 3 与 cluster 7 的差异表达；统计单位必须保持为 donor，校正 batch，并把低细胞数 donor 的不稳定性保留为解释边界。",
                  marks: [],
                }],
              }, {
                kind: "paragraph",
                content: [{
                  text: "预期只在方向跨 donor 一致、FDR < 0.05 且质量控制没有显示单一样本驱动时形成工作解释。",
                  marks: [{ kind: "strong" }],
                }],
              }],
            },
          },
        }, {
          block_id: "block:vibe-agent-work",
          content: {
            kind: "surface_ref",
            instance_id: mockAgentInstance.instance_id,
            live: true,
          },
        }],
      }, {
        section_id: "section:vibe-candidate-output",
        heading: "候选产物与限制",
        layout: { kind: "flow" },
        blocks: [{
          block_id: "block:vibe-artifact",
          content: {
            kind: "artifact_ref",
            artifact_id: "artifact:plot-1",
            label: "donor 聚合后的差异表达与 QC 图（候选产物）",
          },
        }, {
          block_id: "block:vibe-limitation",
          content: {
            kind: "callout",
            tone: "warning",
            text: "当前产物只确认执行和谱系字段已记录；它不等于生物学结论，仍需查验 donor 一致性与低细胞数敏感性。",
          },
        }],
      }];
      (page as { label: string }).label = "Cluster 3 与 7 的 donor 级差异比较";
      (page as { sections: readonly VibeSection[] }).sections = sections;
      (page as { focused_block_id: string | null }).focused_block_id = "block:vibe-artifact";
    }
  }
  if (search.get("plugin") === "surface") {
    const pluginOrigin = {
      kind: "workspace_plugin" as const,
      plugin_id: "org.example.analysis",
      package_digest: `sha256:${"a".repeat(64)}`,
    };
    const pluginFactory = {
      definition: {
        surface_id: "ui.surface.differential-expression",
        contract_major: 1,
        label: "Differential expression",
        purpose: "Explore one bounded differential-expression result.",
        icon: "🧬",
        renderer_kind: "declarative_document" as const,
        scope: "project" as const,
        instance_policy: "multi_instance" as const,
        instance_quota_class: "standard" as const,
        resource_kinds: ["project_file"],
        modes: [{ mode_id: "explore", label: "Explore", interaction_kind: "interactive" as const }],
        sizing_hints: {
          min_inline: 180, min_block: 96, ideal_inline: 520, ideal_block: 360,
          max_inline: null, max_block: null, stretch_inline: true, stretch_block: true,
          presentation_classes: ["full", "compact"],
        },
        accepted_contexts: ["project"],
        commands: [],
        origin: pluginOrigin,
      },
      activation_generation: 1,
    };
    const pluginInstance: SurfaceInstance = {
      instance_id: "surface-instance:plugin-analysis",
      surface_id: pluginFactory.definition.surface_id,
      project_id: surfaces.project_id,
      origin: pluginOrigin,
      activation_generation: 1,
      surface_revision: 1,
      mode_id: "explore",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: {},
      lifecycle_state: "active",
    };
    (surfaces.catalog.factories as unknown as typeof pluginFactory[]).push(pluginFactory);
    (surfaces.catalog.instances as unknown as SurfaceInstance[]).push(pluginInstance);
    (profile.profile.surface_instance_specs as unknown as SurfaceInstanceSpec[]).push({
      instance_id: pluginInstance.instance_id,
      surface_id: pluginInstance.surface_id,
      origin: pluginOrigin,
      mode_id: pluginInstance.mode_id,
      resource_binding: null,
      runtime_attachment_intent: null,
      view_group_id: null,
      view_state: {},
    });
    if (studio.scene.root.kind === "container") {
      (studio.scene.root.children as unknown as LayoutChild[]).push({
        basis: { kind: "minmax", min_logical_pixels: 240, max_logical_pixels: 720, weight: 1 },
        resizable: true,
        collapse_priority: 30,
        child: { kind: "surface", node_id: "node:plugin-analysis", instance_id: pluginInstance.instance_id },
      });
    }
  }
  if (search.get("stress") === "large") {
    const stressFactory = surfaces.catalog.factories.find(
      (factory) => factory.definition.surface_id === "rho.surface-playground",
    );
    if (stressFactory == null) throw new Error("Stress fixture requires the playground Surface factory.");
    const stressInstances: SurfaceInstance[] = Array.from({ length: 96 }, (_, index) => ({
      instance_id: `surface-instance:stress-${String(index).padStart(3, "0")}`,
      surface_id: stressFactory.definition.surface_id,
      project_id: surfaces.project_id,
      origin: stressFactory.definition.origin,
      activation_generation: stressFactory.activation_generation,
      surface_revision: 1,
      mode_id: stressFactory.definition.modes[0]?.mode_id ?? null,
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: { draft: `stress-${index}` },
      lifecycle_state: "active",
    }));
    (surfaces.catalog.instances as unknown as SurfaceInstance[]).push(...stressInstances);
    (profile.profile.surface_instance_specs as unknown as SurfaceInstanceSpec[]).push(
      ...stressInstances.map((instance) => ({
        instance_id: instance.instance_id,
        surface_id: instance.surface_id,
        origin: instance.origin,
        mode_id: instance.mode_id,
        resource_binding: null,
        runtime_attachment_intent: null,
        view_group_id: null,
        view_state: instance.view_state,
      })),
    );
    const originalRoot = structuredClone(studio.scene.root);
    const stressRoot: SceneState["root"] = {
      kind: "container",
      node_id: "node:stress-root",
      axis: "horizontal",
      children: [{
        child: originalRoot,
        basis: { kind: "fraction", weight: 3 },
        resizable: true,
        collapse_priority: null,
      }, {
        child: {
          kind: "stack",
          node_id: "node:stress-stack",
          active_instance_id: stressInstances[0]!.instance_id,
          instances: stressInstances.map((instance) => instance.instance_id),
        },
        basis: { kind: "fraction", weight: 2 },
        resizable: true,
        collapse_priority: 40,
      }],
    };
    (studio.scene as { root: SceneState["root"] }).root = stressRoot;
    const stressScene = profile.profile.studio_scenes.find(
      (scene) => scene.scene_id === profile.profile.active_studio_scene_id,
    );
    if (stressScene != null) (stressScene as { root: SceneState["root"] }).root = structuredClone(stressRoot);
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    );
    if (page != null) {
      const textBlocks = Array.from({ length: 160 }, (_, index) => ({
        block_id: `vibe-block:stress-text-${String(index).padStart(3, "0")}`,
        content: {
          kind: "rich_text" as const,
          document: {
            blocks: [{
              kind: "paragraph" as const,
              content: [{
                text: `分析 ${index} · مرحبا بالعالم · שלום עולם · 🧬`,
                marks: [],
              }],
            }],
          },
        },
      }));
      const surfaceBlocks = stressInstances.slice(0, 24).map((instance, index) => ({
        block_id: `vibe-block:stress-surface-${String(index).padStart(3, "0")}`,
        content: { kind: "surface_ref" as const, instance_id: instance.instance_id, live: true },
      }));
      const section: VibeSection = {
        section_id: "vibe-section:stress-large",
        heading: "Large multilingual Surface document",
        layout: { kind: "flow" },
        blocks: [...textBlocks, ...surfaceBlocks],
      };
      (page.sections as unknown as VibeSection[]).push(section);
    }
  }
  const sourceFixture = search.get("fixture") === "source-gaps"
    ? [
        "# setup",
        "",
        "library(ggplot2)",
        "",
        "df <- data.frame(",
        "  x = 1:3,",
        "  y = c(2, 4, 8)",
        ")",
        "",
        "plot(df$x, df$y)",
        "",
      ].join("\n")
    : "library(ggplot2)\nplot(mtcars$wt, mtcars$mpg)\n";
  const persistedContent = new Map<string, string>([["analysis.R", sourceFixture]]);
  const runtimeHistoryItems: Array<DomainSurfaceData["items"][number]> = [{
    id: "run:mock-1",
    title: "workspace.execute",
    subtitle: "analysis.R",
    status: "completed",
    detail: "{\"origin\":\"user\",\"source_path\":\"analysis.R\",\"execution_mode\":\"expression\",\"code_preview\":\"summary(mtcars)\",\"started_at\":\"2026-08-23T06:00:00Z\"}",
  }];
  const typedRunRecords = (): readonly RunSummary[] => [{
    run_id: "run:mock-1",
    parent_run_id: null,
    project_root: current.project.display_path,
    origin: "user",
    status: "completed",
    started_at: "2026-08-23T06:00:00Z",
    finished_at: "2026-08-23T06:00:03Z",
    terminal_reason: null,
    request_type: "workspace.execute",
    operation_class: "scientific_execution",
    source_path: "analysis.R",
    execution_mode: "expression",
    document_version: 4,
    workspace_id: `workspace:${current.project.project_id}`,
    state_revision_before: 7,
    project_revision_before: current.context.project_revision,
    state_revision_after: 8,
    project_revision_after: current.context.project_revision,
    environment_snapshot_id: null,
    environment_snapshot_id_after: null,
    code_preview: "summary(mtcars)",
    error_message: null,
  }];
  const typedArtifactRecords = (): readonly ArtifactRecordSummary[] => [{
    artifact_id: "artifact:plot-1",
    artifact_kind: "plot",
    run_id: "run:mock-1",
    project_root: current.project.display_path,
    output_path: "plots/qc.png",
    source_path: "analysis.R",
    execution_mode: "expression",
    document_version: 4,
    workspace_id: `workspace:${current.project.project_id}`,
    state_revision: 8,
    project_revision: current.context.project_revision,
    media_type: "image/png",
    metadata_json: "{}",
    provenance_complete: true,
    incomplete_reason: null,
    created_at: "2026-08-23T06:00:03Z",
  }];
  const typedPlotRecords = (): readonly PlotArtifactSummary[] => [{
    plot_id: "plot:mock-1",
    run_id: "run:mock-1",
    project_root: current.project.display_path,
    source_path: "analysis.R",
    execution_mode: "expression",
    document_version: 4,
    workspace_id: `workspace:${current.project.project_id}`,
    state_revision: 8,
    project_revision: current.context.project_revision,
    media_type: "image/png",
    payload_json: "{}",
    provenance_complete: true,
    created_at: "2026-08-23T06:00:03Z",
  }];
  const typedEvidenceRecords = (): readonly EvidenceClaim[] => [{
    claim_id: "claim:1",
    project_root: current.project.display_path,
    kind: "source_statement",
    summary: "The analysis records a fixed random seed before sampling.",
    anchor_kind: "source_range",
    source_path: "analysis.R",
    start_line: 1,
    start_column: 1,
    end_line: 2,
    end_column: 24,
    source_sha256: "a".repeat(64),
    source_excerpt: "set.seed(42)",
    artifact_id: null,
    linked_evidence_ids: [1],
    created_at: "2026-08-23T06:00:03Z",
    updated_at: "2026-08-23T06:00:03Z",
  }];
  const runtimeExecutionRecords: RuntimeExecution[] = [];
  const runtimeOutputChunks = new Map<string, readonly RuntimeOutputChunk[]>();
  const runtimeOutputPolicies = new Map<string, RuntimeOutputPolicyView["policy"]>();
  const runtimeOutputPolicy = () => {
    const root = current.project.display_path;
    const existing = runtimeOutputPolicies.get(root);
    if (existing != null) return existing;
    const policy: RuntimeOutputPolicyView["policy"] = {
      project_root: root,
      revision: 0,
      max_runtime_output_bytes_per_execution: 128 * 1024 * 1024,
      runtime_output_project_warning_bytes: 1024 * 1024 * 1024,
      max_runtime_execution_rows: 5_000,
      auto_prune_enabled: false,
      updated_at: "",
    };
    runtimeOutputPolicies.set(root, policy);
    return policy;
  };
  const runtimeOutputPolicyView = (): RuntimeOutputPolicyView => {
    const policy = runtimeOutputPolicy();
    const rows = runtimeExecutionRecords.filter((execution) => execution.project_root === current.project.display_path);
    const bytes = rows.reduce((total, execution) => total + execution.output_bytes, 0);
    return {
      policy,
      project_output_bytes: bytes,
      project_execution_count: rows.length,
      warning_active: (policy.runtime_output_project_warning_bytes != null
        && bytes >= policy.runtime_output_project_warning_bytes)
        || (policy.max_runtime_execution_rows != null && rows.length >= policy.max_runtime_execution_rows),
    };
  };
  const mockContextPlanDigest = (prompt: string, reference: RuntimeOutputReference | null) => {
    const nibble = (prompt.length + (reference?.end_sequence ?? 0)) % 16;
    return nibble.toString(16).repeat(64);
  };
  const documents = new Map<string, {
    content: string;
    baseContent: string;
    documentRevision: number;
    baseResourceRevision: number;
    dirty: boolean;
  }>();
  let nextInstance = 1;
  let nextNode = 1;
  let nextRuntime = 1;
  let nextExecution = 1;
  let nextCheck = 1;
  let nextScene = 1;
  let projectionGeneration = 0;
  const allocateNode = () => `node:mock-${nextNode++}`;
  const undo: SceneState[] = [];
  const redo: SceneState[] = [];
  const listeners = new Set<() => void>();
  const surfaceListeners = new Set<() => void>();
  const pluginSurfaceListeners = new Set<() => void>();
  const checkResultListeners = new Set<() => void>();
  const studioListeners = new Set<() => void>();
  const runtimeListeners = new Set<() => void>();
  const resourceListeners = new Set<() => void>();
  const agentListeners = new Set<() => void>();
  const agentTurnEventListeners = new Set<(frame: AgentTurnEventFrame) => void>();
  const workbenchListeners = new Set<() => void>();
  const agentNow = "2026-08-22T12:00:00Z";
  const agentProjectRoot = current.project.display_path;
  let agentConfigSnapshotGeneration = 1;
  let agentLlmSettings: AgentLlmSettingsView = {
    schema_version: 6,
    revision: 1,
    config_store: {
      home_path: "/mock/home/.rho",
      config_path: "/mock/home/.rho/config.yaml",
      status: "loaded",
      detail: null,
      found_schema_version: 6,
      config_snapshot_id: "mock-config-snapshot-1",
      permission_issues: [],
    },
    selected_model_id: "mock-profile",
    providers: [{
      id: "mock-provider",
      display_name: "Mock Provider",
      kind: "openai_compatible",
      registered_provider_id: null,
      api_key_env: "MOCK_API_KEY",
      api_key_required: true,
      base_url: "https://example.invalid/v1",
      base_url_env: null,
      wire_api: "chat_completions",
      disable_stream_options: false,
      credential_status: "detected",
      credential_effective_source: "config_file",
      env_shadows_file: false,
      session_credential_present: false,
      config_file_credential_present: true,
      effective_base_url: "https://example.invalid/v1",
      base_url_source: "configured",
    }],
    models: [{
      id: "mock-profile",
      provider_id: "mock-provider",
      display_name: "Mock model",
      model_id: "mock-model",
      enabled: true,
      model_type: { value: "language", source: "aisdk_catalog" },
      capabilities: {
        function_call: { value: "yes", source: "aisdk_catalog" },
        reasoning: { value: "unknown", source: "unknown" },
        vision_input: { value: "unknown", source: "unknown" },
        image_output: { value: "unknown", source: "unknown" },
        image_edit: { value: "unknown", source: "unknown" },
        audio_input: { value: "unknown", source: "unknown" },
        audio_output: { value: "unknown", source: "unknown" },
        structured_output: { value: "unknown", source: "unknown" },
        web_search: { value: "unknown", source: "unknown" },
      },
      selected: true,
      context_window_tokens: 32_768,
      reserved_output_tokens: 4_096,
      context_capacity_source: "conservative_default",
      last_test: null,
      provider_display_name: "Mock Provider",
      selector_status: "ready",
      act_enabled: true,
    }],
    selected_model: {
      id: "mock-profile",
      display_name: "Mock model",
      provider_display_name: "Mock Provider",
      selector_status: "ready",
      tool_calling: "yes",
      act_enabled: true,
    },
    capability_routes: [{
      capability: "agent.chat",
      label: "Chat",
      description: "Ordinary Agent conversation",
      model_id: "mock-profile",
      model_display_name: "Mock model",
      provider_display_name: "Mock Provider",
      model_type: "language",
      required_model_capabilities: [],
      configured: true,
      inherited_from: null,
      compatibility: "ready",
      credential_status: "unchecked",
      consumer_status: "ready",
    }],
    user_environ: {
      path: "/mock/home/.Renviron",
      source: "not_used_for_agent_credentials",
    },
    validation_error: null,
  };
  let agentRuntimeDiagnostics: AgentRuntimeDiagnostics = {
    available: agentRuntimeReady,
    status: agentRuntimeReady ? "ready" : "needs_attention",
    rscript: "/opt/R/4.6.1/bin/Rscript",
    r_version: "4.6.1",
    aisdk_version: agentRuntimeReady ? "1.5.0" : "1.4.12",
    provider_adapters_available: agentRuntimeReady,
    provider_health: agentRuntimeReady ? "ready" : "not_checked",
    dependencies: agentRuntimeReady ? [] : [{
      package: "aisdk",
      status: "incompatible_version",
      installed_version: "1.4.12",
      required_version: "1.5.0",
      resolved_path: "/project/renv/library/R-4.6/aarch64-apple-darwin/aisdk",
      detail: "The installed namespace is older than Rho's Agent API contract.",
      remediation: "CRAN currently provides 1.4.12; install the reviewed >= 1.5.0 source instead of using a CRAN-only command.",
    }, {
      package: "aisdk.providers",
      status: "missing",
      installed_version: null,
      required_version: "0.1.0",
      resolved_path: null,
      detail: "Registered Provider adapters are unavailable.",
      remediation: "Install aisdk.providers in the isolated Agent dependency environment.",
    }],
    error: agentRuntimeReady
      ? null
      : "Agent dependencies need attention. Workspace R remains available.",
  };
  let nextConversation = 2;
  let nextTurn = 2;
  const agentConversations: AgentConversationSummary[] = [{
    conversation_id: "agent-conversation:mock-shared",
    project_root: agentProjectRoot,
    title: "Project direction",
    created_at: agentNow,
    updated_at: agentNow,
    archived_at: null,
    legacy_unthreaded: false,
    turn_count: 1,
    status: "completed",
    latest_turn_id: "agent-turn:mock-1",
    latest_mode: "ask",
    latest_prompt_preview: "What should we inspect first?",
    terminal_reason: "completed",
    pending_request_id: null,
  }];
  const agentTurns: AgentTurnSummary[] = [{
    turn_id: "agent-turn:mock-1",
    conversation_id: "agent-conversation:mock-shared",
    project_root: agentProjectRoot,
    mode: "ask",
    status: "completed",
    started_at: agentNow,
    finished_at: agentNow,
    prompt_preview: "What should we inspect first?",
    model: "mock/provider-model",
    workspace_id_before: "workspace:mock",
    state_revision_before: 4,
    project_revision_before: current.context.project_revision,
    workspace_id_after: "workspace:mock",
    state_revision_after: 4,
    project_revision_after: current.context.project_revision,
    final_message: "Start with the project structure and runtime health.",
    error_message: null,
    pending_request_id: null,
    retry_of_turn_id: null,
    terminal_reason: "completed",
  }];
  const agentDetails = new Map<string, AgentTurnDetail>([["agent-turn:mock-1", {
    turn: agentTurns[0]!,
    events: [{
      id: 1,
      turn_id: "agent-turn:mock-1",
      timestamp: agentNow,
      event_type: "agent.user_prompt",
      title: "You",
      body: "What should we inspect first?",
      status: "completed",
      tool: null,
      request_id: null,
      code: null,
      details_json: "{}",
    }, {
      id: 2,
      turn_id: "agent-turn:mock-1",
      timestamp: agentNow,
      event_type: "agent.final_message",
      title: "Rho",
      body: "Start with the project structure and runtime health.",
      status: "completed",
      tool: null,
      request_id: null,
      code: null,
      details_json: "{}",
    }, {
      id: 3,
      turn_id: "agent-turn:mock-1",
      timestamp: agentNow,
      event_type: "tool.call_completed",
      title: "Proposed file edit",
      body: JSON.stringify({
        kind: "rho.file_edit_proposal",
        operation: "append",
        path: "analysis.R",
        content: "\n# Reviewed by Agent\n",
      }),
      status: "completed",
      tool: "propose_file_edit",
      request_id: null,
      code: null,
      details_json: JSON.stringify({ success: true }),
    }],
    approvals: [],
    context_items: [],
  }]]);
  const notifyWorkbench = () => {
    emitInvalidation("workbench", () => {
      for (const listener of workbenchListeners) listener();
    });
  };
  const notifyKernel = () => {
    emitInvalidation("kernel", () => {
      for (const listener of listeners) listener();
    });
    notifyWorkbench();
  };
  const notifyAgent = () => {
    emitInvalidation("agent", () => {
      for (const listener of agentListeners) listener();
    });
    notifyKernel();
  };
  const profileListeners = new Set<() => void>();
  const notifySurfaces = () => {
    emitInvalidation("surfaces", () => {
      for (const listener of surfaceListeners) listener();
    });
    notifyWorkbench();
  };
  const notifyPluginSurfaces = () => {
    emitInvalidation("plugin-surfaces", () => {
      for (const listener of pluginSurfaceListeners) listener();
    });
  };
  const notifyCheckResults = () => {
    emitInvalidation("check-results", () => {
      for (const listener of checkResultListeners) listener();
    });
  };
  const pluginDocuments = new Map<string, PluginSurfaceDocument>();
  const checkResults = new Map<string, CheckResult>();
  const pluginDocument = (instanceId: string): PluginSurfaceDocument => {
    const existing = pluginDocuments.get(instanceId);
    if (existing != null) return existing;
    const created: PluginSurfaceDocument = {
      contract: "rho.plugin_surface_document.v1",
      revision: 1,
      title: "Differential expression explorer",
      blocks: [{
        kind: "column",
        blocks: [
          { kind: "notice", tone: "info", text: "Workspace plugin · declarative trusted rendering" },
          { kind: "text", text: "Compare a selected contrast without coupling this view to another instance." },
          {
            kind: "tabs",
            active_tab_id: "summary",
            tabs: [{
              tab_id: "summary",
              label: "Summary",
              blocks: [{
                kind: "key_value",
                items: [{ key: "Genes", value: "18,442" }, { key: "Significant", value: "612" }],
              }],
            }, {
              tab_id: "configure",
              label: "Configure",
              blocks: [{
                kind: "field", control_id: "contrast", label: "Contrast", value: "treated-control",
                placeholder: "group-a/group-b", disabled: false, busy: false,
              }],
            }],
          },
          {
            kind: "command_button", control_id: "apply", label: "Apply filter",
            command_id: "analysis.apply", disabled: false, busy: false,
          },
        ],
      }],
    };
    pluginDocuments.set(instanceId, created);
    return created;
  };
  const notifyStudio = () => {
    emitInvalidation("studio", () => {
      for (const listener of studioListeners) listener();
    });
    notifyWorkbench();
  };
  const notifyRuntimes = () => {
    emitInvalidation("runtimes", () => {
      for (const listener of runtimeListeners) listener();
    });
    notifyWorkbench();
  };
  const notifyResources = () => {
    emitInvalidation("resources", () => {
      for (const listener of resourceListeners) listener();
    });
    notifyWorkbench();
  };
  const notifyProfile = () => {
    emitInvalidation("profile", () => {
      for (const listener of profileListeners) listener();
    });
    notifyWorkbench();
  };
  const validateProfileTarget = (target: UiProfileRevisionRequest) => {
    if (
      target.project_id !== profile.profile.project_id ||
      target.expected_profile_revision !== profile.profile.revision
    ) throw new Error("Mock UI Profile request is stale or belongs to another project.");
  };
  const surfaceSpec = (instance: SurfaceInstance): SurfaceInstanceSpec => ({
    instance_id: instance.instance_id,
    surface_id: instance.surface_id,
    origin: instance.origin,
    mode_id: instance.mode_id,
    resource_binding: instance.resource_binding,
    runtime_attachment_intent: instance.runtime_binding == null
      ? profile.profile.surface_instance_specs.find(
          (spec) => spec.instance_id === instance.instance_id,
        )?.runtime_attachment_intent ?? null
      : {
          runtime_provider_id: instance.runtime_binding.runtime_provider_id,
          runtime_instance_id: instance.runtime_binding.runtime_instance_id,
          runtime_kind: instance.runtime_binding.runtime_kind,
        },
    view_group_id: instance.view_group_id,
    view_state: instance.view_state,
  });
  const installProfile = (
    mutate: (draft: ProjectUiProfileSnapshot) => void,
  ): ProjectUiProfileSnapshot => {
    const next = copyProfile(profile) as ProjectUiProfileSnapshot & {
      profile: ProjectUiProfileSnapshot["profile"] & { revision: number };
      load_status: ProjectUiProfileSnapshot["load_status"];
      recovery_detail: string | null;
    };
    mutate(next);
    next.profile.revision += 1;
    next.load_status = "clean";
    next.recovery_detail = null;
    profile = next;
    notifyProfile();
    return copyProfile(profile);
  };
  const syncRuntimeProfile = () => {
    installProfile((next) => {
      const activeId = next.profile.active_studio_scene_id;
      const scenes = next.profile.studio_scenes.map((scene) =>
        scene.scene_id === activeId ? structuredClone(studio.scene) : scene
      );
      (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = scenes;
      (next.profile as { surface_instance_specs: readonly SurfaceInstanceSpec[] })
        .surface_instance_specs = surfaces.catalog.instances.map(surfaceSpec);
      (next.profile as { last_focused_surface_instance_id: string | null })
        .last_focused_surface_instance_id = studio.scene.focused_surface_instance_id;
    });
  };
  const availableIds = () => surfaces.catalog.instances.map((instance) => instance.instance_id);
  const reconcileCurrentStudio = () => {
    const next = reconcileStudio(studio, availableIds(), allocateNode);
    if (next.snapshot_revision !== studio.snapshot_revision) {
      const sceneChanged = JSON.stringify(next.scene) !== JSON.stringify(studio.scene);
      studio = next;
      if (sceneChanged) {
        undo.splice(0);
        redo.splice(0);
      }
      notifyStudio();
    }
  };
  const validateTarget = (request: SurfaceInstanceRequest): number => {
    if (
      request.project_id !== surfaces.project_id ||
      request.expected_project_revision !== surfaces.project_revision
    ) {
      throw new Error("Mock Surface request belongs to another project or revision.");
    }
    const index = surfaces.catalog.instances.findIndex(
      (instance) => instance.instance_id === request.instance_id,
    );
    if (index < 0) throw new Error("Mock Surface instance was not found.");
    const instance = surfaces.catalog.instances[index];
    if (instance == null) throw new Error("Mock Surface instance was not found.");
    if (
      instance.activation_generation !== request.activation_generation ||
      instance.surface_revision !== request.expected_surface_revision
    ) {
      throw new Error("Mock Surface request is stale.");
    }
    return index;
  };
  const installSurfaces = (
    instances: readonly SurfaceInstance[],
    persistProfile = true,
  ) => {
    const next = copySurfaces(surfaces);
    (next as { snapshot_revision: number }).snapshot_revision += 1;
    (next.catalog as unknown as { instances: SurfaceInstance[] }).instances = [...instances];
    surfaces = next;
    notifySurfaces();
    reconcileCurrentStudio();
    if (persistProfile) syncRuntimeProfile();
    return copySurfaces(surfaces);
  };
  const bindingFor = (runtime: RuntimeDescriptor): RuntimeBinding => ({
    runtime_provider_id: runtime.runtime_provider_id,
    runtime_instance_id: runtime.runtime_instance_id,
    runtime_kind: runtime.runtime_kind,
    project_id: runtime.project_id,
    activation_generation: runtime.activation_generation,
    state_revision: runtime.state_revision,
    attach_capabilities: runtime.attach_capabilities,
  });
  const installRuntimes = (instances: readonly RuntimeDescriptor[]) => {
    runtimes = {
      ...copyRuntimes(runtimes),
      snapshot_revision: runtimes.snapshot_revision + 1,
      instances: [...instances],
    };
    notifyRuntimes();
    return copyRuntimes(runtimes);
  };
  const installResources = (nextResources: readonly ResourceDescriptor[]) => {
    resources = {
      ...copyResources(resources),
      snapshot_revision: resources.snapshot_revision + 1,
      resources: [...nextResources],
    };
    notifyResources();
    return copyResources(resources);
  };
  const validateResource = (target: ResourceTarget, exact: boolean): ResourceDescriptor => {
    if (
      target.project_id !== resources.project_id ||
      target.expected_project_revision !== resources.project_revision
    ) throw new Error("Mock Resource belongs to another project or revision.");
    const descriptor = resources.resources.find((resource) =>
      resource.resource_provider_id === target.resource_provider_id &&
      resource.resource_kind === target.resource_kind &&
      resource.resource_id === target.resource_id
    );
    if (descriptor == null) throw new Error("Mock Resource was not resolved.");
    if (exact && descriptor.resource_revision !== target.expected_resource_revision) {
      throw new Error("Mock Resource revision is stale.");
    }
    return descriptor;
  };
  const contentShape = (
    descriptor: ResourceDescriptor,
    document: NonNullable<ReturnType<typeof documents.get>>,
  ): ResourceContent => ({
    contract: "rho.ui.resource-content.v1",
    descriptor,
    consistency: "shared_document",
    document_revision: document.documentRevision,
    base_resource_revision: document.baseResourceRevision,
    dirty: document.dirty,
    stale: descriptor.status !== "ready" ||
      descriptor.resource_revision !== document.baseResourceRevision,
    content_encoding: "utf-8",
    content: document.content,
  });
  const rebindSourceSurfaces = (descriptor: ResourceDescriptor) => {
    const instances = surfaces.catalog.instances.map((instance) =>
      instance.surface_id === "rho.file-source" &&
      instance.resource_binding?.resource_provider_id === descriptor.resource_provider_id &&
      instance.resource_binding.resource_kind === descriptor.resource_kind &&
      instance.resource_binding.resource_id === descriptor.resource_id
        ? {
            ...instance,
            surface_revision: instance.surface_revision + 1,
            resource_binding: {
              resource_provider_id: descriptor.resource_provider_id,
              resource_kind: descriptor.resource_kind,
              resource_id: descriptor.resource_id,
              resource_revision: descriptor.resource_revision,
            } satisfies ResourceBinding,
          }
        : instance
    );
    if (JSON.stringify(instances) !== JSON.stringify(surfaces.catalog.instances)) {
      installSurfaces(instances);
    }
  };
  const validateRuntime = (request: RuntimeInstanceRequest): number => {
    if (
      request.project_id !== runtimes.project_id ||
      request.expected_project_revision !== runtimes.project_revision
    ) throw new Error("Mock Runtime request belongs to another project or revision.");
    const index = runtimes.instances.findIndex(
      (runtime) => runtime.runtime_instance_id === request.runtime_instance_id,
    );
    const runtime = runtimes.instances[index];
    if (
      runtime == null || runtime.runtime_provider_id !== request.runtime_provider_id ||
      runtime.activation_generation !== request.activation_generation ||
      runtime.state_revision !== request.expected_state_revision
    ) throw new Error("Mock Runtime request is stale or unavailable.");
    return index;
  };
  const attachRuntime = (request: RuntimeAttachmentRequest) => {
    const runtimeIndex = validateRuntime(request.runtime);
    const surfaceIndex = validateTarget(request.surface);
    const runtime = runtimes.instances[runtimeIndex];
    const surface = surfaces.catalog.instances[surfaceIndex];
    if (runtime == null || surface == null) throw new Error("Mock attachment target vanished.");
    if (!runtime.attach_capabilities.includes("console.attach")) {
      throw new Error("Mock Runtime cannot attach a Console.");
    }
    const instances = [...surfaces.catalog.instances];
    instances[surfaceIndex] = {
      ...surface,
      surface_revision: surface.surface_revision + 1,
      runtime_binding: bindingFor(runtime),
    };
    return installSurfaces(instances);
  };
  const detachRuntime = (request: RuntimeDetachRequest) => {
    const surfaceIndex = validateTarget(request.surface);
    const surface = surfaces.catalog.instances[surfaceIndex];
    if (surface == null) throw new Error("Mock attachment target vanished.");
    const instances = [...surfaces.catalog.instances];
    instances[surfaceIndex] = {
      ...surface,
      surface_revision: surface.surface_revision + 1,
      runtime_binding: null,
    };
    return installSurfaces(instances);
  };
  const validateStudio = (request: StudioRevisionRequest) => {
    reconcileCurrentStudio();
    if (
      request.project_id !== studio.project_id ||
      request.expected_project_revision !== studio.project_revision ||
      request.expected_layout_revision !== studio.scene.layout_revision
    ) {
      throw new Error("Mock Studio request is stale or belongs to another project.");
    }
  };
  const installScene = (scene: SceneState, persistProfile = true): StudioRuntimeSnapshot => {
    const placed = collectSceneInstances(scene);
    const missing = [...placed].find((id) => !availableIds().includes(id));
    if (missing != null) throw new Error(`Mock Studio instance ${missing} is unavailable.`);
    studio = {
      ...studio,
      snapshot_revision: studio.snapshot_revision + 1,
      scene,
      unplaced_instance_ids: availableIds().filter((id) => !placed.has(id)).sort(),
      can_undo: undo.length > 0,
      can_redo: redo.length > 0,
    };
    notifyStudio();
    if (persistProfile) syncRuntimeProfile();
    return copyStudio(studio);
  };
  const validateSceneAvailability = (scene: SceneState) => {
    const placed = collectSceneInstances(scene);
    const missing = [...placed].find((id) => !availableIds().includes(id));
    if (missing != null) throw new Error(`Mock Studio instance ${missing} is unavailable.`);
  };
  const captureProjectBundle = () => ({
    current: copySnapshot(current),
    surfaces: copySurfaces(surfaces),
    studio: copyStudio(studio),
    runtimes: copyRuntimes(runtimes),
    resources: copyResources(resources),
    profile: copyProfile(profile),
    persistedContent: structuredClone(persistedContent),
    documents: structuredClone(documents),
    agentConversations: structuredClone(agentConversations),
    agentTurns: structuredClone(agentTurns),
    agentDetails: structuredClone(agentDetails),
    pluginDocuments: structuredClone(pluginDocuments),
    checkResults: structuredClone(checkResults),
  });
  type MockProjectBundle = ReturnType<typeof captureProjectBundle>;
  const initialProjectBundle = captureProjectBundle();
  let activeProjectPath = current.project.display_path;
  const projectBundles = new Map<string, MockProjectBundle>();
  const replaceMap = <K, V>(target: Map<K, V>, source: Map<K, V>) => {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
  };
  const reprojectBundle = (source: MockProjectBundle, path: string): MockProjectBundle => {
    const bundle = structuredClone(source);
    const projectId = `project:mock:${encodeURIComponent(path)}`;
    bundle.current = {
      ...bundle.current,
      snapshot_revision: 1,
      project: {
        project_id: projectId,
        display_label: projectLabel(path),
        display_path: path,
      },
      context: {
        ...bundle.current.context,
        project_id: projectId,
        project_revision: 1,
        selection: null,
        active_operations: [],
      },
    };
    bundle.surfaces = {
      ...bundle.surfaces,
      snapshot_revision: 1,
      project_id: projectId,
      project_revision: 1,
      catalog: {
        ...bundle.surfaces.catalog,
        instances: bundle.surfaces.catalog.instances.map((instance) => ({
          ...instance,
          project_id: projectId,
          runtime_binding: instance.runtime_binding == null
            ? null
            : { ...instance.runtime_binding, project_id: projectId },
        })),
      },
    };
    bundle.studio = {
      ...bundle.studio,
      snapshot_revision: 1,
      project_id: projectId,
      project_revision: 1,
      scene: { ...bundle.studio.scene, project_id: projectId, layout_revision: 1 },
    };
    bundle.runtimes = {
      ...bundle.runtimes,
      snapshot_revision: 1,
      project_id: projectId,
      project_revision: 1,
      instances: bundle.runtimes.instances.map((runtime) => ({ ...runtime, project_id: projectId })),
    };
    bundle.resources = {
      ...bundle.resources,
      snapshot_revision: 1,
      project_id: projectId,
      project_revision: 1,
      resources: bundle.resources.resources.map((resource) => ({ ...resource, project_id: projectId })),
    };
    bundle.profile = {
      ...bundle.profile,
      profile: {
        ...bundle.profile.profile,
        project_id: projectId,
        revision: 1,
        studio_scenes: bundle.profile.profile.studio_scenes.map((scene) => ({
          ...scene,
          project_id: projectId,
          layout_revision: 1,
        })),
        vibe_pages: bundle.profile.profile.vibe_pages.map((page) => ({
          ...page,
          project_id: projectId,
          page_revision: 1,
        })),
      },
      immutable_scene_presets: bundle.profile.immutable_scene_presets.map((preset) => ({
        ...preset,
        scene: { ...preset.scene, project_id: projectId },
      })),
    };
    bundle.agentConversations = bundle.agentConversations.map((conversation) => ({
      ...conversation,
      project_root: path,
    }));
    bundle.agentTurns = bundle.agentTurns.map((turn) => ({
      ...turn,
      project_root: path,
      project_revision_before: 1,
      project_revision_after: 1,
    }));
    bundle.agentDetails = new Map([...bundle.agentDetails].map(([id, detail]) => [id, {
      ...detail,
      turn: {
        ...detail.turn,
        project_root: path,
        project_revision_before: 1,
        project_revision_after: 1,
      },
    }]));
    return bundle;
  };
  const activateProjectBundle = (
    source: MockProjectBundle,
    projectRevision: number,
  ): MockProjectBundle => {
    const bundle = structuredClone(source);
    bundle.current = {
      ...bundle.current,
      context: { ...bundle.current.context, project_revision: projectRevision },
    };
    bundle.surfaces = { ...bundle.surfaces, project_revision: projectRevision };
    bundle.studio = { ...bundle.studio, project_revision: projectRevision };
    bundle.runtimes = { ...bundle.runtimes, project_revision: projectRevision };
    bundle.resources = { ...bundle.resources, project_revision: projectRevision };
    return bundle;
  };
  const installProjectBundle = (bundle: MockProjectBundle) => {
    current = copySnapshot(bundle.current);
    surfaces = copySurfaces(bundle.surfaces);
    studio = copyStudio(bundle.studio);
    runtimes = copyRuntimes(bundle.runtimes);
    resources = copyResources(bundle.resources);
    profile = copyProfile(bundle.profile);
    replaceMap(persistedContent, bundle.persistedContent);
    replaceMap(documents, bundle.documents);
    agentConversations.splice(0, agentConversations.length, ...structuredClone(bundle.agentConversations));
    agentTurns.splice(0, agentTurns.length, ...structuredClone(bundle.agentTurns));
    replaceMap(agentDetails, bundle.agentDetails);
    replaceMap(pluginDocuments, bundle.pluginDocuments);
    replaceMap(checkResults, bundle.checkResults);
  };
  const notifyProjectChanged = () => {
    notifySurfaces();
    notifyPluginSurfaces();
    notifyStudio();
    notifyRuntimes();
    notifyResources();
    notifyProfile();
    notifyAgent();
    notifyCheckResults();
  };
  const cancelledProjectSwitch = (): ProjectSwitchResponse => ({
    status: "cancelled",
    project: null,
    session: {},
    unavailable: null,
    blocker: null,
    reason_code: null,
    message: null,
    restored_root: null,
    restart_required: false,
  });
  // SETTINGS-UX2B mock parity helpers mirroring desktop/src-tauri/src/agent_llm.rs.
  const sameCapabilityEvidence = (
    left: AgentLlmSettingsView["models"][number]["capabilities"],
    right: AgentLlmSettingsView["models"][number]["capabilities"],
  ): boolean => {
    const names = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...names].every((name) =>
      left[name]?.value === right[name]?.value && left[name]?.source === right[name]?.source
    );
  };
  const assertAgentConfigGate = (request: {
    readonly expectedRevision: number;
    readonly expectedConfigSnapshotId: string;
  }) => {
    if (request.expectedRevision !== agentLlmSettings.revision
        || request.expectedConfigSnapshotId !== agentLlmSettings.config_store.config_snapshot_id) {
      throw new Error("Model settings or config.yaml changed while this editor was open. Reload and try again.");
    }
  };
  const nextAgentConfigSnapshotId = () =>
    `mock-config-snapshot-${++agentConfigSnapshotGeneration}`;
  const applyContextCapacity = (request: AgentContextCapacityRequest): AgentLlmSettingsView => {
    assertAgentConfigGate(request);
    if (request.contextWindowTokens < 4_096
        || request.reservedOutputTokens < 256
        || request.reservedOutputTokens >= request.contextWindowTokens) {
      throw new Error("Reserved output tokens must be at least 256 and smaller than the context window.");
    }
    const model = agentLlmSettings.models.find((candidate) => candidate.id === request.modelId);
    if (model == null) throw new Error(`Unknown model: ${request.modelId}`);
    agentLlmSettings = {
      ...agentLlmSettings,
      revision: agentLlmSettings.revision + 1,
      config_store: {
        ...agentLlmSettings.config_store,
        config_snapshot_id: nextAgentConfigSnapshotId(),
      },
      models: agentLlmSettings.models.map((candidate) => candidate.id === request.modelId ? {
        ...candidate,
        context_window_tokens: request.contextWindowTokens,
        reserved_output_tokens: request.reservedOutputTokens,
        context_capacity_source: "user_declared",
      } : candidate),
    };
    return structuredClone(agentLlmSettings);
  };
  return {
    source: "mock",
    async prepareWorkspace(
      chooseRscript = false,
      onProgress?: WorkspacePreparationProgressListener,
    ) {
      void chooseRscript;
      emitPreparationProgress(onProgress, { stage: "runtime", state: "active" });
      if (startupFrame === "runtime-active") {
        return await new Promise<WorkspacePreparation>(() => undefined);
      }
      emitPreparationProgress(onProgress, {
        stage: "runtime",
        state: "complete",
        r_version: "4.5.1",
      });
      emitPreparationProgress(onProgress, { stage: "workspace", state: "active" });
      if (startupFrame === "workspace-active") {
        return await new Promise<WorkspacePreparation>(() => undefined);
      }
      emitPreparationProgress(onProgress, {
        stage: "workspace",
        state: "complete",
        workspace_pid: 4_242,
      });
      emitPreparationProgress(onProgress, { stage: "project", state: "active" });
      if (startupFrame === "project-active") {
        return await new Promise<WorkspacePreparation>(() => undefined);
      }
      if (startupFrame === "project-attention") {
        return {
          status: "needs_attention",
          phase: "project_restore_incomplete",
          workspace_ready: true,
          restored_project_status: "unavailable",
          issue: {
            code: "PROJECT_RESTORE_INCOMPLETE",
            title: "The saved project could not be restored",
            message: "Workspace R is ready. Choose or reopen a project to continue.",
            technical_detail: "The deterministic browser fixture holds project recovery for review.",
          },
        } as const;
      }
      emitPreparationProgress(onProgress, {
        stage: "project",
        state: "complete",
        project_root: boundedProgressText(current.project.display_path),
      });
      return {
        status: "ready",
        phase: "project_ready",
        workspace_ready: true,
        restored_project_status: "ready",
        issue: null,
      } as const;
    },
    async openProject(path: string) {
      if (!path || [...path].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })) {
        throw new Error("Mock project path is invalid.");
      }
      projectBundles.set(activeProjectPath, captureProjectBundle());
      const stored = projectBundles.get(path) ?? reprojectBundle(initialProjectBundle, path);
      const nextProjectRevision = Math.max(
        current.context.project_revision,
        stored.current.context.project_revision,
      ) + 1;
      const next = activateProjectBundle(stored, nextProjectRevision);
      installProjectBundle(next);
      activeProjectPath = path;
      projectBundles.set(path, captureProjectBundle());
      notifyProjectChanged();
      return {
        status: "ready",
        project: { root: path, files: [], truncated: false },
        session: {},
        unavailable: null,
        blocker: null,
        reason_code: null,
        message: null,
        restored_root: null,
        restart_required: false,
      } satisfies ProjectSwitchResponse;
    },
    async pickProjectDirectory() {
      return cancelledProjectSwitch();
    },
    async loadWorkbenchProjection() {
      projectionGeneration += 1;
      return {
        contract: "rho.ui.workbench-projection.v1",
        contract_major: 1,
        projection_generation: projectionGeneration,
        project_id: current.project.project_id,
        revisions: {
          project_revision: current.context.project_revision,
          kernel_snapshot_revision: current.snapshot_revision,
          surface_snapshot_revision: surfaces.snapshot_revision,
          studio_snapshot_revision: studio.snapshot_revision,
          layout_revision: studio.scene.layout_revision,
          runtime_snapshot_revision: runtimes.snapshot_revision,
          resource_snapshot_revision: resources.snapshot_revision,
          profile_revision: profile.profile.revision,
        },
        kernel: copySnapshot(current),
        surfaces: copySurfaces(surfaces),
        studio: copyStudio(studio),
        runtimes: copyRuntimes(runtimes),
        resources: copyResources(resources),
        profile: copyProfile(profile),
      } satisfies WorkbenchProjection;
    },
    subscribeWorkbenchInvalidated(listener: () => void): Unsubscribe {
      workbenchListeners.add(listener);
      return () => workbenchListeners.delete(listener);
    },
    async loadSnapshot() {
      return copySnapshot(current);
    },
    async appInfo() {
      return {
        version: "0.4.1-dev.17",
        channel: "development",
        commit: "mock-build",
        platform: "browser-mock",
        executable_path: "unavailable",
        frontend_entry: "mock",
        website_url: "https://yulab-smu.top/Rho/",
        source_url: "https://github.com/YuLab-SMU/Rho",
        runtime: {
          rscript: "/mock/Rscript",
          r_version: "4.5.1",
          agent_available: true,
          aisdk_version: "mock",
        },
      } satisfies AppInfo;
    },
    async setSelection(request: SetUiSelectionRequest) {
      if (
        request.project_id !== current.project.project_id ||
        request.expected_project_revision !== current.context.project_revision ||
        request.expected_snapshot_revision !== current.snapshot_revision
      ) {
        throw new Error("Mock UI selection request is stale.");
      }
      current = copySnapshot(current);
      (current.context as { selection: typeof request.selection }).selection = request.selection;
      (current as { snapshot_revision: number }).snapshot_revision += 1;
      notifyKernel();
      return copySnapshot(current);
    },
    subscribeInvalidated(listener: () => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: UiKernelSnapshot) {
      current = copySnapshot(next);
      notifyKernel();
    },
    async loadSurfaces() {
      return copySurfaces(surfaces);
    },
    async openSurface(request: OpenSurfaceRequest) {
      if (
        request.project_id !== surfaces.project_id ||
        request.expected_project_revision !== surfaces.project_revision ||
        request.expected_layout_revision !== studio.scene.layout_revision
      ) {
        throw new Error("Mock Surface open request is stale.");
      }
      const factory = surfaces.catalog.factories.find(
        (candidate) => candidate.definition.surface_id === request.surface_id,
      );
      if (factory == null) throw new Error("Mock Surface factory is unavailable.");
      if (request.resource_binding != null) {
        const resource = resources.resources.find((candidate) =>
          candidate.resource_provider_id === request.resource_binding?.resource_provider_id &&
          candidate.resource_kind === request.resource_binding.resource_kind &&
          candidate.resource_id === request.resource_binding.resource_id
        );
        if (
          resource == null || resource.status !== "ready" ||
          request.resource_binding.resource_revision !== resource.resource_revision
        ) throw new Error("Mock bound Resource is stale or unavailable.");
      }
      const exact = surfaces.catalog.instances.find(
        (instance) =>
          instance.lifecycle_state !== "placeholder" &&
          instance.surface_id === request.surface_id &&
          instance.activation_generation === factory.activation_generation &&
          instance.mode_id === request.mode_id &&
          JSON.stringify(instance.resource_binding) ===
            JSON.stringify(request.resource_binding) &&
          JSON.stringify(instance.runtime_binding) ===
            JSON.stringify(request.runtime_binding) &&
          instance.view_group_id === request.view_group_id &&
          JSON.stringify(instance.view_state) === JSON.stringify(request.view_state),
      );
      if (request.instance_disposition === "reuse_exact" && exact != null) {
        return copySurfaces(surfaces);
      }
      if (
        factory.definition.instance_policy === "singleton" &&
        surfaces.catalog.instances.some(
          (instance) =>
            instance.surface_id === request.surface_id &&
            instance.lifecycle_state !== "placeholder",
        )
      ) {
        throw new Error("Mock singleton Surface already exists.");
      }
      const instance: SurfaceInstance = {
        instance_id: `surface-instance:mock-${nextInstance++}`,
        surface_id: request.surface_id,
        project_id: request.project_id,
        origin: factory.definition.origin,
        activation_generation: factory.activation_generation,
        surface_revision: 1,
        mode_id: request.mode_id,
        resource_binding: request.resource_binding,
        runtime_binding: request.runtime_binding,
        view_group_id: request.view_group_id,
        view_state: request.view_state,
        lifecycle_state: "active",
      };
      return installSurfaces([...surfaces.catalog.instances, instance]);
    },
    async updateSurface(request: UpdateSurfaceRequest) {
      const index = validateTarget(request.target);
      const instances = [...surfaces.catalog.instances];
      const current = instances[index];
      if (current == null) throw new Error("Mock Surface instance was not found.");
      const mutable = structuredClone(current) as {
        mode_id: string | null;
        resource_binding: typeof current.resource_binding;
        runtime_binding: typeof current.runtime_binding;
        view_group_id: string | null;
        view_state: unknown;
        lifecycle_state: typeof current.lifecycle_state;
        surface_revision: number;
      };
      switch (request.mutation.kind) {
        case "set_mode": mutable.mode_id = request.mutation.mode_id; break;
        case "set_view_state": mutable.view_state = request.mutation.view_state; break;
        case "set_lifecycle": mutable.lifecycle_state = request.mutation.state; break;
        case "bind_resource": {
          const binding = request.mutation.binding;
          if (binding != null) {
            const resource = resources.resources.find((candidate) =>
              candidate.resource_provider_id === binding.resource_provider_id &&
              candidate.resource_kind === binding.resource_kind &&
              candidate.resource_id === binding.resource_id
            );
            if (
              resource == null || resource.status !== "ready" ||
              binding.resource_revision !== resource.resource_revision
            ) throw new Error("Mock bound Resource is stale or unavailable.");
          }
          mutable.resource_binding = binding;
          break;
        }
        case "bind_runtime": mutable.runtime_binding = request.mutation.binding; break;
        case "set_view_group": mutable.view_group_id = request.mutation.view_group_id; break;
      }
      mutable.surface_revision += 1;
      instances[index] = mutable as SurfaceInstance;
      if (
        request.mutation.kind === "set_view_state" &&
        current.view_group_id != null && current.resource_binding != null
      ) {
        for (let siblingIndex = 0; siblingIndex < instances.length; siblingIndex += 1) {
          if (siblingIndex === index) continue;
          const sibling = instances[siblingIndex];
          if (
            sibling == null || sibling.lifecycle_state === "placeholder" ||
            sibling.view_group_id !== current.view_group_id ||
            sibling.resource_binding?.resource_provider_id !== current.resource_binding.resource_provider_id ||
            sibling.resource_binding.resource_kind !== current.resource_binding.resource_kind ||
            sibling.resource_binding.resource_id !== current.resource_binding.resource_id
          ) continue;
          instances[siblingIndex] = {
            ...sibling,
            view_state: request.mutation.view_state,
            surface_revision: sibling.surface_revision + 1,
          };
        }
      }
      return installSurfaces(instances);
    },
    async closeSurface(request: SurfaceInstanceRequest) {
      const index = validateTarget(request);
      return installSurfaces(surfaces.catalog.instances.filter((_, at) => at !== index));
    },
    async suspendSurface(request: SurfaceInstanceRequest) {
      const index = validateTarget(request);
      const instances = [...surfaces.catalog.instances];
      const current = instances[index];
      if (current == null) throw new Error("Mock Surface instance was not found.");
      if (current.lifecycle_state !== "active" && current.lifecycle_state !== "hidden") {
        throw new Error("Mock Surface cannot be suspended from its current state.");
      }
      instances[index] = {
        ...current,
        surface_revision: current.surface_revision + 1,
        lifecycle_state: "suspended",
      };
      return installSurfaces(instances);
    },
    async resumeSurface(request: SurfaceInstanceRequest) {
      const index = validateTarget(request);
      const instances = [...surfaces.catalog.instances];
      const current = instances[index];
      if (current == null) throw new Error("Mock Surface instance was not found.");
      if (current.lifecycle_state !== "suspended") {
        throw new Error("Mock Surface is not suspended.");
      }
      instances[index] = {
        ...current,
        surface_revision: current.surface_revision + 1,
        lifecycle_state: "active",
      };
      return installSurfaces(instances);
    },
    subscribeSurfacesInvalidated(listener: () => void): Unsubscribe {
      surfaceListeners.add(listener);
      return () => surfaceListeners.delete(listener);
    },
    async loadPluginSurfaceDocument(
      request: PluginSurfaceDocumentRequest,
    ): Promise<PluginSurfaceDocumentView> {
      const index = validateTarget(request.target);
      const instance = surfaces.catalog.instances[index];
      if (instance == null || instance.origin.kind !== "workspace_plugin") {
        throw new Error("Mock workspace Surface route is unavailable.");
      }
      if (
        request.expected_layout_revision !== studio.scene.layout_revision ||
        request.expected_page_revision != null
      ) throw new Error("Mock workspace Surface placement is stale.");
      return {
        project_id: instance.project_id,
        instance_id: instance.instance_id,
        surface_id: instance.surface_id,
        surface_revision: instance.surface_revision,
        document: structuredClone(pluginDocument(instance.instance_id)),
        provenance: { origin: "trusted_surface", source: "mock" },
      };
    },
    async dispatchPluginSurfaceEvent(
      request: PluginSurfaceEventRequest,
    ): Promise<PluginSurfaceEventResult> {
      const loaded = await this.loadPluginSurfaceDocument(request);
      if (loaded.document.revision !== request.expected_document_revision) {
        throw new Error("Mock workspace Surface document is stale.");
      }
      const next = structuredClone(loaded.document) as PluginSurfaceDocument & { revision: number };
      next.revision += 1;
      if (request.control_id === "contrast" && typeof request.value === "string") {
        const column = next.blocks[0];
        if (column?.kind === "column") {
          const field = column.blocks.find((block) =>
            block.kind === "field" && block.control_id === "contrast"
          );
          if (field?.kind === "field") {
            (field as { value: string }).value = request.value;
          }
        }
      }
      pluginDocuments.set(request.target.instance_id, next);
      notifyPluginSurfaces();
      return {
        event_id: `mock-surface-event:${next.revision}`,
        status: "completed",
        document: structuredClone(next),
        command_result: null,
        provenance: { origin: "trusted_surface", source: "mock" },
      };
    },
    subscribePluginSurfacesInvalidated(listener: () => void): Unsubscribe {
      pluginSurfaceListeners.add(listener);
      return () => pluginSurfaceListeners.delete(listener);
    },
    async runCheckProject(request: CheckRunRequest) {
      if (
        request.project_id !== current.project.project_id ||
        request.expected_project_revision !== current.context.project_revision
      ) throw new Error("Mock Check request is stale.");
      if (search.get("check") === "dirty") {
        throw new Error("Save modified source files before checking: analysis.R");
      }
      const suffix = nextCheck++;
      const resultId = `check-result:mock-${suffix}`;
      const result: CheckResult = {
        contract: "rho.ui.check-result.v1",
        result_id: resultId,
        project_id: request.project_id,
        project_revision: request.expected_project_revision,
        snapshot: {
          contract: "rho.ui.check-project.snapshot.v1",
          snapshot_id: `check-snapshot:mock-${suffix}`,
          project_id: request.project_id,
          project_revision: request.expected_project_revision,
          captured_at: "2026-08-22T12:00:00Z",
          files: [{
            path: "analysis.R",
            size_bytes: 48,
            content_sha256: "c".repeat(64),
            skipped: false,
            skip_reason: null,
          }],
          source_bytes: 48,
          renv_lock_sha256: "d".repeat(64),
          truncated: false,
          limitations: [],
        },
        ruleset_digest: "e".repeat(64),
        generated_at: "2026-08-22T12:00:01Z",
        status: "findings",
        findings: [{
          rule_id: "rho.repro.v1.randomness.rng_without_seed",
          rule_version: 1,
          origin: { kind: "application", component_id: "rho.check.core" },
          activation_generation: 1,
          severity: "warning",
          category: "randomness",
          title: "Random result may change",
          summary: "Random-number generation was found without a nearby fixed seed.",
          remediation: "Set a deliberate seed before the random analysis.",
          evidence: [{
            kind: "source_range",
            path: "analysis.R",
            line: 2,
            column: 1,
            excerpt: "sample(mtcars$mpg)",
          }],
          limitations: [],
        }, {
          rule_id: "check.rule.local.metadata.naming",
          rule_version: 1,
          origin: {
            kind: "workspace_plugin",
            plugin_id: "org.example.project-checks",
            package_digest: "f".repeat(64),
          },
          activation_generation: 3,
          severity: "info",
          category: "project structure",
          title: "Project metadata can be clearer",
          summary: "The workspace rule pack found a project-specific convention to review.",
          remediation: "Review the project README before sharing this analysis.",
          evidence: [{ kind: "note", text: "README metadata review" }],
          limitations: [],
        }],
        coverage: {
          files_scanned: 1,
          files_skipped: 0,
          core_rules: 22,
          plugin_rule_packs: 1,
          plugin_rule_failures: 0,
        },
        truncated: false,
        limitations: [],
      };
      checkResults.set(resultId, result);
      notifyCheckResults();
      return { result: structuredClone(result) };
    },
    async loadCheckResult(request: CheckResultRequest) {
      if (
        request.project_id !== current.project.project_id ||
        request.expected_project_revision !== current.context.project_revision
      ) throw new Error("Mock Check result request is stale.");
      const result = checkResults.get(request.result_id);
      if (result == null) throw new Error("Check result is unavailable; run Check project again");
      return structuredClone(result);
    },
    subscribeCheckResultsInvalidated(listener: () => void): Unsubscribe {
      checkResultListeners.add(listener);
      return () => checkResultListeners.delete(listener);
    },
    publishSurfaces(next: SurfaceRuntimeSnapshot) {
      surfaces = copySurfaces(next);
      notifySurfaces();
      reconcileCurrentStudio();
    },
    async loadStudio() {
      reconcileCurrentStudio();
      return copyStudio(studio);
    },
    async applyStudio(request: SceneEditRequest) {
      validateStudio(request);
      const previous = copyStudio(studio).scene;
      const candidate = applySceneEdit(studio.scene, request.edit, allocateNode);
      validateSceneAvailability(candidate);
      undo.push(previous);
      if (undo.length > 64) undo.shift();
      redo.splice(0);
      return installScene(candidate);
    },
    async undoStudio(request: StudioRevisionRequest) {
      validateStudio(request);
      const target = undo.pop();
      if (target == null) throw new Error("Mock Studio undo history is empty.");
      redo.push(copyStudio(studio).scene);
      const restored = structuredClone(target) as SceneState & { layout_revision: number };
      restored.layout_revision = studio.scene.layout_revision + 1;
      return installScene(restored);
    },
    async redoStudio(request: StudioRevisionRequest) {
      validateStudio(request);
      const target = redo.pop();
      if (target == null) throw new Error("Mock Studio redo history is empty.");
      undo.push(copyStudio(studio).scene);
      const restored = structuredClone(target) as SceneState & { layout_revision: number };
      restored.layout_revision = studio.scene.layout_revision + 1;
      return installScene(restored);
    },
    subscribeStudioInvalidated(listener: () => void): Unsubscribe {
      studioListeners.add(listener);
      return () => studioListeners.delete(listener);
    },
    publishStudio(next: StudioRuntimeSnapshot) {
      studio = copyStudio(next);
      undo.splice(0);
      redo.splice(0);
      notifyStudio();
    },
    async loadUiProfile() {
      return copyProfile(profile);
    },
    async setUiProfileMode(request: UiProfileSetModeRequest) {
      validateProfileTarget(request.target);
      return installProfile((next) => {
        (next.profile as { active_mode: typeof request.mode }).active_mode = request.mode;
      });
    },
    async selectUiProfileScene(request: UiProfileSelectSceneRequest) {
      validateProfileTarget(request.target);
      const scene = profile.profile.studio_scenes.find(
        (candidate) => candidate.scene_id === request.scene_id,
      );
      if (scene == null) throw new Error("Mock Studio Scene was not found.");
      const snapshot = installProfile((next) => {
        (next.profile as { active_studio_scene_id: string | null }).active_studio_scene_id =
          request.scene_id;
      });
      undo.splice(0);
      redo.splice(0);
      installScene(structuredClone(scene), false);
      return snapshot;
    },
    async selectUiProfilePage(request: UiProfileSelectPageRequest) {
      validateProfileTarget(request.target);
      if (!profile.profile.vibe_pages.some((page) => page.page_id === request.page_id)) {
        throw new Error("Mock Vibe Page was not found.");
      }
      return installProfile((next) => {
        (next.profile as { active_vibe_page_id: string | null }).active_vibe_page_id =
          request.page_id;
      });
    },
    async applyVibePage(request: VibePageMutationRequest) {
      validateProfileTarget(request.target);
      const current = profile.profile.vibe_pages.find((page) => page.page_id === request.page_id);
      if (current == null) throw new Error("Mock Vibe Page was not found.");
      const page = applyVibePageMutation(current, request.expected_page_revision, request.mutation);
      return installProfile((next) => {
        (next.profile as { vibe_pages: readonly VibePage[] }).vibe_pages =
          next.profile.vibe_pages.map((candidate) =>
            candidate.page_id === page.page_id ? page : candidate
          );
      });
    },
    async exportVibePage(request: VibePageExportRequest) {
      if (
        request.project_id !== profile.profile.project_id ||
        request.expected_profile_revision !== profile.profile.revision
      ) throw new Error("Mock Vibe Page export has a stale Profile target.");
      const page = profile.profile.vibe_pages.find((candidate) => candidate.page_id === request.page_id);
      if (page == null || page.page_revision !== request.expected_page_revision) {
        throw new Error("Mock Vibe Page export has a stale Page target.");
      }
      return exportVibePage(page);
    },
    async duplicateUiProfileScene(request: UiProfileSceneLabelRequest) {
      validateProfileTarget(request.target);
      const source = profile.profile.studio_scenes.find(
        (candidate) => candidate.scene_id === request.scene_id,
      );
      if (source == null) throw new Error("Mock Studio Scene was not found.");
      const scene = structuredClone(source) as SceneState & {
        scene_id: string;
        label: string;
        layout_revision: number;
      };
      scene.scene_id = `scene:mock-${nextScene++}`;
      scene.label = request.label;
      scene.layout_revision = 1;
      const snapshot = installProfile((next) => {
        (next.profile as { active_studio_scene_id: string | null }).active_studio_scene_id =
          scene.scene_id;
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = [
          ...next.profile.studio_scenes,
          scene,
        ];
      });
      undo.splice(0);
      redo.splice(0);
      installScene(scene, false);
      return snapshot;
    },
    async saveUiProfileScene(request: UiProfileSceneTargetRequest) {
      validateProfileTarget(request.target);
      if (studio.scene.scene_id !== request.scene_id) {
        throw new Error("Only the active Mock Studio Scene can be saved.");
      }
      return installProfile((next) => {
        const scenes = next.profile.studio_scenes.map((scene) =>
          scene.scene_id === request.scene_id ? structuredClone(studio.scene) : scene
        );
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = scenes;
      });
    },
    async renameUiProfileScene(request: UiProfileSceneLabelRequest) {
      validateProfileTarget(request.target);
      if (!request.label.trim()) throw new Error("Mock Studio Scene label is empty.");
      let found = false;
      const snapshot = installProfile((next) => {
        const scenes = next.profile.studio_scenes.map((scene) => {
          if (scene.scene_id !== request.scene_id) return scene;
          found = true;
          return { ...scene, label: request.label };
        });
        if (!found) throw new Error("Mock Studio Scene was not found.");
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = scenes;
      });
      if (studio.scene.scene_id === request.scene_id) {
        installScene({ ...studio.scene, label: request.label }, false);
      }
      return snapshot;
    },
    async deleteUiProfileScene(request: UiProfileSceneTargetRequest) {
      validateProfileTarget(request.target);
      const remaining = profile.profile.studio_scenes.filter(
        (scene) => scene.scene_id !== request.scene_id,
      );
      if (remaining.length === profile.profile.studio_scenes.length) {
        throw new Error("Mock Studio Scene was not found.");
      }
      const nextScene = remaining[0];
      if (nextScene == null) {
        throw new Error("The last Mock Studio Scene cannot be deleted; reset it instead.");
      }
      const snapshot = installProfile((next) => {
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = remaining;
        (next.profile as { active_studio_scene_id: string | null }).active_studio_scene_id =
          nextScene.scene_id;
      });
      undo.splice(0);
      redo.splice(0);
      installScene(structuredClone(nextScene), false);
      return snapshot;
    },
    async resetUiProfileScene(request: UiProfileSceneTargetRequest) {
      validateProfileTarget(request.target);
      const currentScene = profile.profile.studio_scenes.find(
        (scene) => scene.scene_id === request.scene_id,
      );
      const preset = profile.immutable_scene_presets[0];
      if (currentScene == null || preset == null) {
        throw new Error("Mock Rho Studio preset or Scene was not found.");
      }
      const replacement = {
        ...structuredClone(preset.scene),
        scene_id: currentScene.scene_id,
        project_id: currentScene.project_id,
        label: currentScene.label,
        layout_revision: currentScene.layout_revision + 1,
      };
      const snapshot = installProfile((next) => {
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes =
          next.profile.studio_scenes.map((scene) =>
            scene.scene_id === request.scene_id ? replacement : scene
          );
        const specs = [...next.profile.surface_instance_specs];
        for (const restored of preset.surface_instance_specs) {
          const index = specs.findIndex((spec) => spec.instance_id === restored.instance_id);
          if (index < 0) specs.push(restored);
          else specs[index] = restored;
        }
        (next.profile as { surface_instance_specs: readonly SurfaceInstanceSpec[] })
          .surface_instance_specs = specs;
      });
      undo.splice(0);
      redo.splice(0);
      installScene(replacement, false);
      return snapshot;
    },
    subscribeUiProfileInvalidated(listener: () => void): Unsubscribe {
      profileListeners.add(listener);
      return () => profileListeners.delete(listener);
    },
    publishUiProfile(next: ProjectUiProfileSnapshot) {
      profile = copyProfile(next);
      notifyProfile();
    },
    queueRuntimeEvents(events: readonly RuntimeOutputEvent[]) {
      queuedRuntimeEvents.push(structuredClone(events));
    },
    async loadRuntimes() {
      return copyRuntimes(runtimes);
    },
    async createRuntime(request: RuntimeCreateRequest) {
      if (
        request.project_id !== runtimes.project_id ||
        request.expected_project_revision !== runtimes.project_revision ||
        request.expected_snapshot_revision !== runtimes.snapshot_revision
      ) throw new Error("Mock Runtime create request is stale.");
      const provider = runtimes.providers.find(
        (candidate) => candidate.definition.runtime_provider_id === request.runtime_provider_id,
      );
      if (provider == null || !provider.definition.create_supported) {
        throw new Error("Mock Runtime Provider cannot create an instance.");
      }
      const auxiliaryCount = runtimes.instances.filter(
        (runtime) => runtime.runtime_provider_id === request.runtime_provider_id &&
          !runtime.primary_scientific_runtime,
      ).length;
      if (auxiliaryCount >= provider.definition.max_instances) {
        throw new Error("Mock Runtime Provider instance budget is exhausted.");
      }
      const runtime: RuntimeDescriptor = {
        runtime_provider_id: provider.definition.runtime_provider_id,
        runtime_instance_id: `runtime:mock-r-${nextRuntime++}`,
        runtime_kind: provider.definition.runtime_kind,
        project_id: runtimes.project_id,
        activation_generation: 1,
        state_revision: 2,
        status: "ready",
        attach_capabilities: provider.definition.attach_capabilities,
        persistence_class: "explicit_lease",
        display_label: request.display_label ?? `Auxiliary R ${auxiliaryCount + 1}`,
        primary_scientific_runtime: false,
      };
      return installRuntimes([...runtimes.instances, runtime]);
    },
    async attachRuntime(request: RuntimeAttachmentRequest) {
      return attachRuntime(request);
    },
    async detachRuntime(request: RuntimeDetachRequest) {
      return detachRuntime(request);
    },
    async interruptRuntime(request: RuntimeInstanceRequest) {
      const index = validateRuntime(request);
      const runtime = runtimes.instances[index]!;
      const instances = [...runtimes.instances];
      instances[index] = { ...runtime, state_revision: runtime.state_revision + 2, status: "ready" };
      return installRuntimes(instances);
    },
    async restartRuntime(request: RuntimeInstanceRequest) {
      const index = validateRuntime(request);
      const runtime = runtimes.instances[index]!;
      const restarted: RuntimeDescriptor = {
        ...runtime,
        activation_generation: runtime.activation_generation + 1,
        state_revision: runtime.state_revision + 2,
        status: "ready",
      };
      const instances = [...runtimes.instances];
      instances[index] = restarted;
      const snapshot = installRuntimes(instances);
      const rebound = surfaces.catalog.instances.map((surface) =>
        surface.runtime_binding?.runtime_instance_id === restarted.runtime_instance_id
          ? {
              ...surface,
              surface_revision: surface.surface_revision + 1,
              runtime_binding: bindingFor(restarted),
            }
          : surface,
      );
      if (rebound.some((surface, at) => surface !== surfaces.catalog.instances[at])) {
        installSurfaces(rebound);
      }
      return snapshot;
    },
    async stopRuntime(request: RuntimeInstanceRequest) {
      const index = validateRuntime(request);
      const runtime = runtimes.instances[index]!;
      if (runtime.primary_scientific_runtime) {
        throw new Error("Mock Workspace R is project-owned and cannot be stopped.");
      }
      return installRuntimes(runtimes.instances.filter((_, at) => at !== index));
    },
    async startRuntimeExecution(request: RuntimeExecuteRequest): Promise<RuntimeExecutionStartResponse> {
      scenarioTrace.runtimeExecuteAttempts.push({
        code: request.code,
        sourcePath: request.source_context?.source_path ?? null,
      });
      const index = validateRuntime(request.runtime);
      const runtime = runtimes.instances[index]!;
      const console = surfaces.catalog.instances.find(
        (surface) => surface.instance_id === request.console_instance_id,
      );
      if (
        console == null || console.surface_id !== "rho.console" ||
        console.surface_revision !== request.expected_console_revision ||
        console.runtime_binding?.runtime_instance_id !== runtime.runtime_instance_id ||
        console.runtime_binding.activation_generation !== runtime.activation_generation
      ) throw new Error("Mock Console attachment is stale or unavailable.");
      if (!request.code.trim()) throw new Error("Mock Runtime code must not be empty.");
      if (search.get("delay") === "runtime-execute") {
        const delayMs = Math.max(1, Math.min(2_000, Number(search.get("delay_ms") ?? "250")));
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
      if (search.get("fault") === "runtime-execute") {
        scenarioTrace.runtimeExecuteRejections += 1;
        throw new Error("Injected Runtime rejection: execution was not admitted and no run was recorded.");
      }
      const instances = [...runtimes.instances];
      const finished = { ...runtime, state_revision: runtime.state_revision + 2, status: "ready" as const };
      instances[index] = finished;
      installRuntimes(instances);
      const executionId = `runtime-execution:mock-${nextExecution++}`;
      runtimeHistoryItems.unshift({
        id: executionId,
        title: "Console command",
        subtitle: request.source_context?.source_path ?? "R Console",
        status: "completed",
        detail: JSON.stringify({
          origin: "user",
          source_path: request.source_context?.source_path ?? null,
          execution_mode: request.source_context?.execution_mode ?? "console",
          code_preview: request.code,
          started_at: new Date().toISOString(),
        }),
      });
      scenarioTrace.runtimeExecuteSuccesses += 1;
      const events = queuedRuntimeEvents.shift() ?? [{
          sequence: 1,
          runtime_instance_id: runtime.runtime_instance_id,
          console_instance_id: console.instance_id,
          kind: "mock_result",
          payload: { text: `Mock evaluation: ${request.code}` },
        }] satisfies readonly RuntimeOutputEvent[];
      const now = new Date().toISOString();
      const admitted: RuntimeExecution = {
        execution_id: executionId,
        project_root: current.project.display_path,
        run_id: null,
        runtime_provider_id: runtime.runtime_provider_id,
        runtime_instance_id: runtime.runtime_instance_id,
        runtime_activation_generation: runtime.activation_generation,
        console_instance_id: console.instance_id,
        submitted_code: request.code,
        workspace_id: "workspace:mock",
        source_path: request.source_context?.source_path ?? null,
        execution_mode: request.source_context?.execution_mode ?? "console",
        document_version: request.source_context?.document_version ?? null,
        status: "admitted",
        terminal_reason: null,
        output_state: "collecting",
        last_sequence: 0,
        output_bytes: 0,
        started_at: now,
        finished_at: null,
      };
      const chunks: RuntimeOutputChunk[] = projectConsoleEvents(events).map((block, index) => {
        const bytes = new TextEncoder().encode(block.text).byteLength;
        return {
          execution_id: executionId,
          project_root: admitted.project_root,
          sequence: index + 1,
          producer_sequence: index + 1,
          projection_slot: 0,
          source_kind: "mock_projection",
          presentation_kind: block.kind,
          media_type: "text/plain; charset=utf-8",
          storage_kind: "inline_text",
          text_payload: block.text,
          json_payload: null,
          reference_kind: null,
          reference_id: null,
          payload_bytes: bytes,
          payload_sha256: "a".repeat(64),
          created_at: now,
        };
      });
      const bytes = chunks.reduce((total, chunk) => total + chunk.payload_bytes, 0);
      const completed: RuntimeExecution = {
        ...admitted,
        run_id: runtime.primary_scientific_runtime ? executionId : null,
        status: "completed",
        output_state: "complete",
        last_sequence: chunks.length,
        output_bytes: bytes,
        finished_at: now,
      };
      runtimeExecutionRecords.unshift(completed);
      runtimeOutputChunks.set(executionId, chunks);
      notifyKernel();
      return { execution: admitted, committed_through: 0 };
    },
    async getRuntimeExecution(executionId: string): Promise<RuntimeExecution> {
      const projectRoot = current.project.display_path;
      const execution = runtimeExecutionRecords.find((candidate) => (
        candidate.execution_id === executionId && candidate.project_root === projectRoot
      ));
      if (execution == null) throw new Error("Mock Runtime execution was not found.");
      return structuredClone(execution);
    },
    async listRuntimeExecutions(limit = 50, before?: RuntimeExecutionCursor): Promise<readonly RuntimeExecution[]> {
      const projectRoot = current.project.display_path;
      const scoped = runtimeExecutionRecords.filter((execution) => execution.project_root === projectRoot);
      const start = before == null ? 0 : Math.max(0, scoped.findIndex((execution) => (
        execution.started_at === before.started_at && execution.execution_id === before.execution_id
      )) + 1);
      return structuredClone(scoped.slice(start, start + Math.max(1, Math.min(100, limit))));
    },
    async loadRuntimeOutputPage(request: RuntimeOutputPageRequest): Promise<RuntimeOutputPage> {
      const projectRoot = current.project.display_path;
      const execution = runtimeExecutionRecords.find((candidate) => (
        candidate.execution_id === request.execution_id && candidate.project_root === projectRoot
      ));
      if (execution == null) throw new Error("Mock Runtime execution was not found.");
      const after = request.after_sequence ?? 0;
      const before = request.before_sequence;
      const pageSize = request.page_size ?? 100;
      const all = (runtimeOutputChunks.get(request.execution_id) ?? [])
        .filter((chunk) => chunk.project_root === projectRoot);
      const chunks = before == null
        ? all.filter((chunk) => chunk.sequence > after).slice(0, pageSize)
        : all.filter((chunk) => chunk.sequence < before).slice(-pageSize);
      const previousSequence = chunks.at(0)?.sequence ?? before ?? after;
      const nextSequence = chunks.at(-1)?.sequence ?? after;
      return {
        execution_id: request.execution_id,
        project_root: execution.project_root,
        status: execution.status,
        output_state: execution.output_state,
        total_output_bytes: execution.output_bytes,
        after_sequence: after,
        before_sequence: before ?? null,
        previous_sequence: previousSequence,
        next_sequence: nextSequence,
        has_older: all.some((chunk) => chunk.sequence < previousSequence),
        has_more: all.some((chunk) => chunk.sequence > nextSequence),
        chunks: structuredClone(chunks),
      };
    },
    async searchRuntimeOutput(request: RuntimeOutputSearchRequest): Promise<RuntimeOutputSearchResult> {
      const query = request.query.trim().toLowerCase();
      if (!query) throw new Error("Runtime output search query cannot be empty.");
      const projectRoot = current.project.display_path;
      const scoped = runtimeExecutionRecords.filter((execution) => (
        execution.project_root === projectRoot
        && (request.console_instance_id == null || execution.console_instance_id === request.console_instance_id)
        && (request.started_after == null || execution.started_at > request.started_after)
      ));
      const hits = scoped.flatMap((execution) => {
        const codeHit = execution.submitted_code.toLowerCase().includes(query) ? [{
          execution_id: execution.execution_id,
          sequence: 0,
          presentation_kind: "code",
          storage_kind: "inline_text",
          preview: execution.submitted_code.slice(0, 1_000),
          reference_kind: null,
          reference_id: null,
          payload_sha256: "c".repeat(64),
        }] : [];
        const outputHits = (runtimeOutputChunks.get(execution.execution_id) ?? []).flatMap((chunk) => {
          const preview = chunk.text_payload ?? chunk.json_payload ?? chunk.reference_id ?? "";
          return preview.toLowerCase().includes(query) ? [{
            execution_id: execution.execution_id,
            sequence: chunk.sequence,
            presentation_kind: chunk.presentation_kind,
            storage_kind: chunk.storage_kind,
            preview: preview.slice(0, 1_000),
            reference_kind: chunk.reference_kind,
            reference_id: chunk.reference_id,
            payload_sha256: chunk.payload_sha256,
          }] : [];
        });
        return [...codeHit, ...outputHits];
      });
      const limit = Math.max(1, Math.min(200, request.limit ?? 100));
      const limited = hits.slice(0, limit);
      return {
        query: request.query.trim(),
        searched_execution_count: scoped.length,
        matched_execution_count: new Set(hits.map((hit) => hit.execution_id)).size,
        incomplete_execution_count: scoped.filter((execution) => (
          ["partial", "unavailable", "pruned"].includes(execution.output_state)
        )).length,
        truncated: hits.length > limit,
        hits: structuredClone(limited),
      };
    },
    async getRuntimeOutputPolicy() {
      return structuredClone(runtimeOutputPolicyView());
    },
    async updateRuntimeOutputPolicy(request: RuntimeOutputPolicyUpdate) {
      const currentPolicy = runtimeOutputPolicy();
      if (request.expected_revision !== currentPolicy.revision) {
        throw new Error("Runtime output policy changed while it was being edited.");
      }
      if (request.auto_prune_enabled
          || request.max_runtime_output_bytes_per_execution != null && request.max_runtime_output_bytes_per_execution < 0
          || request.runtime_output_project_warning_bytes != null && request.runtime_output_project_warning_bytes < 0
          || request.max_runtime_execution_rows != null && request.max_runtime_execution_rows < 1) {
        throw new Error("Runtime output policy values are out of bounds.");
      }
      runtimeOutputPolicies.set(currentPolicy.project_root, {
        ...currentPolicy,
        revision: currentPolicy.revision + 1,
        max_runtime_output_bytes_per_execution: request.max_runtime_output_bytes_per_execution,
        runtime_output_project_warning_bytes: request.runtime_output_project_warning_bytes,
        max_runtime_execution_rows: request.max_runtime_execution_rows,
        auto_prune_enabled: false,
        updated_at: new Date().toISOString(),
      });
      return structuredClone(runtimeOutputPolicyView());
    },
    async createRuntimeOutputReference(executionId, startSequence = 1, endSequence) {
      const execution = runtimeExecutionRecords.find((candidate) => candidate.execution_id === executionId);
      if (execution == null) throw new Error("Mock Runtime execution was not found.");
      if (execution.output_state === "pruned") throw new Error("The selected Runtime output was pruned.");
      const end = endSequence ?? execution.last_sequence;
      const chunks = (runtimeOutputChunks.get(executionId) ?? [])
        .filter((chunk) => chunk.sequence >= startSequence && chunk.sequence <= end);
      if (chunks.length !== end - startSequence + 1) throw new Error("Mock Runtime output range is incomplete.");
      return {
        project_id: runtimes.project_id,
        execution_id: executionId,
        start_sequence: startSequence,
        end_sequence: end,
        range_sha256: "c".repeat(64),
        payload_bytes: chunks.reduce((sum, chunk) => sum + chunk.payload_bytes, 0),
        chunk_count: chunks.length,
        status: execution.status,
        output_state: execution.output_state,
      };
    },
    async pruneRuntimeOutput(executionId) {
      const index = runtimeExecutionRecords.findIndex((candidate) => candidate.execution_id === executionId);
      if (index < 0) return { outcome: "not_found", pruned_chunk_count: 0, reclaimed_bytes: 0 };
      const execution = runtimeExecutionRecords[index]!;
      if (["admitted", "running"].includes(execution.status)) {
        return { outcome: "not_active", pruned_chunk_count: 0, reclaimed_bytes: 0 };
      }
      const chunks = runtimeOutputChunks.get(executionId) ?? [];
      const candidates = chunks.filter((chunk) => ["inline_text", "inline_json"].includes(chunk.storage_kind));
      if (candidates.length === 0) return { outcome: "unchanged", pruned_chunk_count: 0, reclaimed_bytes: 0 };
      const pruned = chunks.map((chunk) => {
        if (!["inline_text", "inline_json"].includes(chunk.storage_kind)) return chunk;
        const metadata = JSON.stringify({ reason: "pruned", original_payload_bytes: chunk.payload_bytes });
        return {
          ...chunk,
          presentation_kind: "status" as const,
          media_type: "application/json",
          storage_kind: "tombstone" as const,
          text_payload: null,
          json_payload: metadata,
          reference_kind: null,
          reference_id: null,
          payload_bytes: new TextEncoder().encode(metadata).byteLength,
          payload_sha256: "b".repeat(64),
        };
      });
      const before = candidates.reduce((sum, chunk) => sum + chunk.payload_bytes, 0);
      const after = pruned.filter((chunk) => chunk.storage_kind === "tombstone")
        .reduce((sum, chunk) => sum + chunk.payload_bytes, 0);
      runtimeOutputChunks.set(executionId, pruned);
      runtimeExecutionRecords[index] = {
        ...execution,
        output_state: "pruned",
        output_bytes: pruned.reduce((sum, chunk) => sum + chunk.payload_bytes, 0),
      };
      notifyKernel();
      return { outcome: "applied", pruned_chunk_count: candidates.length, reclaimed_bytes: Math.max(0, before - after) };
    },
    async deleteRuntimeExecution(executionId) {
      const index = runtimeExecutionRecords.findIndex((candidate) => candidate.execution_id === executionId);
      if (index < 0) return { outcome: "not_found", deleted_output_chunk_count: 0 };
      if (["admitted", "running"].includes(runtimeExecutionRecords[index]!.status)) {
        return { outcome: "not_active", deleted_output_chunk_count: 0 };
      }
      const count = runtimeOutputChunks.get(executionId)?.length ?? 0;
      runtimeExecutionRecords.splice(index, 1);
      runtimeOutputChunks.delete(executionId);
      const historyIndex = runtimeHistoryItems.findIndex((item) => item.id === executionId);
      if (historyIndex >= 0) runtimeHistoryItems.splice(historyIndex, 1);
      notifyKernel();
      return { outcome: "applied", deleted_output_chunk_count: count };
    },
    async followRuntimeOutput(executionId, afterSequence, listener): Promise<void> {
      const projectRoot = current.project.display_path;
      const projectId = current.project.project_id;
      const execution = runtimeExecutionRecords.find((candidate) => (
        candidate.execution_id === executionId && candidate.project_root === projectRoot
      ));
      if (execution == null) throw new Error("Mock Runtime execution was not found.");
      const chunks = (runtimeOutputChunks.get(executionId) ?? [])
        .filter((chunk) => chunk.project_root === projectRoot && chunk.sequence > afterSequence);
      if (search.get("delay") === "runtime-execute") {
        const delayMs = Math.max(1, Math.min(2_000, Number(search.get("delay_ms") ?? "250")));
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
      if (chunks.length > 0) {
        const frame: RuntimeOutputFollowFrame = {
          type: "chunks",
          project_id: projectId,
          execution_id: executionId,
          first_sequence: chunks[0]!.sequence,
          last_sequence: chunks.at(-1)!.sequence,
          chunks: structuredClone(chunks),
        };
        listener(frame);
        if (search.get("stream") === "duplicate") listener(frame);
      }
      listener({
        type: "terminal",
        project_id: projectId,
        execution_id: executionId,
        committed_through: execution.last_sequence,
        execution: structuredClone(execution),
      });
    },
    subscribeRuntimesInvalidated(listener: () => void): Unsubscribe {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    publishRuntimes(next: RuntimeRegistrySnapshot) {
      runtimes = copyRuntimes(next);
      notifyRuntimes();
    },
    async loadResources() {
      return copyResources(resources);
    },
    async resolveResource(request: ResourceResolveRequest) {
      if (
        request.project_id !== resources.project_id ||
        request.expected_project_revision !== resources.project_revision ||
        request.expected_snapshot_revision !== resources.snapshot_revision
      ) throw new Error("Mock Resource resolve request is stale.");
      const normalized = request.resource_id.replaceAll("\\", "/");
      if (
        !normalized || normalized.startsWith("/") ||
        normalized.split("/").some((part) => !part || part === "." || part === "..")
      ) throw new Error("Mock Resource path must be normalized.");
      if (resources.resources.some((resource) => resource.resource_id === normalized)) {
        return copyResources(resources);
      }
      const exists = persistedContent.has(normalized);
      const supported = /\.(r|rmd|qmd|md|txt|json|csv|tsv|html|png|jpe?g|gif|webp)$/iu.test(normalized);
      const descriptor: ResourceDescriptor = {
        resource_provider_id: request.resource_provider_id,
        project_id: request.project_id,
        resource_kind: request.resource_kind,
        resource_id: normalized,
        resource_revision: 1,
        label: normalized.split("/").at(-1) ?? normalized,
        capabilities: exists && supported
          ? ["resource.delete", "resource.preview", "resource.read.document", "resource.read.snapshot", "resource.rename", "resource.write"]
          : ["resource.read.snapshot"],
        status: exists ? supported ? "ready" : "unsupported" : "missing",
        media_type: exists && supported ? "text/plain" : null,
        size_bytes: exists && supported ? (persistedContent.get(normalized)?.length ?? 0) : null,
        content_sha256: null,
      };
      return installResources([...resources.resources, descriptor]);
    },
    async readResource(request: ResourceReadRequest): Promise<ResourceContent> {
      const descriptor = validateResource(
        request.target,
        request.consistency === "immutable_snapshot",
      );
      if (descriptor.status !== "ready") throw new Error("Mock Resource is unavailable.");
      if (request.consistency === "immutable_snapshot") {
        if (!descriptor.capabilities.includes("resource.preview")) {
          throw new Error("Mock Resource preview is unsupported.");
        }
        return {
          contract: "rho.ui.resource-content.v1",
          descriptor,
          consistency: "immutable_snapshot",
          document_revision: 1,
          base_resource_revision: descriptor.resource_revision,
          dirty: false,
          stale: false,
          content_encoding: "utf-8",
          content: persistedContent.get(descriptor.resource_id) ?? "",
        };
      }
      let document = documents.get(descriptor.resource_id);
      if (document == null) {
        const content = persistedContent.get(descriptor.resource_id) ?? "";
        document = {
          content,
          baseContent: content,
          documentRevision: 1,
          baseResourceRevision: descriptor.resource_revision,
          dirty: false,
        };
        documents.set(descriptor.resource_id, document);
        resources = { ...resources, snapshot_revision: resources.snapshot_revision + 1 };
        notifyResources();
      }
      return contentShape(descriptor, document);
    },
    async updateResourceDraft(request: ResourceDraftRequest) {
      const descriptor = validateResource(request.target, false);
      const document = documents.get(descriptor.resource_id);
      if (document == null) throw new Error("Mock shared Resource document is not open.");
      if (document.documentRevision !== request.expected_document_revision) {
        throw new Error("Mock Resource document revision is stale.");
      }
      document.content = request.content;
      document.documentRevision += 1;
      document.dirty = document.content !== document.baseContent;
      resources = { ...resources, snapshot_revision: resources.snapshot_revision + 1 };
      notifyResources();
      return contentShape(descriptor, document);
    },
    async saveResource(request: ResourceSaveRequest) {
      const descriptor = validateResource(request.target, false);
      const document = documents.get(descriptor.resource_id);
      if (document == null) throw new Error("Mock shared Resource document is not open.");
      if (
        document.documentRevision !== request.expected_document_revision ||
        document.baseResourceRevision !== descriptor.resource_revision
      ) throw new Error("Mock Resource save request is stale.");
      persistedContent.set(descriptor.resource_id, document.content);
      const saved: ResourceDescriptor = {
        ...descriptor,
        resource_revision: descriptor.resource_revision + 1,
        size_bytes: document.content.length,
      };
      document.baseContent = document.content;
      document.baseResourceRevision = saved.resource_revision;
      document.documentRevision += 1;
      document.dirty = false;
      installResources(resources.resources.map((resource) =>
        resource.resource_id === saved.resource_id ? saved : resource
      ));
      rebindSourceSurfaces(saved);
      return contentShape(saved, document);
    },
    async reloadResource(request: ResourceReloadRequest) {
      const descriptor = validateResource(request.target, false);
      const document = documents.get(descriptor.resource_id);
      if (document == null) throw new Error("Mock shared Resource document is not open.");
      if (document.documentRevision !== request.expected_document_revision) {
        throw new Error("Mock Resource document revision is stale.");
      }
      if (document.dirty && !request.discard_dirty) {
        throw new Error("Mock Resource has an unsaved draft; explicit discard is required.");
      }
      const content = persistedContent.get(descriptor.resource_id) ?? "";
      document.content = content;
      document.baseContent = content;
      document.baseResourceRevision = descriptor.resource_revision;
      document.documentRevision += 1;
      document.dirty = false;
      resources = { ...resources, snapshot_revision: resources.snapshot_revision + 1 };
      notifyResources();
      rebindSourceSurfaces(descriptor);
      return contentShape(descriptor, document);
    },
    async renameResource(request: ResourceRenameRequest) {
      const descriptor = validateResource(request.target, true);
      const document = documents.get(descriptor.resource_id);
      if ((document?.documentRevision ?? null) !== request.expected_document_revision) {
        throw new Error("Mock Resource document revision is stale.");
      }
      if (resources.resources.some((resource) => resource.resource_id === request.new_resource_id)) {
        throw new Error("Mock Resource rename target already exists.");
      }
      const renamed: ResourceDescriptor = {
        ...descriptor,
        resource_id: request.new_resource_id,
        label: request.new_resource_id.split("/").at(-1) ?? request.new_resource_id,
        resource_revision: 1,
      };
      const persisted = persistedContent.get(descriptor.resource_id);
      persistedContent.delete(descriptor.resource_id);
      if (persisted != null) persistedContent.set(renamed.resource_id, persisted);
      if (document != null) {
        documents.delete(descriptor.resource_id);
        document.baseResourceRevision = renamed.resource_revision;
        document.documentRevision += 1;
        documents.set(renamed.resource_id, document);
      }
      const snapshot = installResources([
        ...resources.resources.filter((resource) => resource.resource_id !== descriptor.resource_id),
        renamed,
      ]);
      const binding: ResourceBinding = {
        resource_provider_id: renamed.resource_provider_id,
        resource_kind: renamed.resource_kind,
        resource_id: renamed.resource_id,
        resource_revision: renamed.resource_revision,
      };
      const rebound = surfaces.catalog.instances.map((surface) =>
        surface.resource_binding?.resource_provider_id === descriptor.resource_provider_id &&
        surface.resource_binding.resource_kind === descriptor.resource_kind &&
        surface.resource_binding.resource_id === descriptor.resource_id
          ? { ...surface, surface_revision: surface.surface_revision + 1, resource_binding: binding }
          : surface
      );
      installSurfaces(rebound);
      return snapshot;
    },
    async deleteResource(request: ResourceDeleteRequest) {
      const descriptor = validateResource(request.target, true);
      const document = documents.get(descriptor.resource_id);
      if (document != null) {
        if (request.expected_document_revision !== document.documentRevision) {
          throw new Error("Mock Resource document revision is stale.");
        }
        if (document.dirty && !request.discard_dirty) {
          throw new Error("Mock Resource has an unsaved draft; explicit discard is required.");
        }
        if (request.discard_dirty) documents.delete(descriptor.resource_id);
      }
      persistedContent.delete(descriptor.resource_id);
      const missing: ResourceDescriptor = {
        ...descriptor,
        resource_revision: descriptor.resource_revision + 1,
        status: "missing",
        media_type: null,
        size_bytes: null,
        content_sha256: null,
      };
      return installResources(resources.resources.map((resource) =>
        resource.resource_id === missing.resource_id ? missing : resource
      ));
    },
    subscribeResourcesInvalidated(listener: () => void): Unsubscribe {
      resourceListeners.add(listener);
      return () => resourceListeners.delete(listener);
    },
    async listAgentConversations(limit = 50) {
      return structuredClone(agentConversations.slice(0, limit));
    },
    async createAgentConversation() {
      const conversation: AgentConversationSummary = {
        conversation_id: `agent-conversation:mock-${nextConversation++}`,
        project_root: current.project.display_path,
        title: "New conversation",
        created_at: agentNow,
        updated_at: agentNow,
        archived_at: null,
        legacy_unthreaded: false,
        turn_count: 0,
        status: "empty",
        latest_turn_id: null,
        latest_mode: null,
        latest_prompt_preview: null,
        terminal_reason: null,
        pending_request_id: null,
      };
      agentConversations.unshift(conversation);
      notifyAgent();
      return structuredClone(conversation);
    },
    async listAgentTurns(conversationId, limit = 50) {
      return structuredClone(agentTurns
        .filter((turn) => conversationId == null || turn.conversation_id === conversationId)
        .slice(0, limit));
    },
    async getAgentTurnDetail(turnId) {
      return structuredClone(agentDetails.get(turnId) ?? null);
    },
    subscribeAgentTurnEvents(listener: (frame: AgentTurnEventFrame) => void): Unsubscribe {
      agentTurnEventListeners.add(listener);
      return () => agentTurnEventListeners.delete(listener);
    },
    emitAgentTurnEvent(frame: AgentTurnEventFrame): void {
      const snapshot = structuredClone(frame);
      for (const listener of agentTurnEventListeners) listener(snapshot);
    },
    async loadAgentLlmSettings() {
      return structuredClone(agentLlmSettings);
    },
    async discoverProviderModels(providerId) {
      const provider = agentLlmSettings.providers.find((candidate) => candidate.id === providerId);
      if (provider == null) throw new Error("Provider changed while models were refreshing.");
      return {
        status: provider.credential_status === "detected" ? "ready" : "error",
        provider_id: providerId,
        models: agentLlmSettings.models
          .filter((model) => model.provider_id === providerId)
          .map((model) => ({
            id: model.model_id,
            display_name: model.display_name,
            model_type: structuredClone(model.model_type),
            capabilities: structuredClone(model.capabilities),
          })),
        truncated: false,
        message: provider.credential_status === "detected"
          ? "Loaded available models."
          : "The API key was not accepted.",
        error_class: provider.credential_status === "detected" ? null : "credential_missing",
      };
    },
    async testProviderModel(request) {
      assertAgentConfigGate(request);
      const model = agentLlmSettings.models.find((candidate) => candidate.id === request.modelId);
      if (model == null) throw new Error("Model changed while the connection test was running.");
      agentLlmSettings = {
        ...agentLlmSettings,
        revision: agentLlmSettings.revision + 1,
        config_store: {
          ...agentLlmSettings.config_store,
          config_snapshot_id: nextAgentConfigSnapshotId(),
        },
        models: agentLlmSettings.models.map((candidate) => candidate.id === request.modelId ? {
          ...candidate,
          last_test: {
            status: "ready",
            checked_at: agentNow,
            latency_ms: 48,
            error_class: null,
            message: "Connection ready.",
          },
        } : candidate),
      };
      return structuredClone(agentLlmSettings);
    },
    async viewProviderCredential(providerId): Promise<AgentLlmCredentialRevealView> {
      // CRED-REVEAL-1C browser/mock parity: one click resolves one labelled
      // mock value (never a real secret shape) for a detected credential, and
      // fails closed with the same outcome vocabulary as the real command.
      const provider = agentLlmSettings.providers.find((candidate) => candidate.id === providerId);
      if (provider == null) throw new Error("Provider changed while this credential screen was open.");
      return provider.credential_status === "detected"
        ? {
          outcome: "revealed",
          credential: `mock-${provider.credential_effective_source}-api-key`,
          source: provider.credential_effective_source,
          env_shadows_file: provider.env_shadows_file,
        }
        : {
          outcome: "credential_missing",
          credential: null,
          source: null,
          env_shadows_file: false,
        };
    },
    async saveProviderCredential(request) {
      void request.credential;
      assertAgentConfigGate(request);
      const provider = agentLlmSettings.providers.find((candidate) => candidate.id === request.providerId);
      if (provider == null) throw new Error("Provider changed while this credential screen was open.");
      const replacing = request.target === "session"
        ? provider.session_credential_present
        : provider.config_file_credential_present;
      if (replacing && !request.confirmReplace) {
        throw new Error("An API key is already saved in that target. Confirm replacement to overwrite it.");
      }
      const durable = request.target === "config_file";
      agentLlmSettings = {
        ...agentLlmSettings,
        revision: durable ? agentLlmSettings.revision + 1 : agentLlmSettings.revision,
        // Every accepted request consumes its opaque snapshot capability,
        // including session-only writes whose durable revision is unchanged.
        config_store: {
          ...agentLlmSettings.config_store,
          config_snapshot_id: nextAgentConfigSnapshotId(),
        },
        providers: agentLlmSettings.providers.map((candidate) => {
          if (candidate.id !== request.providerId) return candidate;
          const environmentEffective = candidate.credential_effective_source === "environment";
          const sessionPresent = request.target === "session" || candidate.session_credential_present;
          const filePresent = request.target === "config_file" || candidate.config_file_credential_present;
          return {
            ...candidate,
            credential_status: "detected",
            credential_effective_source: sessionPresent
              ? "session"
              : environmentEffective
                ? "environment"
                : "config_file",
            session_credential_present: sessionPresent,
            config_file_credential_present: filePresent,
            env_shadows_file: !sessionPresent && environmentEffective && filePresent,
          };
        }),
      };
      return structuredClone(agentLlmSettings);
    },
    async repairAgentConfigPermissions(request) {
      assertAgentConfigGate(request);
      if (request.expectedConfigPath !== agentLlmSettings.config_store.config_path) {
        throw new Error("The resolved config.yaml path changed. Reload before repairing permissions.");
      }
      agentLlmSettings = {
        ...agentLlmSettings,
        config_store: {
          ...agentLlmSettings.config_store,
          config_snapshot_id: nextAgentConfigSnapshotId(),
          permission_issues: [],
        },
      };
      return structuredClone(agentLlmSettings);
    },
    async selectAgentChatModel(request) {
      assertAgentConfigGate(request);
      const model = agentLlmSettings.models.find((candidate) => candidate.id === request.modelId);
      if (model == null || !model.enabled || model.model_type.value !== "language") {
        throw new Error("Choose an enabled language model for Chat.");
      }
      agentLlmSettings = {
        ...agentLlmSettings,
        revision: agentLlmSettings.revision + 1,
        config_store: {
          ...agentLlmSettings.config_store,
          config_snapshot_id: nextAgentConfigSnapshotId(),
        },
        selected_model_id: model.id,
        selected_model: {
          id: model.id,
          display_name: model.display_name,
          provider_display_name: model.provider_display_name,
          selector_status: model.selector_status,
          tool_calling: model.capabilities.function_call?.value ?? "unknown",
          act_enabled: model.act_enabled,
        },
        models: agentLlmSettings.models.map((candidate) => ({
          ...candidate,
          selected: candidate.id === model.id,
        })),
        capability_routes: agentLlmSettings.capability_routes.map((route) =>
          route.capability === "agent.chat" ? {
            ...route,
            model_id: model.id,
            model_display_name: model.display_name,
            provider_display_name: model.provider_display_name,
            model_type: model.model_type.value,
            configured: true,
            compatibility: model.selector_status,
            credential_status: agentLlmSettings.providers.find(
              (provider) => provider.id === model.provider_id,
            )?.credential_status ?? "unchecked",
          } : route
        ),
      };
      return structuredClone(agentLlmSettings);
    },
    async setAgentContextCapacity(request: AgentContextCapacityRequest) {
      return applyContextCapacity(request);
    },
    async setModelContextCapacity(request) {
      return applyContextCapacity(request);
    },
    async saveModel(request) {
      assertAgentConfigGate(request);
      const { model } = request;
      const existing = agentLlmSettings.models.find((candidate) => candidate.id === model.id);
      if (existing != null) {
        if (existing.model_type.value !== model.model_type.value
            || existing.model_type.source !== model.model_type.source
            || !sameCapabilityEvidence(existing.capabilities, model.capabilities)) {
          throw new Error("Use the capability declaration command to change model evidence.");
        }
        if (!model.enabled && existing.enabled
            && agentLlmSettings.capability_routes.some((route) => route.model_id === model.id)) {
          throw new Error("Reassign this model's capability routes before disabling it.");
        }
      }
      const provider = agentLlmSettings.providers.find((candidate) => candidate.id === model.provider_id);
      const viewModel: AgentLlmSettingsView["models"][number] = {
        ...structuredClone(model),
        provider_display_name: provider?.display_name ?? model.provider_id,
        selected: existing?.selected ?? agentLlmSettings.selected_model_id === model.id,
        selector_status: existing?.selector_status ?? "ready",
        act_enabled: model.enabled && model.capabilities.function_call?.value === "yes",
      };
      agentLlmSettings = {
        ...agentLlmSettings,
        revision: agentLlmSettings.revision + 1,
        config_store: {
          ...agentLlmSettings.config_store,
          config_snapshot_id: nextAgentConfigSnapshotId(),
        },
        models: existing == null
          ? [...agentLlmSettings.models, viewModel]
          : agentLlmSettings.models.map((candidate) => candidate.id === model.id ? viewModel : candidate),
      };
      return structuredClone(agentLlmSettings);
    },
    async deleteModel(request) {
      assertAgentConfigGate(request);
      const model = agentLlmSettings.models.find((candidate) => candidate.id === request.modelId);
      if (model == null) throw new Error(`Unknown model: ${request.modelId}`);
      if (agentLlmSettings.capability_routes.some((route) => route.model_id === request.modelId)) {
        throw new Error("Reassign or remove this model's capability routes before deleting it.");
      }
      agentLlmSettings = {
        ...agentLlmSettings,
        revision: agentLlmSettings.revision + 1,
        config_store: {
          ...agentLlmSettings.config_store,
          config_snapshot_id: nextAgentConfigSnapshotId(),
        },
        models: agentLlmSettings.models.filter((candidate) => candidate.id !== request.modelId),
      };
      return structuredClone(agentLlmSettings);
    },
    async declareModelCapability(request) {
      assertAgentConfigGate(request);
      const model = agentLlmSettings.models.find((candidate) => candidate.id === request.modelId);
      if (model == null) throw new Error(`Unknown model: ${request.modelId}`);
      let modelType = model.model_type;
      let capabilities = model.capabilities;
      if (request.capability === "model_type") {
        if (!["language", "embedding", "image", "unknown"].includes(request.value)) {
          throw new Error("Model type must be language, embedding, image or unknown.");
        }
        modelType = { value: request.value, source: "user_declared" };
      } else {
        if (!(MODEL_CAPABILITY_NAMES as readonly string[]).includes(request.capability)) {
          throw new Error(`Unsupported model capability: ${request.capability}`);
        }
        if (!["yes", "no", "unknown"].includes(request.value)) {
          throw new Error("Capability values must be yes, no or unknown.");
        }
        capabilities = {
          ...capabilities,
          [request.capability]: { value: request.value, source: "user_declared" },
        };
      }
      agentLlmSettings = {
        ...agentLlmSettings,
        revision: agentLlmSettings.revision + 1,
        config_store: {
          ...agentLlmSettings.config_store,
          config_snapshot_id: nextAgentConfigSnapshotId(),
        },
        models: agentLlmSettings.models.map((candidate) => candidate.id === request.modelId ? {
          ...candidate,
          model_type: modelType,
          capabilities,
          act_enabled: candidate.enabled && capabilities.function_call?.value === "yes",
        } : candidate),
      };
      return structuredClone(agentLlmSettings);
    },
    async previewAgentContext(request) {
      const reference = request.runtime_output_context;
      const selectedModel = agentLlmSettings.models.find((model) => model.selected)
        ?? agentLlmSettings.models[0];
      if (selectedModel == null) throw new Error("Mock Agent has no configured model.");
      return {
        plan_digest: mockContextPlanDigest(request.prompt, reference),
        context_window_tokens: selectedModel.context_window_tokens,
        reserved_output_tokens: selectedModel.reserved_output_tokens,
        estimated_input_tokens: request.prompt.length + (reference?.payload_bytes ?? 0),
        capacity_source: selectedModel.context_capacity_source,
        items: [{
          context_item_id: "agent-context:mock-current-request",
          ordinal: 0,
          source_kind: "current_request",
          source_id: null,
          source_revision: "1",
          source_sha256: "a".repeat(64),
          trust_class: "user_instruction",
          capacity_source: "conservative",
          original_bytes: request.prompt.length,
          included_bytes: request.prompt.length,
          estimated_tokens: request.prompt.length,
          disposition: "complete",
          reason_code: null,
        }, ...(reference == null ? [] : [{
          context_item_id: "agent-context:mock-runtime-output",
          ordinal: 1,
          source_kind: "runtime_output",
          source_id: `${reference.execution_id}:${reference.start_sequence}-${reference.end_sequence}`,
          source_revision: `sequence:${reference.end_sequence}`,
          source_sha256: reference.range_sha256,
          trust_class: "explicit_project_data",
          capacity_source: "conservative",
          original_bytes: reference.payload_bytes,
          included_bytes: reference.payload_bytes,
          estimated_tokens: reference.payload_bytes,
          disposition: "complete",
          reason_code: null,
        }])],
        model_profile_id: selectedModel.id,
        model_display_name: selectedModel.display_name,
        settings_revision: agentLlmSettings.revision,
        conversation_id: request.conversation_id,
        runtime_output_context: reference,
      };
    },
    async runAgent(request) {
      if (request.runtime_output_context != null
          && request.context_plan_digest !== mockContextPlanDigest(request.prompt, request.runtime_output_context)) {
        throw new Error("Agent context changed after review.");
      }
      let conversation = agentConversations.find(
        (candidate) => candidate.conversation_id === request.conversation_id,
      );
      if (conversation == null) {
        conversation = await this.createAgentConversation();
      }
      const turnId = `agent-turn:mock-${nextTurn++}`;
      const startedAt = new Date().toISOString();
      const turn: AgentTurnSummary = {
        turn_id: turnId,
        conversation_id: conversation.conversation_id,
        project_root: current.project.display_path,
        mode: request.mode,
        status: "completed",
        started_at: startedAt,
        finished_at: startedAt,
        prompt_preview: request.prompt,
        model: "mock/provider-model",
        workspace_id_before: "workspace:mock",
        state_revision_before: 4,
        project_revision_before: current.context.project_revision,
        workspace_id_after: "workspace:mock",
        state_revision_after: 4,
        project_revision_after: current.context.project_revision,
        final_message: `Mock ${request.mode} response for: ${request.prompt}`,
        error_message: null,
        pending_request_id: null,
        retry_of_turn_id: null,
        terminal_reason: "completed",
      };
      const events: AgentTurnEvent[] = [{
        id: 1, turn_id: turnId, timestamp: startedAt,
        event_type: "agent.user_prompt", title: "You", body: request.prompt,
        status: "completed", tool: null, request_id: null, code: null,
        details_json: "{}",
      }, {
        id: 2, turn_id: turnId, timestamp: startedAt,
        event_type: "agent.final_message", title: "Rho", body: turn.final_message,
        status: "completed", tool: null, request_id: null, code: null,
        details_json: "{}",
      }];
      agentTurns.unshift(turn);
      agentDetails.set(turnId, {
        turn,
        events,
        approvals: [],
        context_items: request.runtime_output_context == null ? [] : [{
          ordinal: 1,
          source_kind: "runtime_output",
          source_id: `${request.runtime_output_context.execution_id}:${request.runtime_output_context.start_sequence}-${request.runtime_output_context.end_sequence}`,
          source_revision: `sequence:${request.runtime_output_context.end_sequence}`,
          source_sha256: request.runtime_output_context.range_sha256,
          trust_class: "explicit_project_data",
          capacity_source: "conservative",
          original_bytes: request.runtime_output_context.payload_bytes,
          included_bytes: request.runtime_output_context.payload_bytes,
          estimated_tokens: request.runtime_output_context.payload_bytes,
          disposition: "complete",
          reason_code: null,
        }],
      });
      const conversationIndex = agentConversations.findIndex(
        (candidate) => candidate.conversation_id === conversation!.conversation_id,
      );
      agentConversations[conversationIndex] = {
        ...conversation,
        updated_at: startedAt,
        turn_count: conversation.turn_count + 1,
        status: "completed",
        latest_turn_id: turnId,
        latest_mode: request.mode,
        latest_prompt_preview: request.prompt,
        terminal_reason: "completed",
      };
      notifyAgent();
      return {
        status: "started" as const,
        turn_id: turnId,
        conversation_id: conversation.conversation_id,
        retry_of_turn_id: null,
        auto_approve: request.auto_approve,
        task_kind: request.task_kind,
      };
    },
    async retryAgentTurn(turnId) {
      const source = agentTurns.find((turn) => turn.turn_id === turnId);
      if (source == null) throw new Error("Mock Agent turn is unavailable.");
      const response = await this.runAgent({
        prompt: source.prompt_preview,
        mode: source.mode as AgentMode,
        task_kind: "agent_turn",
        model_id: null,
        auto_approve: false,
        editor_context: null,
        conversation_id: source.conversation_id,
        runtime_output_context: null,
        context_plan_digest: null,
      });
      const created = agentTurns.find((turn) => turn.turn_id === response.turn_id)!;
      agentTurns[agentTurns.indexOf(created)] = { ...created, retry_of_turn_id: turnId };
      return { ...response, retry_of_turn_id: turnId };
    },
    async cancelAgentTurn(turnId) {
      const index = agentTurns.findIndex((turn) => turn.turn_id === turnId);
      if (index < 0) throw new Error("Mock Agent turn is unavailable.");
      agentTurns[index] = {
        ...agentTurns[index]!,
        status: "cancelled",
        finished_at: new Date().toISOString(),
        terminal_reason: "user_cancelled",
      };
      notifyAgent();
      return { status: "cancelled", turn_id: turnId };
    },
    async respondAgentApproval(request: AgentApprovalDecisionRequest) {
      for (const [turnId, detail] of agentDetails) {
        const index = detail.approvals.findIndex(
          (approval) => approval.request_id === request.request_id,
        );
        if (index < 0) continue;
        const approvals = [...detail.approvals];
        approvals[index] = {
          ...approvals[index]!,
          decision: request.decision,
          reason: request.reason,
          status: request.decision === "approve" ? "approved" : "rejected",
          responded_at: new Date().toISOString(),
        };
        agentDetails.set(turnId, { ...detail, approvals });
        notifyAgent();
        return { status: "delivered", request_id: request.request_id, turn_id: turnId };
      }
      throw new Error("Mock Agent approval is unavailable.");
    },
    async getAgentRuntimeDiagnostics() {
      return structuredClone(agentRuntimeDiagnostics);
    },
    async retryAgentRuntime() {
      agentRuntimeDiagnostics = {
        ...agentRuntimeDiagnostics,
        status: agentRuntimeDiagnostics.available ? "ready" : "needs_attention",
      };
      notifyAgent();
      return structuredClone(agentRuntimeDiagnostics);
    },
    subscribeAgentInvalidated(listener: () => void): Unsubscribe {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
    async listRuns(limit = 100) {
      return structuredClone(typedRunRecords().slice(0, Math.max(0, limit)));
    },
    async listArtifactRecords(limit = 100) {
      return structuredClone(typedArtifactRecords().slice(0, Math.max(0, limit)));
    },
    async listProblems(limit = 100): Promise<readonly ProblemSummary[]> {
      return structuredClone(([] as ProblemSummary[]).slice(0, Math.max(0, limit)));
    },
    async listPlotArtifacts(limit = 100) {
      return structuredClone(typedPlotRecords().slice(0, Math.max(0, limit)));
    },
    async listEvidenceClaims(limit = 100) {
      return structuredClone(typedEvidenceRecords().slice(0, Math.max(0, limit)));
    },
    async toolchainDoctor() {
      return {
        status: "ready",
        configured: true,
        rho_toml_sha256: "f".repeat(64),
        r_version: "4.5.2",
        rscript: "/opt/R/4.5.2/bin/Rscript",
        python_version: "3.12",
        python: "/project/.venv/bin/python",
        checks: [
          { id: "rig", status: "ready", detail: "exact R 4.5.2 resolved" },
          { id: "renv", status: "ready", detail: "project library ready" },
          { id: "uv", status: "ready", detail: "Python 3.12 environment ready" },
        ],
      };
    },
    async loadDomainSurface(surfaceId) {
      const fixtures: Readonly<Record<string, DomainSurfaceData["items"]>> = {
        "rho.environment": [
          { id: "package:rho", title: "rho", subtitle: "0.4.1-dev.13", status: "installed", detail: "Project library" },
          { id: "package:aisdk", title: "aisdk", subtitle: "required >= 1.5.0", status: "incompatible", detail: "Installed 1.4.12 in Agent R" },
        ],
        "rho.evidence": [{ id: "claim:1", title: "Analysis uses a fixed seed", subtitle: "analysis.R:1-2", status: "current", detail: "Source-backed evidence claim" }],
        "rho.git": [{ id: "git:main", title: "main", subtitle: "2 modified · 1 staged", status: "dirty", detail: "Local project repository" }],
        "rho.runs": runtimeHistoryItems,
        "rho.problems": [{ id: "problem:seed", title: "Random result may change", subtitle: "analysis.R:2", status: "warning", detail: "Set a deliberate seed." }],
        "rho.plots": [{ id: "plot:mock-1", title: "QC plot", subtitle: "image/png", status: "ready", detail: "Runtime plot artifact" }],
        "rho.logs": [{ id: "log:startup", title: "Desktop shell ready", subtitle: agentNow, status: "info", detail: "Surface Runtime initialized." }],
        "rho.render-jobs": [{ id: "render:mock-1", title: "analysis.qmd → html", subtitle: "Quarto", status: "completed", detail: "Output analysis.html" }],
        "rho.help": [{ id: "rho.command.search", title: "Search commands", subtitle: "Command Registry", status: "available", detail: "Find every contextual command." }],
      };
      const items = fixtures[surfaceId] ?? [];
      return {
        surface_id: surfaceId,
        loaded_at: agentNow,
        summary: `${items.length} ${items.length === 1 ? "record" : "records"}`,
        items: structuredClone(items),
      };
    },
    async readPlotArtifact(plotId) {
      if (!typedPlotRecords().some((plot) => plot.plot_id === plotId)) {
        throw new Error("Mock Plot artifact is unavailable.");
      }
      return {
        plot_id: plotId,
        media_type: "image/png",
        data_base64: MOCK_PLOT_PNG_BASE64,
      };
    },
    async retryRun(runId) {
      notifyAgent();
      return { status: "started", parent_run_id: runId };
    },
    async applyAgentFileEdit(request) {
      notifyAgent();
      return {
        status: "applied",
        path: request.path,
        content: request.before_content,
        start: 0,
        end: request.before_content.length,
        after_sha256: "a".repeat(64),
        project: {
          root: activeProjectPath,
          files: [{
            path: request.path,
            name: request.path.split("/").at(-1) ?? request.path,
            kind: "file",
            size_bytes: request.before_content.length,
          }],
          truncated: false,
        },
        workspace: {
          workspace_id: `workspace:${current.project.project_id}`,
          kernel_instance_id: "kernel:mock",
          execution_seq: 0,
          state_revision: 0,
          project_revision: current.context.project_revision,
        },
      };
    },
    async undoAgentFileEdit(request) {
      notifyAgent();
      return {
        status: "undone",
        path: request.path,
        content: request.created ? null : request.before_content,
        start: 0,
        end: 0,
        after_sha256: request.created ? null : "b".repeat(64),
        project: {
          root: activeProjectPath,
          files: request.created ? [] : [{
            path: request.path,
            name: request.path.split("/").at(-1) ?? request.path,
            kind: "file",
            size_bytes: request.before_content.length,
          }],
          truncated: false,
        },
        workspace: {
          workspace_id: `workspace:${current.project.project_id}`,
          kernel_instance_id: "kernel:mock",
          execution_seq: 0,
          state_revision: 0,
          project_revision: current.context.project_revision,
        },
      };
    },
    publishResources(next: ResourceRegistrySnapshot) {
      resources = copyResources(next);
      notifyResources();
    },
  };
}
