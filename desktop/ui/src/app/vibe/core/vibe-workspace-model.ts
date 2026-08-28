import type { SurfaceInstance, VibeBlock, VibePage } from "../../../transport";

export const VIBE_REGION_ORDER = [
  "manuscript",
  "exploration",
  "verification",
] as const;

export type VibeRegionRole = (typeof VIBE_REGION_ORDER)[number];

export type VibeLayoutMode =
  | "overview"
  | "focus-manuscript"
  | "focus-exploration"
  | "focus-verification";

export interface VibeExactReferences {
  readonly surfaceInstanceIds: readonly string[];
  readonly conversationIds: readonly string[];
  readonly runIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly plotIds: readonly string[];
  readonly checkIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly taskIds: readonly string[];
}

export interface VibeFocus {
  readonly projectId: string;
  readonly pageId: string;
  readonly blockId: string | null;
  readonly region: VibeRegionRole;
  readonly exactRefs: VibeExactReferences;
}

export interface VibeCorrespondenceStep {
  readonly role: VibeRegionRole;
  readonly label: string;
  readonly detail: string;
}

export interface VibeCorrespondence {
  readonly hasExactLink: boolean;
  readonly summary: string;
  readonly steps: readonly VibeCorrespondenceStep[];
}

export interface VibeWorkspaceViewState {
  readonly projectId: string;
  readonly pageId: string;
  readonly activeRegion: VibeRegionRole;
  readonly layoutMode: VibeLayoutMode;
  readonly blockId: string | null;
}

const EXACT_REFERENCE_KEYS = [
  "surfaceInstanceIds",
  "conversationIds",
  "runIds",
  "artifactIds",
  "plotIds",
  "checkIds",
  "evidenceIds",
  "findingIds",
  "taskIds",
] as const satisfies readonly (keyof VibeExactReferences)[];

export function sameVibeExactReferences(
  left: VibeExactReferences,
  right: VibeExactReferences,
): boolean {
  return EXACT_REFERENCE_KEYS.every((key) => (
    left[key].length === right[key].length
    && left[key].every((value, index) => value === right[key][index])
  ));
}

export type VibeWorkspaceViewAction =
  | { readonly kind: "activate_region"; readonly region: VibeRegionRole }
  | { readonly kind: "show_overview" }
  | { readonly kind: "select_block"; readonly blockId: string | null }
  | {
      readonly kind: "replace_page";
      readonly projectId: string;
      readonly pageId: string;
      readonly blockId?: string | null;
    };

const EMPTY_REFS: VibeExactReferences = Object.freeze({
  surfaceInstanceIds: Object.freeze([]),
  conversationIds: Object.freeze([]),
  runIds: Object.freeze([]),
  artifactIds: Object.freeze([]),
  plotIds: Object.freeze([]),
  checkIds: Object.freeze([]),
  evidenceIds: Object.freeze([]),
  findingIds: Object.freeze([]),
  taskIds: Object.freeze([]),
});

export function initialVibeWorkspaceViewState(
  projectId: string,
  pageId: string,
  blockId: string | null = null,
): VibeWorkspaceViewState {
  return {
    projectId,
    pageId,
    activeRegion: "manuscript",
    layoutMode: "overview",
    blockId,
  };
}

export function focusModeForRegion(region: VibeRegionRole): VibeLayoutMode {
  return `focus-${region}`;
}

export function reduceVibeWorkspaceView(
  state: VibeWorkspaceViewState,
  action: VibeWorkspaceViewAction,
): VibeWorkspaceViewState {
  switch (action.kind) {
    case "activate_region":
      return {
        ...state,
        activeRegion: action.region,
        layoutMode: focusModeForRegion(action.region),
      };
    case "show_overview":
      return { ...state, layoutMode: "overview" };
    case "select_block":
      return { ...state, blockId: action.blockId };
    case "replace_page":
      if (state.projectId === action.projectId && state.pageId === action.pageId) {
        return { ...state, blockId: action.blockId ?? null };
      }
      return {
        ...initialVibeWorkspaceViewState(action.projectId, action.pageId),
        blockId: action.blockId ?? null,
      };
  }
}

export function blockForId(page: VibePage, blockId: string | null): VibeBlock | null {
  if (blockId == null) return null;
  for (const section of page.sections) {
    const block = section.blocks.find((candidate) => candidate.block_id === blockId);
    if (block != null) return block;
  }
  return null;
}

