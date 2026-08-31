import { describe, expect, it } from "vitest";

import {
  EXTERNAL_OBSERVER_CAPABILITIES,
  FIRST_PARTY_PROVIDER_CAPABILITIES,
  browserMockProviderCapabilities,
  validateProviderCapabilities,
  validateProviderConfigUpdate,
} from "./providerCapabilities";

describe("provider capability Rust/TypeScript/browser facet", () => {
  it("validates first-party and external browser fixtures", () => {
    expect(validateProviderCapabilities(FIRST_PARTY_PROVIDER_CAPABILITIES)).toEqual([]);
    expect(validateProviderCapabilities(EXTERNAL_OBSERVER_CAPABILITIES)).toEqual([]);
    expect(browserMockProviderCapabilities("first_party")).toEqual(
      FIRST_PARTY_PROVIDER_CAPABILITIES,
    );
    expect(browserMockProviderCapabilities("external_observer")).toEqual(
      EXTERNAL_OBSERVER_CAPABILITIES,
    );
  });

  it("fails closed for stale capability snapshots and unknown options", () => {
    expect(
      validateProviderConfigUpdate(FIRST_PARTY_PROVIDER_CAPABILITIES, {
        expected_capability_snapshot_id: "stale_snapshot",
        values: { model: "fast" },
      }),
    ).toContain("stale_capability_snapshot");
    expect(
      validateProviderConfigUpdate(FIRST_PARTY_PROVIDER_CAPABILITIES, {
        expected_capability_snapshot_id:
          FIRST_PARTY_PROVIDER_CAPABILITIES.capability_snapshot_id,
        values: { provider_private: true },
      }),
    ).toContain("unknown_option:provider_private");
  });

  it("keeps permission and egress posture stable across provider switch", () => {
    expect(EXTERNAL_OBSERVER_CAPABILITIES.permission_posture).toBe(
      FIRST_PARTY_PROVIDER_CAPABILITIES.permission_posture,
    );
    expect(EXTERNAL_OBSERVER_CAPABILITIES.data_egress).toBe(
      FIRST_PARTY_PROVIDER_CAPABILITIES.data_egress,
    );
  });
});
