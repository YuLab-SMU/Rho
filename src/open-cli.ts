import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RhoClient } from './client.js';
import { defaultStateDirectory } from './agent-connect.js';
import { connection, holds, openInBrowser, rhoCommand, startInBackground } from './background.js';
import { findProject, grantReply } from './connect-cli.js';

// `rho open` is what a person means by "start this project with Rho": Rho running, this folder one
// of its projects, and the folder's page open in their browser. Agents asked to do that spent
// minutes finding the commands, restarted Rho on a parent folder that listed every sibling, or
// registered the folder through a grant; the person was rarely told that Rho is a browser page.

const startOptions = ['root', 'agent-backend', 'acp-command', 'rscript', 'python', 'claude', 'codex', 'core', 'port', 'example', 'plugins', 'limits', 'ssh', 'serverctl'] as const;
export const openUsage = `Open a folder in Rho, in the browser on this machine, and start Rho first when it is not running:
  rho open [FOLDER] [--state-dir SERVICE_STATE] [--no-browser] [--json] [START_OPTIONS]
FOLDER is the folder to work in (the current folder without it); it stays where it is. Rho uses the
running Rho that already has it as a project, else the one for --state-dir (~/Rho/state without
it), started in the background when it is not running: with ~/Rho/projects as its projects folder
unless --root is given, and with START_OPTIONS such as --agent-backend codex-acp or --rscript PATH.
The reply says what to tell the person and how an Agent works in the project.
`;
export const removeUsage = `Take a folder off Rho's list of projects. The folder, its files and the records Rho keeps in it
stay as they are, and rho open FOLDER lists it again as it was:
  rho remove [FOLDER] [--stop] [--state-dir SERVICE_STATE] [--json]
FOLDER is the project's own folder (the current folder without it); one that is no longer on disk
is named by the path it had. Work Rho runs in the project (an Agent answering, live sessions,
terminals, running commands) is counted first, and then nothing is stopped or removed; --stop
stops each as the person's and removes the project once all have ended. This is the person's
command: an Agent runs it only when the person asked for that project to be removed.
`;
export const toolUsage = `Call Rho's four Agent tools from a shell, for an Agent whose client cannot load Rho's MCP server
in this session (most load MCP servers only when a session starts):
  rho tool index|resolve|call|read [INPUT_JSON | -] --as NAME [--project FOLDER] [--state-dir SERVICE_STATE]
  rho tool list --as NAME                    each tool's description and input schema
INPUT_JSON is the tool's input, exactly as the MCP tool rho_index, rho_resolve, rho_call or rho_read
takes it ("-" reads it from standard input; none is {}). The reply is that tool's JSON reply, and
the exit code is 1 when it is an error. NAME and FOLDER are those of rho connect: the same NAME
keeps the same grant, so a client that also loaded the MCP server keeps working. The usual round:
  rho tool index --as NAME                                   the operations, and a catalogRef
  rho tool resolve '{"catalogRef":"…","selected":["kernel.run"]}' --as NAME
                                                             each one's contract (its ref) and rules
  rho tool call - --as NAME < input.json                     {"operation":"kernel.run","contractRef":"…","input":{…}}
`;

const quoted = (value: string) => /^[A-Za-z0-9_./:@=+,-]+$/.test(value) ? value : `"${value}"`;
const fail = (code: number, message: string) => { process.stderr.write(message.trimEnd() + '\n'); return code; };
const messageOf = (error: unknown) => { const e = error as { error?: { message?: string }; message?: string }; return e?.error?.message ?? e?.message ?? String(error); };

