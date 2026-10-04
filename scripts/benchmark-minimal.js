'use strict';

// Reproducible local benchmark; synthetic transcripts, no user logs or network.
// Measures Node collector RSS/CPU (excludes Electron and the tokscale child).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

async function child(mode, home) {
  const { collectUsageOnce, resolvePlatformBinary } = require('../src/shared/collector');
  // runTokscale keeps binary compatibility/fallback behavior. Custom scan paths
  // isolate the generated transcripts without changing the user's HOME.
  const started = performance.now();
  const before = process.cpuUsage();
  const compact = mode === 'minimal';
  const record = await collectUsageOnce({
    clients: 'codex', deviceId: 'benchmark', allTimeSince: '2024-01-01',
    homeDir: home, commandTimeoutMs: 120000, historyEnabled: false,
    projectsEnabled: false, compactUsage: compact,
    customScanPaths: { codex: [path.join(home, '.codex', 'sessions')] },
    runTokscale: async ({ flags }) => {
      const result = spawnSync(resolvePlatformBinary().path, [
        '--json', '--client', 'codex', '--home', home,
        '--group-by', compact ? 'client,model' : 'client,session,model', ...flags
      ], { encoding: 'utf8', env: process.env, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
      if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
      return JSON.parse(result.stdout);
    }
  });
  const cpu = process.cpuUsage(before);
  console.log(JSON.stringify({
    mode, wallMs: Math.round(performance.now() - started),
    nodeCpuMs: Math.round((cpu.user + cpu.system) / 1000),
    peakNodeRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    snapshotBytes: Buffer.byteLength(JSON.stringify(record)),
    sessions: Object.keys(record.allTime.sessions).length,
    tokens: record.allTime.totalTokens, costUsd: record.allTime.costUsd
  }));
}

async function main() {
  if (process.argv[2] === '--child') return child(process.argv[3], process.argv[4]);
  const count = Number(process.argv[2] || 10000);
  if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error('Session count must be 1–100000');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-minimal-benchmark-'));
  try {
    const sessions = path.join(home, '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const timestamp = new Date().toISOString();
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      const records = [
        { timestamp, type: 'session_meta', payload: { id, cwd: home, timestamp, originator: 'codex_cli_rs' } },
        { timestamp, type: 'turn_context', payload: { cwd: home, model: 'gpt-5' } },
        { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 1100 },
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 1100 }
        } } }
      ];
      fs.writeFileSync(path.join(sessions, `rollout-${id}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    }
    const measurements = [];
    for (const mode of ['full', 'minimal']) {
      const configDir = path.join(home, `config-${mode}`);
      fs.mkdirSync(path.join(configDir, 'cache'), { recursive: true });
      for (const source of ['litellm', 'openrouter', 'models-dev']) {
        fs.writeFileSync(path.join(configDir, 'cache', `pricing-${source}.json`), JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), data: {} }));
      }
      const result = spawnSync(process.execPath, [__filename, '--child', mode, home], {
        encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024,
        env: { ...process.env, CODEX_HOME: path.join(home, '.codex'), TOKSCALE_CONFIG_DIR: configDir,
          TOKSCALE_PRICING_CACHE_ONLY: '1', TOKSCALE_EXTRA_DIRS: '', TOKEN_MONITOR_SHARED_DIR: path.join(home, 'monitor') }
      });
      if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
      measurements.push(JSON.parse(result.stdout.trim()));
    }
    if (!measurements[0].tokens || measurements[0].tokens !== measurements[1].tokens || measurements[0].costUsd !== measurements[1].costUsd) {
      throw new Error('Benchmark usage parity failed');
    }
    console.log(JSON.stringify({ sessionsGenerated: count, scope: 'Node collector only; three serial scans; quotas/history/watch disabled; synthetic Codex data', measurements }, null, 2));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
