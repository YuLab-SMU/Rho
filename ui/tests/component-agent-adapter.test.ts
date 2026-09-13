import { afterEach, expect, it } from "vitest";
import { componentDraftCache } from "../src/component-agent-adapter";
afterEach(() => localStorage.clear());

it("keeps different windows and projects independent", () => {
  const first = componentDraftCache("one"), second = componentDraftCache("two");
  first.writeLocal("/project", { text: "first" }); second.writeLocal("/project", { text: "second" });
  first.writeLocal("/other", { text: "other" });
  expect(first.readLocal("/project")).toEqual({ text: "first" });
  expect(second.readLocal("/project")).toEqual({ text: "second" });
  expect(first.readLocal("/other")).toEqual({ text: "other" });
});
it("cannot collide when identifiers contain separators", () => {
  const first = componentDraftCache("one:/part"), second = componentDraftCache("one");
  first.writeLocal("/project", { text: "first" }); second.writeLocal("/part:/project", { text: "second" });
  expect(first.readLocal("/project")).toEqual({ text: "first" });
  expect(second.readLocal("/part:/project")).toEqual({ text: "second" });
});
it("reports corrupt recovery data without exposing its contents", () => {
  const cache = componentDraftCache("one"); cache.writeLocal("/project", { ok: true });
  localStorage.setItem(localStorage.key(0)!, "private draft contents, invalid json");
  expect(() => cache.readLocal("/project")).toThrow("Saved assistant state is unreadable.");
});
