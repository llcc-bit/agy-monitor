/** @fileoverview Antigravity shared credentials and the plugin's Windows credential vault. */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveGoogleCredential, retrieveCredentialQuota } from './account-oauth.mjs';
import { HERE } from './config.mjs';
import { callLsRpc } from './ls-rpc.mjs';

const ACCOUNT_ERRORS = new Set([
  'unsupported', 'invalidEmail', 'invalidCredential', 'credentialTooLarge', 'notFound',
  'noCurrentCredential', 'busy', 'storeFailed', 'rollbackFailed', 'credentialAccessDenied',
  'credentialChanged', 'credentialRejected', 'identityMismatch', 'oauthClientUnavailable',
  'oauthUnavailable', 'quotaUnavailable',
]);

export function normalizeAccountEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function normalizeAccountCredential(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 16384) return null;
  const text = input.trim();
  let source;
  try { source = JSON.parse(text); } catch {
    if (!/^1\/{1,2}[\w.-]{20,}$/.test(text)) return null;
    source = { refresh_token: text };
  }
  const token = source?.token || source;
  if (!token || (source.auth_method && source.auth_method !== 'consumer') ||
      typeof token.refresh_token !== 'string' || !token.refresh_token.trim() ||
      /\s/.test(token.refresh_token) || (token.token_type && !/^bearer$/i.test(token.token_type))) return null;
  const timestamp = token.expiry_date ?? (Number(token.expiry_timestamp) * 1000);
  const expiry = token.expiry || (Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 253402300799999
    ? new Date(timestamp).toISOString() : '1970-01-01T00:00:00Z');
  if (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry))) return null;
  const payload = {
    token: {
      access_token: typeof token.access_token === 'string' ? token.access_token : '',
      refresh_token: token.refresh_token,
      token_type: 'Bearer',
      expiry: new Date(expiry).toISOString(),
    },
    auth_method: 'consumer',
  };
  const idToken = source.id_token || token.id_token;
  if (typeof idToken === 'string' && idToken) payload.id_token = idToken;
  return JSON.stringify(payload);
}

export function runWindowsCredentialStore(request) {
  const script = readFileSync(join(HERE, 'backend', 'account-credentials.ps1'), 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const shell = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    // The helper exchanges private data over its pipes, keeping it out of process arguments.
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('storeFailed'));
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, ''))); } catch { reject(new Error('storeFailed')); }
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

function serializeHostCredential(credential) {
  let payload = JSON.stringify(credential);
  if (Buffer.byteLength(payload, 'utf8') > 2560 && credential.id_token) {
    const { id_token, ...compact } = credential;
    payload = JSON.stringify(compact);
  }
  if (Buffer.byteLength(payload, 'utf8') > 2560) throw new Error('credentialTooLarge');
  return payload;
}

async function confirmHostCredential(email, rpc) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await rpc('GetAuthStatus', {}, 1200).catch(() => null);
    const status = await rpc('GetUserStatus', {}, 1200).catch(() => null);
    if (normalizeAccountEmail(status?.userStatus?.email) === email) return true;
    if (attempt < 2) await delay(300);
  }
  return false;
}

export async function handleAccountCredentialAction(data, {
  platform = process.platform,
  store = runWindowsCredentialStore,
  rpc = callLsRpc,
  resolveCredential = resolveGoogleCredential,
  getQuota = retrieveCredentialQuota,
} = {}) {
  if (platform !== 'win32') return { supported: false, accounts: [], error: 'unsupported' };
  const action = data?.action || 'list';
  if (!['list', 'save', 'capture', 'switch', 'remove', 'quota'].includes(action)) return { error: 'invalidCredential' };
  const email = normalizeAccountEmail(data?.email);
  if (['switch', 'remove', 'quota'].includes(action) && !email) return { error: 'invalidEmail' };
  const gemini = join(homedir(), '.gemini');
  const config = {
    target: 'gemini:antigravity',
    vault: join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'AntigravityUsageMonitor', 'accounts.dpapi'),
    fallbacks: [join(gemini, 'jetski-standalone-oauth-token'), join(gemini, 'antigravity-cli', 'antigravity-oauth-token')],
  };
  async function runStore(fields) {
    const result = await store({ ...config, ...fields });
    if (!result || result.error) throw new Error(result?.error || 'storeFailed');
    return result;
  }

  function publicList(result) {
    return {
      supported: true,
      accounts: (Array.isArray(result.accounts) ? result.accounts : []).map(normalizeAccountEmail).filter(Boolean),
      selectedEmail: normalizeAccountEmail(result.selectedEmail),
    };
  }

  async function verifyCredential(raw, refresh = false) {
    const normalized = normalizeAccountCredential(raw);
    if (!normalized) throw new Error('invalidCredential');
    let result;
    try {
      result = await resolveCredential(JSON.parse(normalized), { refresh });
    } catch (error) {
      throw new Error(ACCOUNT_ERRORS.has(error?.message) ? error.message : 'oauthUnavailable');
    }
    result.email = normalizeAccountEmail(result.email);
    if (!result.email) throw new Error('credentialRejected');
    return result;
  }

  try {
    if (action === 'list' || action === 'remove') return publicList(await runStore({ action, email }));
    if (action === 'save') {
      const verified = await verifyCredential(data.credential, true);
      return publicList(await runStore({ action, email: verified.email, credential: serializeHostCredential(verified.credential) }));
    }
    if (action === 'capture') {
      const status = await rpc('GetUserStatus', {}, 2000).catch(() => null);
      const activeEmail = normalizeAccountEmail(status?.userStatus?.email);
      if (!activeEmail) throw new Error('noCurrentCredential');
      const { credential } = await runStore({ action: 'readCurrent' });
      const verified = await verifyCredential(credential);
      if (verified.email !== activeEmail) throw new Error('identityMismatch');
      return publicList(await runStore({ action: 'save', email: activeEmail, credential: serializeHostCredential(verified.credential) }));
    }

    const saved = await runStore({ action: 'read', email });
    const verified = await verifyCredential(saved.credential);
    if (verified.email !== email) throw new Error('identityMismatch');
    const credential = serializeHostCredential(verified.credential);
    if (action === 'quota') {
      if (credential !== saved.credential) {
        await runStore({ action: 'save', email, credential, expectedCredential: saved.credential });
      }
      const pools = await getQuota(verified.credential.token.access_token);
      return { email, pools };
    }
    const updated = await runStore({ action: 'switch', email, credential, expectedCredential: saved.credential });
    const confirmed = await confirmHostCredential(email, rpc);
    return { ...publicList(updated), confirmed };
  } catch (error) {
    return { error: ACCOUNT_ERRORS.has(error?.message) ? error.message : 'storeFailed' };
  }
}
