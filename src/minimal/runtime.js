'use strict';

const fs = require('node:fs');
const { startCollector } = require('../shared/collector');
const { normalizeLimitProvider, normalizeLimitsSummary } = require('../shared/limits/core');
const { providerStatusFromError } = require('../shared/limits/providerHelpers');
const { appVersion } = require('../shared/appVersion');
const { readAccountOptions } = require('./config');

// Load only the selected quota adapters; the full registry eagerly loads all vendors.
const LOADERS = {
  codex: () => require('../shared/providers/codex/limits').fetchCodexLimits,
  claude: () => require('../shared/providers/claude/limits').fetchClaudeLimits,
  antigravity: () => require('./antigravity').fetchMinimalAntigravityLimits
};

function createMinimalRuntime(options, deps = {}) {
  const collect = deps.startCollector || startCollector;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const accountOptions = deps.accountOptions || readAccountOptions(options.accountsFile);
  const controller = new AbortController();
  let usage = null;
  let stopped = false;
  let timer = null;
  let limitsFlight = null;
  let limits = normalizeLimitsSummary({ providers: [], refreshMs: options.limitsRefreshMs });
  const listeners = new Set();
  const providerRuntimeState = new Map();
  let resolveReady;
  let rejectReady;
  let settled = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A daemon may serve its loading state while the initial scan fails and retries.
  ready.catch(() => {});
  let lastError = null;

  function publish() {
    if (stopped || !usage) return;
    const record = { ...usage, limits };
    for (const listener of listeners) {
      try { listener(record); } catch (error) { deps.onError?.(error); }
    }
  }

  function renewAntigravity({ account, credentials }) {
    const accounts = accountOptions.antigravityManagedAccounts || [];
    const stored = accounts.find((row) => row.id === account.id || row.accountKey === account.accountKey);
    if (!stored) return;
    stored.credentials = { ...credentials };
    if (!options.accountsFile || options.dryRun) return;
    // Preserve other private fields; never write these options into usage or HTTP DTOs.
    const current = JSON.parse(fs.readFileSync(options.accountsFile, 'utf8'));
    current.antigravityManagedAccounts = accounts;
    const temp = `${options.accountsFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, options.accountsFile);
    } finally {
      try { fs.unlinkSync(temp); } catch (_) {}
    }
  }

  async function probeLimits() {
    const rows = [];
    for (const provider of options.clients.split(',')) {
      if (stopped) return;
      const fetcher = deps.fetchers?.[provider] || LOADERS[provider]();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
      let result;
      try {
        result = await fetcher(accountOptions, {
          signal, providerRuntimeState, onAntigravityCredentialsRenewed: renewAntigravity,
          fetch: (url, init = {}) => (deps.fetch || fetch)(url, {
            ...init,
            signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal
          })
        });
      } catch (error) {
        result = normalizeLimitProvider({ provider, status: providerStatusFromError(error), updatedAt: new Date().toISOString(), windows: [] });
      }
      if (stopped) return;
      for (const row of (Array.isArray(result) ? result : [result]).filter(Boolean)) {
        const prior = limits.providers.find((old) => old.provider === provider && (!row.accountKey || old.accountKey === row.accountKey));
        if (prior?.windows?.length && ['error', 'unavailable', 'rateLimited', 'sourceRateLimited'].includes(row.status)) {
          rows.push({ ...prior, stale: true, status: row.status });
        } else rows.push(row);
      }
    }
    limits = normalizeLimitsSummary({ providers: rows, refreshMs: options.limitsRefreshMs, updatedAt: new Date().toISOString() });
    publish();
  }

  function refreshLimits() {
    if (stopped || !options.limitsEnabled) return Promise.resolve();
    if (limitsFlight) return limitsFlight;
    limitsFlight = probeLimits().catch((error) => deps.onError?.(error)).finally(() => {
      limitsFlight = null;
      if (!stopped && !options.once) timer = setTimer(refreshLimits, options.limitsRefreshMs);
    });
    return limitsFlight;
  }

  const collector = collect({
    clients: options.clients,
    deviceId: options.deviceId,
    agentVersion: appVersion(),
    agentRuntime: 'minimal',
    allTimeSince: options.allTimeSince,
    intervalMs: options.intervalMs,
    commandTimeoutMs: options.commandTimeoutMs,
    compactUsage: true,
    projectsEnabled: false,
    historyEnabled: false,
    dailyHistoryArchiveEnabled: false,
    anchorPersistenceEnabled: false,
    wslScanEnabled: false,
    watchEnabled: options.once ? false : options.watchEnabled,
    watchDebounceMs: 1500,
    watchUsePolling: false,
    logger: deps.logger,
    onUpdate(summary) {
      if (stopped) return;
      usage = summary;
      lastError = null;
      publish();
      if (!settled) { settled = true; resolveReady(summary); }
    },
    onError(error) {
      if (stopped) return;
      lastError = error.message;
      deps.onError?.(error);
      if (!settled) { settled = true; rejectReady(error); }
    }
  });
  refreshLimits();

  return {
    ready,
    getSnapshot: () => usage ? { ...usage, limits } : null,
    getError: () => lastError,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refreshUsage: () => stopped ? Promise.resolve(false) : collector.tick('manual', { todayOnly: true }),
    async whenReady() { await ready; await limitsFlight; return this.getSnapshot(); },
    async stop() {
      if (stopped) return;
      stopped = true;
      controller.abort(new Error('minimal stopped'));
      if (timer !== null) clearTimer(timer);
      listeners.clear();
      collector.stop();
      await Promise.allSettled([collector.whenIdle?.(), limitsFlight]);
    }
  };
}

module.exports = { createMinimalRuntime };
