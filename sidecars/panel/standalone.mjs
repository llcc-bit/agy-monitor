#!/usr/bin/env node
/**
 * @fileoverview Antigravity Usage Monitor 独立 Web 监控 CLI 入口 (`standalone.mjs`)。
 *
 * 在无头服务器 (`agy` / `agy remote-control serve`) 或纯终端环境下，脱离 `sidecar_sdk`
 * 直接拉起完整的四分页监控面板与 API 服务：
 * - `node sidecars/panel/standalone.mjs --port 8787`（配合 `ssh -L 8787:127.0.0.1:8787` 零鉴权安全访问）
 * - `node sidecars/panel/standalone.mjs --host 0.0.0.0 --port 8787 --token <secret>`（带访问令牌保护）
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function applyPreImportEnvOverrides(argv) {
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i] || '');
    if (!raw) continue;
    const eqIdx = raw.indexOf('=');
    const flag = eqIdx > 0 ? raw.slice(0, eqIdx) : raw;
    const readVal = () => {
      if (eqIdx > 0) return raw.slice(eqIdx + 1).trim();
      if (i + 1 < argv.length) {
        i += 1;
        return String(argv[i] || '').trim();
      }
      return '';
    };
    if (flag === '--data-dir') {
      const v = readVal();
      if (v) process.env.USAGE_MONITOR_DATA_DIR = v;
    } else if (flag === '--app-data-dir') {
      const v = readVal();
      if (v) process.env.USAGE_MONITOR_APP_DATA_DIR = v;
    } else if (flag === '--gemini-dir') {
      const v = readVal();
      if (v) process.env.ANTIGRAVITY_GEMINI_DIR = v;
    } else if (flag === '--ls-addr') {
      const v = readVal();
      if (v) process.env.ANTIGRAVITY_LS_ADDRESS = v;
    } else if (flag === '--csrf-token') {
      const v = readVal();
      if (v) process.env.ANTIGRAVITY_CSRF_TOKEN = v;
    }
  }
}

export async function runStandaloneCli(argv = process.argv.slice(2)) {
  applyPreImportEnvOverrides(argv);

  const {
    createStandaloneWebServer,
    formatStandaloneHelpText,
    parseStandaloneCliArgs,
  } = await import('./backend/standalone-server.mjs');
  const { DATA_DIR, lsRuntimeEndpoint } = await import('./backend/config.mjs');
  const { ensureLsEndpointDiscovered } = await import('./backend/ls-discovery.mjs');

  let parsed;
  try {
    parsed = parseStandaloneCliArgs(argv, process.env, { defaultPort: 8787 });
  } catch (err) {
    console.error(`[usage-monitor] ${err.message}`);
    process.exitCode = 1;
    return null;
  }

  if (parsed.help) {
    console.log(formatStandaloneHelpText());
    return null;
  }

  let controller;
  try {
    controller = createStandaloneWebServer({
      host: parsed.host,
      port: parsed.port,
      token: parsed.token,
      lsAddr: parsed.lsAddr,
      csrfToken: parsed.csrfToken,
    });
    const status = await controller.start();
    await ensureLsEndpointDiscovered({ force: false }).catch(() => false);
    const lsDesc = lsRuntimeEndpoint.baseUrl
      ? `connected (${lsRuntimeEndpoint.baseUrl})`
      : 'offline fallback (reading local transcripts/cache; will auto-connect when agy starts)';
    const authDesc = status.tokenProtected
      ? 'token required (--token)'
      : 'loopback-only (use ssh -L for remote access)';
    console.log(`[usage-monitor] Standalone Web UI listening at ${status.url}`);
    console.log(`[usage-monitor] Security mode: ${authDesc}`);
    console.log(`[usage-monitor] Language Server: ${lsDesc}`);
    console.log(`[usage-monitor] Data directory: ${DATA_DIR}`);
  } catch (err) {
    console.error(`[usage-monitor] Failed to start standalone server: ${err.message}`);
    process.exitCode = 1;
    return null;
  }

  let closing = false;
  const gracefulShutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await controller.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    void gracefulShutdown();
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown();
  });

  return controller;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  void runStandaloneCli();
}
