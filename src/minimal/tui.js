'use strict';

const readline = require('node:readline');
const { loadDotEnv, parseArgs } = require('../shared/config');
const { readServiceState } = require('./service');
const { PERIODS, renderTui } = require('./tuiView');

function readTuiOptions(argv = [], env = process.env, state = readServiceState()) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };
  for (const key of ['server', 'poll', 'period']) if (args[key] === true) throw new Error(`--${key} requires a value`);
  const server = new URL(args.server ?? (env.TOKEN_MONITOR_TUI_URL || state?.url) ?? `http://127.0.0.1:${env.TOKEN_MONITOR_MINIMAL_PORT || 17322}`);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) {
    throw new Error('Server must be an HTTP(S) base URL without credentials, query or fragment.');
  }
  const pollMs = Number(args.poll ?? 5000);
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000) throw new Error('--poll must be between 1000 and 60000 ms');
  const period = args.period || 'today';
  if (!PERIODS.includes(period)) throw new Error('--period must be today, month or allTime');
  return { server: server.toString().replace(/\/$/, ''), secret: env.TOKEN_MONITOR_SECRET || '', pollMs, period, once: args.once === true || args.once === '1' };
}

function validateSnapshot(value) {
  if (!value || typeof value.ready !== 'boolean' || !Array.isArray(value.limits)
    || PERIODS.some((period) => {
      const current = value.periods?.[period];
      return !Number.isFinite(current?.totalTokens) || !Number.isFinite(current?.totalCost)
        || !Array.isArray(current?.clients) || current.clients.some((client) => typeof client?.label !== 'string' || !Number.isFinite(client.tokens) || !Number.isFinite(client.cost));
    }) || value.limits.some((provider) => typeof provider?.label !== 'string' || typeof provider.status !== 'string'
      || !Array.isArray(provider.windows) || provider.windows.some((window) => !window || typeof window !== 'object'))) throw new Error('Service returned an invalid usage snapshot.');
  return value;
}

