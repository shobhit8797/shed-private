import test from 'node:test';
import assert from 'node:assert/strict';
import { readTailscale } from '../server/tailscale.js';

const host = 'mac.tail1234.ts.net';
const status = { BackendState:'Running', Self:{ DNSName:`${host}.` }, CertDomains:[host] };
const serving = port => ({ TCP:{ 8443:{ HTTPS:true } }, Web:{ [`${host}:8443`]:{ Handlers:{ '/':{ Proxy:`http://127.0.0.1:${port}` } } } } });

test('Shed served on the tailnet gives a stable https address', () => {
  const result = readTailscale(status, serving(4379), { shedPort:4379 });
  assert.equal(result.url, `https://${host}:8443`);
  assert.equal(result.problem, '');
});

test('Shed is not served yet: no address and no problem, so it can be published', () => {
  const result = readTailscale(status, {}, { shedPort:4379 });
  assert.equal(result.serving, false);
  assert.equal(result.url, '');
  assert.equal(result.problem, '');
});

test('Funnel on the port would make Shed public, so there is no address', () => {
  const result = readTailscale(status, { ...serving(4379), AllowFunnel:{ [`${host}:8443`]:true } }, { shedPort:4379 });
  assert.equal(result.url, '');
  assert.match(result.problem, /Funnel/);
});

test('a port that serves something else is not replaced', () => {
  const result = readTailscale(status, serving(18080), { shedPort:4379 });
  assert.equal(result.portTaken, true);
  assert.match(result.problem, /already serves http:\/\/127\.0\.0\.1:18080/);
});

test('Tailscale signed out, or without HTTPS certificates, explains what to do', () => {
  assert.match(readTailscale({ ...status, BackendState:'NeedsLogin' }, {}, { shedPort:4379 }).problem, /not connected/);
  assert.match(readTailscale({ ...status, CertDomains:[] }, {}, { shedPort:4379 }).problem, /HTTPS certificates/);
});
