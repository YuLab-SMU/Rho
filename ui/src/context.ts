import { useSyncExternalStore } from "react";
import { Studio } from "./studio";
import { HostClient } from "./host-client";

export const studio = new Studio(HostClient.fromLocation());
export function useStudio(...channels: string[]) {
  const selected = channels.length
    ? channels
    : ["shell", "runtime", "console", "layout", "documents"];
  useSyncExternalStore(
    (fn) => studio.subscribeChannels(selected, fn),
    () => studio.channelSnapshot(selected),
  );
  return studio;
}
