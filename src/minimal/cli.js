'use strict';

const { loadDotEnv } = require('../shared/config');
const { readOptions } = require('./config');

async function main() {
  loadDotEnv();
  const options = readOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Token Monitor minimal — Codex, Claude Code, AGY

npm run service:start                 Start the background collector service
npm run tui                           View usage and quotas in your terminal
npm run service:status                Show background service status
npm run service:stop                  Stop the background service
npm run headless                      Run the API service in the foreground
npm run headless:once                 Print one usage + quota snapshot as JSON
npm run headless:once -- --dry-run     Collect without posting to a Hub

--clients codex,claude,antigravity     Restrict the supported tools
--interval 60000                      Usage interval in milliseconds (minimum 10000)
--limits 0                            Disable quota requests
--limitsRefreshMs 300000              Quota interval (minimum 60000)
--watch 1                             Opt into native live watching
--host 127.0.0.1 --port 17322          Dashboard bind address
--web 1                              Enable the optional browser dashboard
--hub https://hub.example             Optional existing Token Monitor Hub
--secret <secret>                     Dashboard / Hub bearer secret (or env)
--accountsFile /private/accounts.json Private managed quota accounts (chmod 600)
--since 2024-01-01                    Start date for all-time usage

See docs/minimal.md for server installation and systemd configuration.`);
    return;
  }
  const { createMinimalRuntime } = require('./runtime');
  const { createMinimalServer, listen } = require('./server');
  const { createOrderedSink } = require('../shared/orderedSink');
  const { postSyncPayload } = require('../shared/syncPayload');
  const { createOutboundFetch } = require('../shared/outboundFetch');
  const fetchFn = createOutboundFetch();
  const runtime = createMinimalRuntime(options, { fetch: fetchFn, onError: (error) => console.error(`[minimal] ${error.message}`) });
  const uploadAbort = new AbortController();
  async function upload(record) {
    const { response } = await postSyncPayload((url, init) => fetchFn(url, {
      ...init, redirect: 'error', signal: AbortSignal.any([uploadAbort.signal, AbortSignal.timeout(15000)])
    }), `${options.hubUrl}/api/ingest`, {
      headers: { 'content-type': 'application/json', 'x-token-monitor-response': 'minimal', ...(options.secret ? { authorization: `Bearer ${options.secret}` } : {}) },
      summary: record
    });
    if (!response.ok) throw new Error(`Hub responded ${response.status}`);
    await response.arrayBuffer();
  }
  let server;
  let sink;
  let revision = 0;
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    uploadAbort.abort();
    sink?.stop();
    server?.closeAllConnections();
    stopping = Promise.allSettled([
      runtime.stop(),
      server ? new Promise((resolve) => server.close(resolve)) : null
    ]);
    return stopping;
  }
  const onSignal = () => { stop().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (options.once || options.dryRun) {
      const record = await runtime.whenReady();
      if (options.hubUrl && !options.dryRun) await upload(record);
      console.log(JSON.stringify(record, null, 2));
      await stop();
      return;
    }
    if (options.hubUrl) {
      sink = createOrderedSink({ send: upload });
      runtime.subscribe((record) => sink.enqueue(record, ++revision).catch((error) => console.error(`[hub] ${error.message}`)));
    }
    server = createMinimalServer(runtime, options);
    const url = await listen(server, options);
    console.log(`Token Monitor service: ${url} · ${options.clients} · usage ${options.intervalMs / 1000}s · quotas ${options.limitsEnabled ? `${options.limitsRefreshMs / 1000}s` : 'off'} · web ${options.webEnabled ? 'on' : 'off'}`);
    process.send?.({ type: 'minimal-ready', url });
  } catch (error) {
    await stop();
    throw error;
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
