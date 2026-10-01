import { useEffect } from "react";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PluginFrameLayer } from "../src/plugin-frame-layer";

it("retains each frame's DOM parent and creation order when tabs move, hide and return", () => {
  const mounted = vi.fn(), disposed = vi.fn();
  function Frame({ id }: { id: string }) {
    useEffect(() => { mounted(id); return () => disposed(id); }, [id]);
    return <iframe title={id} />;
  }
  const first = { id: "first", title: "Original", content: <Frame id="first" /> };
  const second = { id: "second", title: "User branch", content: <Frame id="second" /> };
  const regions = new Map([["first", { x: 0, y: 32, width: 500, height: 400 }], ["second", { x: 506, y: 32, width: 300, height: 400 }]]);
  const view = render(<PluginFrameLayer frames={[first, second]} regions={regions} />);
  const frame = view.getByTitle("first"), parent = frame.parentElement!, layer = parent.parentElement!;
  const move = vi.spyOn(layer, "insertBefore"), append = vi.spyOn(layer, "appendChild");
  view.rerender(<PluginFrameLayer frames={[second, first]} regions={new Map([["second", regions.get("first")!]])} dragging />);
  expect(view.getByTitle("first")).toBe(frame);
  expect(frame.parentElement).toBe(parent);
  expect(parent.style.display).toBe("none"); expect(parent.hasAttribute("inert")).toBe(true);
  expect(layer.firstElementChild).toBe(parent); expect(move).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  view.rerender(<PluginFrameLayer frames={[second, first]} regions={new Map([["first", { x: 5, y: 32, width: 380, height: 600 }]])} />);
  expect(parent.style.display).toBe("block"); expect(parent.style.left).toBe("5px"); expect(parent.hasAttribute("inert")).toBe(false);
  expect(view.getByTitle("first")).toBe(frame); expect(mounted).toHaveBeenCalledTimes(2); expect(disposed).not.toHaveBeenCalled();
  view.rerender(<PluginFrameLayer frames={[second]} regions={regions} />);
  expect(disposed).toHaveBeenCalledExactlyOnceWith("first");
  view.unmount(); expect(disposed).toHaveBeenCalledTimes(2);
});
