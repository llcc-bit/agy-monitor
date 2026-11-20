import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveGoogleCredential, retrieveCredentialQuota } from '../backend/account-oauth.mjs';
import { handleAccountCredentialAction, normalizeAccountCredential, runWindowsCredentialStore } from '../backend/account-switch.mjs';

test('accepts a shared OAuth credential or refresh token, and rejects other credential types', () => {
  const refreshToken = '1//synthetic-refresh-token-for-test';
  assert.deepEqual(JSON.parse(normalizeAccountCredential(refreshToken)), {
    auth_method: 'consumer',
    token: { access_token: '', token_type: 'Bearer', refresh_token: refreshToken, expiry: '1970-01-01T00:00:00.000Z' },
  });
  const saved = JSON.parse(normalizeAccountCredential(JSON.stringify({
    token: { refresh_token: refreshToken, access_token: 'example-access', expiry_timestamp: 1800000000 },
  })));
  assert.equal(saved.token.access_token, 'example-access');
  assert.equal(saved.token.expiry, '2027-01-15T08:00:00.000Z');
  assert.equal(normalizeAccountCredential(JSON.stringify({ auth_method: 'enterprise', refresh_token: refreshToken })), null);
  assert.equal(normalizeAccountCredential('example-api-key'), null);
});

test('import uses the verified email and switches only after checking the credential identity', async () => {
  const calls = [];
  const input = '1//synthetic-refresh-token-for-test';
  const credential = JSON.parse(normalizeAccountCredential(input));
  const saved = JSON.stringify(credential);
  let verifiedEmail = 'Next@example.com';
  const options = {
    platform: 'win32',
    resolveCredential: async (_credential, opts) => {
      calls.push(opts.refresh ? 'refresh-identity' : 'verify-identity');
      return { email: verifiedEmail, credential };
    },
    rpc: async (method) => {
      calls.push(method);
      return { userStatus: { email: 'Next@example.com' } };
    },
    store: async (request) => {
      calls.push(request.action);
      if (request.action === 'read') return { credential: saved };
      assert.equal(request.target, 'gemini:antigravity');
      assert.equal(request.email, 'next@example.com');
      if (request.action === 'switch') assert.equal(request.expectedCredential, saved);
      return { accounts: ['next@example.com'], selectedEmail: request.email, credential: saved };
    },
  };
  assert.deepEqual(await handleAccountCredentialAction({ action: 'save', email: 'ignored@example.com', credential: input }, options), {
    supported: true, accounts: ['next@example.com'], selectedEmail: 'next@example.com',
  });
  assert.deepEqual(calls.splice(0), ['refresh-identity', 'save']);
  const result = await handleAccountCredentialAction({ action: 'switch', email: 'NEXT@example.com' }, options);
  assert.deepEqual(result, { supported: true, accounts: ['next@example.com'], selectedEmail: 'next@example.com', confirmed: true });
  assert.deepEqual(calls.splice(0), ['read', 'verify-identity', 'switch', 'GetAuthStatus', 'GetUserStatus']);
  verifiedEmail = 'different@example.com';
  assert.deepEqual(await handleAccountCredentialAction({ action: 'switch', email: 'next@example.com' }, options), { error: 'identityMismatch' });
  assert.deepEqual(calls, ['read', 'verify-identity']);
});

test('a saved credential can query its quota without replacing the active login', async () => {
  const credential = normalizeAccountCredential(JSON.stringify({ refresh_token: 'test', access_token: 'saved-access' }));
  const pools = [{ poolKey: 'Gemini', remainingPct: 0, weeklyRemainingPct: 29 }];
  const result = await handleAccountCredentialAction({ action: 'quota', email: 'next@example.com' }, {
    platform: 'win32',
    store: async (request) => {
      assert.equal(request.action, 'read');
      return { credential };
    },
    resolveCredential: async (stored) => ({ email: 'next@example.com', credential: stored }),
    getQuota: async (token) => {
      assert.equal(token, 'saved-access');
      return pools;
    },
  });
  assert.deepEqual(result, { email: 'next@example.com', pools });
});

test('Google OAuth confirms the email and the same account token retrieves quota pools', async () => {
  const endpoints = [];
  const refreshToken = 'first-refresh';
  const token = { access_token: 'new-access', refresh_token: 'latest-refresh', expires_in: 3600 };
  const fetchFn = async (url, request) => {
    endpoints.push(url);
    assert.equal(request.redirect, 'error');
    if (url.endsWith('/token')) {
      assert.equal(request.body.get('refresh_token'), refreshToken);
      return { ok: true, json: async () => token };
    }
    assert.equal(request.headers.Authorization, 'Bearer new-access');
    if (url.endsWith('/userinfo')) return { ok: true, json: async () => ({ email: 'owner@example.com', verified_email: true }) };
    if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({ cloudaicompanionProject: { id: 'test-project' } }) };
    assert.equal(JSON.parse(request.body).project, 'test-project');
    if (url.endsWith(':fetchAvailableModels')) return { ok: true, json: async () => ({ models: {} }) };
    assert.match(url, /:retrieveUserQuotaSummary$/);
    return { ok: true, json: async () => ({ response: { quotaSummary: { groups: [
      { name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0 }, { window: 'weekly', remainingFraction: 0.29 }] },
    ] } } }) };
  };
  const resolved = await resolveGoogleCredential({ token: { refresh_token: refreshToken } }, {
    fetchFn, getClients: async () => [{ id: 'desktop-client', secret: 'test-config' }],
  });
  assert.equal(resolved.email, 'owner@example.com');
  assert.equal(resolved.credential.token.refresh_token, token.refresh_token);
  const pools = await retrieveCredentialQuota(resolved.credential.token.access_token, fetchFn);
  assert.deepEqual(pools.map(({ poolKey, remainingPct, weeklyRemainingPct }) => [poolKey, remainingPct, weeklyRemainingPct]), [['Gemini', 0, 29]]);
  assert.equal(endpoints.length, 5);
});

test('Windows vault atomically saves, reloads and removes encrypted entries', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('../.account-test-', import.meta.url)));
  const vault = join(directory, 'test.dpapi');
  const run = (action, email, credential) => runWindowsCredentialStore({ action, email, credential, vault });
  try {
    const credential = normalizeAccountCredential('1//synthetic-refresh-token-for-test');
    assert.deepEqual(await run('list'), { accounts: [], selectedEmail: '' });
    assert.deepEqual(await run('save', 'active@example.com', credential), { accounts: ['active@example.com'], selectedEmail: '' });
    assert.deepEqual(await run('save', 'next@example.com', credential), { accounts: ['active@example.com', 'next@example.com'], selectedEmail: '' });
    assert.deepEqual(await run('read', 'next@example.com'), { credential });
    assert.deepEqual(await runWindowsCredentialStore({ action: 'save', email: 'next@example.com', credential, expectedCredential: 'stale', vault }), { error: 'credentialChanged' });
    assert.equal((await readFile(vault)).includes('synthetic-refresh-token-for-test'), false);
    assert.deepEqual(await run('list'), { accounts: ['active@example.com', 'next@example.com'], selectedEmail: '' });
    assert.deepEqual(await run('remove', 'next@example.com'), { accounts: ['active@example.com'], selectedEmail: '' });
  } finally {
    await unlink(vault).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    await rmdir(directory);
  }
});
