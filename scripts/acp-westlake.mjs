// Acceptance configuration only. Credentials are read by the caller and remain in memory.
import fs from 'node:fs/promises';
import path from 'node:path';
export async function westlakeCodexEnv(auth, root, model) {
  const codexStateRoot = path.join(root, '.codex'); await fs.mkdir(codexStateRoot, { recursive: true, mode: 0o700 });
  return { CODEX_HOME: codexStateRoot, CODEX_API_KEY: auth.ANTHROPIC_AUTH_TOKEN || auth.ANTHROPIC_API_KEY,
    MODEL_PROVIDER: 'westlake-hpc', NO_BROWSER: '1', INITIAL_AGENT_MODE: 'workspace-write', DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key' }),
    CODEX_CONFIG: JSON.stringify({ model, model_provider: 'westlake-hpc', web_search: 'disabled',
      tools: { update_plan: { enabled: true } }, features: { multi_agent: false, apply_patch_freeform: true },
      model_providers: { 'westlake-hpc': { name: 'Westlake HPC', base_url: new URL('/v1', auth.ANTHROPIC_BASE_URL).href,
        env_key: 'CODEX_API_KEY', wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 1 } } }) };
}
