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

  it("redacts arbitrary POSIX and Windows project paths plus additional typed identities", () => {
    const message = vibeFailureMessage(
      "Failed at /projects/clinical/private.R, D:\\research\\cohort\\private.csv, " +
        "C:/clinical/private.tsv, and \\\\lab-server\\restricted\\result.csv " +
        "for resource:abc123 and profile:abc123.",
      "Agent activity failed.",
    );

    expect(message).toBe(
      "Failed at [local path], [local path], [local path], and [local path] " +
        "for [internal reference] and [internal reference].",
    );
    expect(message).not.toContain("/projects/clinical");
    expect(message).not.toContain("D:\\research");
    expect(message).not.toContain("resource:abc123");
    expect(message).not.toContain("profile:abc123");
  });

  it("fails closed for assigned, bearer, and recognizable standalone secrets", () => {
    const message = vibeFailureMessage(
      "Provider failed with OPENAI_API_KEY=sk-private-value, Authorization: Bearer abc.def.ghi, " +
        "and fallback sk-another-private-value.",
      "Provider failed.",
    );

    expect(message).toBe("Provider failed with [secret], [secret], and fallback [secret].");
    expect(message).not.toContain("sk-private-value");
    expect(message).not.toContain("abc.def.ghi");
    expect(message).not.toContain("sk-another-private-value");
  });

  it("redacts quoted and nested JSON-shaped identities and secrets in mixed narration", () => {
    const message = vibeFailureMessage(
      "Tool failed with {\"outer\":{\"conversation_id\":\"opaque-secret-7\"," +
        "\"password\":\"hunter2\",\"detail\":\"/研究/李 四/私密/model.R\"}}; retry later.",
      "Tool failed.",
    );

    expect(message).toContain("Tool failed with");
    expect(message).toContain("[internal reference]");
    expect(message).toContain("[secret]");
    expect(message).toContain("[local path]");
    expect(message).toContain("retry later.");
    expect(message).not.toContain("opaque-secret-7");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("李 四");
  });

  it("redacts Unicode paths and raw scheme URIs without leaving partial authorities", () => {
    const message = vibeFailureMessage(
      "Read /研究/李 四/私密/model.R, \\\\研究服务器\\共享 数据\\李 四\\结果.csv, " +
        "s3://private-bucket/subject-7, file:///private/subject-8.csv, and " +
        "https://internal.example/api?token=hunter2; analysis stopped.",
      "Read failed.",
    );

    expect(message).toBe(
      "Read [local path], [local path], [internal reference], [internal reference], and " +
        "[internal reference]; analysis stopped.",
    );
    expect(message).not.toContain("李 四");
    expect(message).not.toContain("研究服务器");
    expect(message).not.toContain("private-bucket");
    expect(message).not.toContain("internal.example");
    expect(message).not.toContain("hunter2");
  });

  it("preserves ordinary safe failure narration", () => {
    expect(vibeFailureMessage(
      "Model fit failed: donor 4 retained a 5/6 ratio; marker A/B was unchanged, p = 0.04.",
      "Model fit failed.",
    )).toBe("Model fit failed: donor 4 retained a 5/6 ratio; marker A/B was unchanged, p = 0.04.");
  });
});
