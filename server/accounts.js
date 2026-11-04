import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe } from './health.js';

// Accounts: several logins of Claude Code or Codex on one Mac. Each account is a config folder that the CLI reads
// from an environment variable. Shed sets that variable for one command only, never for the whole Mac.
// { id:'<harness>:<name>', harness, name, configDir, alias }. "<harness>:default" is the normal folder.
export const ACCOUNT_HARNESSES = { claude:{ env:'CLAUDE_CONFIG_DIR', folder:'.claude', sessions:'projects' }, codex:{ env:'CODEX_HOME', folder:'.codex', sessions:'sessions' } };
export const ACCOUNT_NAME = /^[a-z0-9-]{1,30}$/;

// The root is configurable so tests never touch ~/.shed.
export const accountsRoot = () => process.env.SHED_ACCOUNTS_DIR || path.join(os.homedir(), '.shed', 'accounts');
const registryFile = () => path.join(accountsRoot(), 'accounts.json');
export const aliasesFile = () => path.join(accountsRoot(), 'aliases.sh');

const withAlias = a => ({ ...a, alias:a.name === 'default' ? a.harness : `${a.harness}-${a.name}` });
function defaultAccount(harness) {
  return withAlias({ id:`${harness}:default`, harness, name:'default', configDir:path.join(os.homedir(), ACCOUNT_HARNESSES[harness].folder) });
}
function addedAccounts() {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(registryFile(), 'utf8')); } catch { return []; }
  return rows.filter(r => ACCOUNT_HARNESSES[r?.harness] && ACCOUNT_NAME.test(r.name) && r.name !== 'default')
    .map(r => withAlias({ id:`${r.harness}:${r.name}`, harness:r.harness, name:r.name, configDir:path.join(accountsRoot(), r.harness, r.name) }));
}

export const listAccounts = () => [...Object.keys(ACCOUNT_HARNESSES).map(defaultAccount), ...addedAccounts()];
export const getAccount = id => listAccounts().find(a => a.id === id);
// The account a launch uses: the requested one when it belongs to that harness, else the harness default.
export const accountFor = (harness, id) => { const a = id && getAccount(id); return a && a.harness === harness ? a : getAccount(`${harness}:default`); };

// The default account sets nothing, so a user with no added accounts runs exactly as before.
export const accountEnv = account => account && account.name !== 'default' ? { [ACCOUNT_HARNESSES[account.harness].env]:account.configDir } : {};

export function addAccount({ harness, name }) {
  if (!ACCOUNT_HARNESSES[harness]) throw new Error('Accounts are for Claude Code or Codex. Choose one of them.');
  if (typeof name !== 'string' || !ACCOUNT_NAME.test(name)) throw new Error('Account names must be 1–30 lowercase letters, numbers, or dashes.');
  if (name === 'default') throw new Error('The name "default" is for the normal account. Choose another name.');
  const account = withAlias({ id:`${harness}:${name}`, harness, name, configDir:path.join(accountsRoot(), harness, name) });
  if (getAccount(account.id)) throw new Error(`There is already an account named ${name} for ${harness}.`);
  fs.mkdirSync(account.configDir, { recursive:true, mode:0o700 });
  saveRegistry([...addedAccounts(), account]);
  return account;
}
// Forgets the account only. Its folder holds transcripts and stays on disk.
export function removeAccount(id) {
  const found = addedAccounts().find(a => a.id === id);
  if (!found) throw new Error(id.endsWith(':default') ? 'The default account cannot be removed.' : 'Account not found.');
  saveRegistry(addedAccounts().filter(a => a.id !== id));
}
function saveRegistry(list) {
  fs.mkdirSync(accountsRoot(), { recursive:true, mode:0o700 });
  fs.writeFileSync(registryFile(), JSON.stringify(list.map(a => ({ harness:a.harness, name:a.name }))), { mode:0o600 });
  writeAliases();
}

// Where an account keeps its transcripts, for session discovery.
export const transcriptDir = account => path.join(account.configDir, ACCOUNT_HARNESSES[account.harness].sessions);

// Aliases for the added accounts. Paths under the home folder are written with $HOME so the file survives a move.
const inDouble = value => value.replace(/[\\"$`]/g, '\\$&');
export function aliasesText(accounts = addedAccounts()) {
  const home = os.homedir();
  const lines = accounts.map(a => {
    const dir = a.configDir.startsWith(home + path.sep) ? `$HOME${inDouble(a.configDir.slice(home.length))}` : inDouble(a.configDir);
    return `alias ${a.alias}='${ACCOUNT_HARNESSES[a.harness].env}="${dir}" ${a.harness}'`;
  });
  return `# Written by Shed. Do not edit: Shed rewrites this file when accounts change.\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}
export function writeAliases() {
  fs.mkdirSync(accountsRoot(), { recursive:true, mode:0o700 });
  fs.writeFileSync(aliasesFile(), aliasesText());
}
export const sourceLine = () => {
  const file = aliasesFile(), home = os.homedir();
  return `source ${file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file}`;
};
export const zshrcPath = () => process.env.SHED_ZSHRC || path.join(os.homedir(), '.zshrc');
export const inZshrc = (zshrc = zshrcPath()) => {
  try { return fs.readFileSync(zshrc, 'utf8').split('\n').some(line => line.trim() === sourceLine()); } catch { return false; }
};
// Only the Settings button calls this. Adds the line once, and never changes the rest of the file.
export function addToZshrc(zshrc = zshrcPath()) {
  if (inZshrc(zshrc)) return { added:false };
  writeAliases();
  let text = '';
  try { text = fs.readFileSync(zshrc, 'utf8'); } catch {}
  fs.appendFileSync(zshrc, `${text && !text.endsWith('\n') ? '\n' : ''}# Shed accounts\n${sourceLine()}\n`);
  return { added:true };
}

// Sign-in state per account, from the harness's own check run in that account's folder. The default account reuses
// the existing snapshot. Results are kept for 30 seconds.
const loginCache = new Map();
export async function accountStatus(harnessSnapshot = {}) {
  return Promise.all(listAccounts().map(async a => {
    let loggedIn;
    if (a.name === 'default') loggedIn = harnessSnapshot[a.harness]?.state === 'ready';
    else {
      const hit = loginCache.get(a.id);
      if (hit && Date.now() - hit.at < 30000) loggedIn = hit.loggedIn;
      else {
        loggedIn = (await probe(a.harness, accountEnv(a))).state === 'ready';
        loginCache.set(a.id, { at:Date.now(), loggedIn });
      }
    }
    return { id:a.id, harness:a.harness, name:a.name, alias:a.alias, loggedIn };
  }));
}
export const forgetLoginState = id => loginCache.delete(id);
