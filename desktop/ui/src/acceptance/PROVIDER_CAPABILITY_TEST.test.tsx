import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderControls } from "../app/agent/ProviderControls";
import {
  EXTERNAL_OBSERVER_CAPABILITIES,
  FIRST_PARTY_PROVIDER_CAPABILITIES,
  type NegotiatedProviderCapabilities,
} from "../contracts/providerCapabilities";

function render(capabilities: NegotiatedProviderCapabilities): string {
  return renderToStaticMarkup(<ProviderControls capabilities={capabilities} />);
}

describe("PROVIDER_CAPABILITY_TEST negotiated controls", () => {
  it("omits plan, resume, config, model, and reasoning controls when unsupported", () => {
    const markup = render(EXTERNAL_OBSERVER_CAPABILITIES);
    expect(markup).toContain("Read-only observer");
    expect(markup).toContain("cannot resume model context");
    expect(markup).not.toContain("Provider plan available");
    expect(markup).not.toContain("Resume provider context");
    expect(markup).not.toContain(">Model<");
    expect(markup).not.toContain("Reasoning effort");
  });

  it("renders first-party controls strictly from feature and option schema", () => {
    const markup = render(FIRST_PARTY_PROVIDER_CAPABILITIES);
    expect(markup).toContain("Provider plan available");
    expect(markup).toContain("Resume provider context");
    expect(markup).toContain("Model");
    expect(markup).toContain("Reasoning effort");
    expect(markup).toContain("aisdk-adapter-v1");
  });

  it("renders an unknown neutral config option without a provider-specific branch", () => {
    const fixture: NegotiatedProviderCapabilities = {
      ...FIRST_PARTY_PROVIDER_CAPABILITIES,
      capability_snapshot_id: "capability_snapshot_generic",
      provider_label: "Any provider",
      config_options: [
        {
          option_id: "temperature",
          label: "Temperature",
          kind: "number",
          required: false,
          allowed_values: [],
        },
      ],
    };
    expect(render(fixture)).toContain("Temperature");
  });

  it("shows availability, version, digest, read-only tier, and resume limitation", () => {
    const markup = render({
      ...EXTERNAL_OBSERVER_CAPABILITIES,
      availability: "offline",
    });
    expect(markup).toContain("offline");
    expect(markup).toContain("Version 1.2.3");
    expect(markup).toContain("sha256:bbbbbbbbbbbb");
    expect(markup).toContain("Read-only observer");
  });

  it("contains no provider identity branch and keeps permission controls outside options", () => {
    const source = String.raw`${ProviderControls}`;
    expect(source).not.toMatch(/provider\s*===/);
    expect(source).not.toMatch(/provider_id/);
    const markup = render(EXTERNAL_OBSERVER_CAPABILITIES);
    expect(markup).toContain("Permission posture");
    expect(markup).toContain("ask before changes");
    expect(markup).toContain("configured provider only");
  });
});