export async function openCli(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { 'state-dir': { type: 'string' }, 'no-browser': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
      ...Object.fromEntries(startOptions.map(name => [name, { type: 'string' as const }])) } });
  } catch (error) { return fail(2, messageOf(error) + '\n\n' + openUsage); }
  const { positionals } = parsed, values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help) { process.stdout.write(openUsage); return 0; }
  if (positionals.length > 1) return fail(2, 'Give one folder; quote it if it has spaces.\n\n' + openUsage);
  const asked = path.resolve(positionals[0] ?? process.cwd());
  const folder = await fs.realpath(asked).catch(() => null);
  if (!folder || !(await fs.stat(folder)).isDirectory()) return fail(1, `There is no folder ${asked}.`);
  const given = typeof values['state-dir'] === 'string' ? path.resolve(values['state-dir']) : null;

  // The Rho that has the folder already, else the one for the state folder, started if need be.
  const search = await findProject(folder, given);
  let client: RhoClient, state: string, project: { id: string; root: string }, started = false;
  if (search.found) ({ client, state, project } = search.found);
  else {
    state = given ?? defaultStateDirectory();
    const up = search.running.find(r => path.resolve(r.state) === path.resolve(state));
    if (up) client = up.client;
    else {
      if (await connection(state) && await holds(state)) return fail(1, `The Rho for ${state} holds its state but does not answer. Check it with: ${rhoCommand} --status --state-dir "${state}"`);
      const root = path.resolve(typeof values.root === 'string' ? values.root : path.join(path.dirname(defaultStateDirectory()), 'projects'));
      await fs.mkdir(root, { recursive: true });
      const start = ['--root', root, '--state-dir', state];
      for (const name of startOptions) { const value = values[name]; if (name !== 'root' && typeof value === 'string') start.push('--' + name, value); }
      const code = await startInBackground(start, state, { quiet: true });
      if (code) return code;
      started = true;
      client = await RhoClient.fromFile(path.join(state, 'connection.json'));
    }
    try { project = await client.call('project.open', { path: folder }); }
    catch (error) {
      // An earlier Rho opens folders inside its projects folder only.
      const text = messageOf(error);
      return fail(1, /project-relative path|outside|escape/i.test(text)
        ? `The Rho running for ${state} cannot open ${folder}: ${text}\nIt is an earlier version, which opens folders inside its projects folder only. The person can open the folder with "Open folder…" on Rho's home page, or stop that Rho (${rhoCommand} --stop --state-dir "${state}") and run this again to start this version.`
        : `Rho could not open ${folder}: ${text}`);
    }
  }
  const url = `${client.connection.url}/#project=${project.id}`;
  const browser = values['no-browser'] ? { opened: false, note: 'No browser was opened (--no-browser).' } : await openInBrowser(url);
  const log = path.join(state, 'rho.log');
  if (values.json) {
    process.stdout.write(JSON.stringify({ open: { url, projectId: project.id, folder: project.root, state, started, browser } }) + '\n');
    return 0;
  }
  const name = path.basename(project.root);
  process.stdout.write([
    `Rho is open on ${JSON.stringify(name)} (${project.root}).`,
    started ? `Rho was not running, so it was started in the background (state ${state}, log ${log}).` : `Rho was already running (state ${state}).`,
    '',
    'Its page for this folder, in the browser on this machine:',
    `  ${url}`,
    browser.note,
    '',
    'Tell the person, in their language:',
    '- Rho is a workspace in their web browser, not in this chat or a terminal: the page above shows this folder, with its files, figures and tables, a live R and Python Notebook, notes, and an Agent panel where they can ask Claude Code or Codex to work while they watch.',
    '- Opening the address in a browser on this machine is all the access needed: no account, link or code. The address stays the same when Rho restarts.',
    `- Rho keeps running in the background until it is stopped: ${rhoCommand} --stop --state-dir ${quoted(state)}.`,
    '',
    'To work in this project yourself, as an Agent:',
    `- ${rhoCommand} tool index --as NAME --project ${quoted(project.root)}: Rho's tools from your shell, now. NAME is a short, stable name for you.`,
    `- ${rhoCommand} connect ${quoted(project.root)} --as NAME: adds them to your client as an MCP server, which a new session loads.`,
    'Do the analysis in Rho\'s Notebook (the tools\' kernel.run) rather than a separate Rscript or python, so the person sees each step, figure and value on the page.',
  ].join('\n') + '\n');
  return 0;
}

