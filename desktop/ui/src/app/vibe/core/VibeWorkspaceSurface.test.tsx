import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../../contracts/generated/rsr-contract-fixtures.json";
import type {
  ProjectUiProfileSnapshot,
  SurfaceInstance,
  VibePage,
} from "../../../transport";
import type { VibeExplorationTransport } from "../exploration/VibeExplorationPanel";
import type { VerificationAdapter } from "../verification/verification-adapter";
import {
  makeCheck,
  makeSnapshot,
  source,
} from "../verification/verification-test-fixtures";
import {
  VibeWorkspaceSurface,
  type VibeWorkspaceSurfaceProps,
} from "./VibeWorkspaceSurface";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const profileFixture = fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;
const instanceFixture = fixture.instances.find(
  (candidate) => candidate.instance_id === "instance:check",
) as unknown as SurfaceInstance;

function focusedPage(): VibePage {
  const page = structuredClone(profileFixture.profile.vibe_pages[0]!);
  return { ...page, focused_block_id: "block:check" };
}

function checkInstance(resultId: string): SurfaceInstance {
  return {
    ...structuredClone(instanceFixture),
    view_state: { check_result_id: resultId },
  };
}

const explorationTransport: VibeExplorationTransport = {
  listAgentConversations: async () => [],
  listAgentTurns: async () => [],
  getAgentTurnDetail: async () => null,
  subscribeAgentInvalidated: () => () => undefined,
};

