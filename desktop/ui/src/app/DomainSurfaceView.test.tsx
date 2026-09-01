import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SurfaceInstance, UiKernelTransport } from "../transport";
import { DomainSurfaceView } from "./DomainSurfaceView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => document.body.replaceChildren());

describe("generic non-semantic Surface", () => {
  it("renders bounded Help records without semantic Authority inference", async () => {
    const instance: SurfaceInstance = {
      instance_id: "surface:help",
      surface_id: "rho.help",
      project_id: "project:a",
      origin: { kind: "application", component_id: "rho.help" },
      activation_generation: 1,
      surface_revision: 1,
      mode_id: "context",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: {},
      lifecycle_state: "active",
    };
    const transport = {
      loadDomainSurface: vi.fn(async () => ({
        surface_id: "rho.help",
        loaded_at: "2026-08-31T20:00:00Z",
        summary: "1 record",
        items: [{ id: "help:1", title: "Rho help", subtitle: null, status: "available", detail: "Current commands" }],
      })),
      subscribeInvalidated: vi.fn(() => () => undefined),
    } as unknown as UiKernelTransport;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<DomainSurfaceView
        instance={instance}
        transport={transport}
        persist={vi.fn(async () => undefined)}
        reportError={vi.fn()}
        openSurfaceById={vi.fn()}
      />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(host.textContent).toContain("Rho help");
    root.unmount();
  });
});
