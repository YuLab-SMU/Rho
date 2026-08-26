import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VibeWorkspace } from "./VibeWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const correspondence = {
  hasExactLink: true,
  summary: "当前对应：手稿中的候选产物引用 → 查验记录。",
  steps: [{
    role: "manuscript" as const,
    label: "当前手稿内容",
    detail: "工作手稿中的当前选择",
  }, {
    role: "verification" as const,
    label: "候选产物",
    detail: "由手稿中精确引用的产物",
  }],
};

describe("VibeWorkspace", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
  });

  async function renderWorkspace(options: {
    readonly layoutMode?: "overview" | "focus-exploration";
    readonly activeRegion?: "manuscript" | "exploration";
    readonly activate?: (region: "manuscript" | "exploration" | "verification") => void;
    readonly overview?: () => void;
  } = {}) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VibeWorkspace
      label="Cluster 3 与 7 的差异比较"
      layoutMode={options.layoutMode ?? "overview"}
      activeRegion={options.activeRegion ?? "manuscript"}
      correspondence={correspondence}
      manuscript={<p>manuscript content</p>}
      exploration={<p>exploration content</p>}
      verification={<p>verification content</p>}
      onActivateRegion={options.activate ?? (() => undefined)}
      onShowOverview={options.overview ?? (() => undefined)}
    />));
    return container;
  }

  function button(container: HTMLElement, label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    if (found == null) throw new Error(`Button ${label} was not rendered.`);
    return found;
  }

  it("keeps manuscript, exploration, and verification in semantic DOM order", async () => {
    const container = await renderWorkspace();
    expect([...container.querySelectorAll<HTMLElement>(".rho-vibe-region")]
      .map((region) => region.dataset.region)).toEqual([
      "manuscript", "exploration", "verification",
    ]);
    expect(container.querySelector("h1")?.textContent).toBe("Cluster 3 与 7 的差异比较");
  });

  it("emits region focus and overview intents without changing scientific content", async () => {
    const activate = vi.fn();
    const overview = vi.fn();
    const container = await renderWorkspace({
      layoutMode: "focus-exploration",
      activeRegion: "exploration",
      activate,
      overview,
    });
    act(() => button(container, "查验与结论").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => button(container, "三联总览").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(activate).toHaveBeenCalledWith("verification");
    expect(overview).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("manuscript content");
  });

  it("renders human correspondence copy without exposing internal identities", async () => {
    const container = await renderWorkspace();
    const relation = container.querySelector<HTMLElement>(".rho-vibe-correspondence");
    expect(relation?.textContent).toContain("候选产物引用");
    expect(relation?.textContent).not.toContain("artifact:");
    expect(relation?.querySelectorAll("li")).toHaveLength(2);
  });
});
