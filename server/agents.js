import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ignoreInGit } from './uploads.js';

// Named agents: a lasting identity (a name in a project, on one harness, tied to one native session) that Shed wakes
// in a Terminal window for each message and ends once its task is done and it needs nothing from the person.
// The session ID is kept, so the next message resumes the same conversation. The agent keeps its decisions in
// <project>/.shed/agents/<name>.md and reads that file only when it needs earlier context.
export const AGENT_HARNESSES = ['claude', 'codex'];
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
// How long an agent must sit idle (no Shed task, not asking anything) before it is ended, so a reply that is still
// being written, or a person typing at the Mac, is not cut off.
export const SLEEP_AFTER_MS = 30000;

export const memoryFile = agent => path.join(agent.cwd, '.shed', 'agents', `${agent.name}.md`);

// Read by the agent, not by a person: written in Simplified Technical English (strict) so it has one reading.
export function instructions(agent, extra = '') {
  const file = memoryFile(agent);
  return [
    `You are the Shed agent "${agent.name}". Your project is ${agent.cwd}.`,
    'Shed starts you when a message comes in. Shed stops you when you finish a task and need no input.',
    'Shed keeps your conversation and resumes it for the next message.',
    `Your memory file is ${file}. It records your decisions for this project.`,
    '',
    'Rules:',
    '1. Do not read the memory file at the start of each task.',
    '2. Read the memory file only when you need earlier context:',
    '   - Your context does not contain the earlier work.',
    '   - The user refers to earlier work.',
    '   - You are not sure about an earlier decision.',
    '3. Search the memory file for a keyword first. Read the full file only when the search does not give the answer.',
    '4. At the end of each task, add one entry at the end of the "## Log" section.',
    '5. Use this format for each entry:',
    '   ### <date> <short task title>',
    '   - Decisions: <what you decided>',
    '   - Reasons: <why you decided it>',
    '   - Changes: <the files and commands that you changed or used>',
    '   - Open items: <the work that is not complete, or "None">',
    '6. Keep each entry to 10 lines or fewer.',
    '7. When the log has more than 40 entries, move the oldest entries into short points in the "## Summary" section.',
    '8. Do not copy the memory file into your replies.',
    ...(extra ? ['', extra] : []),
  ].join('\n');
}

// Extra command-line arguments for a new or resumed agent window. The instructions go in on every launch: Claude
// records them once per conversation and renders them again after a compaction, so they survive it.
// `extra` adds standing instructions. `readOnly` starts the agent unable to edit (the critic): Claude in plan mode, Codex in a read-only sandbox.
export function launchArgs(agent, { resume, extra = '', readOnly = false }) {
  const text = instructions(agent, extra);
  if (agent.harness === 'claude') return [...(resume ? [] : ['--session-id', agent.nativeId, '--name', agent.name]), ...(readOnly ? ['--permission-mode', 'plan'] : []), '--append-system-prompt', text, '--autocompact', 'auto'];
  // Codex parses the value as TOML; a JSON string is also a valid TOML basic string.
  return [...(readOnly ? ['-s', 'read-only'] : []), '-c', `developer_instructions=${JSON.stringify(text)}`];
}

// What a page shows for an agent: off, new (no conversation yet), asleep (no process), or its live state.
export function agentState(agent, session) {
  if (!agent.enabled) return 'off';
  if (!session) return 'new';
  return session.liveState === 'history' ? 'asleep' : session.liveState;
}

function createMemoryFile(agent) {
  const file = memoryFile(agent);
  if (fs.existsSync(file)) return; // An agent made again with an old name keeps its memory.
  fs.mkdirSync(path.dirname(file), { recursive:true });
  ignoreInGit(agent.cwd);
  fs.writeFileSync(file, `# Agent: ${agent.name}\n\nProject: ${agent.cwd}\nHarness: ${agent.harness}\nCreated: ${agent.createdAt.slice(0, 10)}\n\n## Summary\n\nNone yet.\n\n## Log\n`);
}

export function agentStore(dataDir) {
  const file = path.join(dataDir, 'agents.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  const save = () => fs.writeFileSync(file, JSON.stringify(list), { mode:0o600 });
  return {
    all:() => list,
    get:id => list.find(agent => agent.id === id),
    forSession:session => session ? list.find(agent => agent.harness === session.harness && agent.nativeId && agent.nativeId === session.nativeId) : undefined,
    create({ name, cwd, harness, account }) {
      if (!AGENT_NAME.test(name)) throw new Error('Agent names must be 1–40 lowercase letters, numbers, or dashes, and start with a letter or number.');
      if (!AGENT_HARNESSES.includes(harness)) throw new Error('Agents run in Claude Code or Codex. Choose one of them.');
      if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('The agent’s project folder does not exist.');
      if (list.some(agent => agent.cwd === cwd && agent.name === name)) throw new Error(`This project already has an agent named ${name}.`);
      // Claude takes the session ID from Shed (--session-id). Codex makes its own, and Shed links it once it is known.
      const agent = { id:crypto.randomUUID(), name, cwd, harness, nativeId:harness === 'claude' ? crypto.randomUUID() : '', enabled:true, ...(account ? { account } : {}), createdAt:new Date().toISOString() };
      createMemoryFile(agent);
      list.push(agent); save();
      return agent;
    },
    link(id, nativeId) {
      const agent = list.find(a => a.id === id);
      if (!agent || !nativeId || agent.nativeId === nativeId) return;
      agent.nativeId = nativeId; save();
    },
    setEnabled(id, enabled) {
      const agent = list.find(a => a.id === id);
      if (agent) { agent.enabled = Boolean(enabled); save(); }
      return agent;
    },
    // The critic override for one agent: true (on), false (off) or null (follow the Critic setting).
    setCritic(id, value) {
      const agent = list.find(a => a.id === id);
      if (agent) { if (typeof value === 'boolean') agent.critic = value; else delete agent.critic; save(); }
      return agent;
    },
    // Forgets the agent only. Its conversation and its memory file stay on disk.
    remove(id) {
      const before = list.length;
      list = list.filter(agent => agent.id !== id); save();
      return list.length < before;
    },
  };
}
