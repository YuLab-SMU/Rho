import type { PluginWindowLayout } from "../../sdk/plugin-protocol/index.js";
import type { HostClient } from "./host-client";
import { json } from "./host-client";
import { PluginWindowState } from "./plugin-window-state";

/** The containing shell uses the same Query/Operation ports as CLI and MCP. The
 * model receives no credential and cannot choose another project's transport. */
export function createPluginWindowState(client: Pick<HostClient, "windowId" | "query" | "invoke">, project: string) {
  return new PluginWindowState(client.windowId, {
    read: async () => {
      const snapshot = await client.query(project, "windows.layout", { window: client.windowId });
      if (snapshot.status !== "ready" || !snapshot.data)
        throw new Error(snapshot.notices.join("\n") || "The saved window layout is unavailable.");
      return snapshot.data as unknown as PluginWindowLayout;
    },
    write: async (args, requestId) => {
      const record = await client.invoke(project, { client_request_id: requestId,
        capability: { id: "windows.update_layout", version: 1 }, arguments: json(args), preconditions: [] });
      if (record.operation.client_request_id !== requestId || record.operation.capability.id !== "windows.update_layout" || record.operation.capability.version !== 1)
        throw new Error("The layout reply belongs to a different Operation.");
      if (record.status !== "succeeded" || record.outcome !== "succeeded" || !record.output)
        throw new Error(record.error || `Layout save is ${record.status}. Inspect Operation ${record.operation.operation_id} before retrying.`);
      return record.output as unknown as PluginWindowLayout;
    },
  });
}
