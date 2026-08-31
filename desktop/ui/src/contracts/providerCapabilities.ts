export const PROVIDER_CAPABILITY_CONTRACT = "rho.ui.provider-capabilities.v1" as const;

export type ProviderFeature =
  | "streaming"
  | "plan"
  | "resume"
  | "config"
  | "model_selection"
  | "reasoning_effort";

export type ProviderConfigOption = {
  option_id: string;
  label: string;
  kind: "select" | "boolean" | "number" | "text";
  required: boolean;
  allowed_values: string[];
};

export type NegotiatedProviderCapabilities = {
  contract: typeof PROVIDER_CAPABILITY_CONTRACT;
  contract_major: 1;
  capability_snapshot_id: string;
  provider_label: string;
  availability: "ready" | "offline" | "crashed" | "disabled" | "uninstalled";
  provider_version: string;
  executable_digest: string;
  read_only: boolean;
  support_tier: "first_party_full" | "external_observer";
  features: ProviderFeature[];
  config_options: ProviderConfigOption[];
  permission_posture: "ask_before_changes" | "auto_within_policy";
  data_egress:
    | "deny"
    | "configured_provider_only"
    | "allowlisted_destinations"
    | "ask_for_unrestricted_destination";
};

export type ProviderConfigUpdate = {
  expected_capability_snapshot_id: string;
  values: Record<string, unknown>;
};

export const FIRST_PARTY_PROVIDER_CAPABILITIES: NegotiatedProviderCapabilities = {
  contract: PROVIDER_CAPABILITY_CONTRACT,
  contract_major: 1,
  capability_snapshot_id: "capability_snapshot_first_party_1",
  provider_label: "First-party provider",
  availability: "ready",
  provider_version: "aisdk-adapter-v1",
  executable_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  read_only: false,
  support_tier: "first_party_full",
  features: ["streaming", "plan", "resume", "config", "model_selection", "reasoning_effort"],
  config_options: [
    {
      option_id: "model",
      label: "Model",
      kind: "select",
      required: true,
      allowed_values: ["default", "fast"],
    },
    {
      option_id: "reasoning_effort",
      label: "Reasoning effort",
      kind: "select",
      required: false,
      allowed_values: ["low", "medium", "high"],
    },
  ],
  permission_posture: "ask_before_changes",
  data_egress: "configured_provider_only",
};

export const EXTERNAL_OBSERVER_CAPABILITIES: NegotiatedProviderCapabilities = {
  contract: PROVIDER_CAPABILITY_CONTRACT,
  contract_major: 1,
  capability_snapshot_id: "capability_snapshot_external_1",
  provider_label: "External scientific observer",
  availability: "ready",
  provider_version: "1.2.3",
  executable_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  read_only: true,
  support_tier: "external_observer",
  features: ["streaming"],
  config_options: [],
  permission_posture: "ask_before_changes",
  data_egress: "configured_provider_only",
};

export function validateProviderCapabilities(
  capabilities: NegotiatedProviderCapabilities,
): string[] {
  const errors: string[] = [];
  if (capabilities.contract !== PROVIDER_CAPABILITY_CONTRACT || capabilities.contract_major !== 1) {
    errors.push("contract");
  }
  if (new Set(capabilities.features).size !== capabilities.features.length) errors.push("features_duplicate");
  if (!capabilities.features.includes("config") && capabilities.config_options.length > 0) {
    errors.push("options_without_config");
  }
  if (capabilities.support_tier === "external_observer" && !capabilities.read_only) {
    errors.push("external_not_read_only");
  }
  if (!capabilities.executable_digest.startsWith("sha256:")) errors.push("digest");
  return errors;
}

export function validateProviderConfigUpdate(
  capabilities: NegotiatedProviderCapabilities,
  update: ProviderConfigUpdate,
): string[] {
  const errors: string[] = [];
  if (update.expected_capability_snapshot_id !== capabilities.capability_snapshot_id) {
    errors.push("stale_capability_snapshot");
  }
  const optionIds = new Set(capabilities.config_options.map((option) => option.option_id));
  for (const key of Object.keys(update.values)) {
    if (!optionIds.has(key)) errors.push(`unknown_option:${key}`);
  }
  return errors;
}

export function browserMockProviderCapabilities(
  kind: "first_party" | "external_observer",
): NegotiatedProviderCapabilities {
  return structuredClone(
    kind === "first_party"
      ? FIRST_PARTY_PROVIDER_CAPABILITIES
      : EXTERNAL_OBSERVER_CAPABILITIES,
  ) as NegotiatedProviderCapabilities;
}
