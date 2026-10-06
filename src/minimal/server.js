'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { CLIENTS, LABELS } = require('./config');

function dashboardSnapshot(record, runtime, options) {
  const periods = {};
  for (const name of ['today', 'month', 'allTime']) {
    const period = record?.[name];
    periods[name] = {
      totalTokens: period?.totalTokens || 0,
      totalCost: period?.costUsd || 0,
      clients: CLIENTS.filter((client) => options.clients.split(',').includes(client)).map((id) => ({
        id, label: LABELS[id], tokens: period?.clients?.[id] || 0,
        cost: period?.clientCosts?.[id] || 0
      }))
    };
  }
  return {
    ready: Boolean(record), updatedAt: record?.updatedAt || null,
    error: runtime.getError() ? 'Usage collection failed; see service logs.' : null, intervalMs: options.intervalMs,
    limitsRefreshMs: options.limitsRefreshMs, watchEnabled: options.watchEnabled,
    periods,
    // Explicit projection: account identifiers, credentials, source paths and transcripts stay private.
    limits: (record?.limits?.providers || []).map((row) => ({
      provider: row.provider, label: LABELS[row.provider], status: row.status,
      connectionHint: row.provider === 'antigravity' && row.source === 'rpc' && row.status === 'notConfigured'
        ? '请启动 agy 或 Antigravity' : null,
      updatedAt: row.updatedAt, stale: row.status !== 'ok' && row.windows?.length > 0,
      windows: (row.windows || []).map((window) => ({
        kind: window.kind, label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
        metric: window.metric, remaining: window.remaining, limit: window.limit, currency: window.currency
      }))
    }))
  };
}

function createMinimalServer(runtime, options) {
  const assets = new Map((options.webEnabled === false ? [] : [
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ...CLIENTS.map((id) => [`/icons/${id}.svg`, [`icons/${id}.svg`, 'image/svg+xml; charset=utf-8']])
  ]).map(([route, [file, type]]) => [route, { type, body: fs.readFileSync(path.join(__dirname, 'web', file)) }]));
  const digest = (value) => createHash('sha256').update(value).digest();
  const expected = digest(options.secret || '');
  let refreshing = false;
  let nextRefreshAt = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    function json(status, data) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { return json(400, { error: 'Invalid URL' }); }
    if (url.pathname.startsWith('/api/')) {
      if (options.secret && !timingSafeEqual(expected, digest(String(req.headers.authorization || '').replace(/^Bearer /, '')))) {
        return json(401, { error: 'Authentication required' });
      }
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        return json(200, dashboardSnapshot(runtime.getSnapshot(), runtime, options));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(200, { ok: true, ready: Boolean(runtime.getSnapshot()), error: runtime.getError() ? 'Usage collection failed; see service logs.' : null });
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        const origin = req.headers.origin;
        if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`)) {
          return json(403, { error: 'Cross-origin refresh refused' });
        }
        if (refreshing || Date.now() < nextRefreshAt) return json(429, { error: 'Refresh already requested; wait a few seconds' });
        refreshing = true;
        nextRefreshAt = Date.now() + 10000;
        Promise.resolve().then(() => runtime.refreshUsage()).catch(() => {}).finally(() => { refreshing = false; });
        return json(202, { ok: true });
      }
      return json(404, { error: 'Not found' });
    }
    const asset = assets.get(url.pathname);
    if (req.method !== 'GET' || !asset) return json(404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': asset.type });
    res.end(asset.body);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve(`http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`);
    });
  });
}

module.exports = { createMinimalServer, dashboardSnapshot, listen };
