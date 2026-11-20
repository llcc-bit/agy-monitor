/** @fileoverview Google OAuth identity and quota queries for saved Antigravity credentials. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildOfficialQuotaPools } from './quota-pools.mjs';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_USER_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CLOUD_CODE_HOSTS = ['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com'];
let nativeOAuthClients;

export function extractNativeOAuthClients(binary) {
  const pe = binary.length >= 64 && binary.readUInt16LE(0) === 0x5a4d ? binary.readUInt32LE(60) : 0;
  if (!pe || pe + 24 > binary.length || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x8664) return [];
  const count = binary.readUInt16LE(pe + 6);
  const table = pe + 24 + binary.readUInt16LE(pe + 20);
  if (table + count * 40 > binary.length) return [];

  const sections = Array.from({ length: count }, (_, i) => {
    const offset = table + i * 40;
    return {
      name: binary.toString('ascii', offset, offset + 8).replace(/\0+$/, ''),
      rva: binary.readUInt32LE(offset + 12),
      size: binary.readUInt32LE(offset + 16),
      start: binary.readUInt32LE(offset + 20),
    };
  });
  const text = sections.find(({ name }) => name === '.text');
  const rodata = sections.find(({ name }) => name === '.rdata');
  if (!text || !rodata || text.start + text.size > binary.length || rodata.start + rodata.size > binary.length) return [];
  const machineCode = binary.subarray(text.start, text.start + text.size);

  function readLiteral(displacementOffset, length) {
    const rva = text.rva + displacementOffset + 4 + machineCode.readInt32LE(displacementOffset);
    const offset = rva - rodata.rva;
    if (length > 100 || offset < 0 || offset + length > rodata.size) return '';
    return binary.toString('ascii', rodata.start + offset, rodata.start + offset + length);
  }

  // Go's x64 OAuth config initializer sets ClientID and ClientSecret as two consecutive pointer/length pairs.
  const idLength = Buffer.from([0x48, 0xc7, 0x40, 0x08]);
  const loadAndStoreId = Buffer.from([0x48, 0x8d, 0x0d]);
  const betweenLiterals = Buffer.from([0x48, 0x89, 0x08, 0x48, 0xc7, 0x40, 0x18]);
  const clients = new Map();
  for (let i = machineCode.indexOf(idLength); i >= 0 && i + 33 <= machineCode.length; i = machineCode.indexOf(idLength, i + 1)) {
    if (!machineCode.subarray(i + 8, i + 11).equals(loadAndStoreId) ||
        !machineCode.subarray(i + 15, i + 22).equals(betweenLiterals) ||
        !machineCode.subarray(i + 26, i + 29).equals(loadAndStoreId)) continue;
    const id = readLiteral(i + 11, machineCode.readUInt32LE(i + 4));
    const secret = readLiteral(i + 29, machineCode.readUInt32LE(i + 22));
    if (/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(id) && /^GOCSPX-[\w-]+$/.test(secret)) {
      clients.set(id, { id, secret });
    }
  }
  return Array.from(clients.values()).reverse();
}

async function loadNativeOAuthClients() {
  if (!nativeOAuthClients) {
    nativeOAuthClients = (async () => {
      const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
      const binaries = [
        join(local, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
        join(homedir(), '.gemini', 'bin', 'agy.exe'),
      ];
      for (const filename of binaries) {
        const binary = await readFile(filename).catch(() => null);
        const clients = binary ? extractNativeOAuthClients(binary) : [];
        if (clients.length) return clients;
      }
      return [];
    })();
  }
  const clients = await nativeOAuthClients;
  if (!clients.length) nativeOAuthClients = null;
  return clients;
}

export async function resolveGoogleCredential(credential, { refresh = false, fetchFn = fetch, getClients = loadNativeOAuthClients } = {}) {
  let { access_token: accessToken, refresh_token: refreshToken, expiry } = credential.token;
  let idToken = credential.id_token;
  if (refresh || !accessToken || Date.parse(expiry) <= Date.now() + 60_000) {
    const clients = await getClients();
    if (!clients.length) throw new Error('oauthClientUnavailable');
    let refreshed = false;
    for (const { id, secret } of clients) {
      const response = await fetchFn(OAUTH_TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(result?.error)) continue;
        throw new Error('oauthUnavailable');
      }
      if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('oauthUnavailable');
      accessToken = result.access_token;
      refreshToken = result.refresh_token || refreshToken;
      idToken = result.id_token;
      expiry = new Date(Date.now() + result.expires_in * 1000).toISOString();
      refreshed = true;
      break;
    }
    if (!refreshed) throw new Error('credentialRejected');
  }
  const userResponse = await fetchFn(OAUTH_USER_URL, {
    redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) throw new Error(userResponse.status === 401 ? 'credentialRejected' : 'oauthUnavailable');
  const user = await userResponse.json();
  if (!user.email || user.verified_email === false) throw new Error('credentialRejected');
  return {
    email: user.email,
    credential: {
      token: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expiry },
      auth_method: 'consumer',
      id_token_email: user.email,
      ...(idToken ? { id_token: idToken } : {}),
    },
  };
}

export async function retrieveCredentialQuota(accessToken, fetchFn = fetch) {
  async function post(method, data) {
    for (const host of CLOUD_CODE_HOSTS) {
      const response = await fetchFn(`https://${host}/v1internal:${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4500),
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(() => null);
      if (response?.ok) {
        const payload = await response.json().catch(() => null);
        if (payload) return payload.response ?? payload;
      }
      if (response?.status === 401 || response?.status === 403) break;
    }
    return null;
  }

  const setup = await post('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } });
  const project = setup?.cloudaicompanionProject?.id || setup?.cloudaicompanionProject;
  if (!setup) throw new Error('quotaUnavailable');
  const request = {
    project: typeof project === 'string' && project ? project : 'cloudaicompanion-enterprise',
  };
  const clientConfigs = setup.cascadeModelConfigData?.clientModelConfigs;
  const [summary, available] = await Promise.all([
    post('retrieveUserQuotaSummary', request),
    Array.isArray(clientConfigs) && clientConfigs.length ? null : post('fetchAvailableModels', request),
  ]);
  const configs = Array.isArray(clientConfigs) && clientConfigs.length ? clientConfigs :
    Object.entries(available?.models || {}).filter(([, model]) => model?.quotaInfo && !model.disabled)
      .map(([modelId, model]) => ({ modelId, modelOrAlias: { model: modelId }, label: model.displayName, quotaInfo: model.quotaInfo }));
  const raw = summary?.quotaSummary ?? summary;
  if (!Array.isArray(raw?.groups) && !Array.isArray(raw?.buckets) && !configs.length) throw new Error('quotaUnavailable');
  const adaptBuckets = (buckets) => (Array.isArray(buckets) ? buckets : []).map((bucket) => ({
    ...bucket,
    bucketId: bucket?.bucketId ?? bucket?.bucket_id,
    remainingFraction: bucket?.remainingFraction ?? bucket?.remaining_fraction,
    resetTime: bucket?.resetTime ?? bucket?.reset_time,
  }));
  const quota = {
    groups: (Array.isArray(raw?.groups) ? raw.groups : []).map((group) => ({
      ...group, displayName: group?.displayName || group?.name, buckets: adaptBuckets(group?.buckets),
    })),
    buckets: adaptBuckets(raw?.buckets),
  };
  const { quotaPoolsMap } = buildOfficialQuotaPools(quota, configs);
  return Array.from(quotaPoolsMap.values()).filter(({ isAvailable }) => isAvailable).map((pool) => ({
    poolKey: pool.poolKey,
    poolLabel: pool.poolLabel,
    remainingPct: pool.remainingPct,
    weeklyRemainingPct: pool.weeklyRemainingPct,
    resetTime: pool.resetTime,
    weeklyResetTime: pool.weeklyResetTime,
  }));
}
