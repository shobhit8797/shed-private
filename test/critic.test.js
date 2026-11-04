import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { criticEngine, prefs, enabledFor, criticHarness, noConcerns, reviewRequest, launchExtras, DIFF_LIMIT } from '../server/critic.js';
import { agentStore, launchArgs } from '../server/agents.js';
import { exchangeStore } from '../server/exchanges.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'critic-'));

// A fake Shed: sessions, tasks and a send() that records the message; answer(n, text) plays the other agent.
function rig({ settings = { critic:{ enabled:true, rounds:2 } }, harness = 'claude', agentOverride } = {}) {
  const dataDir = tmp(), cwd = tmp();
  const agents = agentStore(dataDir), exchanges = exchangeStore(dataDir);
  const sessionsList = [{ id:`${harness}:w`, harness, nativeId:'w', cwd, liveState:'open' }];
  const tasks = [{ id:'t1', status:'completed', harness, sessionId:`${harness}:w`, prompt:'Add login', output:'Done.', updatedAt:new Date().toISOString() }];
  const sent = [];
  const engine = criticEngine({ dataDir, settings:() => settings, agents, tasks:() => tasks, sessions:() => sessionsList, exchanges,
    send:async ({ kind, from, to, message }) => { const exchange = exchanges.add({ id:`x${sent.length}`, kind, from:from.id, to:to.id, message, status:'waiting', createdAt:new Date().toISOString() }); sent.push({ kind, from, to, message }); return { exchange }; } });
  const answer = (n, reply) => Object.assign(exchanges.get(`x${n}`), { status:'answered', reply });
  if (agentOverride !== undefined) { const w = agents.create({ name:'worker', cwd, harness }); agents.link(w.id, 'w'); agents.setCritic(w.id, agentOverride); }
  return { engine, exchanges, sent, answer, agents, tasks, cwd, settings };
}

test('settings: off by default, rounds clamp to 0-5, harness defaults to the other one', () => {
  assert.deepEqual(prefs(), { enabled:false, harness:'other', rounds:2 });
  assert.equal(prefs({ rounds:9 }).rounds, 5);
  assert.equal(prefs({ rounds:-3 }).rounds, 0);
  assert.equal(prefs({ harness:'bogus' }).harness, 'other');
  assert.equal(criticHarness({}, 'claude'), 'codex');
  assert.equal(criticHarness({}, 'codex'), 'claude');
  assert.equal(criticHarness({ harness:'claude' }, 'claude'), 'claude');
});

test('per-agent override beats the setting, and the critic is never a worker', () => {
  assert.equal(enabledFor({ enabled:false }, {}), false);
  assert.equal(enabledFor({ enabled:false }, { critic:true }), true);
  assert.equal(enabledFor({ enabled:true }, { critic:false }), false);
  assert.equal(enabledFor({ enabled:true }, { name:'critic' }), false);
});

test('"No concerns." ends a review', () => {
  assert.ok(noConcerns(' No concerns.\n'));
  assert.ok(!noConcerns('1. No tests.'));
});

test('a completed task starts round 1; the critic is made read-only in its own project', async () => {
  const { engine, sent, agents, cwd } = rig();
  await engine.sweep();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'review');
  assert.match(sent[0].message, /Add login/);
  assert.match(sent[0].message, /Done\./);
  const critic = agents.all().find(a => a.name === 'critic');
  assert.equal(critic.cwd, cwd);
  assert.equal(critic.harness, 'codex'); // the other harness
  assert.ok(sent[0].to.fresh);
  assert.deepEqual(launchArgs(critic, { resume:false, readOnly:true }).slice(0, 2), ['-s', 'read-only']);
  const claudeCritic = { name:'critic', harness:'claude', nativeId:'n', cwd };
  assert.ok(launchArgs(claudeCritic, { resume:false, readOnly:true }).join(' ').includes('--permission-mode plan'));
  assert.ok(engine.holds('claude:w'));
  await engine.sweep(); // The same task is not reviewed twice.
  assert.equal(sent.length, 1);
});

