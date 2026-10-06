'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { stripVTControlCharacters } = require('node:util');
const { readTuiOptions, terminalAppearance, apiRequest, startTui, validateSnapshot } = require('../../src/minimal/tui');
const { renderTui, cleanText, textWidth } = require('../../src/minimal/tuiView');

function stats() {
  return {
    ready: true, intervalMs: 60000, limitsRefreshMs: 300000, updatedAt: '2026-10-06T16:00:00Z',
    periods: Object.fromEntries([['today', 15532], ['month', 59249150], ['allTime', 1060000000]].map(([period, tokens]) => [period, {
      totalTokens: tokens, totalCost: 12.34, clients: [{ id: 'codex', label: 'Codex', tokens, cost: 12.34 }]
    }])),
    limits: [{ provider: 'codex', label: 'Codex', status: 'ok', windows: [{ kind: 'weekly', usedPercent: 25 }] },
      { provider: 'antigravity', label: 'AGY / Antigravity', status: 'ok', windows: [
        { label: 'Gemini 5-hour', usedPercent: 50 }, { label: 'Credits', metric: 'credits', currency: 'USD', remaining: 4.5 }
      ] }]
  };
}

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  output.isTTY = true; output.columns = 80; output.rows = 24;
  let text = '';
  output.on('data', (chunk) => { text += chunk.toString(); });
  return { input, output, signals: new EventEmitter(), text: () => stripVTControlCharacters(text), rawText: () => text };
}

test('TUI options discover background service without putting authentication into URLs', () => {
  assert.equal(readTuiOptions([], {}, { url: 'http://127.0.0.1:18000' }).server, 'http://127.0.0.1:18000');
  assert.equal(readTuiOptions(['--server', 'https://server.example/monitor'], {}, null).server, 'https://server.example/monitor');
  for (const argv of [['--server'], ['--server', 'https://user:secret@example.com'], ['--server', 'https://example.com/?secret=x'], ['--server', 'file:///tmp'], ['--poll', '0'], ['--period', 'year']]) {
    assert.throws(() => readTuiOptions(argv, {}, null));
  }
});

test('TUI rendering respects terminal dimensions, integer token units, credits and scroll bounds', () => {
  for (const [period, expected] of [['today', '16K'], ['month', '59M'], ['allTime', '1B']]) {
    const frame = renderTui(stats(), { period, columns: 80, rows: 24 });
    assert.match(frame.text, new RegExp(`TOKENS ${expected}`));
    assert.ok(frame.text.split('\n').length < 24);
    assert.ok(frame.text.split('\n').every((line) => line.length <= 78));
  }
  const frame = renderTui(stats(), { columns: 80, rows: 100, fill: false });
  assert.match(frame.text, /25% used/);
  assert.match(frame.text, /USD 4\.50 remaining/);
  assert.match(frame.text, /Weekly/);
  assert.ok(frame.text.split('\n').length < 40);
  const small = renderTui(stats(), { columns: 42, rows: 12, scroll: 999 });
  assert.equal(small.scroll, small.maxScroll);
  assert.match(renderTui(stats(), { columns: 15, rows: 5 }).text, /Token Monitor/);
  assert.equal(cleanText('\x1b]52;c;c2VjcmV0\x07Codex\x1b[2J\n'), 'Codex ');
  assert.throws(() => validateSnapshot({ ...stats(), limits: [{ label: 'Codex', status: 'ok', windows: {} }] }), /invalid/);
});

