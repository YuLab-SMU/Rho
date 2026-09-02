import { describe, expect, it } from "vitest";

import { settingsModuleFromViewState } from "./SettingsSurfaceView";

describe("SettingsSurfaceView ACP boundary", () => {
  it("defaults to external Agents and rejects retired Provider modules", () => {
    expect(settingsModuleFromViewState(null)).toBe("agents");
    expect(settingsModuleFromViewState({ module_id: "agents" })).toBe("agents");
    expect(settingsModuleFromViewState({ module_id: "components" })).toBe("components");
    expect(settingsModuleFromViewState({ module_id: "providers" })).toBe("agents");
  });
});

