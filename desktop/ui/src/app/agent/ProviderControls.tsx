import type {
  NegotiatedProviderCapabilities,
  ProviderConfigOption,
  ProviderConfigUpdate,
} from "../../contracts/providerCapabilities";

export type ProviderControlsProps = {
  capabilities: NegotiatedProviderCapabilities;
  values?: Record<string, unknown>;
  onUpdate?: (update: ProviderConfigUpdate) => void;
};

export function ProviderControls({ capabilities, values = {}, onUpdate }: ProviderControlsProps) {
  const canConfigure = capabilities.features.includes("config");
  return (
    <section className="rho-agent-vnext__provider" aria-label="Provider capabilities">
      <header>
        <div>
          <strong>{capabilities.provider_label}</strong>
          <p>
            Version {capabilities.provider_version} · {capabilities.availability}
          </p>
        </div>
        {capabilities.read_only ? (
          <span className="rho-agent-vnext__status" aria-label="Read-only provider">
            Read-only observer
          </span>
        ) : null}
      </header>
      <code title={capabilities.executable_digest}>
        {capabilities.executable_digest.slice(0, 19)}…
      </code>

      {!capabilities.features.includes("resume") ? (
        <p role="note">Provider cannot resume model context; Rho history and jobs remain durable.</p>
      ) : (
        <p role="note">Provider supports model-context resume.</p>
      )}

      <div className="rho-agent-vnext__provider-features" aria-label="Negotiated controls">
        {capabilities.features.includes("plan") ? (
          <span data-control="plan">Provider plan available</span>
        ) : null}
        {capabilities.features.includes("resume") ? (
          <button type="button" data-control="resume">
            Resume provider context
          </button>
        ) : null}
        {canConfigure
          ? capabilities.config_options.map((option) => (
              <ProviderOption
                key={option.option_id}
                option={option}
                value={values[option.option_id]}
                onChange={(value) =>
                  onUpdate?.({
                    expected_capability_snapshot_id: capabilities.capability_snapshot_id,
                    values: { ...values, [option.option_id]: value },
                  })
                }
              />
            ))
          : null}
      </div>
      <dl>
        <div>
          <dt>Permission posture</dt>
          <dd>{capabilities.permission_posture.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Data egress</dt>
          <dd>{capabilities.data_egress.replaceAll("_", " ")}</dd>
        </div>
      </dl>
    </section>
  );
}

function ProviderOption({
  option,
  value,
  onChange,
}: {
  option: ProviderConfigOption;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (option.kind === "select") {
    return (
      <label>
        {option.label}
        <select
          value={typeof value === "string" ? value : (option.allowed_values[0] ?? "")}
          onChange={(event) => onChange(event.currentTarget.value)}
          required={option.required}
        >
          {option.allowed_values.map((allowed) => (
            <option key={allowed} value={allowed}>
              {allowed}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (option.kind === "boolean") {
    return (
      <label>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        {option.label}
      </label>
    );
  }
  return (
    <label>
      {option.label}
      <input
        type={option.kind === "number" ? "number" : "text"}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(
            option.kind === "number"
              ? Number(event.currentTarget.value)
              : event.currentTarget.value,
          )
        }
        required={option.required}
      />
    </label>
  );
}