async function apiRequest(options, path, { method = 'GET', signal, fetch: fetchFn = fetch } = {}) {
  const response = await fetchFn(`${options.server}${path}`, {
    method, redirect: 'error', signal,
    headers: options.secret ? { authorization: `Bearer ${options.secret}` } : {}
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Set TOKEN_MONITOR_SECRET to the service secret.'
      : response.status === 429 ? 'Refresh is already requested; wait a few seconds.' : `Service request failed (HTTP ${response.status}).`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

function startTui(options, deps = {}) {
  const input = deps.input || process.stdin;
  const output = deps.output || process.stdout;
  const signals = deps.signals || process;
  const fetchFn = deps.fetch || fetch;
  if (!input.isTTY || !output.isTTY) throw new Error('TUI needs an interactive terminal. Use --once for a text snapshot.');
  const controller = new AbortController();
  let snapshot;
  let period = options.period;
  let connection = 'connecting';
  let notice = '';
  let scroll = 0;
  let maxScroll = 0;
  let timer;
  let flight;
  let refreshing = false;
  let stopped = false;
  let pasted = false;
  let lastFrame = '';
  const wasRaw = Boolean(input.isRaw);
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  function draw() {
    if (stopped) return;
    const frame = renderTui(snapshot, { period, connection, notice, scroll, columns: output.columns || 80, rows: output.rows || 24 });
    scroll = frame.scroll; maxScroll = frame.maxScroll || 0;
    if (frame.text !== lastFrame) {
      lastFrame = frame.text;
      output.write(`\x1b[H\x1b[J${frame.text.replaceAll('\n', '\r\n')}`);
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    input.removeListener('keypress', onKey);
    input.removeListener('end', stop);
    output.removeListener('resize', onResize);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.removeListener(signal, stop);
    input.setRawMode(wasRaw);
    input.pause();
    output.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
    resolveDone();
  }

  function load() {
    if (stopped || flight) return flight;
    clearTimeout(timer);
    flight = apiRequest(options, '/api/stats', { fetch: fetchFn, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
      .then((value) => { snapshot = validateSnapshot(value); connection = 'connected'; if (notice.startsWith('Cannot') || notice.startsWith('Set ')) notice = ''; })
      .catch((error) => {
        if (stopped) return;
        connection = error.httpStatus === 401 ? 'unauthorized' : 'offline / last result';
        notice = error.httpStatus === 401 ? error.message : 'Cannot reach the service. Run npm run service:start. Retrying...';
      })
      .finally(() => {
        flight = null;
        if (!stopped) { draw(); timer = setTimeout(load, snapshot?.ready ? options.pollMs : 2000); }
      });
    return flight;
  }

  async function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      await apiRequest(options, '/api/refresh', { method: 'POST', fetch: fetchFn, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      notice = 'Usage refresh requested. Quotas keep their independent timer.';
      await load();
    } catch (error) {
      if (!stopped) notice = error.httpStatus ? error.message : 'Cannot request a refresh; check the service connection.';
    } finally { refreshing = false; draw(); }
  }

  function onResize() { lastFrame = ''; draw(); }
  function onKey(text, key = {}) {
    if (key.name === 'paste-start') { pasted = true; return; }
    if (key.name === 'paste-end') { pasted = false; return; }
    if (pasted || stopped) return;
    if (key.name === 'q' || key.name === 'escape' || key.ctrl && ['c', 'd'].includes(key.name)) return stop();
    if (['1', '2', '3'].includes(text)) { period = PERIODS[Number(text) - 1]; scroll = 0; }
    else if (key.name === 'right' || key.name === 'tab') { period = PERIODS[(PERIODS.indexOf(period) + 1) % 3]; scroll = 0; }
    else if (key.name === 'left') { period = PERIODS[(PERIODS.indexOf(period) + 2) % 3]; scroll = 0; }
    else if (key.name === 'down') scroll++;
    else if (key.name === 'up') scroll--;
    else if (key.name === 'pagedown') scroll += Math.max(1, (output.rows || 24) - 8);
    else if (key.name === 'pageup') scroll -= Math.max(1, (output.rows || 24) - 8);
    else if (key.name === 'home') scroll = 0;
    else if (key.name === 'end') scroll = maxScroll;
    else if (key.name === 'r') { void refresh(); return; }
    draw();
  }

  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  input.on('keypress', onKey);
  input.once('end', stop);
  output.on('resize', onResize);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.once(signal, stop);
  output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  draw();
  void load();
  return { done, stop, load };
}

async function main(argv = process.argv.slice(2)) {
  loadDotEnv();
  const options = readTuiOptions(argv);
  if (options.help) {
    console.log(`Token Monitor TUI\n\nnpm run service:start      Background collector\nnpm run tui                Connect to the service\nnpm run tui -- --once       Print a text snapshot\n\n--server http://127.0.0.1:17322  Local or remote service\n--period today|month|allTime    Initial view\n--poll 5000                    UI polling milliseconds\n\nSet TOKEN_MONITOR_SECRET for an authenticated service.\nKeys: 1/2/3 or left/right = period; r = refresh usage; up/down/PgUp/PgDn = scroll; q/Esc/Ctrl+C = close TUI.\nClosing TUI leaves the background collector running.`);
    return;
  }
  if (options.once) {
    const snapshot = validateSnapshot(await apiRequest(options, '/api/stats', { signal: AbortSignal.timeout(5000) }));
    console.log(renderTui(snapshot, { period: options.period, connection: 'connected', columns: process.stdout.columns || 100, rows: 200, fill: false }).text.trimEnd());
    return;
  }
  await startTui(options).done;
}

if (require.main === module) main().catch((error) => {
  console.error(error.httpStatus ? error.message : 'TUI could not start. Check --server / --help and that the service is running.');
  process.exitCode = 1;
});
module.exports = { readTuiOptions, validateSnapshot, apiRequest, startTui, main };
