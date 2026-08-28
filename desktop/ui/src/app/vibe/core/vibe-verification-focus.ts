import type { SurfaceInstance, VibePage } from "../../../transport";
import type {
  VerificationExactReference,
  VerificationFocus,
  VerificationReferenceKind,
} from "../verification";
import { blockForId, type VibeFocus } from "./vibe-workspace-model";

function viewStateId(instance: SurfaceInstance, key: string): string | null {
  if (instance.view_state == null || typeof instance.view_state !== "object") return null;
  const viewState = instance.view_state as Readonly<Record<string, unknown>>;
  if (!(key in viewState)) return null;
  const value = viewState[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function surfaceReference(
  instance: SurfaceInstance | undefined,
): { readonly kind: VerificationReferenceKind; readonly id: string; readonly label: string } | null {
  if (instance == null) return null;
  const selectedId = viewStateId(instance, "selected_id");
  switch (instance.surface_id) {
    case "rho.check-result": {
      const id = viewStateId(instance, "check_result_id");
      return id == null ? null : { kind: "check", id, label: "项目检查结果" };
    }
    case "rho.runs":
      return selectedId == null ? null : { kind: "run", id: selectedId, label: "执行记录" };
    case "rho.plots":
      return selectedId == null ? null : { kind: "plot", id: selectedId, label: "候选图形" };
    case "rho.evidence":
      return selectedId == null
        ? null
        : { kind: "evidence", id: selectedId, label: "结构化证据记录" };
    default:
      return null;
  }
}

function referencesForBlock(
  page: VibePage,
  blockId: string,
  instances: ReadonlyMap<string, SurfaceInstance>,
): readonly VerificationExactReference[] {
  const block = blockForId(page, blockId);
  if (block == null) return [];
  const origin = { kind: "page-block" as const, pageId: page.page_id, blockId };
  switch (block.content.kind) {
    case "artifact_ref":
      return [{
        kind: "artifact",
        id: block.content.artifact_id,
        label: block.content.label,
        origin,
      }];
    case "finding_ref":
      return [{
        kind: "finding",
        id: block.content.finding_id,
        label: block.content.label,
        origin,
      }];
    case "surface_ref": {
      const exact = surfaceReference(instances.get(block.content.instance_id));
      return exact == null ? [] : [{
        ...exact,
        origin: { kind: "surface", instanceId: block.content.instance_id },
      }];
    }
    case "rich_text":
    case "callout":
    case "divider":
    case "file_excerpt":
    case "task_ref":
    case "command_ref":
      return [];
  }
}

export function verificationFocusForVibe({
  page,
  projectRoot,
  projectRevision,
  epoch,
  focus,
  instances,
}: {
  readonly page: VibePage;
  readonly projectRoot: string;
  readonly projectRevision: number;
  readonly epoch: number;
  readonly focus: VibeFocus;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
}): VerificationFocus | null {
  if (focus.blockId == null || blockForId(page, focus.blockId) == null) return null;
  return {
    projectId: page.project_id,
    projectRoot,
    projectRevision,
    epoch,
    pageId: page.page_id,
    blockId: focus.blockId,
    references: referencesForBlock(page, focus.blockId, instances),
  };
}
