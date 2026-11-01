import { ResultStore, defaults } from './store.js';

export const name = 'dsh-rho';
export const inject = ['tools', 'sessions'];

export async function apply(ctx: any, config: { projectRoot: string; stateDir: string; limits?: Partial<typeof defaults> }) {
  if (!config?.projectRoot || !config?.stateDir) throw new Error('dsh-rho needs projectRoot and stateDir. Set RHO_DSH_PROJECT and RHO_DSH_STATE before enabling its bundle.');
  const limits = { ...defaults };
  for (const [name, value] of Object.entries(config.limits ?? {})) {
    if (!(name in defaults) || !Number.isSafeInteger(value) || value < 1 || value > defaults[name as keyof typeof defaults]) throw new Error('Invalid dsh-rho limit: ' + name);
    limits[name as keyof typeof defaults] = value;
  }
  const store = new ResultStore(config.projectRoot, config.stateDir, limits);
  await store.start();
  ctx.on('dispose', () => store.close());
  const sessionOf = (id: unknown) => {
    if (typeof id !== 'string' || id.length > 256) throw new Error('Select an existing dsh session.');
    const session = ctx.sessions.get(id);
    if (!session) throw new Error('Open the original session in dsh before viewing its results.');
    return { id: session.id, cwd: session.header.cwd };
  };
  ctx.tools.register({
    name: 'rho_present',
    description: 'Show a completed analysis result in the Rho tab of this same conversation. Captures exact bytes; does not execute analysis. Supports CSV, PNG, JPEG, SVG. For CSV, explicitly declare all columns (header order, string/number/boolean); optional key names a unique nonempty string column for selecting rows. Submit each result separately. Only files in the configured project are accessible.',
    parameters: { type: 'object', additionalProperties: false, required: ['path', 'title'], properties: {
      path: { type: 'string', description: 'Project-relative output file path.' },
      title: { type: 'string', description: 'Short human-readable description of the result.' },
      columns: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string', enum: ['string', 'number', 'boolean'] } } } },
      key: { type: 'string', description: 'Optional unique string column; never infer identity from displayed row positions.' },
    } },
    output: { schema: { type: 'string' }, render: (_: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(input: any, exec: any) {
      const result = await store.present(sessionOf(exec.agent?.id), exec.callId, input, exec.signal);
      return JSON.stringify({ shown: true, title: result.title, path: result.resource.provenance.originalPath, resource: { id: result.resource.id, version: result.resource.version }, sessionId: result.sessionId, capturedAt: result.capturedAt });
    },
  });
  ctx.inject(['connection'], (c: any) => {
    c.effect(() => c.connection.fetch.register({ path: '/api/dsh-rho', methods: ['POST'], requestBody: 'buffered',
      async fetch(request: Request) {
        const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
        try {
          // Connection's authenticated /api carrier checks Host/Origin and owner
          // Peer before dispatch. Its internal Request URL is carrier-neutral.
          if (request.headers.get('sec-fetch-site') === 'cross-site') return reply({ ok: false, error: 'Use the same dsh browser origin.' }, 403);
          const text = await request.text();
          if (Buffer.byteLength(text) > 32 * 1024) throw new Error('The request exceeds the 32 KiB budget.');
          const body = JSON.parse(text), session = sessionOf(body.sessionId);
          let value;
          if (body.action === 'list') value = await store.list(session);
          else if (body.action === 'call') value = await store.call(session, body.method, body.input ?? {});
          else if (body.action === 'question') {
            if (typeof body.callId !== 'string' || !body.callId) throw new Error('Select an original result before asking a question.');
            value = await store.question(session, body.resource, body.entities ?? [], body.question, body.callId);
          }
          else throw new Error('Unknown dsh-rho action.');
          return reply({ ok: true, value });
        } catch (error: any) { return reply({ ok: false, error: error?.message ?? 'The result could not be read.' }, 400); }
      },
    }), 'dsh-rho: result reader');
  });
}

export { defaults };
