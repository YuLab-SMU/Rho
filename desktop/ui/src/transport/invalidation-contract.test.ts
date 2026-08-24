import { describe, expect, it } from "vitest";

import { INVALIDATION_EVENTS, INVALIDATION_TOPICS, invalidationEvents } from "./invalidation-contract";
import { MOCK_INVALIDATION_TOPICS } from "./mock";

describe("invalidation contract", () => {
  it("keeps every Tauri topic non-empty, deduplicated, and namespaced", () => {
    for (const topic of INVALIDATION_TOPICS) {
      const events = invalidationEvents(topic);
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events).size).toBe(events.length);
      expect(events.every((event) => event.startsWith("rho://") || event.startsWith("project://"))).toBe(true);
    }
  });

  it("keeps mock perturbation topics in exact parity with Tauri subscriptions", () => {
    expect([...MOCK_INVALIDATION_TOPICS].sort()).toEqual([...INVALIDATION_TOPICS].sort());
    expect(Object.keys(INVALIDATION_EVENTS).sort()).toEqual([...INVALIDATION_TOPICS].sort());
  });
});
