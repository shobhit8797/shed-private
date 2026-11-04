import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

// Phone access over Tailscale. `tailscale serve` publishes Shed to this person's tailnet only (never Funnel), at
// https://<this Mac>.<tailnet>.ts.net:8443 with a real certificate. A phone with the Tailscale app on connects straight
// to the Mac over WireGuard when the two networks allow it, and through Tailscale's encrypted relays otherwise.
// Shed only adds or removes its own handler on that port; it never touches other serve or Funnel settings.
export const TAILSCALE_HTTPS_PORT = 8443;
const BINARIES = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function findTailscale() {
  const found = spawnSync('which', ['tailscale'], { encoding:'utf8' }).stdout?.trim();
  return found || BINARIES.find(file => fs.existsSync(file)) || '';
}

function run(bin, args, timeout = 15000) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio:['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', error => { clearTimeout(timer); resolve({ code:-1, out, err:error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
const json = text => { try { return JSON.parse(text); } catch { return null; } };

// Reads `tailscale status --json` and `tailscale serve status --json` into what Shed needs to know.
export function readTailscale(status, serve, { shedPort, httpsPort = TAILSCALE_HTTPS_PORT }) {
  const host = String(status?.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
  const running = status?.BackendState === 'Running';
  const certificates = Array.isArray(status?.CertDomains) && status.CertDomains.map(d => String(d).toLowerCase()).includes(host);
  const key = `${host}:${httpsPort}`;
  const proxy = String(serve?.Web?.[key]?.Handlers?.['/']?.Proxy || '');
  const ours = `http://127.0.0.1:${shedPort}`;
  const serving = Boolean(serve?.TCP?.[httpsPort]?.HTTPS) && proxy === ours;
  const funnel = Boolean(serve?.AllowFunnel?.[key]);
  const portTaken = Boolean(serve?.TCP?.[httpsPort]) && !serving;
  const url = running && serving && !funnel && HOST.test(host) ? `https://${host}:${httpsPort}` : '';
  const problem = !running ? 'Tailscale is not connected. Open Tailscale on this Mac and sign in.'
    : !host ? 'Tailscale did not report a name for this Mac. Turn on MagicDNS in the Tailscale admin console (DNS page).'
    : !certificates ? 'HTTPS certificates are off for your tailnet. Turn on HTTPS Certificates in the Tailscale admin console (DNS page).'
    : funnel ? `Tailscale Funnel is on for port ${httpsPort}, so Shed would be public on the internet. Run: tailscale funnel --https=${httpsPort} off`
    : portTaken ? `Port ${httpsPort} on Tailscale already serves ${proxy || 'something else'}. Shed does not replace it.`
    : '';
  return { installed:true, running, host, certificates, serving, funnel, portTaken, httpsPort, url, problem };
}

export async function tailscaleStatus({ shedPort, httpsPort = TAILSCALE_HTTPS_PORT }) {
  const bin = findTailscale();
  if (!bin) return { installed:false, serving:false, url:'', httpsPort, problem:'Tailscale is not installed on this Mac. Install it from tailscale.com/download and sign in.' };
  const [status, serve] = await Promise.all([run(bin, ['status', '--json']), run(bin, ['serve', 'status', '--json'])]);
  return readTailscale(json(status.out), json(serve.out) || {}, { shedPort, httpsPort });
}

// Adds Shed's handler (tailnet only). Turning Shed off removes that one handler and nothing else.
export async function publish({ shedPort, httpsPort = TAILSCALE_HTTPS_PORT }) {
  const now = await tailscaleStatus({ shedPort, httpsPort });
  if (now.serving && !now.funnel) return now;
  if (!now.installed || now.problem) throw new Error(now.problem);
  const result = await run(findTailscale(), ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${shedPort}`], 60000);
  if (result.code !== 0) throw new Error(`Tailscale did not publish Shed: ${(result.err || result.out).trim().slice(0, 300) || `exit code ${result.code}`}`);
  return tailscaleStatus({ shedPort, httpsPort });
}

export async function unpublish({ shedPort, httpsPort = TAILSCALE_HTTPS_PORT }) {
  const now = await tailscaleStatus({ shedPort, httpsPort });
  if (!now.serving) return now;
  const result = await run(findTailscale(), ['serve', `--https=${httpsPort}`, 'off']);
  if (result.code !== 0) throw new Error(`Tailscale did not remove Shed: ${(result.err || result.out).trim().slice(0, 300) || `exit code ${result.code}`}`);
  return tailscaleStatus({ shedPort, httpsPort });
}
