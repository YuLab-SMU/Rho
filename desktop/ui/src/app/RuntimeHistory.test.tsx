import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DomainSurfaceData,
  RuntimeExecution,
  RuntimeOutputPage,
  RuntimeOutputPolicyView,
} from "../transport";
import { RuntimeHistory } from "./RuntimeHistory";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function execution(overrides: Partial<RuntimeExecution> = {}): RuntimeExecution {
  return {
    execution_id: "execution:latest",
    project_root: "/projects/a",
    run_id: "run:latest",
    runtime_provider_id: "runtime-provider:r",
    runtime_instance_id: "runtime:r",
    runtime_activation_generation: 1,
    console_instance_id: "console:source",
    submitted_code: "latest_local_result()",
    workspace_id: "workspace:a",
    source_path: "analysis.R",
    execution_mode: "expression",
    document_version: 1,
    status: "completed",
    terminal_reason: null,
    output_state: "complete",
    last_sequence: 0,
    output_bytes: 0,
    started_at: "2026-08-27T02:00:00Z",
    finished_at: "2026-08-27T02:00:01Z",
    ...overrides,
  };
}

const policy: RuntimeOutputPolicyView = {
  policy: {
    project_root: "/projects/a",
    revision: 1,
    max_runtime_output_bytes_per_execution: null,
    runtime_output_project_warning_bytes: null,
    max_runtime_execution_rows: null,
    auto_prune_enabled: false,
    updated_at: "2026-08-27T00:00:00Z",
  },
  project_output_bytes: 0,
  project_execution_count: 0,
  warning_active: false,
};

function pageFor(row: RuntimeExecution): RuntimeOutputPage {
  return {
    execution_id: row.execution_id,
    project_root: row.project_root,
    status: row.status,
    output_state: row.output_state,
    total_output_bytes: row.output_bytes,
    after_sequence: 0,
    before_sequence: null,
    previous_sequence: 0,
    next_sequence: 0,
    has_older: false,
    has_more: false,
    chunks: [],
  };
}

type HistoryTransport = ComponentProps<typeof RuntimeHistory>["transport"];

function historyTransport(
  runtimePages: readonly (readonly RuntimeExecution[])[],
  legacyItems: DomainSurfaceData["items"] = [],
): HistoryTransport {
  let pageIndex = 0;
  const transport = {
    listRuntimeExecutions: vi.fn(async (_limit?: number, before?: unknown) => {
      const index = before == null ? 0 : ++pageIndex;
      return runtimePages[index] ?? [];
    }),
    loadDomainSurface: vi.fn(async (): Promise<DomainSurfaceData> => ({
      surface_id: "rho.runs",
      loaded_at: "2026-08-27T00:00:00Z",
      summary: "history",
      items: legacyItems,
    })),
    subscribeInvalidated: vi.fn(() => () => undefined),
    getRuntimeOutputPolicy: vi.fn(async () => policy),
    updateRuntimeOutputPolicy: vi.fn(async () => policy),
    loadRuntimeOutputPage: vi.fn(async ({ execution_id }: { readonly execution_id: string }) => {
      const row = runtimePages.flat().find((candidate) => candidate.execution_id === execution_id);
      if (row == null) throw new Error("Execution not found in test transport.");
      return pageFor(row);
    }),
    getRuntimeExecution: vi.fn(),
    searchRuntimeOutput: vi.fn(),
    createRuntimeOutputReference: vi.fn(),
    pruneRuntimeOutput: vi.fn(),
    deleteRuntimeExecution: vi.fn(),
    followRuntimeOutput: vi.fn(),
  };
  return transport as unknown as HistoryTransport;
}

async function renderHistory(options: {
  readonly transport: HistoryTransport;
  readonly selectedId: string | null;
  readonly filter?: string;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<RuntimeHistory
      transport={options.transport}
      initialFilter={options.filter ?? ""}
      selectedId={options.selectedId}
      persistFilter={async () => undefined}
      reportError={vi.fn()}
      useInAgent={vi.fn()}
      openOutputReference={vi.fn()}
    />);
    await settle();
  });
  return host;
}

describe("Runtime History exact-target navigation", () => {
  it.each([
    ["run id", "run:exact"],
    ["execution id", "execution:exact"],
  ])("locates an execution by exact %s and ignores a conflicting filter", async (_label, selectedId) => {
    const latest = execution();
    const exact = execution({
      execution_id: "execution:exact",
      run_id: "run:exact",
      submitted_code: "exact_manuscript_result()",
      started_at: "2026-08-27T01:00:00Z",
    });
    const host = await renderHistory({
      transport: historyTransport([[latest, exact]]),
      selectedId,
      filter: "latest_local_result",
    });

    const rows = [...host.querySelectorAll<HTMLElement>(".rho-runtime-history-row")];
    expect(rows.map((row) => row.dataset.domainId)).toEqual(["execution:exact"]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(host.textContent).toContain("exact_manuscript_result()");
    expect(host.textContent).not.toContain("latest_local_result()");
  });

  it("continues through Runtime pages until an older exact run is found", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => execution({
      execution_id: `execution:recent-${index}`,
      run_id: `run:recent-${index}`,
      submitted_code: `recent_${index}()`,
      started_at: `2026-08-27T02:${String(59 - index).padStart(2, "0")}:00Z`,
    }));
    const exact = execution({
      execution_id: "execution:older-exact",
      run_id: "run:older-exact",
      submitted_code: "older_exact_result()",
      started_at: "2026-08-26T23:00:00Z",
    });
    const transport = historyTransport([firstPage, [exact]]);
    const host = await renderHistory({ transport, selectedId: "run:older-exact" });

    expect(transport.listRuntimeExecutions).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-domain-id='execution:older-exact']")).not.toBeNull();
    expect(host.textContent).not.toContain("Exact target unavailable");
  });

  it("selects an exact legacy id without falling back to a newer Runtime execution", async () => {
    const host = await renderHistory({
      transport: historyTransport([[execution()]], [{
        id: "run:legacy-exact",
        title: "Legacy exact run",
        subtitle: "legacy.R",
        status: "completed",
        detail: "{\"source_path\":\"legacy.R\",\"code_preview\":\"legacy_exact_result()\"}",
      }]),
      selectedId: "run:legacy-exact",
    });

    expect(host.querySelector("[data-domain-id='run:legacy-exact']")?.getAttribute("aria-current"))
      .toBe("true");
    expect(host.textContent).toContain("legacy_exact_result()");
    expect(host.textContent).not.toContain("latest_local_result()");
  });

  it("shows exact-unavailable for another project's id and never selects the local latest row", async () => {
    const local = execution({
      submitted_code: "mentions('run:project-b')",
      project_root: "/projects/a",
    });
    const host = await renderHistory({
      transport: historyTransport([[local]]),
      selectedId: "run:project-b",
      filter: "project-b",
    });

    expect(host.querySelectorAll(".rho-runtime-history-row")).toHaveLength(0);
    expect(host.querySelectorAll(".rho-domain-exact-unavailable")).toHaveLength(2);
    expect(host.textContent).toContain("No substitute was selected");
    expect(host.textContent).not.toContain("mentions('run:project-b')");
    expect(host.querySelector("[aria-current='true']")).toBeNull();
  });
});
