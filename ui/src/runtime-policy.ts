import type { RuntimeSettings } from "./generated/RuntimeSettings";
import type { RuntimeSettingsScope } from "./generated/RuntimeSettingsScope";
import type { RuntimePolicyOverrides } from "./generated/RuntimePolicyOverrides";

export const runtimeSettingsScopes: RuntimeSettingsScope[] = ["app", "project", "instance"];
export function policyAtScope(settings: RuntimeSettings, scope: RuntimeSettingsScope, draft: Partial<RuntimePolicyOverrides> = {}) {
  const value = { ...settings.defaults };
  const effective = { value, app: {}, project: {}, instance: {} } as RuntimeSettings["effective"];
  for (const level of runtimeSettingsScopes.slice(0, runtimeSettingsScopes.indexOf(scope) + 1)) {
    const overrides = level === scope ? { ...settings.effective[level], ...draft } : settings.effective[level];
    effective[level] = overrides as RuntimePolicyOverrides;
    for (const [field, setting] of Object.entries(overrides)) if (setting !== null && setting !== undefined) {
      Object.assign(value, { [field]: field === "idle_stop_without_windows_seconds" && setting === 0 ? null : setting });
    }
  }
  return effective;
}
