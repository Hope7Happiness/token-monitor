'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinimalServer, listen } = require('../../src/minimal/server');
const { readOptions } = require('../../src/minimal/config');

async function fixture(t, secret = '') {
  let refreshes = 0;
  const runtime = {
    getSnapshot: () => ({ updatedAt: '2026-10-04T12:00:00Z', today: {
      totalTokens: 42, costUsd: 0.25, clients: { codex: 42 }, clientCosts: { codex: 0.25 },
      sessions: { secret: { title: 'private title' } }
    }, limits: { providers: [{ provider: 'codex', accountEmail: 'private@example.com', credentials: 'private credential', status: 'ok', windows: [{ label: 'Session', usedPercent: 20 }] }] } }),
    getError: () => 'failed to scan /private/transcripts/session.jsonl',
    refreshUsage: async () => { refreshes++; }
  };
  const options = readOptions(['--port', '0'], { TOKEN_MONITOR_SECRET: secret });
  const server = createMinimalServer(runtime, options);
  const url = await listen(server, options);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url, refreshes: () => refreshes };
}

test('dashboard uses canonical costs/tokens and keeps credentials, identities and transcripts private', async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/api/stats`);
  const data = await response.json();
  assert.equal(data.periods.today.totalTokens, 42);
  assert.equal(data.periods.today.totalCost, 0.25);
  assert.equal(data.periods.today.clients[0].tokens, 42);
  assert.equal(data.periods.today.clients[0].cost, 0.25);
  assert.equal(JSON.stringify(data).includes('private'), false);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${url}/../../package.json`)).status, 404);
});

test('remote secret protects API and allows the login page without exposing data', async (t) => {
  const { url } = await fixture(t, 'test-secret');
  assert.equal((await fetch(`${url}/`)).status, 200);
  assert.equal((await fetch(`${url}/api/stats`)).status, 401);
  assert.equal((await fetch(`${url}/api/health`)).status, 401);
  assert.equal((await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer test-secret' } })).status, 200);
});

test('usage refresh blocks foreign origins and repeated requests without refreshing quotas', async (t) => {
  const fixtureData = await fixture(t);
  const url = `${fixtureData.url}/api/refresh`;
  assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 202);
  assert.equal((await fetch(url, { method: 'POST' })).status, 429);
  assert.equal(fixtureData.refreshes(), 1);
});
