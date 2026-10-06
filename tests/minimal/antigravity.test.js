'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCliCredential, readCliAccount, fetchMinimalAntigravityLimits } = require('../../src/minimal/antigravity');
const oauth = require('../../src/shared/providers/antigravity/oauth');

function credential({ audience = oauth._officialOAuthClient().clientId, email = 'native@example.com', accessToken = 'native-access' } = {}) {
  const idToken = `header.${Buffer.from(JSON.stringify({ aud: audience, email })).toString('base64url')}.signature`;
  return `go-keyring-base64:${Buffer.from(JSON.stringify({
    auth_method: 'consumer', id_token: idToken,
    token: { access_token: accessToken, refresh_token: 'native-refresh', expiry: '2026-10-06T13:00:00Z' }
  })).toString('base64')}`;
}

function keychain(text) {
  return (file, args, options, callback) => {
    assert.equal(file, '/usr/bin/security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']);
    assert.equal(options.timeout, 5000);
    callback(null, text);
  };
}

test('native CLI keyring envelope maps expiry and the matching OAuth client', () => {
  const account = parseCliCredential(credential());
  assert.equal(account.accountEmail, 'native@example.com');
  assert.equal(account.credentials.expiresAt, Date.parse('2026-10-06T13:00:00Z'));
  assert.equal(account.credentials.clientId, oauth._officialOAuthClient().clientId);
  assert.equal(parseCliCredential(credential({ audience: 'different-client' })), null);
  assert.equal(parseCliCredential(credential({ email: '' })), null);
});

test('keychain absence/corruption is a fallback and subprocess errors never escape with secrets', async () => {
  assert.equal(await readCliAccount({ platform: 'linux', execFile: () => assert.fail('Unexpected keychain read') }), null);
  assert.equal(await readCliAccount({ platform: 'darwin', execFile: keychain('invalid JSON') }), null);
  assert.equal(await readCliAccount({ platform: 'darwin', execFile: (_file, _args, _options, callback) => {
    callback(Object.assign(new Error('private command output'), { stdout: 'secret' }), 'secret');
  } }), null);
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await assert.rejects(readCliAccount({ platform: 'darwin', signal: controller.signal, execFile: () => assert.fail('Unexpected subprocess') }), /stopped/);
});

test('native login keeps renewed credentials in runtime memory and notices account switches/logout', async () => {
  const state = new Map();
  let text = credential();
  const deps = {
    platform: 'darwin', providerRuntimeState: state,
    execFile: (...args) => keychain(text)(...args),
    fetchAntigravityLimits: async (options, injected) => {
      const account = options.antigravityManagedAccounts?.[0];
      if (!account) return { status: 'notConfigured' };
      await assert.rejects(injected.antigravityProbe(), /uses OAuth/);
      const before = account.credentials.accessToken;
      injected.onAntigravityCredentialsRenewed({ account, credentials: { ...account.credentials, accessToken: 'renewed' } });
      return { status: 'ok', accessToken: before, accountEmail: account.accountEmail };
    }
  };
  assert.equal((await fetchMinimalAntigravityLimits({}, deps)).accessToken, 'native-access');
  assert.equal((await fetchMinimalAntigravityLimits({}, deps)).accessToken, 'renewed');
  text = credential({ email: 'second@example.com', accessToken: 'second-access' });
  assert.equal((await fetchMinimalAntigravityLimits({}, deps)).accessToken, 'second-access');
  text = '';
  assert.equal((await fetchMinimalAntigravityLimits({}, deps)).status, 'notConfigured');
  assert.equal(state.size, 0);
});

test('explicit managed accounts take precedence over native login', async () => {
  const options = { antigravityManagedAccounts: [{ id: 'explicit' }] };
  const result = await fetchMinimalAntigravityLimits(options, {
    execFile: () => assert.fail('Unexpected native discovery'),
    fetchAntigravityLimits: async (received) => { assert.equal(received, options); return 'explicit'; }
  });
  assert.equal(result, 'explicit');
});

test('expired native login refreshes over OAuth with no running RPC service or credential file', async () => {
  const urls = [];
  let refreshes = 0;
  const state = new Map();
  const deps = {
    platform: 'darwin', providerRuntimeState: state, execFile: keychain(credential()),
    now: () => Date.parse('2026-10-06T14:00:00Z'),
    fetch: async (url, init) => {
      urls.push(url);
      if (url === oauth.TOKEN_URL) {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('client_id'), oauth._officialOAuthClient().clientId);
        assert.equal(body.get('refresh_token'), 'native-refresh');
        refreshes++;
        return { ok: true, json: async () => ({ access_token: 'fresh-access', expires_in: 3600 }) };
      }
      assert.equal(init.headers.authorization, 'Bearer fresh-access');
      if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({ cloudaicompanionProject: 'project' }) };
      assert.ok(url.startsWith('https://daily-cloudcode-pa.googleapis.com/'));
      return { ok: true, json: async () => ({ groups: [{ displayName: 'Gemini', buckets: [{ window: 'SESSION', remainingFraction: 0.6 }] }] }) };
    }
  };
  const first = await fetchMinimalAntigravityLimits({}, deps);
  assert.equal(first[0].status, 'ok');
  assert.equal(first[0].windows[0].usedPercent, 40);
  assert.equal(JSON.stringify(first).includes('fresh-access'), false);
  await fetchMinimalAntigravityLimits({}, deps);
  assert.equal(refreshes, 1);
  assert.equal(urls.some((url) => url.includes('127.0.0.1')), false);
});
