import { describe, expect, it } from "vitest";

import type { DomainSurfaceItem } from "../transport";
import {
  domainItemPresentation,
  domainItemsForMode,
  domainPresentationKind,
  domainSummary,
} from "./domain-presentation";

describe("generic non-semantic Domain presentation", () => {
  it("limits the generic path to diagnostics, Git, and Help presentation", () => {
    expect(domainPresentationKind("rho.logs")).toBe("stream");
    expect(domainPresentationKind("rho.git")).toBe("git");
    expect(domainPresentationKind("rho.help")).toBe("help");
  });

  it("filters Git modes without assigning Authority or Evidence status", () => {
    const working: DomainSurfaceItem = {
      id: "git:working",
      title: "main",
      subtitle: null,
      status: "changed",
      detail: "{\"dirty\":true,\"staged\":1}",
    };
    const commit: DomainSurfaceItem = {
      id: "commit:abc",
      title: "Add analysis",
      subtitle: null,
      status: "commit",
      detail: "{\"hash\":\"abc\"}",
    };
    expect(domainItemsForMode("rho.git", "changes", [working, commit])).toEqual([working]);
    expect(domainItemsForMode("rho.git", "history", [working, commit])).toEqual([commit]);
    expect(domainItemPresentation("rho.git", working).status).toBe("changed");
    expect(domainSummary("rho.git", [working]).title).toBe("main");
  });
});
