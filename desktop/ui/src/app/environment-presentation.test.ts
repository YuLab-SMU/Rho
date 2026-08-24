import { describe, expect, it } from "vitest";

import type { DomainSurfaceItem } from "../transport";
import {
  environmentDetail,
  environmentItemsForMode,
  environmentMatches,
  environmentSummary,
  environmentTone,
} from "./environment-presentation";

const items: readonly DomainSurfaceItem[] = [
  { id: "package:rho", title: "rho", subtitle: "0.4.1", status: "installed", detail: "Project library" },
  { id: "package:aisdk", title: "aisdk", subtitle: "required >= 1.5.0", status: "incompatible", detail: "{\"installed_version\":\"1.4.12\",\"required_version\":\"1.5.0\",\"resolved_path\":\"/private/library\",\"request_id\":\"internal-package-scan\"}" },
  { id: "environment-request:1", title: "Restore project library", subtitle: null, status: "running", detail: "{\"operation\":\"restore\",\"request_id\":\"secret-id\",\"project_root\":\"/private/project\"}" },
];

describe("Environment presentation", () => {
  it("separates package inventory from operation requests and summarizes attention", () => {
    const packages = environmentItemsForMode(items, "packages");
    const requests = environmentItemsForMode(items, "requests");
    expect(packages.map((item) => item.title)).toEqual(["rho", "aisdk"]);
    expect(requests.map((item) => item.title)).toEqual(["Restore project library"]);
    expect(environmentSummary(packages, "packages")).toEqual({
      title: "1 package needs attention",
      subtitle: "2 packages in this project",
    });
    expect(environmentSummary(requests, "requests").title).toBe("1 active operation");
  });

  it("projects allowlisted facts without exposing raw JSON or internal paths", () => {
    expect(environmentDetail(items[1]!)).toBe("Installed: 1.4.12 · Required: 1.5.0");
    expect(environmentDetail(items[2]!)).toBe("Operation: restore");
    expect(environmentDetail(items[1]!)).not.toContain("resolved_path");
    expect(environmentTone(items[1]!)).toBe("attention");
  });

  it("searches human-facing fields and excludes hidden raw payload fields", () => {
    expect(environmentMatches(items[1]!, "1.4.12")).toBe(true);
    expect(environmentMatches(items[1]!, "private/library")).toBe(false);
    expect(environmentMatches(items[2]!, "restore")).toBe(true);
  });
});
