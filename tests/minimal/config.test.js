'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readOptions, readAccountOptions } = require('../../src/minimal/config');

test('minimal defaults select exactly three tools and disable recursive watching', () => {
  const options = readOptions([], {});
  assert.equal(options.clients, 'codex,claude,antigravity');
  assert.equal(options.watchEnabled, false);
  assert.equal(options.webEnabled, false);
  assert.equal(readOptions(['--web', '1'], {}).webEnabled, true);
  assert.equal(options.intervalMs, 60000);
  assert.equal(options.limitsRefreshMs, 300000);
  assert.equal(readOptions(['--watch', '1', '--clients', 'codex,claude'], {}).watchEnabled, true);
});

test('reject unsupported clients, timer overflows and unauthenticated remote binding', () => {
  for (const argv of [['--clients', 'cursor'], ['--clients', ''], ['--interval', 'Infinity'], ['--interval', '2147483648'], ['--limitsRefreshMs', '0'], ['--host', '0.0.0.0'], ['--secret'], ['--port'], ['--since', '2026-02-30']]) {
    assert.throws(() => readOptions(argv, {}));
  }
  assert.equal(readOptions(['--host', '0.0.0.0', '--secret', 'test'], {}).host, '0.0.0.0');
});

test('private account config is bounded and only provider options are admitted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-minimal-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, JSON.stringify({ claudeWebCookie: 'private', clients: 'cursor', codexManagedAccounts: [] }), { mode: 0o600 });
  assert.deepEqual(readAccountOptions(file), { claudeWebCookie: 'private', codexManagedAccounts: [] });
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o644);
    assert.throws(() => readAccountOptions(file), /private/);
  }
});
