'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDailySnapshots } = require('../../src/minimal/dailySnapshots');

test('scan-constrained daily snapshots replace a day, survive restart and never add polls or sessions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auv-daily-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'days.json');
  const record = (day, tokens) => ({ updatedAt: new Date(2026, 10, day, 12).toISOString(), today: { totalTokens: tokens, costUsd: 1, clients: { codex: tokens }, sessions: { secret: 'private' } } });
  const store = createDailySnapshots(file);
  store.capture(record(6, 10));store.capture(record(6, 20));
  const result = createDailySnapshots(file).capture(record(7, 4));
  assert.deepEqual(result.history.daily.map((d) => d.tokens), [20, 4]);
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
  assert.equal(result.historyStale, false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
});