function exactViewStateId(
  instance: SurfaceInstance | undefined,
  key: string,
): string | null {
  if (instance == null) return null;
  if (instance.view_state == null || typeof instance.view_state !== "object") return null;
  const viewState = instance.view_state as Readonly<Record<string, unknown>>;
  if (!(key in viewState)) return null;
  const value = viewState[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function exactSurfaceReferences(instance: SurfaceInstance | undefined): VibeExactReferences {
  if (instance == null) return EMPTY_REFS;
  switch (instance.surface_id) {
    case "rho.agent": {
      const conversationId = exactViewStateId(instance, "conversation_id");
      return {
        ...EMPTY_REFS,
        conversationIds: conversationId == null ? [] : [conversationId],
      };
    }
    case "rho.check-result": {
      const checkId = exactViewStateId(instance, "check_result_id");
      return { ...EMPTY_REFS, checkIds: checkId == null ? [] : [checkId] };
    }
    case "rho.runs": {
      const runId = exactViewStateId(instance, "selected_id");
      return { ...EMPTY_REFS, runIds: runId == null ? [] : [runId] };
    }
    case "rho.plots": {
      const plotId = exactViewStateId(instance, "selected_id");
      return { ...EMPTY_REFS, plotIds: plotId == null ? [] : [plotId] };
    }
    case "rho.evidence": {
      const evidenceId = exactViewStateId(instance, "selected_id");
      return { ...EMPTY_REFS, evidenceIds: evidenceId == null ? [] : [evidenceId] };
    }
    default:
      return EMPTY_REFS;
  }
}

export function exactReferencesForBlock(
  page: VibePage,
  blockId: string | null,
  instances: ReadonlyMap<string, SurfaceInstance>,
): VibeExactReferences {
  const block = blockForId(page, blockId);
  if (block == null) return EMPTY_REFS;
  const content = block.content;
  switch (content.kind) {
    case "surface_ref": {
      const linked = exactSurfaceReferences(instances.get(content.instance_id));
      return {
        ...linked,
        surfaceInstanceIds: [content.instance_id],
      };
    }
    case "artifact_ref":
      return { ...EMPTY_REFS, artifactIds: [content.artifact_id] };
    case "finding_ref":
      return { ...EMPTY_REFS, findingIds: [content.finding_id] };
    case "task_ref":
      return { ...EMPTY_REFS, taskIds: [content.task_id] };
    case "rich_text":
    case "callout":
    case "divider":
    case "file_excerpt":
    case "command_ref":
      return EMPTY_REFS;
  }
}

export function focusForPage(
  page: VibePage,
  state: VibeWorkspaceViewState,
  instances: ReadonlyMap<string, SurfaceInstance>,
): VibeFocus {
  const blockId = blockForId(page, state.blockId)?.block_id ?? null;
  return {
    projectId: page.project_id,
    pageId: page.page_id,
    blockId,
    region: state.activeRegion,
    exactRefs: exactReferencesForBlock(page, blockId, instances),
  };
}

export function correspondenceForFocus(focus: VibeFocus): VibeCorrespondence {
  const manuscript: VibeCorrespondenceStep = {
    role: "manuscript",
    label: "当前手稿内容",
    detail: "工作手稿中的当前选择",
  };
  if (focus.blockId == null) {
    return {
      hasExactLink: false,
      summary: "选择手稿中的内容，查看它已有的精确探索与查验关系。",
      steps: [],
    };
  }
  if (focus.exactRefs.conversationIds.length > 0) {
    return {
      hasExactLink: true,
      summary: "当前对应：手稿中的 Agent 引用 → 该会话的探索记录。",
      steps: [manuscript, {
        role: "exploration",
        label: "探索会话",
        detail: "由手稿中精确引用的 Agent 会话",
      }],
    };
  }
  if (focus.exactRefs.artifactIds.length > 0) {
    return {
      hasExactLink: true,
      summary: "当前对应：手稿中的候选产物引用 → 查验记录。",
      steps: [manuscript, {
        role: "verification",
        label: "候选产物",
        detail: "由手稿中精确引用的产物",
      }],
    };
  }
  if (focus.exactRefs.plotIds.length > 0) {
    return {
      hasExactLink: true,
      summary: "当前对应：手稿中的候选图形引用 → 查验记录。",
      steps: [manuscript, {
        role: "verification",
        label: "候选图形",
        detail: "由手稿中精确引用的图形产物",
      }],
    };
  }
  if (focus.exactRefs.runIds.length > 0) {
    return {
      hasExactLink: true,
      summary: "当前对应：手稿中的执行引用 → 查验记录。",
      steps: [manuscript, {
        role: "verification",
        label: "执行记录",
        detail: "由手稿中精确引用的执行",
      }],
    };
  }
  if (focus.exactRefs.checkIds.length > 0 || focus.exactRefs.findingIds.length > 0) {
    return {
      hasExactLink: true,
      summary: focus.exactRefs.checkIds.length > 0
        ? "当前对应：手稿中的项目检查引用 → 查验记录。"
        : "当前对应：手稿中的检查发现引用 → 查验记录。",
      steps: [manuscript, {
        role: "verification",
        label: focus.exactRefs.checkIds.length > 0 ? "项目检查" : "检查发现",
        detail: focus.exactRefs.checkIds.length > 0
          ? "由手稿中精确引用的检查结果"
          : "由手稿中精确引用的发现",
      }],
    };
  }
  if (focus.exactRefs.evidenceIds.length > 0) {
    return {
      hasExactLink: true,
      summary: "当前对应：手稿中的证据记录引用 → 查验记录。",
      steps: [manuscript, {
        role: "verification",
        label: "证据链接",
        detail: "由手稿中精确引用的结构化证据记录",
      }],
    };
  }
  if (focus.exactRefs.taskIds.length > 0) {
    return {
      hasExactLink: true,
      summary: "当前对应：手稿中的任务引用。尚无精确产物关系。",
      steps: [manuscript],
    };
  }
  if (focus.exactRefs.surfaceInstanceIds.length > 0) {
    return {
      hasExactLink: true,
      summary: "当前对应：手稿中的组件引用。该组件尚未提供精确探索或查验关系。",
      steps: [manuscript],
    };
  }
  return {
    hasExactLink: false,
    summary: "当前手稿内容尚未建立精确的探索或查验关系。",
    steps: [manuscript],
  };
}
