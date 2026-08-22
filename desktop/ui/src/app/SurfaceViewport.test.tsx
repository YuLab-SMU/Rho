import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SurfaceViewport } from "./SurfaceViewport";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    TestIntersectionObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  readonly root = null;
  readonly rootMargin = "800px 0px";
  readonly thresholds = [0];
  trigger(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

describe("Surface viewport lease", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    TestIntersectionObserver.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounts near the viewport and releases an unfocused heavy projection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<SurfaceViewport label="Agent view" releaseDelayMs={25}><input value="heavy" readOnly /></SurfaceViewport>);
    });
    expect(host.querySelector("input")).toBeNull();
    await act(async () => TestIntersectionObserver.instances[0]!.trigger(true));
    expect(host.querySelector("input")?.value).toBe("heavy");
    await act(async () => {
      TestIntersectionObserver.instances[0]!.trigger(false);
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toContain("released while outside the viewport");
  });

  it("does not release a focused projection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<SurfaceViewport label="Editor" releaseDelayMs={20}><input aria-label="focused editor" /></SurfaceViewport>);
    });
    await act(async () => {
      TestIntersectionObserver.instances[0]!.trigger(true);
    });
    host.querySelector<HTMLInputElement>("input")!.focus();
    await act(async () => {
      TestIntersectionObserver.instances[0]!.trigger(false);
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(host.querySelector("input")).not.toBeNull();
  });
});
