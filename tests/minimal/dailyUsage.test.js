'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyUsage } = require('../../src/minimal/dailyUsage');
const options = { clients: 'codex,claude' };

test('Monday week uses dates across months, replaces live today and distinguishes missing from zero', () => {
  const now = new Date(2026, 10, 1, 12); // Sunday; week starts in October, DST ends.
  const record = { updatedAt: now.toISOString(), today: { totalTokens: 8, costUsd: 2, clients: { codex: 8 }, clientCosts: { codex: 2 } }, history: { daily: [
    { date: '2026-10-26', tokens: 10, cost: 1, perClient: { codex: { tokens: 10, cost: 1 } } },
    { date: '2026-10-27', tokens: 0, cost: 0 },
    { date: '2026-11-01', tokens: 3, cost: 1 },
    { date: '2026-10-26', tokens: 10, cost: 1, perClient: { codex: { tokens: 10, cost: 1 } } }
  ] } };
  const result = dailyUsage(record, options, now);
  assert.equal(result.week.start, '2026-10-26');
  assert.equal(result.week.totalTokens, 18, 'repeated dates and live graph overlap are not added');
  assert.equal(result.week.totalCost, 3);
  assert.equal(result.week.complete, false);
  assert.equal(result.week.availableDays, 3);
  assert.equal(result.week.expectedDays, 7);
  assert.equal(result.days.find((day) => day.date === '2026-10-27').tokens, 0);
  assert.equal(result.days.find((day) => day.date === '2026-10-28').tokens, null);
  assert.equal(result.days.at(-1).tokens, 8);
  assert.equal(result.week.clients[0].tokens, 18);
  assert.ok(result.days.length <= 84);
  assert.equal(result.days[0].date, '2026-08-10');
  assert.deepEqual(dailyUsage(record, options, now), result, 'polls are idempotent');
});

test('unknown week is unavailable, Monday resets week and old live values cannot become today', () => {
  const now = new Date(2027, 0, 4, 0, 10);
  const value = dailyUsage({ updatedAt: new Date(2027, 0, 3, 23).toISOString(), today: { totalTokens: 99 } }, options, now);
  assert.equal(value.week.start, '2027-01-04');
  assert.equal(value.week.totalTokens, null);
  assert.equal(value.week.totalCost, null);
  assert.equal(value.week.availableDays, 0);
  assert.equal(value.week.expectedDays, 1);
  assert.equal(value.days.at(-1).tokens, null);
});