const verificationAdapter: VerificationAdapter = {
  load: async (focus) => {
    const reference = focus.references.find((candidate) => candidate.kind === "check");
    const base = makeCheck();
    return makeSnapshot(focus, {
      checks: reference == null ? source() : source([{
        status: "ready",
        result: {
          ...base,
          result_id: reference.id,
          project_id: focus.projectId,
          project_revision: focus.projectRevision,
          snapshot: {
            ...base.snapshot,
            project_id: focus.projectId,
            project_revision: focus.projectRevision,
          },
        },
        references: [reference],
      }]),
    });
  },
  subscribe: () => () => undefined,
};

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("VibeWorkspaceSurface", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("opens the latest exact Surface selection when the selected block identity is unchanged", async () => {
    const page = focusedPage();
    const onOpenStudio = vi.fn<VibeWorkspaceSurfaceProps["onOpenStudio"]>()
      .mockResolvedValue(undefined);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    const renderSurface = (resultId: string) => (
      <VibeWorkspaceSurface
        page={page}
        profileRevision={profileFixture.profile.revision}
        projectRoot="/projects/fixture"
        projectRevision={12}
        projectEpoch={1}
        transitionBusy={false}
        instances={new Map([[instanceFixture.instance_id, checkInstance(resultId)]])}
        restoredReturnPoint={null}
        onReturnPointRestored={() => undefined}
        commitPage={async () => profileFixture}
        exportCurrentPage={async () => ({
          contract: "rho.ui.vibe-page.export.v1",
          project_id: page.project_id,
          page_id: page.page_id,
          page_revision: page.page_revision,
          label: page.label,
          markdown: "",
        })}
        explorationTransport={explorationTransport}
        verificationAdapter={verificationAdapter}
        onOpenStudio={onOpenStudio}
        onOpenAgent={async () => undefined}
        reportError={vi.fn()}
      />
    );

    await act(async () => {
      root.render(renderSurface("check-result-old"));
      await settle();
    });
    await act(async () => {
      root.render(renderSurface("check-result-current"));
      await settle();
    });

    const open = [...host.querySelectorAll<HTMLButtonElement>(".rho-vibe-verification button")]
      .find((button) => button.textContent === "在 Studio 中查看");
    expect(open).toBeDefined();
    await act(async () => {
      open!.click();
      await settle();
    });

    expect(onOpenStudio).toHaveBeenCalledOnce();
    expect(onOpenStudio.mock.calls[0]?.[0]).toMatchObject({
      blockId: "block:check",
      sourceExactRefs: {
        surfaceInstanceIds: ["instance:check"],
        checkIds: ["check-result-current"],
      },
      target: { kind: "check", id: "check-result-current" },
    });
  });

  it("locks manuscript mutations before an exact Studio handoff flush begins", async () => {
    const page = focusedPage();
    const onOpenStudio = vi.fn<VibeWorkspaceSurfaceProps["onOpenStudio"]>()
      .mockResolvedValue(undefined);
    let markCommitRequested = () => {};
    const commitRequested = new Promise<void>((resolve) => {
      markCommitRequested = resolve;
    });
    let releaseCommit: (snapshot: ProjectUiProfileSnapshot) => void = () => undefined;
    const blockedCommit = new Promise<ProjectUiProfileSnapshot>((resolve) => {
      releaseCommit = resolve;
    });
    const commitPage = vi.fn(() => {
      markCommitRequested();
      return blockedCommit;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(async () => {
      root.render(
        <VibeWorkspaceSurface
          page={page}
          profileRevision={profileFixture.profile.revision}
          projectRoot="/projects/fixture"
          projectRevision={12}
          projectEpoch={1}
          transitionBusy={false}
          instances={new Map([[instanceFixture.instance_id, checkInstance("check-result-current")]])}
          restoredReturnPoint={null}
          onReturnPointRestored={() => undefined}
          commitPage={commitPage}
          exportCurrentPage={async () => ({
            contract: "rho.ui.vibe-page.export.v1",
            project_id: page.project_id,
            page_id: page.page_id,
            page_revision: page.page_revision,
            label: page.label,
            markdown: "",
          })}
          explorationTransport={explorationTransport}
          verificationAdapter={verificationAdapter}
          onOpenStudio={onOpenStudio}
          onOpenAgent={async () => undefined}
          reportError={vi.fn()}
        />,
      );
      await settle();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[aria-label='Heading']")!.click();
      await settle();
    });
    expect(host.querySelector(".rho-vibe-manuscript-save-state")?.textContent)
      .toBe("Unsaved changes");

    const open = [...host.querySelectorAll<HTMLButtonElement>(".rho-vibe-verification button")]
      .find((button) => button.textContent === "在 Studio 中查看")!;
    await act(async () => {
      open.click();
      await commitRequested;
      await settle();
    });

    expect(onOpenStudio).not.toHaveBeenCalled();
    expect(host.querySelector(".rho-vibe-manuscript")?.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect([...host.querySelectorAll<HTMLButtonElement>(".rho-vibe-manuscript-toolbar button")]
      .every((button) => button.disabled)).toBe(true);

    await act(async () => {
      releaseCommit(profileFixture);
      await settle();
    });
    expect(onOpenStudio).toHaveBeenCalledOnce();
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
  });

  it("locks manuscript mutations before an Agent handoff flush begins", async () => {
    const page = focusedPage();
    const onOpenAgent = vi.fn<VibeWorkspaceSurfaceProps["onOpenAgent"]>()
      .mockResolvedValue(undefined);
    let markCommitRequested = () => {};
    const commitRequested = new Promise<void>((resolve) => {
      markCommitRequested = resolve;
    });
    let releaseCommit: (snapshot: ProjectUiProfileSnapshot) => void = () => undefined;
    const blockedCommit = new Promise<ProjectUiProfileSnapshot>((resolve) => {
      releaseCommit = resolve;
    });
    const commitPage = vi.fn(() => {
      markCommitRequested();
      return blockedCommit;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(async () => {
      root.render(
        <VibeWorkspaceSurface
          page={page}
          profileRevision={profileFixture.profile.revision}
          projectRoot="/projects/fixture"
          projectRevision={12}
          projectEpoch={1}
          transitionBusy={false}
          instances={new Map([[instanceFixture.instance_id, checkInstance("check-result-current")]])}
          restoredReturnPoint={null}
          onReturnPointRestored={() => undefined}
          commitPage={commitPage}
          exportCurrentPage={async () => ({
            contract: "rho.ui.vibe-page.export.v1",
            project_id: page.project_id,
            page_id: page.page_id,
            page_revision: page.page_revision,
            label: page.label,
            markdown: "",
          })}
          explorationTransport={explorationTransport}
          verificationAdapter={verificationAdapter}
          onOpenStudio={async () => undefined}
          onOpenAgent={onOpenAgent}
          reportError={vi.fn()}
        />,
      );
      await settle();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[aria-label='Heading']")!.click();
      await settle();
    });

    const startAgent = [...host.querySelectorAll<HTMLButtonElement>(".rho-vibe-exploration button")]
      .find((button) => button.textContent === "开始探索")!;
    await act(async () => {
      startAgent.click();
      await commitRequested;
      await settle();
    });

    expect(onOpenAgent).not.toHaveBeenCalled();
    expect(host.querySelector(".rho-vibe-manuscript")?.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");

    await act(async () => {
      releaseCommit(profileFixture);
      await settle();
    });
    expect(onOpenAgent).toHaveBeenCalledWith(
      { conversationId: null, turnId: null },
      true,
      expect.objectContaining({
        projectId: page.project_id,
        pageId: page.page_id,
      }),
    );
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
  });
});