// `rho remove` is the cross on a project's row, from a shell: the same operation, as the person
// at this machine. Only the project whose own folder is named is removed, never the one a folder
// lies in, and a folder that is gone from disk still names its project.
export async function removeCli(args: string[]): Promise<number> {
  let parsed;
  try { parsed = parseArgs({ args, allowPositionals: true, options: { 'state-dir': { type: 'string' }, stop: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' } } }); }
  catch (error) { return fail(2, messageOf(error) + '\n\n' + removeUsage); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(removeUsage); return 0; }
  if (positionals.length > 1) return fail(2, 'Give one folder; quote it if it has spaces.\n\n' + removeUsage);
  // A folder that is gone is named by the path it had, under the folder that still holds its place.
  const real = (place: string): Promise<string> => fs.realpath(place).catch(async () => { const parent = path.dirname(path.resolve(place)); return parent === path.resolve(place) ? parent : path.join(await real(parent), path.basename(place)); });
  const asked = path.resolve(positionals[0] ?? process.cwd()), folder = await real(asked);
  const search = await findProject(folder, values['state-dir'] ? path.resolve(values['state-dir']) : null);
  let hit: { client: RhoClient; state: string; project: { id: string; root: string } } | null = null;
  if (search.found) {
    if (await real(search.found.project.root) !== folder) return fail(1, `${folder} lies in the project ${search.found.project.root}. Name that folder to take the project off Rho's list.`);
    hit = search.found;
  } else {
    if (!search.running.length) return fail(1, /^No Rho has run/.test(search.message) ? search.message : `Rho is not running, and its list of projects changes only while it runs. Start it (${rhoCommand}), then run this again.`);
    for (const up of search.running) {
      const projects = await up.client.call('project.list', {}).catch(() => []);
      for (const project of projects) if (await real(project.root) === folder) { hit = { ...up, project }; break; }
      if (hit) break;
    }
    if (!hit) return fail(1, `${folder} is not one of Rho's projects.`);
  }
  const words = (n: Record<string, number>) => [[n.conversations, 'Agent answering', 'Agents answering'], [n.sessions, 'live session', 'live sessions'], [n.terminals, 'terminal', 'terminals'], [n.commands, 'running command', 'running commands']]
    .filter(([count]) => count).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`).join(', ');
  let reply;
  try { reply = await hit.client.call('project.remove', { projectId: hit.project.id, ...(values.stop ? { stop: true } : {}) }); }
  catch (error) {
    const e = (error as { error?: { kind?: string; message?: string; details?: { running?: Record<string, number> } } }).error;
    if (values.json) { process.stdout.write(JSON.stringify({ refused: { kind: e?.kind ?? 'failed', message: messageOf(error), ...(e?.details?.running ? { running: e.details.running } : {}) } }) + '\n'); return 1; }
    if (e?.message === 'Unknown API operation.') return fail(1, `The Rho running for ${hit.state} is an earlier version, which does not remove projects. Stop it (${rhoCommand} --stop --state-dir ${quoted(hit.state)}), start this version, then run this again.`);
    if (e?.kind === 'conflict' && e.details?.running && !values.stop) return fail(1, `Rho is running work in ${hit.project.root}: ${words(e.details.running)}.\nNothing was stopped or removed. To stop each as the person's and remove the project: ${rhoCommand} remove ${quoted(hit.project.root)} --stop`);
    return fail(1, messageOf(error));
  }
  if (values.json) { process.stdout.write(JSON.stringify({ removed: { projectId: reply.project.id, folder: reply.project.root, state: hit.state, stopped: reply.stopped } }) + '\n'); return 0; }
  process.stdout.write([
    `${JSON.stringify(reply.project.name ?? path.basename(reply.project.root))} is off Rho's list of projects${words(reply.stopped) ? `, with ${words(reply.stopped)} stopped first` : ''}.`,
    `Its folder and files are as they were: ${reply.project.root}`,
    `List it again as it was: ${rhoCommand} open ${quoted(reply.project.root)}`,
  ].join('\n') + '\n');
  return 0;
}

// The tools come from Rho's own MCP server for this grant, started for one call: the same
// validation, contracts, result pages and session identity as in a client that loaded it.
export async function toolCli(args: string[]): Promise<number> {
  let parsed;
  try { parsed = parseArgs({ args, allowPositionals: true, options: { as: { type: 'string' }, project: { type: 'string' }, 'state-dir': { type: 'string' }, help: { type: 'boolean' } } }); }
  catch (error) { return fail(2, messageOf(error) + '\n\n' + toolUsage); }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) { process.stdout.write(toolUsage); return values.help ? 0 : 2; }
  const tool = positionals[0]!.replace(/^rho_/, '');
  if (!['index', 'resolve', 'call', 'read', 'list'].includes(tool)) return fail(2, `There is no tool ${positionals[0]}: choose index, resolve, call, read or list.\n\n${toolUsage}`);
  if (positionals.length > 2) return fail(2, 'Give the input as one JSON argument, quoted, or "-" to read it from standard input.');
  const session = values.as;
  if (!session || session === 'NAME' || !/^[A-Za-z0-9._:@-]{1,128}$/.test(session)) return fail(2, 'Add --as and a short, stable name for yourself (1–128 characters from A–Z, a–z, 0–9, dot, underscore, colon, @ or hyphen), the same each time.');
  let input: unknown = {};
  const raw = positionals[1] === '-' ? await new Promise<string>(resolve => { let text = ''; process.stdin.setEncoding('utf8').on('data', c => { text += c; }).on('end', () => resolve(text)); }) : positionals[1];
  if (raw !== undefined && raw.trim()) {
    try { input = JSON.parse(raw); } catch { return fail(2, 'The input is not JSON. Quote it for your shell, or pass "-" and write it to standard input.'); }
  }
  const asked = path.resolve(values.project ?? process.cwd());
  const folder = await fs.realpath(asked).catch(() => null);
  if (!folder) return fail(1, `There is no folder ${asked}.`);
  const search = await findProject(folder, values['state-dir'] ? path.resolve(values['state-dir']) : null);
  if (!search.found) return fail(search.code, search.message);
  let file: string;
  try { file = (await grantReply(search.found.client, search.found.project, session)).connectionFile; }
  catch (error) { return fail(1, messageOf(error)); }

  const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), '--mcp', file], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const reply = await new Promise<{ code: number; text: string }>(resolve => {
    let buffered = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        let message: { id?: number; result?: any; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return resolve({ code: 1, text: `Rho's MCP server refused to start: ${message.error.message}` });
          send({ method: 'notifications/initialized' });
          send(tool === 'list' ? { id: 2, method: 'tools/list' } : { id: 2, method: 'tools/call', params: { name: 'rho_' + tool, arguments: input } });
        } else if (message.id === 2) {
          if (message.error) return resolve({ code: 1, text: `rho_${tool} failed: ${message.error.message}` });
          if (tool === 'list') return resolve({ code: 0, text: JSON.stringify({ tools: (message.result?.tools ?? []).map((t: { name: string; description?: string; inputSchema?: unknown }) => ({ tool: t.name.replace(/^rho_/, ''), description: t.description, input: t.inputSchema })) }, null, 1) });
          const text = (message.result?.content ?? []).map((part: { text?: string }) => part.text ?? '').join('');
          return resolve({ code: message.result?.isError ? 1 : 0, text });
        }
      }
    });
    child.on('exit', code => resolve({ code: 1, text: `Rho's MCP server ended (exit ${code}) before it replied.${errors ? '\n' + errors.trim() : ''}` }));
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rho tool', version } } });
  });
  child.kill();
  if (reply.code && !reply.text.startsWith('{')) return fail(1, reply.text);
  process.stdout.write(reply.text + '\n');
  if (reply.code && /"kind":"invalid"/.test(reply.text) && /discovery, call or result-page schema/.test(reply.text)) process.stderr.write(`The input does not match rho_${tool}'s schema: rho tool list --as ${session} shows it.\n`);
  return reply.code;
}
