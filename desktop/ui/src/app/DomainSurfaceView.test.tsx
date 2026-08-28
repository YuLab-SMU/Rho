import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DomainSurfaceData, SurfaceInstance, UiKernelTransport } from "../transport";
import { DomainSurfaceView } from "./DomainSurfaceView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function surface(viewState: unknown, projectId = "project:a"): SurfaceInstance {
  return {
    instance_id: "surface-instance:evidence",
    surface_id: "rho.evidence",
    project_id: projectId,
    origin: { kind: "application", component_id: "rho.evidence" },
    activation_generation: 1,
    surface_revision: 1,
    mode_id: "records",
    resource_binding: null,
    runtime_binding: null,
    view_group_id: null,
    view_state: viewState,
    lifecycle_state: "active",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function renderDomain(data: DomainSurfaceData, viewState: unknown) {
  const transport = {
    loadDomainSurface: vi.fn(async () => data),
    subscribeInvalidated: vi.fn(() => () => undefined),
  } as unknown as UiKernelTransport;
  const persist = vi.fn(async () => undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<DomainSurfaceView
      instance={surface(viewState)}
      transport={transport}
      persist={persist}
      reportError={vi.fn()}
      useRuntimeOutputInAgent={vi.fn()}
      openSurfaceById={vi.fn()}
    />);
    await settle();
  });
  return { host, persist };
}

const evidence: DomainSurfaceData = {
  surface_id: "rho.evidence",
  loaded_at: "2026-08-27T00:00:00Z",
  summary: "2 outputs",
  items: [
    {
      id: "claim:local-latest",
      title: "Latest local claim",
      subtitle: "latest.R",
      status: "ready",
      detail: "A newer output from this project.",
    },
    {
      id: "claim:exact",
      title: "Exact source-backed claim",
      subtitle: "analysis.R",
      status: "ready",
      detail: "The manuscript-linked output.",
    },
  ],
};

describe("generic domain exact-target navigation", () => {
  it("gives selected_id priority over filter and preserves it on view-state writes", async () => {
    const { host, persist } = await renderDomain(evidence, {
      selected_id: "claim:exact",
      filter: "Latest local claim",
      retained_key: "retained-value",
    });

    const records = [...host.querySelectorAll<HTMLElement>("[data-domain-id]")];
    expect(records.map((record) => record.dataset.domainId)).toEqual(["claim:exact"]);
    expect(host.textContent).toContain("Exact source-backed claim");
    expect(host.textContent).not.toContain("Latest local claim");

    const input = host.querySelector<HTMLInputElement>("[aria-label='Filter rho.evidence']")!;
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await settle();
    });
    expect(persist).toHaveBeenCalledWith({
      selected_id: "claim:exact",
      filter: "Latest local claim",
      retained_key: "retained-value",
    });
  });

  it("matches generic records by item.id only and never substitutes a local record", async () => {
    const { host } = await renderDomain({
      ...evidence,
      items: [{
        id: "claim:project-a",
        title: "claim:project-b",
        subtitle: "foreign-id-in-visible-copy.R",
        status: "ready",
        detail: "The requested foreign identifier appears in searchable text only.",
      }],
    }, { selected_id: "claim:project-b", filter: "project-b" });

    expect(host.querySelectorAll("[data-domain-id]")).toHaveLength(0);
    expect(host.querySelector(".rho-domain-exact-unavailable")?.textContent)
      .toContain("Exact target unavailable");
    expect(host.textContent).toContain("No substitute was selected");
    expect(host.textContent).not.toContain("foreign-id-in-visible-copy.R");
  });

  it("remounts the exact reader across projects so a late prior-project read cannot replace current truth", async () => {
    const projectA = deferred<DomainSurfaceData>();
    const projectB: DomainSurfaceData = {
      ...evidence,
      items: [{
        id: "claim:project-b",
        title: "Project B exact claim",
        subtitle: "project-b.R",
        status: "ready",
        detail: null,
      }],
    };
    const transport = {
      loadDomainSurface: vi.fn()
        .mockImplementationOnce(async () => projectA.promise)
        .mockImplementationOnce(async () => projectB),
      subscribeInvalidated: vi.fn(() => () => undefined),
    } as unknown as UiKernelTransport;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const commonProps = {
      transport,
      persist: vi.fn(async () => undefined),
      reportError: vi.fn(),
      useRuntimeOutputInAgent: vi.fn(),
      openSurfaceById: vi.fn(),
    };

    await act(async () => {
      root.render(<DomainSurfaceView
        {...commonProps}
        instance={surface({ selected_id: "claim:project-a" }, "project:a")}
      />);
      await settle();
    });
    await act(async () => {
      root.render(<DomainSurfaceView
        {...commonProps}
        instance={surface({ selected_id: "claim:project-b" }, "project:b")}
      />);
      await settle();
    });
    projectA.resolve({
      ...evidence,
      items: [{
        id: "claim:project-a",
        title: "Project A late claim",
        subtitle: "project-a.R",
        status: "ready",
        detail: null,
      }],
    });
    await act(async () => { await settle(); });

    expect(host.querySelector("[data-domain-id='claim:project-b']")).not.toBeNull();
    expect(host.textContent).toContain("Project B exact claim");
    expect(host.textContent).not.toContain("Project A late claim");
  });
});
