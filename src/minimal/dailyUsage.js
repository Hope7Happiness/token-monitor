'use strict';

const { CLIENTS, LABELS } = require('./config');
const { localDayKey, dayKeyAddDays } = require('../shared/history');
const number = (value) => Number.isFinite(value) ? value : 0;

// Calendar arithmetic uses UTC only for date keys, never to assign events to a
// day. The scanner and collector assign those in the service's local timezone.
function dailyUsage(record, options, now = new Date()) {
  const today = localDayKey(now);
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weekStart = dayKeyAddDays(today, -weekday);
  const start = dayKeyAddDays(weekStart, -11 * 7);
  const ids = CLIENTS.filter((id) => options.clients.split(',').includes(id));
  const project = (value, date) => ({ date, tokens: number(value.tokens), cost: number(value.cost),
    clients: ids.map((id) => ({ id, label: LABELS[id], tokens: number(value.perClient?.[id]?.tokens), cost: number(value.perClient?.[id]?.cost) })) });
  const byDate = new Map();
  for (const day of record?.history?.daily || []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day.date) && day.date >= start && day.date <= today) {
      // History is a replacement snapshot, never accumulated across polling or
      // sessions. Duplicate date rows cannot inflate the result.
      byDate.set(day.date, project(day, day.date));
    }
  }
  // Today's graph may be 15 minutes old; replace it with the exact live period.
  // Do not apply yesterday's live period after crossing local midnight.
  if (record?.today && localDayKey(new Date(record.updatedAt)) === today) {
    byDate.set(today, project({ tokens: record.today.totalTokens, cost: record.today.costUsd,
      perClient: Object.fromEntries(ids.map((id) => [id, { tokens: record.today.clients?.[id], cost: record.today.clientCosts?.[id] }])) }, today));
  }
  const days = [];
  for (let date = start; date <= today; date = dayKeyAddDays(date, 1)) {
    days.push(byDate.get(date) || { date, tokens: null, cost: null, clients: [] });
  }
  const weekly = days.filter((day) => day.date >= weekStart);
  const known = weekly.filter((day) => day.tokens !== null);
  const complete = known.length === weekly.length;
  const week = { totalTokens: known.length ? known.reduce((sum, day) => sum + day.tokens, 0) : null,
    totalCost: known.length ? known.reduce((sum, day) => sum + day.cost, 0) : null,
    complete, availableDays: known.length, expectedDays: weekly.length, start: weekStart, end: today,
    clients: ids.map((id) => ({ id, label: LABELS[id],
      tokens: known.reduce((sum, day) => sum + number(day.clients.find((client) => client.id === id)?.tokens), 0),
      cost: known.reduce((sum, day) => sum + number(day.clients.find((client) => client.id === id)?.cost), 0) })) };
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, start, end: today,
    updatedAt: record?.historyUpdatedAt || null, stale: Boolean(record?.historyStale), days, week };
}

module.exports = { dailyUsage };
