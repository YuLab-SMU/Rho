import type { PluginWindowLayout, PluginViewConnection, PluginViewRecord, PluginInspection } from "../../sdk/plugin-protocol/index.js";
import type { HostClient } from "./host-client";
import { json } from "./host-client";
import { PluginWindowState } from "./plugin-window-state";
import { PluginWindowViews } from "./plugin-window-views";
import { PluginWindowClosures, ConfirmedCloseFailure } from "./plugin-window-close";

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

/** Scoped metadata and connection observations; no provider is activated and
 * presentation names come from immutable manifest contributions. */
export function createPluginWindowViews(client: Pick<HostClient, "windowId" | "query">, project: string) {
  const read = async <T>(capability: string, args: Record<string, string>): Promise<T> => {
    const snapshot = await client.query(project, capability, args);
    if (snapshot.status !== "ready" || !snapshot.data) throw new Error(snapshot.notices.join("\n") || "The view observation is unavailable.");
    return snapshot.data as unknown as T;
  };
  return new PluginWindowViews(client.windowId, {
    connect: view => read<PluginViewConnection>("views.connection", { view }),
    inspect: view => read<PluginViewRecord>("views.inspect", { view }),
    title: async record => {
      const inspection = await read<PluginInspection>("plugins.inspect", { revision: record.instance.revision });
      if (inspection.summary.revision !== record.instance.revision || inspection.manifest.id !== record.instance.plugin)
        throw new Error("The view title belongs to another plugin revision.");
      return inspection.manifest.views.find(view => view.id === record.contribution)?.title ?? record.contribution;
    },
  });
}

export function createPluginWindowClosures(client: Pick<HostClient, "windowId" | "invoke">, project: string) {
  return new PluginWindowClosures(async (view, request) => {
    const record = await client.invoke(project, { client_request_id: request,
      capability: { id: "views.close", version: 1 }, arguments: { view, mode: { kind: "flush" } }, preconditions: [] });
    if (record.operation.client_request_id !== request || record.operation.capability.id !== "views.close" || record.operation.capability.version !== 1)
      throw new Error("The close reply belongs to a different Operation.");
    if (record.status !== "succeeded" || record.outcome !== "succeeded" || !record.output) {
      const error = record.error || `Close is ${record.status}. Original Operation: ${record.operation.operation_id}.`;
      if (record.status === "failed" || record.status === "cancelled") throw new ConfirmedCloseFailure(error);
      throw new Error(error);
    }
    const closed = record.output as unknown as PluginViewRecord;
    if (closed.window !== client.windowId) throw new Error("The close reply belongs to another window.");
    return closed;
  });
}
