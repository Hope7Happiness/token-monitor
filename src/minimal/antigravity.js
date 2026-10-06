'use strict';

const { execFile } = require('node:child_process');
const oauth = require('../shared/providers/antigravity/oauth');
const { fetchAntigravityLimits } = require('../shared/providers/antigravity/limits');

const KEYRING_PREFIX = 'go-keyring-base64:';
const STATE_KEY = 'antigravity:native-cli';

function parseCliCredential(text) {
  const value = String(text || '').trim();
  const payload = value.startsWith(KEYRING_PREFIX)
    ? Buffer.from(value.slice(KEYRING_PREFIX.length), 'base64').toString('utf8') : value;
  const saved = JSON.parse(payload);
  const token = saved?.token;
  if (saved.auth_method !== 'consumer' || !token?.access_token || !token?.refresh_token) return null;
  const identity = JSON.parse(Buffer.from(String(saved.id_token || '').split('.')[1] || '', 'base64url').toString('utf8'));
  const client = oauth._officialOAuthClient();
  // Only refresh a credential belonging to the supported desktop OAuth client.
  if (identity.aud !== client.clientId) return null;
  const email = String(identity.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  const expiresAt = Date.parse(token.expiry);
  if (!Number.isFinite(expiresAt)) return null;
  return {
    id: 'native-cli', accountEmail: email, enabled: true,
    credentials: {
      accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt, idToken: saved.id_token, ...client
    }
  };
}

async function readCliAccount(deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin' || deps.readMacKeychain === false) return null;
  deps.signal?.throwIfAborted();
  const execute = deps.execFile || execFile;
  const text = await new Promise((resolve, reject) => {
    execute('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, signal: deps.signal
    }, (error, stdout) => {
      // execFile errors can embed stdout, which contains credentials. Do not forward them.
      if (deps.signal?.aborted) return reject(deps.signal.reason);
      resolve(error ? '' : stdout);
    });
  });
  if (!text) return null;
  try { return parseCliCredential(text); } catch (_) { return null; }
}

async function fetchMinimalAntigravityLimits(options = {}, deps = {}) {
  const fetchLimits = deps.fetchAntigravityLimits || fetchAntigravityLimits;
  if (options.antigravityManagedAccounts?.length) return fetchLimits(options, deps);
  const state = deps.providerRuntimeState;
  const native = await readCliAccount(deps);
  if (!native) {
    state?.delete(STATE_KEY);
    return fetchLimits(options, deps);
  }
  const previous = state?.get(STATE_KEY);
  // Read the keychain each time to notice logout/account switches. Refreshed
  // credentials live only in main's runtime state; the CLI's keychain is read-only.
  const credentials = previous?.originalAccessToken === native.credentials.accessToken
    && previous?.originalRefreshToken === native.credentials.refreshToken
    && previous.accountEmail === native.accountEmail
    ? previous.credentials : native.credentials;
  const remember = (renewed) => state?.set(STATE_KEY, {
    accountEmail: native.accountEmail,
    originalAccessToken: native.credentials.accessToken,
    originalRefreshToken: native.credentials.refreshToken,
    credentials: { ...renewed }
  });
  remember(credentials);
  return fetchLimits({ ...options, antigravityManagedAccounts: [{ ...native, credentials }] }, {
    ...deps,
    // Native OAuth works with the CLI closed; don't duplicate it with RPC probes.
    antigravityProbe: async () => { throw new Error('Native CLI account uses OAuth'); },
    onAntigravityCredentialsRenewed: ({ credentials: renewed }) => remember(renewed)
  });
}

module.exports = { fetchMinimalAntigravityLimits, parseCliCredential, readCliAccount };
