'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinimalRuntime } = require('../../src/minimal/runtime');
const { readOptions } = require('../../src/minimal/config');
const { emptyPeriod } = require('../../src/shared/usage');

function fakeCollector(captured) {
  return (options) => {
    captured.options = options;
    captured.stop = false;
    queueMicrotask(() => options.onUpdate({ today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }));
    return {
      tick: async () => { options.onUpdate({ today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }); },
      stop: () => { captured.stop = true; }, whenIdle: async () => {}
    };
  };
}

test('quotas run serially, never refresh from token updates, and stop removes scheduled work', async () => {
  const captured = {};
  let active = 0;
  let peak = 0;
  const calls = [];
  let cleared = false;
  const timers = [];
  let state;
  const fetchers = Object.fromEntries(['codex', 'claude', 'antigravity'].map((provider) => [provider, async (_options, deps) => {
    assert.ok(deps.providerRuntimeState instanceof Map);
    if (state) assert.equal(deps.providerRuntimeState, state);
    state = deps.providerRuntimeState;
    active++; peak = Math.max(peak, active); calls.push(provider);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { provider, status: 'ok', windows: [] };
  }]));
  const runtime = createMinimalRuntime(readOptions([], {}), {
    startCollector: fakeCollector(captured), fetchers,
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return 42; },
    clearTimeout: (id) => { assert.equal(id, 42); cleared = true; }
  });
  await runtime.whenReady();
  assert.equal(peak, 1);
  assert.deepEqual(calls, ['codex', 'claude', 'antigravity']);
  assert.equal(captured.options.compactUsage, true);
  assert.equal(captured.options.historyEnabled, false);
  assert.equal(captured.options.watchEnabled, false);
  assert.equal(timers[0].delay, 300000);
  await runtime.refreshUsage();
  assert.equal(calls.length, 3);
  await runtime.stop();
  assert.equal(captured.stop, true);
  assert.equal(cleared, true);
  await timers[0].fn();
  assert.equal(calls.length, 3);
});

test('stop aborts quota transport and does not publish late results', async () => {
  const captured = {};
  let signal;
  let updates = 0;
  const runtime = createMinimalRuntime(readOptions(['--clients', 'codex'], {}), {
    startCollector: fakeCollector(captured), fetchers: { codex: async (_options, deps) => {
      signal = deps.signal;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { provider: 'codex', status: 'ok', windows: [] };
    } }
  });
  runtime.subscribe(() => updates++);
  await runtime.ready;
  const before = updates;
  await runtime.stop();
  assert.equal(signal.aborted, true);
  assert.equal(updates, before);
});

test('one-shot collector failures propagate and quota failures remain visible', async () => {
  const runtime = createMinimalRuntime(readOptions(['--once', '--clients', 'codex'], {}), {
    startCollector: (options) => {
      queueMicrotask(() => options.onError(new Error('broken scan')));
      return { stop() {}, whenIdle: async () => {} };
    },
    fetchers: { codex: async () => { throw new Error('offline'); } }
  });
  await assert.rejects(runtime.whenReady(), /broken scan/);
  assert.equal(runtime.getError(), 'broken scan');
  await runtime.stop();
});

test('renewed AGY credentials stay nested, private and bound to the matching account', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-minimal-renewal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'accounts.json');
  fs.writeFileSync(file, JSON.stringify({
    otherSetting: 'preserve',
    antigravityManagedAccounts: [
      { id: 'first', credentials: { accessToken: 'unchanged' } },
      { id: 'second', credentials: { accessToken: 'old' } }
    ]
  }), { mode: 0o600 });
  const runtime = createMinimalRuntime(readOptions(['--clients', 'antigravity', '--once', '--accountsFile', file], {}), {
    startCollector: fakeCollector({}),
    fetchers: { antigravity: async (_options, deps) => {
      await deps.onAntigravityCredentialsRenewed({ account: { id: 'second', accountKey: 'bound' }, credentials: { accessToken: 'renewed', refreshToken: 'refresh', expiresAt: 123456 } });
      return { provider: 'antigravity', status: 'ok', windows: [] };
    } }
  });
  await runtime.whenReady();
  await runtime.stop();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.otherSetting, 'preserve');
  assert.equal(saved.antigravityManagedAccounts[0].credentials.accessToken, 'unchanged');
  assert.equal(saved.antigravityManagedAccounts[1].credentials.accessToken, 'renewed');
  assert.equal(saved.antigravityManagedAccounts[1].accessToken, undefined);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
});
