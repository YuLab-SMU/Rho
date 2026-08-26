import { describe, expect, it } from "vitest";

import { vibeFailureMessage } from "./vibe-failure";

describe("Vibe failure presentation", () => {
  it("preserves a useful cause while hiding local paths and internal identities", () => {
    const message = vibeFailureMessage(
      new Error(
        "Could not refresh /Users/alice/private/project for conversation_id=conversation:secret-42 and turn:internal-7.",
      ),
      "自主探索记录暂时不可用。",
    );

    expect(message).toContain("Could not refresh [local path]");
    expect(message).toContain("[internal reference]");
    expect(message).not.toContain("/Users/alice");
    expect(message).not.toContain("conversation:secret-42");
    expect(message).not.toContain("turn:internal-7");
  });

  it("redacts unlabeled UUIDs and internal implementation tokens", () => {
    const message = vibeFailureMessage(
      "Request 63b6f3e2-879a-4f73-961a-8ad7964ea301 failed at exec_internal_456.",
      "Vibe operation failed.",
    );

    expect(message).toBe("Request [internal reference] failed at [internal reference].");
  });

  it("covers mounted volumes and UNC locations outside the shared path set", () => {
    const message = vibeFailureMessage(
      "Read /Volumes/research/private/data.csv and \\\\lab-server\\restricted\\result.csv failed.",
      "Read failed.",
    );

    expect(message).toBe("Read [local path] and [local path] failed.");
  });
});
