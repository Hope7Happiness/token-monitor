'use strict';

const { stripVTControlCharacters } = require('node:util');
const numbers = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const segments = new Intl.Segmenter('en', { granularity: 'grapheme' });
const PERIODS = ['today', 'month', 'allTime'];
const PERIOD_LABELS = ['Today', 'Month', 'All time'];
const STATUS = { ok: 'connected', notConfigured: 'not configured', unavailable: 'unavailable', unauthorized: 'sign in again', rateLimited: 'rate limited', sourceRateLimited: 'rate limited', error: 'read failed' };
const STYLES = { muted: '2', strong: '1', accent: '36', title: '1;36', selected: '1;4;36', codex: '36', claude: '33', antigravity: '35', good: '32', warning: '33', danger: '1;31' };

function cleanText(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function graphemeWidth(segment) {
  // Our borders/meters are single-cell Unicode. Account for wide upstream labels
  // and joined emoji without counting their code points or styling as columns.
  if (/^[\p{Mark}\p{Format}]+$/u.test(segment)) return 0;
  if (/\p{Emoji_Presentation}|\uFE0F/u.test(segment)) return 2;
  return [...segment].some((char) => {
    const code = char.codePointAt(0);
    return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
      || code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f
      || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff
      || code >= 0xfe10 && code <= 0xfe19 || code >= 0xfe30 && code <= 0xfe6f
      || code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6
      || code >= 0x20000 && code <= 0x3fffd);
  }) ? 2 : 1;
}

function textWidth(value) {
  let used = 0;
  for (const { segment } of segments.segment(cleanText(value))) used += graphemeWidth(segment);
  return used;
}

function clip(value, width) {
  let result = '';
  let used = 0;
  for (const { segment } of segments.segment(cleanText(value))) {
    const cells = graphemeWidth(segment);
    if (used + cells > width) break;
    used += cells;
    result += segment;
  }
  return { text: result, width: used };
}

function fit(value, width, right = false) {
  const result = clip(value, width);
  const padding = ' '.repeat(Math.max(0, width - result.width));
  return right ? padding + result.text : result.text + padding;
}

