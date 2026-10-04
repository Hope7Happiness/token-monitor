'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

test('compact scans aggregate before crossing the subprocess boundary and skip transcript enrichment', async () => {
  const original = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ entries: [{ client: 'codex', model: 'gpt-5', input: 100, output: 20, cost: 1 }] }));
      child.emit('close', 0);
    });
    return child;
  };
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  try {
    const { collectUsageOnce } = require(collectorPath);
    let reads = 0;
    const options = {
      clients: 'codex', deviceId: 'test', allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000, historyEnabled: false, projectsEnabled: false, compactUsage: true,
      sessionMetadataDeps: { sessionMetadataResolvers: new Map([['codex', () => { reads++; return new Map(); }]]) }
    };
    const record = await collectUsageOnce(options);
    assert.equal(record.today.totalTokens, 120);
    assert.equal(record.today.costUsd, 1);
    assert.equal(record.month.totalTokens, 120);
    assert.equal(record.allTime.totalTokens, 120);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((args) => args[args.indexOf('--group-by') + 1] === 'client,model'));
    assert.equal(Object.keys(record.allTime.sessions).length, 0);
    await collectUsageOnce({ ...options, runTokscale: async () => ({ entries: [{ client: 'codex', sessionId: 'sample', model: 'gpt-5', input: 1 }] }) });
    assert.equal(reads, 0);
  } finally {
    childProcess.spawn = original;
    delete require.cache[collectorPath];
  }
});
