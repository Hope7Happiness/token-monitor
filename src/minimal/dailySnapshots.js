'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { localDayKey, dayKeyAddDays } = require('../shared/history');

// For scan-constrained services: save only the already-collected aggregate
// today period. No new source reads, graph scans, session ids or credentials.
function createDailySnapshots(file) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let saved = { timeZone, days: [] };
  try {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('Daily snapshot file is too large');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.timeZone === timeZone && Array.isArray(value.days)) saved = { ...value, days: value.days.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d?.date || '')).slice(-90) };
  } catch (_) {}
  return {
    capture(record) {
      const at = new Date(record.updatedAt);
      if (!record.today || !Number.isFinite(at.getTime())) return record;
      const date = localDayKey(at);
      const start = dayKeyAddDays(date, -89);
      const p = record.today;
      const perClient = Object.fromEntries(Object.entries(p.clients || {}).map(([id, tokens]) => [id, { tokens, cost: p.clientCosts?.[id] || 0 }]));
      const day = { date, tokens: p.totalTokens, cost: p.costUsd, perClient };
      const days = saved.days.filter((d) => d.date >= start && d.date < date).slice(-89).concat(day);
      let stale = false;
      if (JSON.stringify(days) !== JSON.stringify(saved.days)) {
        const next = { timeZone, updatedAt: record.updatedAt, days };
        const temporary = `${file}.${process.pid}.tmp`;
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
          fs.renameSync(temporary, file);
          saved = next;
        } catch (_) { stale = true; }
        finally { try { fs.unlinkSync(temporary); } catch (_) {} }
      }
      return { ...record, history: { daily: days }, historyUpdatedAt: record.updatedAt, historyStale: stale };
    }
  };
}

module.exports = { createDailySnapshots };
