import { describe, expect, it } from "vitest";

import { JOBS_FIXTURE, browserMockJobsFixture, validateJobsSnapshot } from "./jobs";

describe("Jobs contract", () => {
  it("validates browser fixture with running and uncertain truth", () => {
    expect(validateJobsSnapshot(JOBS_FIXTURE)).toEqual([]);
    expect(browserMockJobsFixture()).toEqual(JOBS_FIXTURE);
  });

  it("rejects artifact before CAS commit", () => {
    const fixture = browserMockJobsFixture();
    fixture.jobs[0]!.artifacts.push({
      artifact_id: "artifact_early",
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      media_type: "text/plain",
      byte_size: 4,
    });
    expect(validateJobsSnapshot(fixture)).toContain(
      "job_local_running:artifact_before_cas_commit",
    );
  });

  it("rejects cancelled state before process-tree confirmation", () => {
    const fixture = browserMockJobsFixture();
    fixture.jobs[0]!.state = "cancelled";
    fixture.jobs[0]!.cancel_state = "requested";
    fixture.jobs[0]!.terminal_reason_code = "cancelled";
    expect(validateJobsSnapshot(fixture)).toContain("job_local_running:cancel_not_confirmed");
  });
});
