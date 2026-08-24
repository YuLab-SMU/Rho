import { Suspense, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleExecutionRouter } from "./console-execution-router";
import { useConsoleProjectActivation } from "./console-project-activation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ router, projectId }: {
  readonly router: ConsoleExecutionRouter;
  readonly projectId: string | null;
}) {
  useConsoleProjectActivation(router, projectId);
  return <div>{projectId}</div>;
}

describe("Console project activation lifecycle", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function root() {
    const container = document.createElement("div");
    document.body.append(container);
    const created = createRoot(container);
    roots.push(created);
    return created;
  }

  it("does not activate a project for a render that never commits", async () => {
    const router = new ConsoleExecutionRouter();
    const activate = vi.spyOn(router, "activateProject");
    const pending = new Promise<void>(() => undefined);
    function Discarded(): never {
      useConsoleProjectActivation(router, "project:discarded");
      throw pending;
    }
    const created = root();
    await act(async () => {
      created.render(<Suspense fallback={<div>Loading</div>}><Discarded /></Suspense>);
      await Promise.resolve();
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it("activates committed A/B projects and rejects old-project waiters", async () => {
    const router = new ConsoleExecutionRouter();
    const activate = vi.spyOn(router, "activateProject");
    const created = root();
    await act(async () => {
      created.render(<Harness router={router} projectId="project:a" />);
    });
    const waiting = router.waitFor("console:project-a");
    const rejected = expect(waiting).rejects.toThrow("project changed");
    await act(async () => {
      created.render(<Harness router={router} projectId="project:b" />);
    });
    await rejected;
    expect(activate.mock.calls.map(([projectId]) => projectId))
      .toEqual(["project:a", "project:b"]);
  });

  it("disposes the router and clears pending waiters on unmount", async () => {
    const router = new ConsoleExecutionRouter();
    const created = root();
    await act(async () => {
      created.render(<Harness router={router} projectId="project:a" />);
    });
    const waiting = router.waitFor("console:closing");
    const rejected = expect(waiting).rejects.toThrow("workbench closed");
    act(() => created.unmount());
    roots.splice(roots.indexOf(created), 1);
    await rejected;
  });
});