test('concerns go to the worker, then the worker reply is reviewed again, until the round limit', async () => {
  const { engine, sent, answer } = rig({ settings:{ critic:{ enabled:true, rounds:2 } } });
  await engine.sweep();
  answer(0, '1. No tests.');
  await engine.sweep();
  assert.equal(sent.length, 2);
  assert.match(sent[1].message, /1\. No tests\./);
  assert.match(sent[1].message, /Fix each concern/);
  assert.equal(sent[1].to.id, 'claude:w');
  answer(1, 'fixed');
  await engine.sweep();
  assert.equal(sent.length, 3); // round 2 review
  assert.match(sent[2].message, /Review round 2 of 2/);
  answer(2, '1. Still no docs.');
  await engine.sweep();
  assert.equal(sent.length, 4); // the worker still gets the last concerns
  answer(3, 'fixed');
  await engine.sweep();
  assert.equal(sent.length, 4); // limit reached: no round 3
  assert.equal(engine.holds('claude:w'), false);
  assert.equal(engine.chains()[0].ended, 'round limit');
});

test('"No concerns." stops the rounds early', async () => {
  const { engine, sent, answer } = rig();
  await engine.sweep();
  answer(0, 'No concerns.');
  await engine.sweep();
  assert.equal(sent.length, 1);
  assert.equal(engine.holds('claude:w'), false);
});

test('a failed exchange ends the chain', async () => {
  const { engine, exchanges } = rig();
  await engine.sweep();
  Object.assign(exchanges.get('x0'), { status:'failed', error:'lost' });
  await engine.sweep();
  assert.equal(engine.holds('claude:w'), false);
});

test('off setting, zero rounds, a disabled worker, and the critic itself start no rounds', async () => {
  let r = rig({ settings:{ critic:{ enabled:false } } }); await r.engine.sweep(); assert.equal(r.sent.length, 0);
  r = rig({ settings:{ critic:{ enabled:true, rounds:0 } } }); await r.engine.sweep(); assert.equal(r.sent.length, 0);
  r = rig({ settings:{ critic:{ enabled:true } }, agentOverride:false }); await r.engine.sweep(); assert.equal(r.sent.length, 0);
  r = rig({ settings:{ critic:{ enabled:false } }, agentOverride:true }); await r.engine.sweep(); assert.equal(r.sent.length, 1);
  r = rig(); r.agents.setEnabled(r.agents.create({ name:'worker', cwd:r.cwd, harness:'claude' }).id, false);
  r.agents.link(r.agents.all()[0].id, 'w'); await r.engine.sweep(); assert.equal(r.sent.length, 0);
  r = rig(); const c = r.agents.create({ name:'critic', cwd:r.cwd, harness:'claude' }); r.agents.link(c.id, 'w');
  await r.engine.sweep(); assert.equal(r.sent.length, 0); // the session "w" is the critic's own
  r = rig(); r.agents.create({ name:'critic', cwd:r.cwd, harness:'codex' }); r.agents.setEnabled(r.agents.all()[0].id, false);
  await r.engine.sweep(); assert.equal(r.sent.length, 0); // a turned-off critic
});

test('old tasks and tasks of exchanges are not reviewed', async () => {
  const r = rig();
  r.tasks[0].updatedAt = new Date(Date.now() - 3600000).toISOString();
  r.tasks.push({ ...r.tasks[0], id:'t2', updatedAt:new Date().toISOString(), exchangeKind:'ask' });
  await r.engine.sweep();
  assert.equal(r.sent.length, 0);
});

test('review request carries a size-limited diff in a git repository only', () => {
  const dir = tmp();
  assert.match(reviewRequest({ prompt:'p', reply:'r', cwd:dir, round:1, max:2 }), /not a git repository/);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(DIFF_LIMIT * 2));
  const text = reviewRequest({ prompt:'p', reply:'r', cwd:dir, round:1, max:2 });
  assert.match(text, /a\.txt \|/);
  assert.match(text, /cut at/);
  assert.ok(text.length < DIFF_LIMIT + 3000);
});

test('worker and critic get their standing instructions', () => {
  assert.match(launchExtras({ enabled:true }, { name:'w' }, 'shed').extra, /shed ask critic/);
  assert.deepEqual(launchExtras({ enabled:false }, { name:'w' }, 'shed'), {});
  assert.equal(launchExtras({ enabled:true }, { name:'critic' }, 'shed').readOnly, true);
});
