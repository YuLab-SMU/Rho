import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
// A Unix Host's socket lies under its project, within the socket path limit; Windows Hosts use pipes.
const shortTemp = process.platform === 'win32' ? tmpdir() : '/tmp';

// A project is a folder. The person takes one off Rho's list and nothing else changes: the folder,
// its files and the records Rho keeps in it stay, and the folder opened again is the project it was.
async function setup(t, config = {}) {
  const root = await fs.mkdtemp(path.join(shortTemp, 'rho-remove-'));
  for (const name of ['one', 'two']) { await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, 'data.csv'), 'id\n1\n'); }
  const start = () => new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing', python: process.env.RHO_PYTHON, ...config }).start();
  const live = { service: await start() };
  t.after(async () => { await live.service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const clients = () => ({ admin: new RhoClient({ url: live.service.url, token: live.service.adminToken }), person: new BrowserClient({ url: live.service.url }) });
  return { root, live, start, clients };
}
const names = list => list.map(p => path.basename(p.root));
const kind = expected => error => { assert.equal(error.error?.kind, expected, error.message); return true; };

test('a project leaves the list, its folder stays, and Undo or opening the folder lists it as it was', async t => {
  const { root, live, start, clients } = await setup(t);
  let { admin, person } = clients();
  const one = await admin.call('project.open', { path: 'one' }), two = await admin.call('project.open', { path: 'two' });
  const grant = path.join(root, 'agent.json');
  await live.service.agentConnection(one.id, 'reader', grant, undefined, undefined, 'layered-business');
  const granted = JSON.parse(await fs.readFile(grant, 'utf8')), agent = () => new RhoClient(granted);
  await agent().call('kernel.read', { projectId: one.id });
  // Only the person at this machine removes a project; an Agent's grant never holds the operation.
  await assert.rejects(agent().call('project.remove', { projectId: one.id }), error => ['unauthorized', 'scope'].includes(error.error?.kind));
  assert.deepEqual(names(await person.call('project.list', {})), ['one', 'two']);

  const removed = await person.call('project.remove', { projectId: one.id });
  assert.equal(removed.project.id, one.id);
  assert.deepEqual(removed.stopped, { conversations: 0, sessions: 0, terminals: 0, commands: 0 });
  assert.deepEqual(names(await person.call('project.list', {})), ['two']);
  // Nothing in the folder changed: its file and Rho's own records are where they were.
  assert.equal(await fs.readFile(path.join(root, 'one', 'data.csv'), 'utf8'), 'id\n1\n');
  assert.ok((await fs.stat(path.join(root, 'one', '.rho'))).isDirectory());
  // A removed project is not reached by its identity, by the person or by an Agent granted it.
  await assert.rejects(person.call('project.entries', { projectId: one.id }), kind('not_found'));
  await assert.rejects(agent().call('kernel.read', { projectId: one.id }), kind('not_found'));
  await assert.rejects(person.call('project.remove', { projectId: one.id }), kind('not_found'));

  // Undo lists it where it stood, and the grant reaches it again.
  const back = await person.call('project.restore', { projectId: one.id });
  assert.equal(back.id, one.id);
  assert.deepEqual(names(await person.call('project.list', {})), ['one', 'two']);
  await agent().call('kernel.read', { projectId: one.id });
  // Listing one that is listed changes nothing.
  assert.equal((await person.call('project.restore', { projectId: one.id })).id, one.id);
  assert.deepEqual(names(await person.call('project.list', {})), ['one', 'two']);

  // A removal lasts across a restart, and so does what is kept to list the project again.
  await person.call('project.remove', { projectId: one.id });
  await live.service.close(); live.service = await start();
  ({ admin, person } = clients());
  assert.deepEqual(names(await person.call('project.list', {})), ['two']);
  // Opening the folder again lists the same project.
  const opened = await admin.call('project.open', { path: 'one' });
  assert.equal(opened.id, one.id);
  assert.deepEqual(names(await person.call('project.list', {})).sort(), ['one', 'two']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.service', 'removed-projects.json'), 'utf8')), []);
  // One never removed, or forgotten, is not brought back by its identity.
  await person.call('project.remove', { projectId: two.id });
  await fs.writeFile(path.join(root, '.service', 'removed-projects.json'), '[]');
  await live.service.close(); live.service = await start();
  ({ admin, person } = clients());
  await assert.rejects(person.call('project.restore', { projectId: two.id }), kind('not_found'));
});

test('work Rho runs in a project is counted first and stopped only when the person says so', async t => {
  const { live, clients } = await setup(t);
  const { admin, person } = clients();
  const one = await admin.call('project.open', { path: 'one' });
  const ran = await person.call('kernel.run', { projectId: one.id, language: 'python', code: 'kept = 41 + 1', changeId: 'r1', waitMs: 30000 });
  assert.equal(ran.cell.state, 'done');
  // A live session holds values; the project stays listed and the session keeps running.
  await assert.rejects(person.call('project.remove', { projectId: one.id }), error => {
    assert.equal(error.error.kind, 'conflict');
    assert.deepEqual(error.error.details.running, { conversations: 0, sessions: 1, terminals: 0, commands: 0 });
    assert.match(error.error.message, /1 live session/);
    return true;
  });
  assert.deepEqual(names(await person.call('project.list', {})), ['one']);
  assert.equal((await person.call('kernel.read', { projectId: one.id })).sessions.filter(s => s.state !== 'ended').length, 1);

  const removed = await person.call('project.remove', { projectId: one.id, stop: true });
  assert.deepEqual(removed.stopped, { conversations: 0, sessions: 1, terminals: 0, commands: 0 });
  assert.deepEqual(await person.call('project.list', {}), []);
  // Listed again, its record says the session was stopped, and by whom; nothing was started.
  await person.call('project.restore', { projectId: one.id });
  const sessions = (await person.call('kernel.read', { projectId: one.id })).sessions;
  assert.deepEqual(sessions.map(s => [s.state, s.ending, s.stop?.by]), [['ended', 'stopped', 'browser:local']]);
  assert.ok(live.service);
});

// An Agent that takes a message and does not answer until it is told to stop, as an Agent at work is.
const waitingAgent = `import fs from 'node:fs';
import {createInterface} from 'node:readline';
const log=v=>fs.appendFileSync(process.env.RHO_ACP_TEST_LOG,JSON.stringify(v)+'\\n');
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
let active;
log({kind:'process',pid:process.pid});
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),reply=result=>out({id:r.id,result});
 if(!r.method)return;
 log({kind:r.method});
 if(r.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{}});
 if(r.method==='session/new')return reply({sessionId:'s'});
 if(r.method==='session/prompt'){active=r.id;return out({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working'},messageId:'a'}}});}
 if(r.method==='session/cancel'){if(active)out({id:active,result:{stopReason:'cancelled'}});active=null;}
});`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('an answering Agent, a terminal, a running command and a session are each counted, then stopped as the person\'s', { skip: process.platform === 'win32' && 'a terminal needs a pseudo-terminal' }, async t => {
  const peer = path.join(await fs.mkdtemp(path.join(shortTemp, 'rho-remove-peer-')), 'peer.mjs'), log = peer + '.jsonl';
  await fs.writeFile(peer, waitingAgent);
  t.after(() => fs.rm(path.dirname(peer), { recursive: true, force: true }));
  const agent = { command: { file: process.execPath, args: [peer] }, env: { RHO_ACP_TEST_LOG: log } };
  const { root, clients } = await setup(t, { coreBinary: path.join(shortTemp, 'absent-core'), claudeAcp: agent, codexAcp: agent, conversations: { stopGraceMs: 500 } });
  const { admin, person } = clients();
  const one = await admin.call('project.open', { path: 'one' }), call = (method, body = {}) => person.call(method, { projectId: one.id, ...body });
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

  const talk = await call('conversation.start', { changeId: 'talk', text: 'wait' }), conversationId = talk.conversation.conversationId;
  for (let i = 0; i < 400 && !(await calls()).some(c => c.kind === 'session/prompt'); i++) await new Promise(r => setTimeout(r, 25));
  const terminal = (await call('console.terminal.open', { cols: 80, rows: 24 })).terminal;
  const command = (await call('console.run', { command: 'sleep 600', changeId: 'long' })).command;
  assert.equal((await call('kernel.run', { language: 'python', code: 'kept = 1', changeId: 'cell', waitMs: 30000 })).cell.state, 'done');
  const agentPid = (await calls()).find(c => c.kind === 'process').pid, sessionPid = (await call('kernel.read')).sessions[0].pid;

  const all = { conversations: 1, sessions: 1, terminals: 1, commands: 1 };
  await assert.rejects(call('project.remove'), error => {
    assert.equal(error.error.kind, 'conflict');
    assert.deepEqual(error.error.details.running, all);
    assert.match(error.error.message, /1 Agent answering, 1 live session, 1 terminal, 1 command/);
    return true;
  });
  // Counting stopped nothing.
  assert.equal((await call('conversation.read', { conversationId })).turns.at(-1).state, 'running');
  assert.equal((await call('console.terminal.list')).terminals.find(x => x.terminalId === terminal.terminalId).endedAt, null);
  assert.equal((await call('console.list')).commands.find(x => x.commandId === command.commandId).state, 'running');
  assert.ok(alive(sessionPid) && alive(agentPid));

  const removed = await call('project.remove', { stop: true });
  assert.deepEqual(removed.stopped, all);
  assert.deepEqual(await person.call('project.list', {}), []);
  assert.ok((await calls()).some(c => c.kind === 'session/cancel'), 'the Agent was told to stop');
  for (let i = 0; i < 200 && alive(sessionPid); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(alive(sessionPid), false, 'the session\'s process ended');
  for (let i = 0; i < 200 && alive(agentPid); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(alive(agentPid), false, 'the Agent\'s connection ended with the removal');
  // The folder holds what it held; listed again, each record says it was stopped, and by whom.
  assert.equal(await fs.readFile(path.join(root, 'one', 'data.csv'), 'utf8'), 'id\n1\n');
  await person.call('project.restore', { projectId: one.id });
  const turn = (await call('conversation.read', { conversationId })).turns.at(-1);
  assert.notEqual(turn.state, 'running');
  const ran = (await call('console.list')).commands.find(x => x.commandId === command.commandId);
  assert.notEqual(ran.state, 'running');
  assert.equal(ran.stop?.by, 'browser:local');
  assert.equal(alive(command.pid), false, 'the command\'s process ended');
  assert.notEqual((await call('console.terminal.list')).terminals.find(x => x.terminalId === terminal.terminalId)?.endedAt ?? 'gone', null, 'the terminal\'s shell ended');
  assert.deepEqual((await call('kernel.read')).sessions.map(s => [s.state, s.ending, s.stop?.by]), [['ended', 'stopped', 'browser:local']]);
});

test('rho remove takes the project whose own folder is named off the list, and stops its work only with --stop', { timeout: 120000 }, async t => {
  const { root, clients } = await setup(t);
  const { admin, person } = clients();
  const one = await admin.call('project.open', { path: 'one' }), two = await admin.call('project.open', { path: 'two' });
  await fs.mkdir(path.join(root, 'one', 'inner'));
  const rho = (...args) => new Promise(resolve => execFile(process.execPath, [cli, 'remove', ...args, '--state-dir', path.join(root, '.service')], { timeout: 60000, windowsHide: true },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  // Only a project's own folder names it: not a folder inside one, nor one Rho does not list.
  let got = await rho(path.join(root, 'one', 'inner'));
  assert.equal(got.code, 1); assert.match(got.stderr, /lies in the project .*one\. Name that folder/);
  got = await rho(path.join(root, 'three'));
  assert.equal(got.code, 1); assert.match(got.stderr, /is not one of Rho's projects/);
  assert.deepEqual(names(await person.call('project.list', {})), ['one', 'two']);

  // Running work is counted and nothing is stopped; --stop stops it as the person's.
  await person.call('kernel.run', { projectId: one.id, language: 'python', code: 'kept = 1', changeId: 'cell', waitMs: 30000 });
  got = await rho(path.join(root, 'one'));
  assert.equal(got.code, 1); assert.match(got.stderr, /1 live session\.\nNothing was stopped or removed\..*remove .*one"? --stop/s);
  got = await rho(path.join(root, 'one'), '--json');
  assert.deepEqual([got.code, JSON.parse(got.stdout).refused.kind, JSON.parse(got.stdout).refused.running.sessions], [1, 'conflict', 1]);
  assert.equal((await person.call('kernel.read', { projectId: one.id })).sessions[0].state, 'idle');
  got = await rho(path.join(root, 'one'), '--stop');
  assert.equal(got.code, 0, got.stderr + got.stdout);
  assert.match(got.stdout, /^"one" is off Rho's list of projects, with 1 live session stopped first\.\nIts folder and files are as they were: .*one\nList it again as it was: .* open .*one"?\n$/);
  assert.deepEqual(names(await person.call('project.list', {})), ['two']);
  assert.equal(await fs.readFile(path.join(root, 'one', 'data.csv'), 'utf8'), 'id\n1\n');

  // A project whose folder is gone from disk is named by the path it had. Not run on Windows,
  // where a folder the service holds open may not be deleted from under it.
  if (process.platform !== 'win32') {
    await fs.rm(path.join(root, 'two'), { recursive: true });
    got = await rho(path.join(root, 'two'), '--json');
    assert.equal(got.code, 0, got.stderr + got.stdout);
    assert.deepEqual([JSON.parse(got.stdout).removed.projectId, JSON.parse(got.stdout).removed.stopped.sessions], [two.id, 0]);
    assert.deepEqual(await person.call('project.list', {}), []);
  }
  // The folder opened again is the project it was.
  assert.equal((await admin.call('project.open', { path: 'one' })).id, one.id);
});
