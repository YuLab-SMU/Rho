import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../../contracts/generated/rsr-contract-fixtures.json";
import type { ProjectUiProfileSnapshot, VibePage } from "../../../transport";
import { VibeManuscriptLane } from "./VibeManuscriptLane";
import type { VibeManuscriptLaneProps } from "./manuscript-types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const profileFixture = fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;

function page(): VibePage {
  return structuredClone(profileFixture.profile.vibe_pages[0]!);
}

function snapshotWithPage(current: VibePage, revision: number): ProjectUiProfileSnapshot {
  const snapshot = structuredClone(profileFixture);
  const mutable = snapshot as unknown as {
    profile: { revision: number; vibe_pages: VibePage[] };
  };
  mutable.profile.revision = revision;
  mutable.profile.vibe_pages = [current];
  return snapshot;
}

describe("Vibe manuscript region", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  async function render(props: VibeManuscriptLaneProps) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VibeManuscriptLane {...props} />));
    return { container, root };
  }

  it("isolates loading and unavailable states from the editor", async () => {
    const retry = vi.fn();
    const { container, root } = await render({ status: "loading" });
    expect(container.querySelector("[aria-busy='true']")?.textContent).toContain("Loading manuscript");
    expect(container.querySelector("[role='textbox']")).toBeNull();

    await act(async () => root.render(
      <VibeManuscriptLane status="error" message="The active Page is unavailable." retry={retry} />,
    ));
    expect(container.querySelector("[role='alert']")?.textContent).toBe("The active Page is unavailable.");
    expect(container.querySelector("[role='textbox']")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("creates the first real block only after the empty-state action and saves it through exact CAS", async () => {
    vi.useFakeTimers();
    const empty: VibePage = { ...page(), sections: [], focused_block_id: null };
    const commitPage = vi.fn(async (request) => snapshotWithPage({
      ...empty,
      page_revision: 2,
      sections: request.mutation.sections,
      focused_block_id: request.mutation.focused_block_id,
    }, 2));
    const { container } = await render({
      status: "ready",
      page: empty,
      profileRevision: 1,
      commitPage,
      reportError: vi.fn(),
    });

    expect(commitPage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This working manuscript has no content yet.");
    await act(async () => container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click());
    expect(container.textContent).toContain("Unsaved changes");
    expect(document.activeElement).toBe(container.querySelector(".ProseMirror"));

    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(commitPage).toHaveBeenCalledOnce();
    expect(commitPage.mock.calls[0]?.[0]).toMatchObject({
      target: {
        project_id: empty.project_id,
        expected_profile_revision: 1,
      },
      page_id: empty.page_id,
      expected_page_revision: 1,
      mutation: { kind: "replace_sections", focused_block_id: null },
    });
    expect(commitPage.mock.calls[0]?.[0].mutation.sections[0]?.blocks[0]?.content.kind).toBe("rich_text");
    expect(container.textContent).toContain("Saved");
  });

  it("shows a truthful error and restores durable content after a rejected save", async () => {
    vi.useFakeTimers();
    const empty: VibePage = { ...page(), sections: [], focused_block_id: null };
    const rejection = new Error("Vibe Page rejected: Page revision is stale.");
    const reportError = vi.fn();
    const { container } = await render({
      status: "ready",
      page: empty,
      profileRevision: 1,
      commitPage: vi.fn(async () => { throw rejection; }),
      reportError,
    });

    await act(async () => container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(180));

    expect(container.querySelector(".rho-vibe-manuscript-save-state[role='alert']")?.textContent)
      .toBe("Save failed; restored the last saved manuscript.");
    expect(container.textContent).not.toContain("Saved");
    expect(container.textContent).toContain("This working manuscript has no content yet.");
    expect(reportError).toHaveBeenCalledWith(rejection);
  });

  it("emits an exact selected block and keeps compact references free of internal IDs", async () => {
    const onActiveBlockChange = vi.fn();
    const current = page();
    const { container } = await render({
      status: "ready",
      page: current,
      profileRevision: profileFixture.profile.revision,
      commitPage: vi.fn(),
      reportError: vi.fn(),
      onActiveBlockChange,
    });

    expect(container.querySelector(".rho-vibe-manuscript-header")?.textContent).not.toContain("· r");
    const atom = container.querySelector<HTMLElement>(".rho-vibe-manuscript-atom-surface_ref")!;
    expect(atom.textContent).toContain("Linked workspace view");
    expect(atom.textContent).not.toContain("instance:check");
    await act(async () => atom.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));
    expect(onActiveBlockChange).toHaveBeenLastCalledWith({
      pageId: current.page_id,
      blockId: "block:check",
    });
    expect(atom.dataset.vibeActive).toBe("true");
  });

  it("provides roving toolbar focus and lets Escape leave the active editor", async () => {
    const current = page();
    const { container } = await render({
      status: "ready",
      page: current,
      profileRevision: profileFixture.profile.revision,
      commitPage: vi.fn(),
      reportError: vi.fn(),
    });

    const toolbar = container.querySelector<HTMLElement>("[role='toolbar']")!;
    const bold = toolbar.querySelector<HTMLButtonElement>("[aria-label='Bold']")!;
    const italic = toolbar.querySelector<HTMLButtonElement>("[aria-label='Italic']")!;
    bold.focus();
    await act(async () => bold.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
    })));
    expect(document.activeElement).toBe(italic);
    expect(bold.tabIndex).toBe(-1);
    expect(italic.tabIndex).toBe(0);

    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    editor.focus();
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    })));
    expect(document.activeElement).toBe(container.querySelector(".rho-vibe-manuscript-header h2"));
  });

  it("keeps one available toolbar tab stop when the active Undo or Save action becomes disabled", async () => {
    const empty: VibePage = { ...page(), sections: [], focused_block_id: null };
    const commitPage = vi.fn(async (request) => snapshotWithPage({
      ...empty,
      page_revision: 2,
      sections: request.mutation.sections,
      focused_block_id: request.mutation.focused_block_id,
    }, 2));
    const { container } = await render({
      status: "ready",
      page: empty,
      profileRevision: 1,
      commitPage,
      reportError: vi.fn(),
    });
    const toolbar = container.querySelector<HTMLElement>("[role='toolbar']")!;
    const assertOneAvailableTabStop = () => {
      const enabled = [...toolbar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      expect(enabled.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    };

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click();
    });
    const undo = toolbar.querySelector<HTMLButtonElement>("[aria-label='Undo manuscript edit']")!;
    expect(undo.disabled).toBe(false);
    await act(async () => undo.focus());
    expect(undo.tabIndex).toBe(0);
    await act(async () => undo.click());
    expect(undo.disabled).toBe(true);
    assertOneAvailableTabStop();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click();
    });
    const save = toolbar.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-save")!;
    expect(save.disabled).toBe(false);
    await act(async () => save.focus());
    expect(save.tabIndex).toBe(0);
    await act(async () => {
      save.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(save.disabled).toBe(true);
    assertOneAvailableTabStop();
  });

  it("keeps a busy manuscript readable while preventing editor and formatting mutations", async () => {
    const empty: VibePage = { ...page(), sections: [], focused_block_id: null };
    const commitPage = vi.fn();
    const ready = {
      status: "ready" as const,
      page: empty,
      profileRevision: 1,
      commitPage,
      reportError: vi.fn(),
    };
    const { container, root } = await render(ready);
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    expect(editor.getAttribute("contenteditable")).toBe("true");

    await act(async () => root.render(<VibeManuscriptLane {...ready} busy />));

    expect(container.querySelector(".rho-vibe-manuscript")?.getAttribute("aria-busy")).toBe("true");
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.getAttribute("aria-readonly")).toBe("true");
    expect([...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-manuscript-toolbar button")]
      .every((button) => button.disabled)).toBe(true);
    const start = container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!;
    expect(start.disabled).toBe(true);
    await act(async () => start.click());
    expect(container.querySelector(".rho-vibe-block-rich_text")).toBeNull();
    expect(container.querySelector(".rho-vibe-manuscript-save-state")?.textContent).toBe("Saved");
    expect(commitPage).not.toHaveBeenCalled();
  });
});
