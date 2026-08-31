import type { SurfaceInstance } from "../../../transport";
import type { VibeExactReferences, VibeRegionRole } from "./vibe-workspace-model";

export type VibeStudioTarget =
  | { readonly kind: "surface"; readonly id: string }
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "check"; readonly id: string };

export interface OpenVibeTargetInStudioIntent {
  readonly projectId: string;
  readonly pageId: string;
  readonly blockId: string | null;
  readonly region: VibeRegionRole;
  readonly sourceExactRefs: VibeExactReferences;
  readonly target: VibeStudioTarget;
}

export interface VibeExactSurfaceRequest {
  readonly surfaceId: string;
  readonly modeId: string | null;
  readonly viewState: Readonly<Record<string, unknown>>;
  readonly exactIdentityKey: "selected_id" | "check_result_id" | "conversation_id";
  readonly exactIdentity: string;
  readonly mayCreate: boolean;
}

function nonEmptyIdentity(id: string): string {
  if (id.trim().length === 0) throw new Error("The exact Studio target identity is empty.");
  return id;
}

export function exactSurfaceRequestForTarget(
  target: Exclude<VibeStudioTarget, { readonly kind: "surface" }>,
): VibeExactSurfaceRequest {
  const id = nonEmptyIdentity(target.id);
  switch (target.kind) {
    case "run": return {
      surfaceId: "rho.runs",
      modeId: "history",
      viewState: { selected_id: id, filter: "" },
      exactIdentityKey: "selected_id",
      exactIdentity: id,
      mayCreate: true,
    };
    case "check": return {
      surfaceId: "rho.check-result",
      modeId: null,
      viewState: { check_result_id: id },
      exactIdentityKey: "check_result_id",
      exactIdentity: id,
      mayCreate: false,
    };
  }
}

export function exactAgentSurfaceRequest(
  conversationId: string,
  compose: boolean,
): VibeExactSurfaceRequest {
  const id = nonEmptyIdentity(conversationId);
  return {
    surfaceId: "rho.agent",
    modeId: compose ? "composer" : "conversation",
    viewState: {
      conversation_id: id,
      mode: "act",
      composer: "",
      auto_approve: false,
    },
    exactIdentityKey: "conversation_id",
    exactIdentity: id,
    mayCreate: true,
  };
}

function viewStateRecord(viewState: unknown): Readonly<Record<string, unknown>> {
  return viewState != null && typeof viewState === "object" && !Array.isArray(viewState)
    ? viewState as Readonly<Record<string, unknown>>
    : {};
}

export function exactSurfaceInstance(
  instances: readonly SurfaceInstance[],
  request: VibeExactSurfaceRequest,
): SurfaceInstance | null {
  return instances.find((instance) => (
    instance.surface_id === request.surfaceId
    && viewStateRecord(instance.view_state)[request.exactIdentityKey] === request.exactIdentity
  )) ?? null;
}
