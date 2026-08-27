import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

const vaultModule = path.join(
  repositoryRoot,
  "desktop/src-tauri/src/agent_credential_vault.rs",
);
assert.equal(
  fs.existsSync(vaultModule),
  false,
  "COMPAT-1B must physically remove the legacy credential-vault module",
);

const agentLlm = read("desktop/src-tauri/src/agent_llm.rs");
const productionAgentLlm = agentLlm.split("#[cfg(test)]\nmod tests", 1)[0];
const productionSources = [
  ["agent_llm.rs production", productionAgentLlm],
  ["main.rs", read("desktop/src-tauri/src/main.rs")],
  ["commands/agent_llm.rs", read("desktop/src-tauri/src/commands/agent_llm.rs")],
  ["commands/agent_execution.rs", read("desktop/src-tauri/src/commands/agent_execution.rs")],
  ["SettingsSurfaceView.tsx", read("desktop/ui/src/app/SettingsSurfaceView.tsx")],
  ["mock.ts", read("desktop/ui/src/transport/mock.ts")],
  ["generated agent settings", read("desktop/ui/src/transport/generated/agent-settings.ts")],
];

const forbiddenAuthorityTokens = [
  "agent_credential_vault",
  "RhoCredentialVaultStore",
  "CREDENTIAL_SOURCE_RHO_VAULT",
  "LEGACY_CREDENTIAL_SOURCE_SYSTEM_STORE",
  "LEGACY_CREDENTIAL_SOURCE_FILE_FALLBACK",
  "llm-profiles.json",
  "agent-local-credentials.json",
  "agent-local-credentials.key",
  "AgentLlmSettingsV1",
  "AgentLlmSettingsV2",
  "AgentLlmSettingsV3",
  "AgentLlmSettingsV4",
  "SETTINGS_V1_BACKUP_FILE_NAME",
  "SETTINGS_V2_BACKUP_FILE_NAME",
  "SETTINGS_V3_BACKUP_FILE_NAME",
  "SETTINGS_V4_BACKUP_FILE_NAME",
  "rho_vault",
  "system_store",
  "file_fallback",
  "vault_locked_",
  "vault_not_initialized",
];

for (const [label, source] of productionSources) {
  for (const token of forbiddenAuthorityTokens) {
    assert.equal(
      source.includes(token),
      false,
      `${label} still references legacy credential authority ${token}`,
    );
  }
}

const generated = read("desktop/ui/src/transport/generated/agent-settings.ts");
assert.doesNotMatch(
  generated,
  /\n\tapi_key: string|\n\tcredential_source: string/,
  "the generated Settings projection must not expose file secrets or the V5 source field",
);
assert.match(
  generated,
  /config_snapshot_id: string/,
  "the generated Settings projection must carry an opaque config snapshot token",
);
assert.match(
  generated,
  /agent_llm_repair_config_permissions/,
  "the generated facade must expose explicit permission repair",
);

const desktopManifest = read("desktop/src-tauri/Cargo.toml");
assert.doesNotMatch(desktopManifest, /^argon2\.workspace\s*=|^chacha20poly1305\.workspace\s*=/mu);

console.log("COMPAT-1B canonical config cutover static contract passed");
