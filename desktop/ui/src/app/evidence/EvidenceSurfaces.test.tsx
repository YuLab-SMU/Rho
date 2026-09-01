import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockEvidenceGraphTransport } from "../../transport/evidence-graph.mock";
import { createMockAuthorityTransport } from "../../transport/authority.mock";
import { createEvidenceGraphPorts } from "../workbench/evidenceGraphPorts";
import { ClaimsSurface } from "./ClaimsSurface";
import { EvidenceGapsSurface } from "./EvidenceGapsSurface";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function render(element: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(element); await settle(); });
  return host;
}

describe("typed Evidence Graph surfaces", () => {
  const ports = () => createEvidenceGraphPorts({
    ...createMockAuthorityTransport(),
    ...createMockEvidenceGraphTransport(),
  });

  it("keeps authority and graph status visibly separate", async () => {
    const host = await render(<ClaimsSurface
      ports={ports()}
      initialClaimId={null}
      openTrace={vi.fn()}
      reportError={vi.fn()}
    />);
    expect(host.textContent).toContain("Analysis uses a fixed seed");
    expect(host.textContent).toContain("graph: promoted · active");
    expect(host.textContent).toContain("authority: succeeded");
    expect(host.textContent).toContain("missing environment");
  });

  it("renders deterministic gap facts without generic JSON parsing", async () => {
    const host = await render(<EvidenceGapsSurface
      ports={ports()}
      reportError={vi.fn()}
    />);
    expect(host.textContent).toContain("missing environment");
    expect(host.textContent).toContain("run:mock-1");
    expect(host.querySelector(".rho-evidence-gap-list dl")).not.toBeNull();
  });
});
