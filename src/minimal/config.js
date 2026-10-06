'use strict';

const fs = require('node:fs');
const { defaultDeviceId, parseArgs } = require('../shared/config');

const CLIENTS = Object.freeze(['codex', 'claude', 'antigravity']);
const LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', antigravity: 'AGY / Antigravity' });

function duration(value, fallback, name, minimum = 10000) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 2147483647) {
    throw new TypeError(`${name} must be an integer between ${minimum} and 2147483647 ms`);
  }
  return parsed;
}

function boolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === true || value === '1' || value === 'true') return true;
  if (value === false || value === '0' || value === 'false') return false;
  throw new TypeError(`Invalid boolean: ${value}`);
}

function readOptions(argv = [], env = process.env) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };
  for (const key of ['clients', 'host', 'port', 'secret', 'since', 'hub', 'device', 'interval', 'limitsRefreshMs', 'timeoutMs', 'accountsFile']) {
    if (args[key] === true) throw new TypeError(`--${key} requires a value`);
  }
  const clients = args.clients ?? env.TOKEN_MONITOR_CLIENTS ?? CLIENTS.join(',');
  const selected = [...new Set(String(clients).split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (!selected.length || selected.some((id) => !CLIENTS.includes(id))) {
    throw new TypeError(`minimal supports only ${CLIENTS.join(',')}`);
  }
  const host = String(args.host ?? env.TOKEN_MONITOR_MINIMAL_HOST ?? '127.0.0.1');
  const secret = String(args.secret ?? env.TOKEN_MONITOR_SECRET ?? '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !secret) {
    throw new TypeError('A non-loopback host requires TOKEN_MONITOR_SECRET');
  }
  const port = Number(args.port ?? env.TOKEN_MONITOR_MINIMAL_PORT ?? 17322);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
  const allTimeSince = String(args.since ?? env.TOKEN_MONITOR_ALL_TIME_SINCE ?? '2024-01-01');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(allTimeSince) || new Date(`${allTimeSince}T00:00:00Z`).toISOString().slice(0, 10) !== allTimeSince) {
    throw new TypeError('since must be a valid YYYY-MM-DD date');
  }
  const hubUrl = String(args.hub ?? env.TOKEN_MONITOR_HUB_URL ?? '').replace(/\/$/, '');
  if (hubUrl && !['http:', 'https:'].includes(new URL(hubUrl).protocol)) throw new TypeError('Invalid Hub URL');
  return {
    clients: selected.join(','), host, port, secret, allTimeSince, hubUrl,
    deviceId: String(args.device || env.TOKEN_MONITOR_DEVICE_ID || defaultDeviceId()),
    intervalMs: duration(args.interval ?? env.TOKEN_MONITOR_INTERVAL_MS, 60000, 'interval'),
    limitsRefreshMs: duration(args.limitsRefreshMs ?? env.TOKEN_MONITOR_LIMITS_REFRESH_MS, 300000, 'limitsRefreshMs', 60000),
    commandTimeoutMs: duration(args.timeoutMs ?? env.TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS, 120000, 'timeoutMs'),
    limitsEnabled: boolean(args.limits ?? env.TOKEN_MONITOR_LIMITS_ENABLED, true),
    watchEnabled: boolean(args.watch ?? env.TOKEN_MONITOR_WATCH, false),
    webEnabled: boolean(args.web ?? env.TOKEN_MONITOR_MINIMAL_WEB, false),
    once: boolean(args.once, false),
    dryRun: boolean(args['dry-run'], false),
    accountsFile: args.accountsFile ?? env.TOKEN_MONITOR_MINIMAL_ACCOUNTS_FILE,
    help: Boolean(args.help)
  };
}

function readAccountOptions(file) {
  if (!file) return {};
  const stat = fs.statSync(file);
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('accountsFile must be private (chmod 600)');
  if (stat.size > 1024 * 1024) throw new Error('accountsFile exceeds 1 MB');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.fromEntries(['codexManagedAccounts', 'antigravityManagedAccounts', 'claudeWebCookie', 'claudeWebOrganizationId']
    .filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

module.exports = { CLIENTS, LABELS, readOptions, readAccountOptions };
