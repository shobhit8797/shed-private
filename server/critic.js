import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Critic: a second agent that questions the judgment of the agent doing a task. The critic is a named agent ("critic",
// one per project, read-only). During a task the worker may ask it with `shed ask critic`. After a worker's Shed task
// completes, Shed sends the critic a review request. Concerns go back to the worker as a follow-up, up to the round limit.
export const CRITIC_NAME = 'critic';
export const MAX_ROUNDS = 5;
export const DIFF_LIMIT = 30000;
const FRESH_WINDOW_MS = 600000; // A task that finished longer ago than this is never reviewed (so turning the critic on skips old tasks).
export const ANSWER_LIMIT_MS = 3600000; // A step with no answer after this ends the chain, so the worker can sleep and get later reviews.

export function prefs(saved = {}) {
  const rounds = Math.round(Number(saved.rounds ?? 2));
  return { enabled:saved.enabled === true, harness:['claude', 'codex'].includes(saved.harness) ? saved.harness : 'other', rounds:Number.isFinite(rounds) ? Math.max(0, Math.min(MAX_ROUNDS, rounds)) : 2 };
}
// A per-agent switch (true or false) beats the Critic setting. Only a worker has one; the critic never reviews itself.
export const enabledFor = (saved, agent) => agent?.name === CRITIC_NAME ? false : typeof agent?.critic === 'boolean' ? agent.critic : prefs(saved).enabled;
export const criticHarness = (saved, workerHarness) => { const p = prefs(saved); return p.harness === 'other' ? (workerHarness === 'claude' ? 'codex' : 'claude') : p.harness; };
// "No concerns." is the only answer that ends a review early.
export const noConcerns = reply => /^no concerns\.?$/i.test(String(reply || '').trim());

// Async so a large repository does not stop the server. The repository's own config must not run a command during a
// review, so fsmonitor, external diff tools and textconv are off.
const run = promisify(execFile);
const git = (cwd, args) => run('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], { encoding:'utf8', maxBuffer:50e6, timeout:15000 }).then(r => r.stdout, () => null);
const DIFF = ['diff', '--no-ext-diff', '--no-textconv'];
// The project's uncommitted changes and new files, or '' when it is not a git repository.
export async function changes(cwd) {
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return '';
  const stat = (await git(cwd, [...DIFF, 'HEAD', '--stat'])) ?? (await git(cwd, [...DIFF, '--stat'])) ?? '';
  const diff = (await git(cwd, [...DIFF, 'HEAD'])) ?? (await git(cwd, DIFF)) ?? '';
  // git diff leaves out untracked files, so a task that only added files would look like no work.
  const added = ((await git(cwd, ['ls-files', '--others', '--exclude-standard'])) ?? '').trim();
  return `\n\ngit diff --stat:\n${stat.trim() || '(no changes)'}${added ? `\n\nNew files, not in git diff (read them yourself):\n${added.slice(0, 4000)}` : ''}\n\ngit diff${diff.length > DIFF_LIMIT ? ` (cut at ${DIFF_LIMIT} of ${diff.length} characters)` : ''}:\n${diff.slice(0, DIFF_LIMIT) || '(no changes)'}`;
}

// Read by agents: Simplified Technical English.
export async function reviewRequest({ prompt, reply, cwd, round, max }) {
  return [
    `Review round ${round} of ${max}. Review the work of the agent that sent this message.`,
    `Task prompt:\n${String(prompt).trim().slice(0, 4000)}`,
    `The agent's final reply:\n${String(reply || '(no reply)').trim().slice(-6000)}`,
    `${(await changes(cwd)).trim() || 'This project is not a git repository, so there is no diff.'}`,
    'Question its decisions on architecture and implementation. Do not edit files.',
    'Answer with a numbered list of concerns. If you have no concerns, answer with exactly: No concerns.',
  ].join('\n\n');
}
export const concernsMessage = (reply, round, max) => [
  `The critic reviewed your work (round ${round} of ${max}) and has these concerns:`, String(reply).trim(),
  'Fix each concern, or reject it and give a reason. Then reply with one line for each concern: "fixed", or "rejected" and the reason.',
].join('\n\n');

export const workerNote = cli => [
  'A critic agent is on for this project. It questions your decisions.',
  `Before an architecture decision, and before a large implementation step, run: ${cli} ask critic "your question"`,
  'Put your plan and your reason in the question. Read the answer. Then fix the plan or give a reason to keep it.',
].join('\n');
export const criticNote = [
  'You are the critic. You review the work of other agents in this project. You are read-only: do not edit files.',
  'Question their decisions on architecture and implementation. Name the risk and the better option.',
  'Answer with a numbered list of concerns, or with exactly: No concerns.',
  'Your memory file keeps earlier reviews. Do not raise a concern again when the agent gave a good reason to reject it.',
].join('\n');
// Standing instructions and launch mode for an agent's window.
export function launchExtras(saved, agent, cli) {
  if (agent.name === CRITIC_NAME) return { extra:criticNote, readOnly:true };
  return enabledFor(saved, agent) ? { extra:workerNote(cli) } : {};
}

// deps: settings() current settings; agents (agentStore); tasks() list; sessions() list; exchanges (exchangeStore);
// send({ kind, from, to, message, title }) starts an exchange; sync() follows exchange replies; save() saves tasks.
export function criticEngine({ dataDir, settings, agents, tasks, sessions, exchanges, send, sync = () => {}, save = () => {}, log = console.error }) {
  const file = path.join(dataDir, 'critic.json');
  let chains = [];
  try { chains = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { chains = []; }
  const persist = () => fs.writeFileSync(file, JSON.stringify(chains.slice(-50)), { mode:0o600 });
  const finish = (chain, why) => { Object.assign(chain, { done:true, ended:why }); persist(); };

  // The critic of the worker's project: made on first need. Null when it is off or the worker is the critic.
  // A real session is returned for an existing critic (open or asleep: a message wakes it), otherwise a stand-in marked `fresh`.
  function target(worker) {
    const own = agents.forSession(worker);
    if (own?.name === CRITIC_NAME || !worker.cwd) return null;
    let agent = agents.all().find(a => a.cwd === worker.cwd && a.name === CRITIC_NAME);
    agent ||= agents.create({ name:CRITIC_NAME, cwd:worker.cwd, harness:criticHarness(settings().critic, worker.harness) });
    if (!agent.enabled) return null;
    const session = sessions().find(s => agents.forSession(s)?.id === agent.id);
    return session ? { ...session, liveState:'open', agent }
      : { id:`${agent.harness}:${agent.nativeId || agent.id}`, harness:agent.harness, cwd:agent.cwd, title:CRITIC_NAME, liveState:'open', fresh:true, agent };
  }
  // True while a review waits on this worker, so the sleep sweep leaves it open.
  const holds = sessionId => chains.some(c => !c.done && c.worker === sessionId);

  async function review(chain, worker, reply) {
    const critic = target(worker);
    if (!critic) return finish(chain, 'no critic');
    const { exchange } = await send({ kind:'review', from:worker, to:critic, message:await reviewRequest({ prompt:chain.prompt, reply, cwd:chain.cwd, round:chain.round, max:chain.max }), title:`review ${chain.round}/${chain.max}` });
    Object.assign(chain, { phase:'review', exchangeId:exchange.id }); persist();
  }
  async function advance(chain) {
    const x = exchanges.get(chain.exchangeId);
    if (!x || x.status === 'failed') return finish(chain, x?.error || 'exchange lost');
    if (x.status !== 'answered') {
      if (Date.now() - Date.parse(x.createdAt) > ANSWER_LIMIT_MS) finish(chain, 'no answer in an hour');
      return;
    }
    const worker = sessions().find(s => s.id === chain.worker);
    if (!worker) return finish(chain, 'worker gone');
    if (chain.phase === 'review') {
      if (noConcerns(x.reply)) return finish(chain, 'no concerns');
      const critic = target(worker);
      if (!critic) return finish(chain, 'no critic');
      // The worker always gets the concerns, even in the last round.
      const { exchange } = await send({ kind:'review', from:critic, to:worker, message:concernsMessage(x.reply, chain.round, chain.max), title:`concerns ${chain.round}/${chain.max}` });
      Object.assign(chain, { phase:'fix', exchangeId:exchange.id }); persist();
    } else if (chain.round >= chain.max) finish(chain, 'round limit');
    else { chain.round++; await review(chain, worker, x.reply); }
  }
  const fresh = task => task.status === 'completed' && !task.criticSeen && !task.exchangeId && !task.exchangeKind && task.agentName !== CRITIC_NAME
    && ['claude', 'codex'].includes(task.harness) && task.sessionId && Date.now() - Date.parse(task.updatedAt) < FRESH_WINDOW_MS;
  async function begin(task) {
    const worker = sessions().find(s => s.id === task.sessionId);
    if (!worker || holds(worker.id)) return; // Tried again on a later sweep while the task is still recent.
    task.criticSeen = true; save();
    const agent = agents.forSession(worker), max = prefs(settings().critic).rounds;
    if (!enabledFor(settings().critic, agent) || (agent && !agent.enabled) || max < 1) return;
    const chain = { id:task.id, worker:worker.id, cwd:worker.cwd, prompt:task.prompt, round:1, max, phase:'review', exchangeId:'', done:false };
    chains.push(chain);
    await review(chain, worker, task.output);
  }

  let busy = false;
  return {
    target, holds, chains:() => chains,
    async sweep() {
      if (busy) return;
      busy = true;
      try {
        sync();
        for (const chain of chains.filter(c => !c.done)) await advance(chain).catch(error => { log(`Critic: ${error.message}`); finish(chain, error.message); });
        for (const task of tasks().filter(fresh)) await begin(task).catch(error => { log(`Critic: ${error.message}`); const c = chains.find(x => x.id === task.id); if (c) finish(c, error.message); });
      } finally { busy = false; }
    },
  };
}