function resetText(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  return `reset ${date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function renderTui(snapshot, { period = 'today', columns = 80, rows = 30, scroll = 0, connection = 'connecting', notice = '', fill = true, color = false, unicode = true } = {}) {
  const width = Math.max(1, Math.floor(columns) - 2);
  const height = Math.max(1, Math.floor(rows));
  if (width < 38 || height < 10) {
    return { text: ['Token Monitor', 'Resize terminal to at least 40 x 10.', 'q: quit'].slice(0, height).map((line) => fit(line, width).trimEnd()).join('\n'), scroll: 0 };
  }
  const glyph = unicode ? { rule: '─', dot: '●', marker: '▏', filled: '━', empty: '─', share: '█', shareEmpty: '░', separator: '·', scroll: '↑↓', tl: '╭', tr: '╮', bl: '╰', br: '╯', side: '│' }
    : { rule: '-', dot: '*', marker: '|', filled: '#', empty: '-', share: '=', shareEmpty: '.', separator: '|', scroll: 'up/down', tl: '+', tr: '+', bl: '+', br: '+', side: '|' };
  const span = (text, tone = '') => ({ text: cleanText(text), tone });
  const cell = (text, cells, tone = '', right = false) => span(fit(text, cells, right), tone);
  // Clip sanitized spans before adding our own SGR. Upstream text never supplies ANSI.
  const line = (...parts) => {
    let available = width;
    return parts.map((part) => {
      const item = typeof part === 'string' ? span(part) : part;
      const clipped = clip(item.text, available);
      available -= clipped.width;
      return color && STYLES[item.tone] && clipped.text ? `\x1b[${STYLES[item.tone]}m${clipped.text}\x1b[0m` : clipped.text;
    }).join('').trimEnd();
  };
  const pair = (left, right, leftTone = '', rightTone = 'muted') => {
    const rightWidth = Math.min(Math.floor(width * 0.5), textWidth(right));
    return line(cell(left, width - rightWidth - 1, leftTone), ' ', cell(right, rightWidth, rightTone, true));
  };
  const meter = (percent, size, tone, share = false) => {
    const count = Math.round(Math.max(0, Math.min(100, percent)) / 100 * size);
    return [span((share ? glyph.share : glyph.filled).repeat(count), tone), span((share ? glyph.shareEmpty : glyph.empty).repeat(size - count), 'muted')];
  };
  const selected = PERIODS.includes(period) ? period : 'today';
  const current = snapshot?.periods?.[selected];
  const innerWidth = width - 4;
  const content = [];
  const heading = ` ${PERIOD_LABELS[PERIODS.indexOf(selected)].toUpperCase()} OVERVIEW `;
  content.push(line(span(glyph.tl + glyph.rule, 'muted'), span(heading, 'accent'), span(glyph.rule.repeat(Math.max(0, width - textWidth(heading) - 3)) + glyph.tr, 'muted')));
  const costWidth = Math.min(29, Math.floor(innerWidth / 2));
  const tokenWidth = innerWidth - costWidth;
  const metric = (label, value, size) => [span(label + ' ', 'muted'), cell(value, Math.max(0, size - label.length - 1), 'strong')];
  content.push(line(span(glyph.side + ' ', 'muted'), ...metric('TOKENS', snapshot?.ready ? numbers.format(current?.totalTokens || 0) : '--', tokenWidth),
    ...metric('EST. COST', snapshot?.ready ? money.format(current?.totalCost || 0) : '--', costWidth), span(' ' + glyph.side, 'muted')));
  content.push(line(span(glyph.bl + glyph.rule.repeat(width - 2) + glyph.br, 'muted')));
  if (!snapshot?.ready) content.push(line(span('  Waiting for the first usage scan...', 'muted')));
  if (snapshot?.error) content.push(line(span('  ! Usage scan failed; see the service log.', 'warning')));
  content.push('');

  const shareWidth = width >= 72 ? 20 : 0;
  const valueWidth = width >= 58 ? 12 : 9;
  const priceWidth = width >= 58 ? 12 : 10;
  const nameWidth = innerWidth - shareWidth - valueWidth - priceWidth;
  content.push(line('  ', cell('TOOL', nameWidth, 'muted'), cell(shareWidth ? 'SHARE' : '', shareWidth, 'muted'), cell('TOKENS', valueWidth, 'muted', true), cell('COST', priceWidth, 'muted', true)));
  for (const client of current?.clients || []) {
    const tone = STYLES[client.id] ? client.id : 'accent';
    const share = current.totalTokens > 0 ? Math.max(0, Math.min(100, client.tokens / current.totalTokens * 100)) : 0;
    const shareSpans = shareWidth ? [...meter(share, 10, tone, true), cell(snapshot?.ready ? `${Math.round(share)}%` : '--', 6, 'muted', true), span(' '.repeat(shareWidth - 16))] : [];
    content.push(line('  ', span(glyph.marker + ' ', tone), cell(client.label, nameWidth - 2, tone), ...shareSpans,
      cell(snapshot?.ready ? numbers.format(client.tokens || 0) : '--', valueWidth, 'strong', true), cell(snapshot?.ready ? money.format(client.cost || 0) : '--', priceWidth, '', true)));
  }
  content.push('', line(span('  ACCOUNT QUOTAS ', 'strong'), span(glyph.rule.repeat(Math.max(0, width - 17)), 'muted')));
  if (!snapshot?.limits?.length) content.push(line(span('  Waiting for quota data, or quotas are disabled.', 'muted')));
  for (const provider of snapshot?.limits || []) {
    const tone = STYLES[provider.provider] ? provider.provider : 'accent';
    const state = provider.connectionHint ? 'start agy / Antigravity' : STATUS[provider.status] || 'unknown';
    const stateTone = provider.stale ? 'warning' : provider.status === 'ok' ? 'good' : ['unauthorized', 'error'].includes(provider.status) ? 'danger' : 'muted';
    content.push('', pair('  ' + glyph.marker + ' ' + cleanText(provider.label), `${provider.stale ? '! cached / ' : glyph.dot + ' '}${state}`, tone, stateTone));
    for (const window of provider.windows || []) {
      const label = cleanText(window.label || ({ session: '5-hour', weekly: 'Weekly', daily: 'Daily' }[window.kind]) || 'Quota');
      const percent = window.metric !== 'credits' && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null;
      const warning = percent >= 100 ? '! full' : percent >= 80 ? '! near limit' : '';
      const meterTone = provider.stale ? 'muted' : percent >= 95 ? 'danger' : percent >= 80 ? 'warning' : tone;
      const bar = window.metric !== 'credits' && percent !== null ? meter(percent, width >= 72 ? 12 : 8, meterTone) : [];
      const reading = window.metric === 'credits'
        ? `${cleanText(window.currency || 'USD')} ${Number.isFinite(window.remaining) ? window.remaining.toFixed(2) : '--'} remaining`
        : percent !== null ? `${Math.round(percent)}% used` : 'not available';
      if (width >= 72) {
        const readingWidth = window.metric === 'credits' ? 26 : 12;
        content.push(line('    ', cell(label, 19, 'muted'), ...bar, bar.length ? ' ' : '', cell(reading + (warning ? ' !' : ''), readingWidth, meterTone),
          span(resetText(window.resetsAt), 'muted'), warning ? span('  ' + warning, meterTone) : span('')));
      } else {
        content.push(line('    ', span(label + ': ', 'muted'), ...bar, bar.length ? ' ' : '', span(reading, meterTone), warning ? span(' !', meterTone) : span('')));
        if (window.resetsAt) content.push(line(span('      ' + resetText(window.resetsAt), 'muted')));
      }
    }
  }
  const statusTone = connection === 'connected' ? 'good' : connection === 'connecting' ? 'muted' : 'danger';
  const tabs = PERIOD_LABELS.flatMap((label, index) => [span(` ${index + 1} ${label} `, PERIODS[index] === selected ? 'selected' : 'muted'), span('  ')]);
  const header = [pair(' TOKEN MONITOR', `${glyph.dot} ${connection.toUpperCase()}`, 'title', statusTone),
    line(span(' Local usage ' + glyph.separator + ' Codex / Claude Code / AGY', 'muted')), line(...tabs), ''];
  const updated = snapshot?.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--';
  const footer = [line(span(glyph.rule.repeat(width), 'muted')),
    line(span(notice || `Updated ${updated} ${glyph.separator} usage ${snapshot?.intervalMs / 1000 || '--'}s ${glyph.separator} quotas ${snapshot?.limitsRefreshMs / 1000 || '--'}s`, notice ? 'warning' : 'muted')),
    line(span(' 1/2/3', 'strong'), span(width < 65 ? ' view  ' : ' period  ', 'muted'), span('r', 'strong'), span(' refresh  ', 'muted'),
      ...(width >= 65 ? [span(glyph.scroll, 'strong'), span(' scroll  ', 'muted')] : []), span('q', 'strong'), span(' quit', 'muted'))];
  const available = Math.max(1, height - header.length - footer.length - 1);
  const maxScroll = Math.max(0, content.length - available);
  const offset = Math.max(0, Math.min(maxScroll, scroll));
  const body = content.slice(offset, offset + available);
  while (fill && body.length < available) body.push('');
  if (maxScroll > 0) footer[0] = pair(glyph.rule.repeat(Math.max(0, width - 34)), `Lines ${offset + 1}-${Math.min(content.length, offset + available)}/${content.length} ${glyph.scroll} scroll`, 'muted');
  return { text: [...header, ...body, ...footer].join('\n'), scroll: offset, maxScroll };
}

module.exports = { PERIODS, cleanText, fit, textWidth, renderTui };
