import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mockEnvironmentHealth,
  mockLocalEnvironmentObservation,
} from "../../transport/environment.mock";
import { AgentEnvironmentPanel } from "../agent/AgentEnvironmentPanel";
import type { AuthorityEnvironmentPort } from "../workbench/authorityPorts";
import { EnvironmentHealthPanel } from "./EnvironmentHealthPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function render(element: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(element); await settle(); });
  return host;
}

describe("Environment Authority and Agent Doctor", () => {
  function port(health = mockEnvironmentHealth()): AuthorityEnvironmentPort {
    return {
      environmentHealth: vi.fn(async () => health),
      reobserveEnvironment: vi.fn(async () => health),
      subscribeInvalidated: vi.fn(() => () => undefined),
    } as unknown as AuthorityEnvironmentPort;
  }

  it("keeps receipt facts, immutable plan and operation checkpoints explicit", async () => {
    const environment = port();
    const host = await render(<EnvironmentHealthPanel
      transport={environment}
      mode="health"
      reportError={vi.fn()}
    />);
    expect(host.textContent).toContain("Authority facts");
    expect(host.textContent).toContain("environment-receipt:mock");
    expect(host.textContent).toContain("Immutable exact plan");
    expect(host.textContent).toContain("install DESeq2@1.50.0");
    expect(host.textContent).toContain("Exact target library");
    expect(host.textContent).toContain("/Users/rho/R/library");
    expect(host.textContent).toContain("Operation activity");
    expect(host.textContent).toContain("committed");
    expect(host.textContent).toContain("Workspace R running");
  });

  it("shows a materialized plan before approval or execution", async () => {
    const base = mockEnvironmentHealth();
    const pending = {
      ...base,
      pending_plan: base.latest_operation!.plan,
      latest_operation: null,
    } as const;
    const host = await render(<EnvironmentHealthPanel
      transport={port(pending)}
      mode="plans"
      reportError={vi.fn()}
    />);
    expect(host.textContent).toContain("Awaiting exact approval");
    expect(host.textContent).toContain(base.latest_operation!.plan.plan_id);
    expect(host.textContent).not.toContain("Operation activity");
  });

  it("presents an ordinary project as locally ready without inventing a plan or receipt", async () => {
    const base = mockEnvironmentHealth();
    const local = {
      ...base,
      status: "local_ready",
      binding: null,
      local_observation: mockLocalEnvironmentObservation(),
      pending_plan: null,
      latest_operation: null,
      workspace: {
        ...base.workspace,
        phase: "unbound",
        active_receipt_digest: null,
      },
      incidents: [],
    } as const;
    const host = await render(<EnvironmentHealthPanel
      transport={port(local)}
      mode="health"
      reportError={vi.fn()}
    />);
    expect(host.textContent).toContain("Ready for local work");
    expect(host.textContent).toContain("Using your existing R environment");
    expect(host.textContent).toContain("Native user");
    expect(host.textContent).toContain("ReproducibilityNot configured");
    expect(host.textContent).toContain("Workspace R running");
    expect(host.textContent).not.toContain("No materialized plan");
    expect(host.textContent).not.toContain("No verified Environment receipt");
  });

  it("Agent Doctor cites Environment Authority and exposes uncertainty without installing", async () => {
    const base = mockEnvironmentHealth();
    const health = {
      ...base,
      status: "blocked_by_incident",
      workspace: {
        ...base.workspace,
        phase: "blocked_by_incident",
        reobserve_required: true,
      },
      incidents: [{
        incident_id: "environment_incident_mock",
        kind: "namespace_load_failure",
        subject: "DESeq2",
        detail: "Namespace did not load.",
        status: "open",
        detected_at: base.observed_at,
        resolved_at: null,
      }],
    } as const;
    const host = await render(<AgentEnvironmentPanel port={port(health)} reportError={vi.fn()} />);
    expect(host.textContent).toContain("Environment Doctor");
    expect(host.textContent).toContain("authority: succeeded");
    expect(host.textContent).toContain("namespace load failure");
    expect(host.textContent).toContain("cannot install directly");
  });

  it("lets Agent cite the local observation without claiming formal reproducibility", async () => {
    const base = mockEnvironmentHealth();
    const local = {
      ...base,
      status: "local_ready",
      binding: null,
      local_observation: mockLocalEnvironmentObservation(),
      incidents: [],
    } as const;
    const host = await render(<AgentEnvironmentPanel port={port(local)} reportError={vi.fn()} />);
    expect(host.textContent).toContain("Ready for local work");
    expect(host.textContent).toContain("R version 4.5.2");
    expect(host.textContent).toContain("local observation");
    expect(host.textContent).toContain("formal reproducibility remain unverified");
    expect(host.textContent).not.toContain("No open Environment incident");
  });

  it("recovers from an unavailable Authority projection without exposing local paths", async () => {
    let available = false;
    const environment = port();
    vi.mocked(environment.environmentHealth).mockImplementation(async () => {
      if (!available) throw new Error("Environment Authority unavailable at /Users/alice/private");
      return mockEnvironmentHealth();
    });
    const host = await render(<EnvironmentHealthPanel
      transport={environment}
      mode="health"
      reportError={vi.fn()}
    />);
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Environment Authority unavailable");
    expect(host.textContent).toContain("[local path]");
    expect(host.textContent).not.toContain("/Users/alice");
    available = true;
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Try again")!.click();
      await settle();
    });
    expect(host.querySelector("[role='alert']")).toBeNull();
    expect(host.querySelector(".rho-environment-health")).not.toBeNull();
  });
});
