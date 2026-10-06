'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { readOptions } = require('../../src/minimal/config');
const { servicePaths, readServiceState, childArguments, matchesServiceCommand, startService, stopService, isServiceRunning } = require('../../src/minimal/service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-background-'));
  const env = { TOKEN_MONITOR_SHARED_DIR: root, CODEX_HOME: path.join(root, 'codex'), TOKSCALE_CONFIG_DIR: path.join(root, 'tokscale'), TOKSCALE_PRICING_CACHE_ONLY: '1' };
  const paths = servicePaths(env);
  t.after(async () => { await stopService(paths); fs.rmSync(root, { force: true, recursive: true }); });
  return { paths, env };
}

test('service identity guards PID reuse and spawn arguments never contain the bearer secret', () => {
  const options = readOptions(['--secret', 'private-service-secret'], {});
  const id = '12345678-1234-1234-1234-123456789abc';
  const args = childArguments(options, id);
  assert.equal(args.join(' ').includes('private-service-secret'), false);
  assert.equal(matchesServiceCommand(args.join(' '), { id }), true);
  assert.equal(matchesServiceCommand(args.join(' '), { id: 'different-instance' }), false);
  assert.equal(matchesServiceCommand('node unrelated.js', { id }), false);
});

test('background service starts once, survives a client disconnect and stops gracefully', async (t) => {
  const { paths, env } = fixture(t);
  const options = readOptions(['--port', '0', '--clients', 'codex', '--limits', '0', '--secret', 'test-secret'], {});
  const state = await startService(options, paths, { env });
  assert.equal(await isServiceRunning(state), true);
  assert.equal((await startService(options, paths, { env })).pid, state.pid);
  assert.equal((await fetch(`${state.url}/api/health`)).status, 401);
  const health = await fetch(`${state.url}/api/health`, { headers: { authorization: 'Bearer test-secret' } });
  assert.equal(health.status, 200);
  await health.arrayBuffer();
  assert.equal((await fetch(`${state.url}/`)).status, 404);
  assert.equal(JSON.stringify(readServiceState(paths)).includes('test-secret'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(paths.state).mode & 0o077, 0);
    assert.equal(fs.statSync(paths.log).mode & 0o077, 0);
  }
  assert.equal(await isServiceRunning(state), true);
  assert.equal(await stopService(paths), true);
  assert.equal(await isServiceRunning(state), false);
  assert.equal(readServiceState(paths), null);
});

test('stale metadata cannot cause stop to signal an unrelated process', async (t) => {
  const { paths } = fixture(t);
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.state, JSON.stringify({ pid: process.pid, id: '12345678-1234-1234-1234-123456789abc', url: 'http://127.0.0.1:1' }));
  assert.equal(await stopService(paths), false);
  assert.equal(readServiceState(paths), null);
});

test('failed binding leaves no managed daemon or command lock behind', async (t) => {
  const { paths, env } = fixture(t);
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  await assert.rejects(startService(readOptions(['--port', String(blocker.address().port), '--clients', 'codex', '--limits', '0'], {}), paths, { env }), /exited before listening/);
  assert.equal(readServiceState(paths), null);
  assert.equal(fs.existsSync(paths.lock), false);
});

test('cancelling startup terminates the detached child and releases its lock', async (t) => {
  const { paths } = fixture(t);
  const controller = new AbortController();
  const child = new EventEmitter();
  let killed;
  let unreferenced = false;
  child.connected = true;
  child.kill = (signal) => { killed = signal; };
  child.disconnect = () => { child.connected = false; };
  child.unref = () => { unreferenced = true; };
  await assert.rejects(startService(readOptions([], {}), paths, {
    signal: controller.signal,
    spawn: () => { setImmediate(() => controller.abort()); return child; }
  }), /cancelled/);
  assert.equal(killed, 'SIGTERM');
  assert.equal(child.connected, false);
  assert.equal(unreferenced, true);
  assert.equal(fs.existsSync(paths.lock), false);
  assert.equal(readServiceState(paths), null);
});
