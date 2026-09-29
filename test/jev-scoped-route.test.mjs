import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openPort } from './port-pool.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const callerKey = 'test-router-caller-capability-with-sufficient-length';

function postWithHost(url, host, headers, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST',
      headers: { ...headers, host } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('a scoped ticket reaches only the Jev route and cannot select another model', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'jev-scoped-router-'));
  writeFileSync(path.join(stateDir, 'enabled-providers.json'),
    JSON.stringify({ version: 1, providers: ['openrouter-jev-campaign'] }));
  const forwarded = [];
  const api = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    forwarded.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"answers":{"keep":{"noul":1}}}');
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const apiPort = api.address().port;
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, 'src', 'router.mjs')], {
    cwd: root,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: callerKey,
      CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
      CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${apiPort}/health`,
      CODEX_ROUTER_INTERNAL_KEY: 'test-internal-service-key-with-sufficient-length',
      KIMI_INTERNAL_KEY: 'test-internal-service-key-with-sufficient-length',
      CODEX_ROUTER_QUIET: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Router exited: ${errors}`);
      try { await fetch(`${base}/health`); break; }
      catch { if (Date.now() > deadline) throw new Error(`Router did not start: ${errors}`); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const mintUrl = `${base}/v1/jev-ticket`;
    const mintHeaders = { 'content-type': 'application/json', 'x-jev-pruner': 'ticket-v1' };
    const deniedMint = await fetch(mintUrl, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }) });
    assert.equal(deniedMint.status, 403);
    const crossOriginMint = await fetch(mintUrl, { method: 'POST',
      headers: { ...mintHeaders, origin: 'https://example.org' },
      body: JSON.stringify({ sessionId: 'session-a' }) });
    assert.equal(crossOriginMint.status, 403);
    const rebindingMint = await postWithHost(mintUrl, `example.org:${port}`, mintHeaders,
      JSON.stringify({ sessionId: 'session-a' }));
    assert.equal(rebindingMint, 403);
    const invalidMint = await fetch(mintUrl, { method: 'POST', headers: mintHeaders,
      body: JSON.stringify({ sessionId: '../other' }) });
    assert.equal(invalidMint.status, 400);
    const minted = await fetch(mintUrl, { method: 'POST', headers: mintHeaders,
      body: JSON.stringify({ sessionId: 'session-a' }) });
    assert.equal(minted.status, 200);
    assert.equal(minted.headers.get('cache-control'), 'no-store');
    const { ticket } = await minted.json();
    assert.equal(typeof ticket, 'string');
    assert.equal(ticket.includes(callerKey), false);
    const authorization = `Bearer ${ticket}`;
    const headers = { authorization, 'content-type': 'application/json' };
    const body = JSON.stringify({ model: 'openrouter-decisions/jev-latest',
      state: 'sample', questions: {} });
    const wrongModel = await fetch(`${base}/v1/jev-decisions`, { method: 'POST', headers, body });
    assert.equal(wrongModel.status, 400);
    const validBody = JSON.stringify({ model: 'openrouter-jev-campaign/jev-1.13',
      state: 'sample', questions: { keep: { type: 'noul', instructions: 'keep?' } } });
    const accepted = await fetch(`${base}/v1/jev-decisions`, {
      method: 'POST', headers, body: validBody });
    assert.equal(accepted.status, 200);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].url, '/v1/decisions');
    assert.equal(forwarded[0].body.state, 'sample');
    for (let index = 0; index < 17; index++) {
      const next = await fetch(`${base}/v1/jev-decisions`, {
        method: 'POST', headers, body: validBody });
      assert.equal(next.status, 200);
    }
    const exhausted = await fetch(`${base}/v1/jev-decisions`, {
      method: 'POST', headers, body: validBody });
    assert.equal(exhausted.status, 401);
    const broadRoute = await fetch(`${base}/v1/decisions`, { method: 'POST', headers, body });
    assert.equal(broadRoute.status, 401);
    const noTicket = await fetch(`${base}/v1/jev-decisions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body });
    assert.equal(noTicket.status, 401);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => api.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
