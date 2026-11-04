import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-accounts-'));
process.env.SHED_ACCOUNTS_DIR = root;
process.env.SHED_ZSHRC = path.join(root, 'zshrc');
const accounts = await import('../server/accounts.js');
const { terminalCommand } = await import('../server/terminal.js');
const { accountSessions } = await import('../server/sessions.js');

test('ids, names and defaults', () => {
  assert.deepEqual(accounts.listAccounts().filter(a => a.name === 'default').map(a => [a.id, a.alias]), [['claude:default', 'claude'], ['codex:default', 'codex']]);
  const work = accounts.addAccount({ harness:'claude', name:'work' });
  assert.equal(work.id, 'claude:work');
  assert.equal(work.alias, 'claude-work');
  assert.equal(work.configDir, path.join(root, 'claude', 'work'));
  assert.ok(fs.statSync(work.configDir).isDirectory());
  for (const name of ['', 'Work', 'a b', 'x'.repeat(31), '../x', 'default']) assert.throws(() => accounts.addAccount({ harness:'claude', name }), name);
  assert.throws(() => accounts.addAccount({ harness:'gemini', name:'x' }));
  assert.throws(() => accounts.addAccount({ harness:'claude', name:'work' }), /already/);
  assert.throws(() => accounts.removeAccount('claude:default'));
});

test('the default account sets no variable; an added one sets only its own', () => {
  assert.deepEqual(accounts.accountEnv(accounts.getAccount('codex:default')), {});
  assert.deepEqual(accounts.accountEnv(accounts.getAccount('claude:work')), { CLAUDE_CONFIG_DIR:path.join(root, 'claude', 'work') });
  assert.equal(accounts.accountFor('codex', 'claude:work').id, 'codex:default', 'an account of another harness is ignored');
});

test('the Terminal command carries the variable for that command only, quoted', () => {
  assert.equal(terminalCommand('/p', ['claude', '--resume', 'abc']), "cd '/p' && 'claude' '--resume' 'abc'");
  const command = terminalCommand("/my dir", ['codex'], '/tmp/p.txt', { CODEX_HOME:"/Users/o'brien/a b" });
  assert.equal(command, `cd '/my dir' && CODEX_HOME='/Users/o'\\''brien/a b' 'codex' "$(cat '/tmp/p.txt'; rm -f '/tmp/p.txt')"`);
});

test('sessions are marked with the account whose folder holds the transcript', () => {
  const dirs = ['claude:default', 'claude:work'].map(id => ({ id, harness:'claude', name:id.split(':')[1], configDir:fs.mkdtempSync(path.join(root, 'cfg-')) }));
  dirs.forEach((a, i) => {
    const project = path.join(transcriptDirOf(a), 'proj');
    fs.mkdirSync(project, { recursive:true });
    fs.writeFileSync(path.join(project, `s${i}.jsonl`), JSON.stringify({ type:'user', sessionId:`id-${i}`, cwd:'/x', message:{ content:'Please build the thing' } }) + '\n');
  });
  const found = accountSessions(dirs);
  assert.deepEqual(found.map(s => [s.nativeId, s.account]).sort(), [['id-0', 'claude:default'], ['id-1', 'claude:work']]);
});
const transcriptDirOf = a => path.join(a.configDir, 'projects');

test('aliases file lists each added account; the zshrc line is added once', () => {
  accounts.addAccount({ harness:'codex', name:'personal' });
  const text = fs.readFileSync(accounts.aliasesFile(), 'utf8');
  assert.match(text, new RegExp(`alias claude-work='CLAUDE_CONFIG_DIR="${path.join(root, 'claude', 'work')}" claude'`));
  assert.match(text, /alias codex-personal='CODEX_HOME=".*codex\/personal" codex'/);
  assert.equal(accounts.inZshrc(), false);
  fs.writeFileSync(process.env.SHED_ZSHRC, 'export A=1');
  assert.equal(accounts.addToZshrc().added, true);
  assert.equal(accounts.addToZshrc().added, false);
  const rc = fs.readFileSync(process.env.SHED_ZSHRC, 'utf8');
  assert.equal(rc.split(accounts.sourceLine()).length - 1, 1);
  assert.ok(rc.startsWith('export A=1\n'));
  accounts.removeAccount('claude:work');
  assert.ok(fs.existsSync(path.join(root, 'claude', 'work')), 'the folder stays');
  assert.doesNotMatch(fs.readFileSync(accounts.aliasesFile(), 'utf8'), /claude-work/);
});

test('prototype keys are not harnesses, and a bad registry reads as no added accounts', () => {
  for (const harness of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.throws(() => accounts.addAccount({ harness, name:'x' }), /Claude Code or Codex/);
  const file = path.join(root, 'accounts.json'), saved = fs.readFileSync(file, 'utf8');
  const ids = () => accounts.listAccounts().map(a => a.id);
  try {
    fs.writeFileSync(file, JSON.stringify([{ harness:'constructor', name:'x' }, { harness:'claude' }]));
    assert.deepEqual(ids(), ['claude:default', 'codex:default'], 'a saved prototype key or a missing name is skipped');
    fs.writeFileSync(file, '{"harness":"claude","name":"x"}');
    assert.deepEqual(ids(), ['claude:default', 'codex:default'], 'a registry that is not a list does not throw');
  } finally { fs.writeFileSync(file, saved); }
});

test('aliases under the home folder use $HOME', () => {
  const dir = path.join(os.homedir(), '.shed', 'accounts', 'claude', 'work');
  assert.match(accounts.aliasesText([{ harness:'claude', alias:'claude-work', configDir:dir }]), /alias claude-work='CLAUDE_CONFIG_DIR="\$HOME\/\.shed\/accounts\/claude\/work" claude'/);
});
