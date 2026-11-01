"""Run an owned, isolated dsh web host for the real prototype episode.

Existing provider credentials are read in memory, never printed or written into
the patch. This fixture uses the same provider selection as Rho's activity trial.
"""
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys

trial = Path(sys.argv[1]).resolve()
package = Path(__file__).resolve().parents[1]
project = trial / 'project'
home = trial / 'dsh-home'
state = trial / 'rho-state'
for directory in (project, home, state):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
modules = home / 'node_modules'
modules.mkdir(exist_ok=True)
manifest = home / 'profiles/web/package.json'
installed = manifest.exists() and 'dsh-rho' in json.loads(manifest.read_text()).get('dsh', {}).get('profile', {}).get('bundles', [])
link = modules / 'dsh-rho'
if installed:
    if link.is_symlink() and link.resolve() == package:
        link.unlink()
elif not link.exists():
    link.symlink_to(package, target_is_directory=True)
auth = json.loads((Path.home() / '.claude/settings.json').read_text())['env']
key = auth.get('ANTHROPIC_AUTH_TOKEN', auth.get('ANTHROPIC_API_KEY', ''))
base = auth['ANTHROPIC_BASE_URL'].rstrip('/')
if not key or not base:
    raise SystemExit('The fixture needs an existing configured provider.')
patch = trial / 'episode.patch.yml'
bootstrap = trial / 'workspace.cjs'
bootstrap.write_text("exports.inject=['workspaceController']; exports.apply=async ctx=>{await ctx.workspaceController.create({path:process.env.RHO_DSH_PROJECT});};\n")
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
- insert:
    - id: rho-episode-workspace
      name: ''' + json.dumps(str(bootstrap)) + '''
''' + ('' if installed else '''    - id: dsh-rho
      name: dsh-rho
      config:
        projectRoot: !!js process.env.RHO_DSH_PROJECT
        stateDir: !!js process.env.RHO_DSH_STATE
'''))
if not (project / 'input.csv').exists():
    (project / 'input.csv').write_text('group,value\nalpha,1\nalpha,2\nalpha,8\nbeta,-3\nbeta,4\nbeta,7\n')
env = dict(os.environ, DSH_HOME=str(home), RHO_DSH_PROJECT=str(project), RHO_DSH_STATE=str(state),
           RHO_PROBE_GATEWAY_KEY=key, RHO_PROBE_GATEWAY_BASE=base if base.endswith('/v1') else base + '/v1')
child = subprocess.Popen(['dsh', '--profile', 'web', '--patch', str(patch), '--no-open', '--port', '0'],
                         cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
def stop(*_):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
(trial / 'setup.json').write_text(json.dumps({'project': str(project), 'home': str(home), 'state': str(state), 'pid': child.pid, 'model': 'westlakehpc/deepseek-v4.1-flash'}))
total = 0
with (trial / 'host.log').open('w') as log:
    for line in child.stdout:
        total += len(line)
        if total > 8 * 1024 * 1024:
            stop()
            break
        text = line.decode(errors='replace').replace(key, '[credential]').replace(base, '[gateway]')
        match = re.search(r'http://127\.0\.0\.1:\d+/\?token=[^\s\x1b]+', text)
        if match:
            connection = trial / 'connection.json'
            connection.write_text(json.dumps({'url': match.group(0)}))
            connection.chmod(0o600)
            text = text.replace(match.group(0), '[private connection saved]')
        log.write(text); log.flush()
        print(text, end='', flush=True)
sys.exit(child.wait())
