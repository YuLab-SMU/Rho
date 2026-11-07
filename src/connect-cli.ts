import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RhoClient } from './client.js';
import { clientEntries, defaultStateDirectory, mcpCommand, mcpName } from './agent-connect.js';
import { running } from './running.js';

// `rho connect` is the one command a setup prompt gives an Agent. The Agent names the project
// folder and itself; Rho finds the project in the service running for the state folder, grants
// it, and tells the Agent in its reply how to add the MCP server and check it. Everything the
// prompt used to spell out (paths, rules, ready entries) is in that reply, for the Agent to read.
export const connectUsage = `Connect yourself, an Agent, to a project of the Rho running on this machine:
  rho connect [PROJECT_FOLDER] --as NAME [--state-dir SERVICE_STATE] [--json]
PROJECT_FOLDER is the project's folder (the current folder without it). NAME is a short, stable
name for you, 1–128 characters from A–Z, a–z, 0–9, dot, underscore, colon, @ or hyphen; use the
same name when you run this again. Without --state-dir, Rho finds the running Rho that holds the
folder; give --state-dir and its state folder when more than one does.
The reply says how to add Rho's MCP server to your client; --json prints it as JSON.
`;

type Client = Pick<RhoClient, 'call'>;
export type GrantReply = Awaited<ReturnType<typeof grantReply>>;

// The same reply `rho --grant` prints: the grant, the stdio MCP server it serves and the ready
// entries for clients whose own mechanism has been used with Rho.
export async function grantReply(client: Client, project: { id: string; root: string }, session: string) {
  const granted = await client.call('session.grant', { projectId: project.id, externalSessionId: session });
  const command = mcpCommand(granted.connectionFile), name = mcpName(project.root);
  return { projectId: project.id, session, connectionFile: granted.connectionFile, methods: granted.methods.length,
    mcp: { name, command: command[0]!, args: command.slice(1) }, ...clientEntries(name, command, project.root) };
}

export function connectText(reply: GrantReply, root: string) {
  return [
    `Rho gave you access to the project ${JSON.stringify(path.basename(root))} (${root}) as ${reply.session}.`,
    '',
    '1. Add this MCP server to your own client, the way your client adds a local stdio MCP server. Keep the entry private, out of files under version control and, where your client allows it, for this project only. Leave your other settings, models and credentials as they are.',
    `   name: ${reply.mcp.name}`,
    `   command: ${reply.mcp.command}`,
    `   args: ${JSON.stringify(reply.mcp.args)}`,
    '   Ready entries for the clients Rho has been used with:',
    `   - Claude Code, run in the project folder: ${reply.claude}`,
    `   - Codex: ${reply.codex}`,
    `   - OpenCode: merge into ${reply.opencode.file}: ${JSON.stringify(reply.opencode.merge)}`,
    `   - DeepSeek Harness: append these lines to ${reply.dsh.file}, which it reloads by itself:`,
    '```yaml', reply.dsh.append.trimEnd(), '```',
    '   If your client cannot run a local stdio MCP server, tell the person so instead.',
    '2. Reload your MCP tools if your client can. If it loads MCP servers only when a session starts, stop here and tell the person to open a new session in the project folder.',
    `3. Call rho_index, with no arguments, through your client's own tools. In its reply, scopeHint.projectId must be ${reply.projectId}.`,
    '',
    'You are connected only when rho_index answers through your own tools. Starting the MCP server yourself, for example over stdio, only tests the server; it does not connect your client, so do not report that as connected. Report what you configured and the rho_index result separately. If a step fails, report the error and run this command again with the same --as name.',
    '',
    'The file in args is your credential: do not print it or copy it into the project. Rho is already running: do not start another.',
  ].join('\n') + '\n';
}

const within = (folder: string, root: string) => folder === root || folder.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export async function connectCli(args: string[]): Promise<number> {
  const fail = (code: number, message: string) => { process.stderr.write(message.trimEnd() + '\n'); return code; };
  let parsed;
  try { parsed = parseArgs({ args, options: { as: { type: 'string' }, 'state-dir': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true }); }
  catch (error) { return fail(2, (error instanceof Error ? error.message : String(error)) + '\n\n' + connectUsage); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(connectUsage); return 0; }
  if (positionals.length > 1) return fail(2, 'Give one project folder; quote it if it has spaces.\n\n' + connectUsage);
  const session = values.as;
  if (!session || session === 'NAME') return fail(2, 'Add --as and a short, stable name for yourself, such as claude-code or hermes-agent, and use the same name when you run this again.');
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(session)) return fail(2, 'A name after --as has 1–128 characters from A–Z, a–z, 0–9, dot, underscore, colon, @ or hyphen.');
  const asked = path.resolve(positionals[0] ?? process.cwd());
  const folder = await fs.realpath(asked).catch(() => null);
  if (!folder) return fail(1, `There is no folder ${asked}.`);
  // The Rho to ask: the state folder given, else each Rho that noted it is running and the
  // default state, of which the one holding the folder as a project is the one meant.
  const given = values['state-dir'] ? path.resolve(values['state-dir']) : null;
  const states = given ? [given] : [...new Set([...(await running()).map(note => note.stateDirectory), defaultStateDirectory()])];
  const held: { client: RhoClient; state: string; project: { id: string; root: string }; depth: number }[] = [];
  const stopped: string[] = [], other: string[] = [];
  for (const state of states) {
    let client: RhoClient;
    try { client = await RhoClient.fromFile(path.join(state, 'connection.json')); }
    catch { if (given) return fail(1, `No Rho has run with the state folder ${state}.`); continue; }
    try {
      const projects = await client.call('project.list', {});
      // The innermost project holding the folder, so a project inside another's folder is itself.
      const roots = await Promise.all(projects.map(async p => ({ project: p, root: await fs.realpath(p.root).catch(() => null) })));
      const found = roots.filter(r => r.root && within(folder, r.root)).sort((a, b) => b.root!.length - a.root!.length)[0];
      if (found) held.push({ client, state, project: found.project, depth: found.root!.length }); else other.push(`${state} (${client.connection.url})`);
    } catch (error) {
      const e = error as { cause?: { code?: string }; error?: { message?: string }; message?: string };
      if (e?.cause?.code === 'ECONNREFUSED') { stopped.push(`${state} (last at ${client.connection.url})`); continue; }
      return fail(1, e?.error?.message ?? e?.message ?? String(error));
    }
  }
  if (held.length > 1) return fail(1, `More than one running Rho has ${folder} as a project: ${held.map(h => `${h.state} (${h.client.connection.url})`).join(', ')}. Ask the person which one they use, and run this again with --state-dir and its state folder.`);
  const chosen = held[0];
  if (!chosen) {
    if (other.length) return fail(1, `${folder} is not a project of the Rho running for ${other.join(', ')}. Ask the person to open it in Rho, or give the folder of a project they opened.`);
    return fail(1, `Rho is not running${stopped.length ? ` for ${stopped.join(', ')}` : ' on this machine'}. Ask the person to start it, then run this again.`);
  }
  try {
    const reply = await grantReply(chosen.client, chosen.project, session);
    process.stdout.write(values.json ? JSON.stringify(reply) + '\n' : connectText(reply, chosen.project.root));
    return 0;
  } catch (error) {
    const e = error as { error?: { message?: string }; message?: string };
    return fail(1, e?.error?.message ?? e?.message ?? String(error));
  }
}
