'use strict';

const { stripVTControlCharacters } = require('node:util');
const numbers = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const segments = new Intl.Segmenter('en', { granularity: 'grapheme' });
const PERIODS = ['today', 'month', 'allTime'];
const PERIOD_LABELS = ['Today', 'Month', 'All time'];
const STATUS = { ok: 'connected', notConfigured: 'not configured', unavailable: 'unavailable', unauthorized: 'sign in again', rateLimited: 'rate limited', sourceRateLimited: 'rate limited', error: 'read failed' };

function cleanText(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function fit(value, width, right = false) {
  let result = '';
  let used = 0;
  for (const { segment } of segments.segment(cleanText(value))) {
    // English layout; conservative widths also keep upstream CJK/emoji labels
    // inside the viewport without depending on a terminal layout framework.
    const cells = [...segment].some((char) => char.codePointAt(0) > 255) ? 2 : 1;
    if (used + cells > width) break;
    used += cells;
    result += segment;
  }
  const padding = ' '.repeat(Math.max(0, width - used));
  return right ? padding + result : result + padding;
}

function resetText(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  return `reset ${date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function renderTui(snapshot, { period = 'today', columns = 80, rows = 30, scroll = 0, connection = 'connecting', notice = '', fill = true } = {}) {
  const width = Math.max(1, Math.floor(columns) - 2);
  const height = Math.max(1, Math.floor(rows));
  if (width < 38 || height < 10) {
    return { text: ['Token Monitor', 'Resize terminal to at least 40 x 10.', 'q: quit'].slice(0, height).map((line) => fit(line, width).trimEnd()).join('\n'), scroll: 0 };
  }
  const selected = PERIODS.includes(period) ? period : 'today';
  const current = snapshot?.periods?.[selected];
  const content = [];
  content.push(snapshot?.ready ? `TOKENS ${numbers.format(current?.totalTokens || 0)}    EST. COST ${money.format(current?.totalCost || 0)}` : 'Waiting for the first usage scan...');
  content.push('');
  const valueWidth = width >= 58 ? 16 : 10;
  const costWidth = 12;
  const nameWidth = width - valueWidth - costWidth;
  content.push(fit('TOOL', nameWidth) + fit('TOKENS', valueWidth, true) + fit('COST', costWidth, true));
  for (const client of current?.clients || []) {
    content.push(fit(client.label, nameWidth) + fit(snapshot?.ready ? numbers.format(client.tokens || 0) : '--', valueWidth, true) + fit(snapshot?.ready ? money.format(client.cost || 0) : '--', costWidth, true));
  }
  content.push('', 'ACCOUNT QUOTAS');
  if (!snapshot?.limits?.length) content.push('Waiting for quota data, or quotas are disabled.');
  for (const provider of snapshot?.limits || []) {
    const state = provider.connectionHint ? 'start agy / Antigravity' : STATUS[provider.status] || 'unknown';
    content.push(`${cleanText(provider.label)}  [${state}${provider.stale ? ' / last result' : ''}]`);
    for (const window of provider.windows || []) {
      const label = cleanText(window.label || ({ session: '5-hour', weekly: 'Weekly', daily: 'Daily' }[window.kind]) || 'Quota');
      let reading;
      if (window.metric === 'credits') {
        reading = `${cleanText(window.currency || 'USD')} ${Number.isFinite(window.remaining) ? window.remaining.toFixed(2) : '--'} remaining`;
      } else if (Number.isFinite(window.usedPercent)) {
        const percent = Math.max(0, Math.min(100, window.usedPercent));
        const used = Math.round(percent / 10);
        reading = `[${'#'.repeat(used)}${'-'.repeat(10 - used)}] ${Math.round(percent)}% used`;
      } else reading = 'not available';
      if (width >= 65) {
        content.push('  ' + fit(label, 19) + fit(reading, 24) + resetText(window.resetsAt));
      } else {
        content.push(`  ${label}: ${reading}`);
        if (window.resetsAt) content.push(`    ${resetText(window.resetsAt)}`);
      }
    }
    content.push('');
  }
  if (snapshot?.error) content.push('Usage scan failed; see the service log.');
  const header = ['TOKEN MONITOR / minimal    ' + connection.toUpperCase(),
    PERIOD_LABELS.map((label, index) => `${index + 1} ${PERIODS[index] === selected ? `[${label}]` : label}`).join('   '), '-'.repeat(width)];
  const footer = ['-'.repeat(width), notice || (snapshot?.updatedAt ? `Updated ${new Date(snapshot.updatedAt).toLocaleTimeString('en-US')} / usage ${snapshot.intervalMs / 1000}s / quotas ${snapshot.limitsRefreshMs / 1000}s` : 'Connecting to the background service...'),
    width < 65 ? '1/2/3 view | r refresh | q quit' : '1/2/3 period | r refresh usage | up/down scroll | q quit'];
  const available = Math.max(1, height - header.length - footer.length - 1);
  const maxScroll = Math.max(0, content.length - available);
  const offset = Math.max(0, Math.min(maxScroll, scroll));
  const body = content.slice(offset, offset + available);
  while (fill && body.length < available) body.push('');
  if (maxScroll > 0) footer[0] = `Lines ${offset + 1}-${Math.min(content.length, offset + available)} / ${content.length} (up/down, PgUp/PgDn)`;
  return { text: [...header, ...body, ...footer].map((line) => fit(line, width).trimEnd()).join('\n'), scroll: offset, maxScroll };
}

module.exports = { PERIODS, cleanText, fit, renderTui };
