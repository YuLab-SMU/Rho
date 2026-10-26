"""Real, bounded native-client driver for agent-activity-episode.mjs.

Uses the existing Claude gateway credentials in memory and an isolated native
configuration. Private native transcripts stay in the selected evidence folder.
"""
import json
import os
import pathlib
import signal
import subprocess
import sys
import threading
import uuid

producer, project_arg, evidence_arg = sys.argv[1:]
project, evidence = pathlib.Path(project_arg), pathlib.Path(evidence_arg)
evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
auth = json.loads((pathlib.Path.home() / '.claude/settings.json').read_text())['env']
key = auth.get('ANTHROPIC_AUTH_TOKEN', auth.get('ANTHROPIC_API_KEY', ''))
base = auth['ANTHROPIC_BASE_URL'].rstrip('/')
model = 'westlakehpc/deepseek-v4.1-flash'
env = dict(os.environ)
session = str(uuid.uuid4())
prompt = '''This is an authorized disposable analysis and observation test. Read input.csv and analysis.py. Fix the one arithmetic bug in the group mean (integer division). Preserve the gate, output creation and intentional diagnostic exit 7. Then run python3 analysis.py exactly once. The Bash command MUST be exactly python3 analysis.py, without any semicolons, wrappers, echo or status suffixes (the native tool reports its exit code). Run it in the foreground, using a timeout of at least 180 seconds. The script waits for a release file from the observer test, writes outputs/summary.csv and outputs/plot.svg, and intentionally exits 7. Do not retry this command or treat this diagnostic exit as something to repair. Report the two paths and the exit status. Work only in this directory. Do not use network, install packages, change the fixture gate, or spawn agents.'''
if producer == 'claude':
    config = evidence / 'config'
    config.mkdir()
    empty = evidence / 'mcp.json'
    empty.write_text('{"mcpServers":{}}')
    env.update({k: v for k, v in auth.items() if k in ('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL')})
    env.update(CLAUDE_CONFIG_DIR=str(config), CLAUDE_CODE_DISABLE_AUTO_MEMORY='1')
    command = ['claude', '--print', '--output-format', 'stream-json', '--verbose', '--model', model,
               '--session-id', session, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', str(empty),
               '--tools', 'Read,Write,Edit,Bash', '--allowedTools', 'Read', 'Write', 'Edit', 'Bash(python3 *)',
               '--permission-mode', 'dontAsk', '--disable-slash-commands', '--no-chrome', '--max-turns', '16', prompt]
else:
    home = evidence / 'dsh-home'
    home.mkdir()
    patch = evidence / 'provider.patch.yml'
    patch.write_text('''- id: llm-pi-ai
  config:
    providers:
      probe:
        apiKeyEnv: RHO_PROBE_GATEWAY_KEY
        api: openai-completions
        baseURL: !!js process.env.RHO_PROBE_GATEWAY_BASE
        compat: {thinkingFormat: deepseek}
        models:
          - id: westlakehpc/deepseek-v4.1-flash
            contextWindow: 262144
            maxTokens: 8192
        retryPolicy: {mode: normal, maxRetries: 1}
- id: agent-default-model
  config: {provider: probe, model: westlakehpc/deepseek-v4.1-flash}
- id: session-telemetry-otel
  disabled: true
- id: session-title-llm
  disabled: true
- id: approval
  config: {policy: never}
- id: permission
  config:
    presets:
      workspace-write: {sandbox: workspace-write, approval: never}
    defaultPreset: workspace-write
''')
    env.update(DSH_HOME=str(home), RHO_PROBE_GATEWAY_KEY=key, RHO_PROBE_GATEWAY_BASE=base if base.endswith('/v1') else base + '/v1')
    command = ['dsh', '--profile', 'headless', '--patch', str(patch), '--json', prompt]

def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if k not in ('thinking', 'reasoning', 'reasoning_content', 'signature')}
    if isinstance(value, list):
        return [clean(v) for v in value if not isinstance(v, dict) or v.get('type') not in ('thinking', 'redacted_thinking')]
    if isinstance(value, str):
        return value.replace(key, '[credential]') .replace(base, '[gateway]') if key else value.replace(base, '[gateway]')
    return value

child = subprocess.Popen(command, cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
def stop(*_):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
def drain(pipe, filename, structured=False):
    total = 0
    with (evidence / filename).open('w') as out:
        for raw in pipe:
            total += len(raw)
            if total > 16 * 1024 * 1024:
                stop()
                break
            value = raw.decode(errors='replace')
            if structured:
                try:
                    event = json.loads(value)
                except ValueError:
                    continue
                if event.get('type') in ('thinking', 'redacted_thinking'):
                    continue
                if producer == 'dsh' and event.get('type') == 'session':
                    (evidence / 'source.json').write_text(json.dumps({'session': event['sessionId'], 'source': str(home / 'sessions')}))
                value = json.dumps(clean(event)) + '\n'
            else:
                value = clean(value)
            out.write(value)
            out.flush()
threads = [threading.Thread(target=drain, args=(child.stdout, 'events.jsonl', True)), threading.Thread(target=drain, args=(child.stderr, 'diagnostics.txt'))]
for thread in threads:
    thread.start()
if producer == 'claude':
    # Native Claude projects are keyed by replacing path punctuation with '-'.
    # Discover the file as soon as the real client creates it, never synthesize it.
    def discover():
        import time
        while child.poll() is None:
            files = list(config.rglob(session + '.jsonl'))
            if files:
                (evidence / 'source.json').write_text(json.dumps({'session': session, 'source': str(files[0])}))
                return
            time.sleep(.1)
    threading.Thread(target=discover, daemon=True).start()
try:
    exit_code = child.wait(timeout=300)
except subprocess.TimeoutExpired:
    stop()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    exit_code = 124
for thread in threads:
    thread.join(timeout=10)
(evidence / 'client-result.json').write_text(json.dumps({'producer': producer, 'model': model, 'exitCode': exit_code}) + '\n')
sys.exit(exit_code)
