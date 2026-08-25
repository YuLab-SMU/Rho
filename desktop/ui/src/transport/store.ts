import type { CommandPlacementTag, UiKernelSnapshot } from "./types";

export { WorkbenchProjectionStore } from "./workbench-store";
export type {
  DomainStoreSnapshot,
  ResourceStoreSnapshot,
  RuntimeStoreSnapshot,
  StudioStoreSnapshot,
  SurfaceStoreSnapshot,
  UiProfileStoreSnapshot,
  UiStoreSnapshot,
  WorkbenchStoreSnapshot,
} from "./workbench-store";

export function commandsForPlacement(
  snapshot: UiKernelSnapshot,
  placement: CommandPlacementTag,
) {
  return snapshot.command_registry.registrations.filter((registration) =>
    registration.definition.placement_tags.includes(placement),
  );
}
