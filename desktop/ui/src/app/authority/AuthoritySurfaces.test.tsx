import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { createMockAuthorityTransport } from "../../transport/authority.mock";
import { ArtifactsSurface } from "./ArtifactsSurface";
import { JobsSurface } from "./JobsSurface";
import { RunsSurface } from "./RunsSurface";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function render(element: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(element); await settle(); });
  return host;
}

describe("Authority surfaces", () => {
  it("renders Run and Artifact facts exactly from Authority receipts", async () => {
    const transport = createMockAuthorityTransport();
    const runs = await render(<RunsSurface transport={transport} />);
    expect(runs.textContent).toContain("run:mock-1");
    expect(runs.textContent).toContain("authority: succeeded");

    const artifacts = await render(<ArtifactsSurface transport={transport} />);
    expect(artifacts.textContent).toContain("artifact:mock-plot");
    expect(artifacts.textContent).toContain("authority: present");
    expect(artifacts.textContent).toContain("digest sha256:");
  });

  it("does not guess a Job from Run strings when no Job owner projection exists", async () => {
    const jobs = await render(<JobsSurface transport={createMockAuthorityTransport()} />);
    expect(jobs.textContent).toContain("No Job Authority projection is currently published");
    expect(jobs.textContent).not.toContain("run:mock-1");
  });
});