test('styled frames keep visible cell bounds and cannot preserve upstream terminal controls', () => {
  const snapshot = stats();
  snapshot.periods.today.clients[0].label = '\x1b]52;c;c2VjcmV0\x07编程👩‍💻e\u0301';
  snapshot.limits[0].label = '\x1b[41mCodex';
  snapshot.limits[0].stale = true;
  snapshot.limits[0].windows[0].usedPercent = 98;
  for (const columns of [40, 59, 72, 91, 120]) {
    for (const rows of [10, 24, 52]) {
      for (const color of [false, true]) {
        const frame = renderTui(snapshot, { columns, rows, color });
        const plain = stripVTControlCharacters(frame.text);
        assert.ok(plain.split('\n').length < rows);
        assert.ok(plain.split('\n').every((row) => textWidth(row) <= columns - 2));
        assert.doesNotMatch(frame.text, /\x1b\]|\x1b\[41m|c2VjcmV0/);
        if (color) assert.match(frame.text, /\x1b\[1;36m/);
        else assert.doesNotMatch(frame.text, /\x1b/);
      }
    }
  }
  const view = renderTui(snapshot, { columns: 91, rows: 100, color: true, fill: false });
  assert.match(stripVTControlCharacters(view.text), /98% used !/);
  assert.match(stripVTControlCharacters(view.text), /cached/);
  const ascii = renderTui(stats(), { unicode: false, color: false, fill: false, rows: 100 });
  assert.doesNotMatch(ascii.text, /[^\x00-\x7f]/);
  assert.match(ascii.text, /TOKENS 16K/);
  assert.equal(textWidth('╭─█·●👩‍💻编程e\u0301'), 12);
});

test('terminal appearance honors no-color, ASCII and plain terminal settings', () => {
  assert.deepEqual(terminalAppearance({ isTTY: true }, { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }), { color: true, unicode: true });
  assert.equal(terminalAppearance({ isTTY: true }, { NO_COLOR: '1' }).color, false);
  assert.equal(terminalAppearance({ isTTY: false }, {}).color, false);
  assert.deepEqual(terminalAppearance({ isTTY: true }, { TERM: 'dumb' }), { color: false, unicode: false });
  assert.equal(terminalAppearance({ isTTY: true }, { LANG: 'C' }).unicode, false);
  assert.equal(terminalAppearance({ isTTY: true }, { LANG: 'en_US.UTF-8', TOKEN_MONITOR_TUI_ASCII: '1' }).unicode, false);
});

test('TUI authenticates via headers and does not display provider-supplied secret error bodies', async () => {
  await assert.rejects(apiRequest({ server: 'https://server.example', secret: 'private-key' }, '/api/stats', {
    fetch: async (url, options) => {
      assert.equal(url, 'https://server.example/api/stats');
      assert.equal(options.headers.authorization, 'Bearer private-key');
      assert.equal(options.redirect, 'error');
      return { ok: false, status: 401, json: () => assert.fail('Do not render untrusted error bodies') };
    }
  }), /Set TOKEN_MONITOR_SECRET/);
});

test('interactive TUI switches periods locally, requests usage only and restores terminal without stopping service', async (t) => {
  const tty = terminal();
  const calls = [];
  const session = startTui(readTuiOptions([], {}, null), { ...tty, fetch: async (url, options) => {
    calls.push({ url, method: options.method });
    return { ok: true, json: async () => url.endsWith('/api/refresh') ? { ok: true } : stats() };
  } });
  t.after(() => session.stop());
  await session.load();
  assert.match(tty.text(), /TOKENS 16K/);
  tty.input.write('2');
  assert.match(tty.text(), /TOKENS 59M/);
  tty.input.write('3');
  assert.match(tty.text(), /TOKENS 1B/);
  assert.equal(calls.length, 1);
  tty.input.write('\x1b[200~rq\x1b[201~');
  assert.equal(tty.input.isRaw, true);
  assert.equal(calls.length, 1);
  tty.input.write('r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(calls.find((call) => call.method === 'POST').url.endsWith('/api/refresh'), true);
  tty.input.write('q');
  await session.done;
  assert.equal(tty.input.isRaw, false);
  assert.match(tty.rawText(), /\x1b\[\?25h\x1b\[\?1049l$/);
  assert.equal(calls.some((call) => call.url.includes('stop') || call.url.includes('limits')), false);
  assert.equal(tty.signals.listenerCount('SIGTERM'), 0);
});

test('disconnect preserves the last snapshot and SIGTERM restores terminal and cancels client requests', async (t) => {
  const tty = terminal();
  let fail = false;
  let signal;
  const session = startTui(readTuiOptions([], {}, null), { ...tty, fetch: async (_url, options) => {
    signal = options.signal;
    if (fail) throw new Error('private upstream failure');
    return { ok: true, json: async () => stats() };
  } });
  t.after(() => session.stop());
  await session.load();
  fail = true;
  await session.load();
  assert.match(tty.text(), /OFFLINE/);
  assert.match(tty.text(), /TOKENS 16K/);
  assert.doesNotMatch(tty.text(), /private upstream/);
  tty.signals.emit('SIGTERM');
  await session.done;
  assert.equal(signal.aborted, true);
  assert.equal(tty.input.isRaw, false);
});
