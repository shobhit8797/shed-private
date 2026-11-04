import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentStore, agentState, launchArgs, memoryFile, instructions } from '../server/agents.js';

function tempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-agents-'));
  const data = path.join(base, 'data'), project = path.join(base, 'project');
  fs.mkdirSync(data); fs.mkdirSync(path.join(project, '.git'), { recursive:true });
  return { data, project };
}

test('a new agent gets a memory file in its project, kept out of git, and survives a restart', () => {
  const { data, project } = tempDirs();
  const store = agentStore(data);
  const agent = store.create({ name:'backend', cwd:project, harness:'claude' });
  assert.match(agent.nativeId, /^[0-9a-f-]{36}$/, 'Claude agents get their session ID from Shed');
  const memory = fs.readFileSync(memoryFile(agent), 'utf8');
  assert.match(memory, /^# Agent: backend/);
  assert.match(memory, /## Summary/);
  assert.match(memory, /## Log\n$/);
  assert.match(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.shed\/$/m);
  assert.deepEqual(agentStore(data).get(agent.id), agent, 'agents.json keeps the agent');
});

test('agent names, harnesses, folders and duplicates are checked', () => {
  const { data, project } = tempDirs();
  const store = agentStore(data);
  assert.throws(() => store.create({ name:'Backend Dev', cwd:project, harness:'claude' }), /lowercase/);
  assert.throws(() => store.create({ name:'ok', cwd:project, harness:'pi' }), /Claude Code or Codex/);
  assert.throws(() => store.create({ name:'ok', cwd:path.join(project, 'missing'), harness:'claude' }), /does not exist/);
  store.create({ name:'ok', cwd:project, harness:'codex' });
  assert.throws(() => store.create({ name:'ok', cwd:project, harness:'claude' }), /already has an agent named ok/);
});

test('a Codex agent is linked to its session once Codex reports it, and found by that session', () => {
  const { data, project } = tempDirs();
  const store = agentStore(data);
  const agent = store.create({ name:'docs', cwd:project, harness:'codex' });
  assert.equal(agent.nativeId, '');
  assert.equal(store.forSession({ harness:'codex', nativeId:'' }), undefined, 'an unlinked agent matches no session');
  store.link(agent.id, 'thread-1');
  assert.equal(store.forSession({ harness:'codex', nativeId:'thread-1' })?.id, agent.id);
  assert.equal(store.forSession({ harness:'claude', nativeId:'thread-1' }), undefined, 'the harness must match too');
});

test('deleting an agent keeps its memory file; turning it off is remembered', () => {
  const { data, project } = tempDirs();
  const store = agentStore(data);
  const agent = store.create({ name:'ops', cwd:project, harness:'claude' });
  store.setEnabled(agent.id, false);
  assert.equal(agentStore(data).get(agent.id).enabled, false);
  assert.equal(store.remove(agent.id), true);
  assert.equal(store.get(agent.id), undefined);
  assert.ok(fs.existsSync(memoryFile(agent)), 'the memory file stays');
  const again = store.create({ name:'ops', cwd:project, harness:'claude' });
  assert.match(fs.readFileSync(memoryFile(again), 'utf8'), /^# Agent: ops/, 'a new agent with the old name reuses the old memory');
});

test('launch arguments carry the identity and the instructions for each harness', () => {
  const claude = { name:'backend', cwd:'/p', harness:'claude', nativeId:'11111111-1111-1111-1111-111111111111' };
  const fresh = launchArgs(claude, { resume:false });
  assert.deepEqual(fresh.slice(0, 4), ['--session-id', claude.nativeId, '--name', 'backend']);
  assert.ok(fresh.includes('--append-system-prompt') && fresh.includes('--autocompact'));
  assert.ok(!launchArgs(claude, { resume:true }).includes('--session-id'), 'a resumed session keeps its own ID');
  const [flag, setting] = launchArgs({ ...claude, harness:'codex' }, { resume:true });
  assert.equal(flag, '-c');
  assert.equal(JSON.parse(setting.slice('developer_instructions='.length)), instructions(claude));
  assert.match(instructions(claude), /\/p\/\.shed\/agents\/backend\.md/);
  assert.doesNotMatch(instructions(claude), /;/, 'the instructions use no semicolons (Simplified Technical English)');
});

test('agent state: off, new, asleep, or the live state of its session', () => {
  const agent = { enabled:true };
  assert.equal(agentState({ enabled:false }, { liveState:'working' }), 'off');
  assert.equal(agentState(agent, undefined), 'new');
  assert.equal(agentState(agent, { liveState:'history' }), 'asleep');
  assert.equal(agentState(agent, { liveState:'asking' }), 'asking');
});
