import { expect, it } from "vitest";
import { policyAtScope } from "../src/runtime-policy";
import { runtimePolicySource } from "../src/runtime-sessions";
import type { RuntimeSettings } from "../src/generated/RuntimeSettings";

const observed = {
  defaults: { mode: "auto_continue", automatic_interval_seconds: 300, idle_delay_seconds: 30, idle_stop_without_windows_seconds: null },
  effective: { value: {}, app: { automatic_interval_seconds: 600 }, project: { idle_delay_seconds: 45, idle_stop_without_windows_seconds: 120 }, instance: { automatic_interval_seconds: 900, idle_stop_without_windows_seconds: 0 } },
  app_version: "a", project_version: "p", instance_version: "i", project_storage_bytes: 0,
} as unknown as RuntimeSettings;

it("editing a wider scope never presents narrower overrides as its defaults", () => {
  const app = policyAtScope(observed, "app"), project = policyAtScope(observed, "project"), instance = policyAtScope(observed, "instance");
  expect(app.value.idle_delay_seconds).toBe(30); expect(app.value.automatic_interval_seconds).toBe(600);
  expect(project.value.idle_delay_seconds).toBe(45); expect(project.value.automatic_interval_seconds).toBe(600);
  expect(instance.value.automatic_interval_seconds).toBe(900); expect(instance.value.idle_stop_without_windows_seconds).toBeNull();
  expect(runtimePolicySource(project, "idle_delay_seconds")).toBe("project");
  expect(runtimePolicySource(instance, "automatic_interval_seconds")).toBe("instance");
});

it("resetting one field reveals its actual inherited value and preserves other local edits", () => {
  const reset = policyAtScope(observed, "instance", { automatic_interval_seconds: null, idle_stop_without_windows_seconds: null, exclude_names: ["db", "atlas"] });
  expect(reset.value.automatic_interval_seconds).toBe(600);
  expect(reset.value.idle_stop_without_windows_seconds).toBe(120);
  expect(reset.value.exclude_names).toEqual(["db", "atlas"]);
  expect(runtimePolicySource(reset, "automatic_interval_seconds")).toBe("app");
  expect(observed.effective.instance.automatic_interval_seconds).toBe(900);
});
