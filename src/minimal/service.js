'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadDotEnv, sharedDataDir } = require('../shared/config');
const { readOptions } = require('./config');

const CLI_PATH = path.join(__dirname, 'cli.js');
const runFile = promisify(execFile);

function servicePaths(env = process.env) {
  const directory = path.join(sharedDataDir({ env }), 'minimal-service');
  return { directory, state: path.join(directory, 'service.json'), lock: path.join(directory, 'command.lock'), log: path.join(directory, 'service.log') };
}

function readServiceState(paths = servicePaths()) {
  try {
    const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    if (!Number.isSafeInteger(state.pid) || state.pid < 1 || !/^[a-f0-9-]{36}$/.test(state.id)) return null;
    return state;
  } catch (_) { return null; }
}

async function processCommand(pid) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await runFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { timeout: 5000, windowsHide: true });
      return stdout.trim();
    }
    const { stdout } = await runFile('ps', ['-p', String(pid), '-o', 'args='], { timeout: 5000 });
    return stdout.trim();
  } catch (_) { return ''; }
}

function matchesServiceCommand(command, state) {
  return Boolean(command && state && command.includes(CLI_PATH)
    && command.includes(`--service-id=${state.id}`));
}

async function isServiceRunning(state) {
  return matchesServiceCommand(state ? await processCommand(state.pid) : '', state);
}

async function acquireLock(paths) {
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(paths.lock, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(paths.lock); } catch (_) {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(paths.lock, 'utf8')); } catch (_) {}
      const command = Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? await processCommand(owner.pid) : '';
      if (command.replaceAll('\\', '/').includes('minimal/service.js')) throw new Error('Another service command is running; try again shortly.', { cause: error });
      try { fs.unlinkSync(paths.lock); } catch (_) {}
    }
  }
  throw new Error('Could not acquire the service command lock.');
}

function childArguments(options, id) {
  const values = {
    clients: options.clients, host: options.host, port: options.port,
    interval: options.intervalMs, limitsRefreshMs: options.limitsRefreshMs,
    timeoutMs: options.commandTimeoutMs, since: options.allTimeSince,
    limits: options.limitsEnabled ? 1 : 0, watch: options.watchEnabled ? 1 : 0,
    web: options.webEnabled ? 1 : 0, hub: options.hubUrl,
    ...(options.accountsFile ? { accountsFile: options.accountsFile } : {})
  };
  // Secrets travel in the child's environment, never ps-visible arguments or PID metadata.
  return [CLI_PATH, `--service-id=${id}`, ...Object.entries(values).map(([key, value]) => `--${key}=${value}`)];
}

async function startService(options, paths = servicePaths(), deps = {}) {
  if (options.once || options.dryRun) throw new Error('Background start cannot use --once or --dry-run.');
  const release = await acquireLock(paths);
  let child;
  let log;
  try {
    deps.signal?.throwIfAborted();
    const prior = readServiceState(paths);
    if (await isServiceRunning(prior)) return { ...prior, alreadyRunning: true };
    deps.signal?.throwIfAborted();
    const id = randomUUID();
    log = fs.openSync(paths.log, 'a', 0o600);
    fs.chmodSync(paths.log, 0o600);
    child = (deps.spawn || spawn)(process.execPath, childArguments(options, id), {
      cwd: path.resolve(__dirname, '../..'), detached: true, windowsHide: true,
      stdio: ['ignore', log, log, 'ipc'],
      env: { ...process.env, ...deps.env, TOKEN_MONITOR_SECRET: options.secret, TOKEN_MONITOR_DEVICE_ID: options.deviceId }
    });
    const url = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(reject, new Error(`Service startup timed out. See ${paths.log}`)), 15000);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        deps.signal?.removeEventListener('abort', onAbort);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        fn(value);
      };
      const onMessage = (message) => {
        if (message?.type === 'minimal-ready' && typeof message.url === 'string') finish(resolve, message.url);
      };
      const onError = () => finish(reject, new Error(`Could not start the service. See ${paths.log}`));
      const onExit = () => finish(reject, new Error(`Service exited before listening. See ${paths.log}`));
      const onAbort = () => finish(reject, new Error('Service startup cancelled.'));
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
      deps.signal?.addEventListener('abort', onAbort, { once: true });
      if (deps.signal?.aborted) onAbort();
    });
    const endpoint = new URL(url);
    if (endpoint.hostname === '0.0.0.0') endpoint.hostname = '127.0.0.1';
    if (endpoint.hostname === '[::]') endpoint.hostname = '[::1]';
    const state = { pid: child.pid, id, url: endpoint.toString().replace(/\/$/, ''), startedAt: new Date().toISOString() };
    const temp = `${paths.state}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.renameSync(temp, paths.state);
    } finally { try { fs.unlinkSync(temp); } catch (_) {} }
    child.disconnect();
    child.unref();
    return state;
  } catch (error) {
    try { child?.kill('SIGTERM'); } catch (_) {}
    if (child?.connected) child.disconnect();
    child?.unref();
    throw error;
  } finally {
    if (log !== undefined) fs.closeSync(log);
    release();
  }
}

async function stopService(paths = servicePaths()) {
  const release = await acquireLock(paths);
  try {
    const state = readServiceState(paths);
    if (!await isServiceRunning(state)) {
      try { fs.unlinkSync(paths.state); } catch (_) {}
      return false;
    }
    process.kill(state.pid, 'SIGTERM');
    const deadline = Date.now() + 20000;
    while (await isServiceRunning(state)) {
      if (Date.now() >= deadline) throw new Error('Service is still shutting down; check its log and status.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fs.unlinkSync(paths.state);
    return true;
  } finally { release(); }
}

async function main(argv = process.argv.slice(2)) {
  loadDotEnv();
  const [action, ...flags] = argv;
  const paths = servicePaths();
  if (action === '--help' || flags.includes('--help')) {
    console.log('npm run service:start [-- --port 17322 --clients codex,claude,antigravity]\nnpm run service:status\nnpm run service:stop\nnpm run tui\n\nUse foreground npm run headless with systemd. Browser assets are opt-in with --web 1.');
    return;
  }
  if (action === 'start') {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.once(signal, cancel);
    let state;
    try { state = await startService(readOptions(flags), paths, { signal: controller.signal }); }
    finally { for (const signal of signals) process.removeListener(signal, cancel); }
    console.log(`Token Monitor service ${state.alreadyRunning ? 'already running' : 'started'} (PID ${state.pid}) at ${state.url}\nOpen terminal UI: npm run tui\nLog: ${paths.log}`);
  } else if (action === 'stop') {
    console.log(await stopService(paths) ? 'Token Monitor service stopped.' : 'Token Monitor service is not running.');
  } else if (action === 'status') {
    const state = readServiceState(paths);
    console.log(await isServiceRunning(state) ? `Token Monitor service running (PID ${state.pid}) at ${state.url}` : 'Token Monitor service is not running.');
  } else {
    throw new Error('Use npm run service:start, service:status or service:stop.');
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { servicePaths, readServiceState, matchesServiceCommand, childArguments, startService, stopService, isServiceRunning, main };
