const { ConnectionError, readConnection, resolveWorkspace, publicError, connectionFiles, projectConnection } = require('./connection.cjs');
const fs = require('node:fs/promises');
const { observeDshSession } = require('../lib/observe.cjs');

const isRhoTool = name => name.startsWith('mcp__rho__');

exports.name = 'dsh-rho';
exports.inject = ['connection', 'agents', 'tools', 'sessionController', 'sessionQuery'];
exports.apply = async (ctx, config = {}) => {
  const bindings = new Map();
  let disposed = false;
  const maxBridges = config.maxBridges ?? 8;
  if (!Number.isSafeInteger(maxBridges) || maxBridges < 1) throw new Error('maxBridges must be a positive integer.');
  const mcpClient = await import('@deepseek-ai/dsh-mcp-client');
  const observationProblems = new Map();
  async function capture(record, sessionId) {
    const current = await readConnection(record.connectionFile);
    if (current.fingerprint !== record.fingerprint) throw new Error('Connection changed.');
    const cut = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal: AbortSignal.timeout(15000) });
    try { return observeDshSession(record.root, cut.header, cut.events); }
    finally { cut[Symbol.dispose](); }
  }

  async function observe(binding, agent) {
    if (disposed || binding.observing || !binding.ready) return;
    binding.observing = true;
    try {
      await checkBinding(binding, agent);
      binding.observation = await capture(binding.record, agent.session.id);
      binding.observationError = undefined;
    } catch { binding.observationError = 'Conversation observation is unavailable. Earlier records remain in Rho. Retry from this tab.'; }
    finally { binding.observing = false; }
  }
  function schedule(binding, agent) {
    if (!binding || binding.timer || disposed) return;
    binding.timer = setTimeout(() => { binding.timer = undefined; void observe(binding, agent); }, 500);
    binding.timer.unref?.();
  }

  async function checkBinding(binding, agent) {
    if (!binding?.record || !binding.ready) throw new ConnectionError('Rho is not connected to this conversation’s project. Open its Rho tab to check the connection.');
    const current = await readConnection(binding.record.connectionFile);
    if (current.fingerprint !== binding.record.fingerprint || await fs.realpath(agent.session.header.cwd) !== binding.record.root) {
      binding.stale = true;
      binding.ready = false;
      throw new ConnectionError('The Rho connection changed. Reload the Rho plugin before using this project; the existing bridge still holds its original connection.');
    }
    return binding.record;
  }

  async function attach(agent) {
    if (disposed) return;
    const previous = bindings.get(agent);
    if (previous) return previous.pending;
    const binding = { ready: false };
    bindings.set(agent, binding);
    binding.pending = (async () => {
      try {
        const record = await resolveWorkspace(config, agent.session.header.cwd);
        if (disposed || bindings.get(agent) !== binding) return;
        if ([...bindings.values()].filter(value => value.fiber).length >= maxBridges) {
          throw new ConnectionError('The Rho bridge limit is reached. Close an unused conversation or increase maxBridges in the Rho plugin configuration.');
        }
        if (ctx.tools.get('mcp__rho__rho_index')) throw new ConnectionError('Remove the old rho-mcp configuration entry. The Rho plugin now connects both tools and workspace from one configuration.');
        binding.record = record;
        binding.fiber = agent.ctx.plugin(mcpClient, {
          serverName: 'rho', transport: 'stdio', command: config.command || 'rho',
          args: [...(config.args || []), '--mcp', record.connectionFile],
          failOnStartupError: true, toolCallTimeoutMs: config.toolCallTimeoutMs ?? 300000,
        });
        await binding.fiber;
        if (disposed || bindings.get(agent) !== binding) { await binding.fiber.dispose(); return; }
        if (!agent.ctx.tools.get('mcp__rho__rho_index', agent)) throw new ConnectionError('Rho tools could not connect. Check the Rho executable and try again.');
        if ((await readConnection(record.connectionFile)).fingerprint !== record.fingerprint) throw new ConnectionError('The Rho connection changed while connecting. Reload the plugin.');
        binding.ready = true;
        await observe(binding, agent);
        // Heartbeat refreshes an open turn's observation, never its execution state.
        binding.heartbeat = setInterval(() => { if (binding.observation?.state !== 'completed') schedule(binding, agent); }, 3000);
        binding.heartbeat.unref?.();
      } catch (error) {
        binding.error = publicError(error);
        if (binding.fiber) { await binding.fiber.dispose(); binding.fiber = undefined; }
      }
    })();
    return binding.pending;
  }

  ctx.effect(() => ctx.tools.guard(exec => {
    if (isRhoTool(exec.name) && !bindings.get(exec.agent)?.ready) {
      return 'Rho is not connected to this conversation’s project. Open its Rho tab; another project’s Rho tools cannot be used here.';
    }
  }));
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (isRhoTool(exec.name)) {
      try { await checkBinding(bindings.get(exec.agent), exec.agent); }
      catch (error) { return { kind: 'deny', reason: publicError(error).error }; }
    }
    return next();
  });
  ctx.on('agent/created', ({ agent }) => attach(agent));
  ctx.on('session/event', (session) => {
    const agent = ctx.agents.get(session.id); if (agent) schedule(bindings.get(agent), agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    const binding = bindings.get(agent); bindings.delete(agent);
    clearTimeout(binding?.timer); clearInterval(binding?.heartbeat);
    if (binding?.fiber) void binding.fiber.dispose();
  });
  ctx.effect(() => async () => {
    disposed = true;
    await Promise.allSettled([...bindings.values()].map(async value => { clearTimeout(value.timer); clearInterval(value.heartbeat); await value.pending; await value.fiber?.dispose(); }));
    bindings.clear();
  });

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-rho/workspace', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      const headers = { 'cache-control': 'no-store' };
      try {
        const sessionId = new URL(request.url).searchParams.get('sessionId');
        if (!sessionId || sessionId.length > 256) throw new ConnectionError('Open a Harness conversation in the project you want to use.');
        const agent = ctx.agents.get(sessionId);
        const header = agent?.session.header || (await ctx.sessionController.inspect(sessionId, request.signal)).meta;
        if (request.method === 'POST' && agent && !bindings.get(agent)?.ready) {
          const previous = bindings.get(agent);
          if (previous) await previous.pending;
          if (previous?.stale) throw new ConnectionError('The Rho connection changed. Reload the plugin to replace the original bridge.');
          if (!previous?.ready) { bindings.delete(agent); await attach(agent); }
        }
        const binding = bindings.get(agent);
        if (binding) await binding.pending;
        if (binding?.error) return Response.json(binding.error, { status: 409, headers });
        // A read verifies the service and project without starting a bridge or resuming an Agent.
        const verified = await resolveWorkspace(config, header.cwd);
        const record = binding?.ready ? await checkBinding(binding, agent) : verified;
        if (verified.fingerprint !== record.fingerprint) throw new ConnectionError('The Rho connection changed. Reload the plugin.');
        let observation = binding?.observation, observationError = binding?.observationError || observationProblems.get(sessionId);
        if (request.method === 'POST') {
          try { observation = await capture(record, sessionId); observationError = undefined; observationProblems.delete(sessionId); }
          catch { observationError = 'Conversation observation is unavailable. Earlier records remain in Rho. Try again.'; }
        }
        return Response.json({ sessionId, ...record.project, toolsReady: Boolean(binding?.ready), observationReady: Boolean(observation), ...(observationError ? { observationError } : {}) }, { headers });
      } catch (error) { return Response.json(publicError(error), { status: 409, headers }); }
    },
  }));
  await Promise.allSettled(ctx.agents.list().map(attach));
  // Backfill existing conversations in configured projects without making a cold
  // Agent live. Only headers are enumerated across the native corpus.
  try {
    const records = (await Promise.allSettled(connectionFiles(config).map(projectConnection))).filter(r => r.status === 'fulfilled').map(r => r.value);
    const sessions = await ctx.sessionQuery.listSessions(AbortSignal.timeout(15000)), counts = new Map();
    for (const { header } of sessions) {
      if (disposed) break;
      let root; try { root = await fs.realpath(header.cwd); } catch { continue; }
      const matches = records.filter(r => r.root === root);
      if (matches.length !== 1) continue;
      const n = counts.get(root) || 0; counts.set(root, n + 1);
      if (n >= 64) { observationProblems.set(header.id, 'The project observation limit is 64 conversations. Earlier records remain in Rho.'); continue; }
      try { await capture(matches[0], header.id); }
      catch { observationProblems.set(header.id, 'Conversation observation is unavailable. Earlier records remain in Rho. Try again.'); }
    }
  } catch { /* The selected conversation can retry; tools retain their own status. */ }
};
