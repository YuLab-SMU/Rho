import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeDescriptor, RuntimeRegistrySnapshot } from "../../transport";
import { RuntimeCenterSurface } from "./RuntimeCenterSurface";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function runtime(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
  return {
    runtime_provider_id: "rho.ark-r",
    runtime_instance_id: "runtime:workspace-r",
    runtime_kind: "r",
    project_id: "project:mock",
    activation_generation: 1,
    state_revision: 1,
    status: "ready",
    attach_capabilities: ["console.attach"],
    persistence_class: "project_persistent",
    display_label: "Workspace R",
    primary_scientific_runtime: true,
    ...overrides,
  };
}

function snapshot(): RuntimeRegistrySnapshot {
  return {
    contract: "rho.ui.runtime-registry.snapshot.v1",
    contract_major: 1,
    snapshot_revision: 8,
    project_id: "project:mock",
    project_revision: 4,
    providers: [{
      definition: {
        runtime_provider_id: "rho.ark-r",
        runtime_kind: "r",
        display_label: "Ark R",
        create_supported: true,
        max_instances: 8,
        attach_capabilities: ["console.attach"],
        application_component_id: "rho.runtime.ark-r",
      },
      activation_generation: 1,
    }],
    instances: [
      runtime(),
      runtime({
        runtime_instance_id: "runtime:aux-1",
        display_label: "Model fitting",
        primary_scientific_runtime: false,
        persistence_class: "explicit_lease",
        status: "busy",
      }),
    ],
  };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function renderSurface(overrides: Partial<Parameters<typeof RuntimeCenterSurface>[0]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const props: Parameters<typeof RuntimeCenterSurface>[0] = {
    snapshot: snapshot(),
    consoleAttachments: [{ console_instance_id: "console:aux", runtime_instance_id: "runtime:aux-1" }],
    createRuntime: vi.fn(async () => undefined),
    openConsole: vi.fn(async () => undefined),
    interruptRuntime: vi.fn(async () => undefined),
    restartRuntime: vi.fn(async () => undefined),
    stopRuntime: vi.fn(async () => undefined),
    reportError: vi.fn(),
    ...overrides,
  };
  await act(async () => { root.render(<RuntimeCenterSurface {...props} />); await settle(); });
  return { host, props };
}

describe("Runtime Center", () => {
  it("separates the primary Runtime from a busy auxiliary process and its Console", async () => {
    const { host, props } = await renderSurface();
    expect(host.textContent).toContain("2 Runtimes");
    expect(host.textContent).toContain("1 ready · 1 active");
    expect(host.textContent).toContain("Primary workspace");
    expect(host.textContent).toContain("Model fitting");
    expect(host.textContent).toContain("1 Console");
    const auxiliary = host.querySelector<HTMLElement>("[data-runtime-id='runtime:aux-1']")!;
    expect(auxiliary.getAttribute("data-status")).toBe("busy");
    await act(async () => {
      [...auxiliary.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Open Console")!.click();
      await settle();
    });
    expect(props.openConsole).toHaveBeenCalledWith(expect.objectContaining({ runtime_instance_id: "runtime:aux-1" }), false);
  });

  it("creates a named auxiliary Runtime and can request a dedicated Console", async () => {
    const createRuntime = vi.fn(async () => undefined);
    const { host } = await renderSurface({ createRuntime });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "New Runtime")!.click();
      await settle();
    });
    const input = host.querySelector<HTMLInputElement>(".rho-runtime-create-fields input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "Background model");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Create Runtime")!.click();
      await settle();
    });
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ definition: expect.objectContaining({ runtime_provider_id: "rho.ark-r" }) }),
      "Background model",
      true,
    );
  });

  it("requires confirmation before stopping an auxiliary Runtime", async () => {
    const stopRuntime = vi.fn(async () => undefined);
    const { host } = await renderSurface({ stopRuntime });
    const auxiliary = host.querySelector<HTMLElement>("[data-runtime-id='runtime:aux-1']")!;
    const manage = auxiliary.querySelector<HTMLDetailsElement>(".rho-runtime-manage")!;
    manage.open = true;
    await act(async () => {
      [...manage.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Stop…")!.click();
      await settle();
    });
    const confirmation = host.querySelector<HTMLElement>("[role='alertdialog']")!;
    expect(confirmation.textContent).toContain("in-memory objects");
    await act(async () => {
      [...confirmation.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Stop Runtime")!.click();
      await settle();
    });
    expect(stopRuntime).toHaveBeenCalledWith(expect.objectContaining({ runtime_instance_id: "runtime:aux-1" }));
  });
});
