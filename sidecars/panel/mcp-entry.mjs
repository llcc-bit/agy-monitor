/**
 * @fileoverview 零工具开销的轻量 MCP Stdio 宿主保活入口 (`mcp_config.json`)。
 *
 * 设计原因：
 * Antigravity IDE 默认关闭了 UI Sidecar 管理器 (`enable-sidecars = false`)，不会启动 `sidecar.json`。
 * 通过将本文件注册为插件内置的 0 工具 MCP Stdio 服务：
 * 1. `agy --hub` 启动或启用插件时会自动拉起本进程，从而托管启动 `bridge-daemon.mjs` 将胶囊挂载至 IDE 顶栏；
 * 2. `tools/list` 返回空数组 `[]`，不注入任何工具定义，消耗 0 个上下文 Token；
 * 3. 用户在 Customizations 中关闭插件开关或退出 IDE 时，`agy --hub` 关闭 `stdin`，
 *    本进程立即通知 `bridge-daemon.mjs` 卸载窗口顶栏组件并干净退出。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MANIFEST_PATH = join(dirname(dirname(PANEL_DIR)), 'plugin.json');
const DAEMON_SCRIPT_PATH = join(PANEL_DIR, 'bridge-daemon.mjs');

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';

export function readMcpServerVersion() {
  try {
    if (existsSync(PLUGIN_MANIFEST_PATH)) {
      const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // 忽略清单读取失败
  }
  return '1.4.4';
}

/**
 * 纯函数处理单条 MCP JSON-RPC 2.0 消息；通知类消息（无 `id`）返回 `null`。
 *
 * @param {object} msg
 * @param {string} [serverVersion='1.4.4']
 * @returns {object|null}
 */
export function handleMcpJsonRpcMessage(msg, serverVersion = '1.4.4') {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  if (!hasId) {
    return null;
  }
  const id = msg.id;
  const method = String(msg.method || '');

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '').trim();
    const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested)
      ? requested
      : DEFAULT_MCP_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'usage-monitor-host',
          version: serverVersion,
        },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [] } };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }

  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

function startMcpHostSupervisor() {
  const serverVersion = readMcpServerVersion();
  let shuttingDown = false;
  let daemonChild = null;
  let respawnTimer = null;
  let rapidCrashCount = 0;
  let lastSpawnMs = 0;

  function spawnDaemon() {
    if (shuttingDown) return;
    lastSpawnMs = Date.now();
    const child = spawn(process.execPath, [DAEMON_SCRIPT_PATH], {
      cwd: PANEL_DIR,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...process.env,
        USAGE_MONITOR_HOST_PPID: `${process.ppid || 0},${process.pid || 0}`,
      },
    });
    daemonChild = child;

    child.stderr?.on('data', (chunk) => {
      try {
        process.stderr.write(chunk);
      } catch {
        // 忽略日志转发异常
      }
    });

    child.on('exit', (code) => {
      if (daemonChild === child) {
        daemonChild = null;
      }
      if (shuttingDown) return;

      const ranDurationMs = Date.now() - lastSpawnMs;
      let delayMs = code === 0 ? 120 : 350;
      if (code !== 0 && ranDurationMs < 10_000) {
        rapidCrashCount += 1;
        delayMs = Math.min(30_000, 1000 * 2 ** Math.min(rapidCrashCount - 1, 5));
      } else {
        rapidCrashCount = 0;
      }

      if (respawnTimer) clearTimeout(respawnTimer);
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        spawnDaemon();
      }, delayMs);
    });

    child.on('error', () => {
      // 交由 exit 回调或退避重试统一处理
    });
  }

  function shutdownSupervisor() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    const child = daemonChild;
    if (!child) {
      process.exit(0);
      return;
    }
    const forceExitTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略强杀异常
      }
      process.exit(0);
    }, 1800);
    forceExitTimer.unref?.();

    child.once('exit', () => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });

    try {
      child.stdin?.write('SHUTDOWN_DISPOSE\n');
      child.stdin?.end();
    } catch {
      try {
        child.kill();
      } catch {
        // 忽略异常
      }
      process.exit(0);
    }
  }

  let framingMode = 'line';
  let rawBuffer = Buffer.alloc(0);

  function writeJsonRpcResponse(payload, mode) {
    const serialized = JSON.stringify(payload);
    if (mode === 'lsp') {
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
    } else {
      process.stdout.write(`${serialized}\n`);
    }
  }

  function dispatchParsedPayload(parsed, mode) {
    if (Array.isArray(parsed)) {
      const batchOut = parsed
        .map((item) => handleMcpJsonRpcMessage(item, serverVersion))
        .filter(Boolean);
      if (batchOut.length > 0) {
        writeJsonRpcResponse(batchOut, mode);
      }
      return;
    }
    const response = handleMcpJsonRpcMessage(parsed, serverVersion);
    if (response) {
      writeJsonRpcResponse(response, mode);
    }
  }

  function drainInputBuffer() {
    while (rawBuffer.length > 0) {
      const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString('utf8');
      if (/^Content-Length:/i.test(preview.trimStart())) {
        framingMode = 'lsp';
        const sepIdx = rawBuffer.indexOf('\r\n\r\n');
        const lfSepIdx = sepIdx < 0 ? rawBuffer.indexOf('\n\n') : -1;
        const headerEnd = sepIdx >= 0 ? sepIdx : lfSepIdx;
        const sepLen = sepIdx >= 0 ? 4 : 2;
        if (headerEnd < 0) return;

        const headerStr = rawBuffer.subarray(0, headerEnd).toString('utf8');
        const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          rawBuffer = rawBuffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(lenMatch[1]);
        const totalFrameLen = headerEnd + sepLen + contentLen;
        if (rawBuffer.length < totalFrameLen) return;

        const bodyStr = rawBuffer.subarray(headerEnd + sepLen, totalFrameLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalFrameLen);
        try {
          dispatchParsedPayload(JSON.parse(bodyStr), 'lsp');
        } catch {
          // 忽略损坏帧
        }
        continue;
      }

      const nlIdx = rawBuffer.indexOf(0x0a);
      if (nlIdx < 0) return;
      const lineStr = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
      rawBuffer = rawBuffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        dispatchParsedPayload(JSON.parse(lineStr), framingMode);
      } catch {
        // 忽略非 JSON 行
      }
    }
  }

  process.stdin.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    rawBuffer = rawBuffer.length === 0 ? buf : Buffer.concat([rawBuffer, buf]);
    drainInputBuffer();
  });

  process.stdin.on('end', shutdownSupervisor);
  process.stdin.on('close', shutdownSupervisor);
  process.on('SIGTERM', shutdownSupervisor);
  process.on('SIGINT', shutdownSupervisor);
  process.stdin.resume();

  spawnDaemon();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  startMcpHostSupervisor();
}

