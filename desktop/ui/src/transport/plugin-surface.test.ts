import { describe, expect, it } from "vitest";

import {
  createTauriPluginSurfaceTransport,
  type PluginSurfaceDocumentRequest,
  type PluginSurfaceTransport,
} from "./plugin-surface";
import type {
  PluginSurfaceDocumentView as PluginSurfaceDocumentViewWire,
  PluginSurfaceEventResult_Serialize as PluginSurfaceEventResultWire,
} from "./generated/plugin-surface";
import { createMockUiKernelTransport } from "./mock";

const target = {
  project_id: "project:fixture",
  instance_id: "instance:playground-a",
  activation_generation: 1,
  expected_project_revision: 7,
  expected_surface_revision: 1,
} as const;

const request = {
  target,
  expected_layout_revision: 4,
  expected_page_revision: null,
} satisfies PluginSurfaceDocumentRequest;

const documentView = {
  project_id: target.project_id,
  instance_id: target.instance_id,
  surface_id: "ui.surface.fixture",
  surface_revision: 1,
  document: {
    contract: "rho.plugin_surface_document.v1",
    revision: 1,
    title: "Fixture Surface",
    blocks: [{
      kind: "column",
      blocks: [
        { kind: "notice", tone: "info", text: "Bounded fixture" },
        {
          kind: "command_button",
          control_id: "apply",
          label: "Apply",
          command_id: "analysis.apply",
          disabled: false,
          busy: false,
        },
      ],
    }],
  },
  provenance: { origin: "trusted_surface", generation: 3 },
} as const satisfies PluginSurfaceDocumentViewWire;

const eventResult = {
  event_id: "surface-event:fixture",
  status: "completed",
  document: documentView.document,
  command_result: { kind: "notification", message: "Applied" },
  provenance: { origin: "trusted_surface", generation: 3 },
} as const satisfies PluginSurfaceEventResultWire;

describe("Workspace-plugin Surface generated transport", () => {
  it("owns exact document/event commands and complete recursive results", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriPluginSurfaceTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return (command === "plugin_surface_document" ? documentView : eventResult) as T;
      },
    );
    const event = {
      ...request,
      expected_document_revision: 1,
      control_id: "apply",
      event_kind: "activate",
      value: { selected: true },
    } as const;

    await expect(transport.loadPluginSurfaceDocument(request)).resolves.toStrictEqual(documentView);
    await expect(transport.dispatchPluginSurfaceEvent(event)).resolves.toStrictEqual(eventResult);
    expect(calls).toEqual([
      { command: "plugin_surface_document", args: { request } },
      { command: "plugin_surface_event", args: { request: event } },
    ]);
    expect(eventResult.document?.blocks[0]).toMatchObject({ kind: "column" });
    expect(eventResult.command_result).toEqual({ kind: "notification", message: "Applied" });
  });

  it("preserves stale document rejection", async () => {
    const transport = createTauriPluginSurfaceTransport(async () => {
      throw new Error("workspace Surface document is stale");
    });
    await expect(transport.dispatchPluginSurfaceEvent({
      ...request,
      expected_document_revision: 1,
      control_id: "apply",
      event_kind: "activate",
      value: null,
    })).rejects.toThrow("document is stale");
  });

  it("keeps the browser mock assignable to the narrow generated facet", async () => {
    const mock = createMockUiKernelTransport("plugin=surface");
    const surfaces = await mock.loadSurfaces();
    const studio = await mock.loadStudio();
    const instance = surfaces.catalog.instances.find(
      (candidate) => candidate.origin.kind === "workspace_plugin",
    );
    if (instance == null) throw new Error("Mock workspace-plugin Surface is unavailable");
    const pluginRequest = {
      target: {
        project_id: instance.project_id,
        instance_id: instance.instance_id,
        activation_generation: instance.activation_generation,
        expected_project_revision: surfaces.project_revision,
        expected_surface_revision: instance.surface_revision,
      },
      expected_layout_revision: studio.scene.layout_revision,
      expected_page_revision: null,
    } satisfies PluginSurfaceDocumentRequest;
    const transport: PluginSurfaceTransport = mock;
    const view = await transport.loadPluginSurfaceDocument(pluginRequest);
    expect(view.document.contract).toBe("rho.plugin_surface_document.v1");
    expect(view.provenance).toMatchObject({ origin: "trusted_surface" });
  });
});
