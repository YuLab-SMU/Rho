import { describe, expect, it } from "vitest";

import { computeLineDiff, LINE_DIFF_TOTAL_BUDGET } from "./diff";

describe("computeLineDiff", () => {
  it("returns an all-add hunk for a create-style empty before", () => {
    const diff = computeLineDiff("", "a\nb\nc\n")!;
    expect(diff.additions).toBe(3);
    expect(diff.removals).toBe(0);
    expect(diff.hunks.length).toBe(1);
    expect(diff.hunks[0]!.lines.every((line) => line.kind === "add")).toBe(true);
  });

  it("returns an all-remove hunk when after is empty", () => {
    const diff = computeLineDiff("a\nb\n", "")!;
    expect(diff.additions).toBe(0);
    expect(diff.removals).toBe(2);
    expect(diff.hunks[0]!.lines.every((line) => line.kind === "remove")).toBe(true);
  });

  it("keeps context around a changed line and counts edits", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "one\ntwo\nTHREE\nfour\nfive\n";
    const diff = computeLineDiff(before, after, 2)!;
    expect(diff.additions).toBe(1);
    expect(diff.removals).toBe(1);
    expect(diff.hunks.length).toBe(1);
    const kinds = diff.hunks[0]!.lines.map((line) => `${line.kind}:${line.text}`);
    expect(kinds).toEqual([
      "context:one",
      "context:two",
      "remove:three",
      "add:THREE",
      "context:four",
      "context:five",
    ]);
  });

  it("splits distant changes into separate hunks", () => {
    const before = "a\n1\n2\n3\n4\n5\n6\n7\n8\nb\n";
    const after = "A\n1\n2\n3\n4\n5\n6\n7\n8\nB\n";
    const diff = computeLineDiff(before, after, 1)!;
    expect(diff.hunks.length).toBe(2);
    expect(diff.hunks[0]!.lines.some((line) => line.text === "A")).toBe(true);
    expect(diff.hunks[1]!.lines.some((line) => line.text === "B")).toBe(true);
  });

  it("merges close changes into one hunk", () => {
    const before = "a\nx\ny\nb\n";
    const after = "A\nx\ny\nB\n";
    const diff = computeLineDiff(before, after, 3)!;
    expect(diff.hunks.length).toBe(1);
  });

  it("treats a missing trailing newline as no change", () => {
    const diff = computeLineDiff("a\nb", "a\nb\n")!;
    expect(diff.additions).toBe(0);
    expect(diff.removals).toBe(0);
    expect(diff.hunks.length).toBe(0);
  });

  it("returns null over the total-line budget", () => {
    const before = Array.from({ length: LINE_DIFF_TOTAL_BUDGET }, (_, index) => `line-${index}`).join("\n");
    expect(computeLineDiff(before, "x")).toBeNull();
  });
});
