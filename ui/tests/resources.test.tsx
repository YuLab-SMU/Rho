import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectViewer } from "../src/panels/resource-panels";

const { state } = vi.hoisted(() => ({
  state: {
    inspectors: new Map(),
    visibleObjects: new Set(),
    runtime: { state: "busy" },
    inspectObject: vi.fn(),
  },
}));
vi.stubGlobal("IntersectionObserver",class { observe(){} disconnect(){} });
vi.mock("../src/context", () => ({ useStudio: () => state }));
afterEach(() => {
  cleanup();
  state.inspectors.clear();
  vi.clearAllMocks();
});
it("renders hostile object text literally and keeps native queries disabled while busy", async () => {
  state.inspectors.set("frame", {
    binding: {
      name: "frame",
      kind: "value",
      classes: ["data.frame"],
      object_type: "list",
      length: null,
      dimensions: [1, 1],
      preview: [
        {
          name: "<script>column</script>",
          values: ["<img src=x onerror=alert(1)>"],
        },
      ],
      truncated: true,
      notice: "bounded",
    },
    observedAt: 1,
    notice: "",
  });
  const { container } = render(<ObjectViewer name="frame" />);
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  expect(container.querySelector("img,script")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh Preview" }),
  );
  expect(state.inspectObject).not.toHaveBeenCalled();
  expect(screen.getByText("Preview truncated.")).toBeTruthy();
});
