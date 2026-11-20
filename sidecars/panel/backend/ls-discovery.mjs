/**
 * @fileoverview Antigravity Hub / Language Server 本地守护文件与进程自动发现器。
 *
 * 兼容 Antigravity 2.0、Antigravity IDE、无头 `agy` CLI 与 `agy remote-control serve`：
 * 1. 优先读取 `~/.gemini/<product>/daemon/hub_*.json`（跨平台零外部命令依赖，毫秒级命中 `httpPort` + `csrfToken`）；
 * 2. 回退枚举当前用户的 `agy` / `antigravity-cli` / `language_server` 进程；
 * 3. 在精简版无头 Linux 环境优先通过 `/proc/<pid>/fd` + `/proc/net/tcp{,6}` 与 `ss -H -lntp` 解析监听端口，不强依赖 `lsof`；
 * 4. 经 `GetUserStatus` 实测握手验证后写入 `lsRuntimeEndpoint`。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_DIRS, lsRuntimeEndpoint, setLsRuntimeEndpoint } from './config.mjs';

const LS_DISC_COOLDOWN_MS = 4000;

const lsDiscoveryState = {
  inFlight: null,
  lastAttemptMs: 0,
};

function defaultIsLsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (typeof process?.kill !== 'function') return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 从 `agy`（`--hub` / `remote-control` / CLI）或 `language_server` 命令行字符串中提取端口号与 CSRF 令牌。
 *
 * @param {string} commandLine
 * @returns {{ hubPort: number|null, csrfToken: string, isHub: boolean, isLanguageServer: boolean }}
 */
export function parseLsArgsFromCommandLine(commandLine) {
  const cmd = String(commandLine || '').trim();
  if (!cmd) {
    return { hubPort: null, csrfToken: '', isHub: false, isLanguageServer: false };
  }
  const isAgyBinary = /(?:^|[\s/\\"'])(?:agy|antigravity-cli)(?:\.exe)?(?:["'\s]|$)/i.test(cmd);
  const isHub = isAgyBinary && /(?:--hub\b|\bremote-control\b|--csrf[-_]token\b)/i.test(cmd);
  const isLanguageServer = /language_server/i.test(cmd);

  let hubPort = null;
  const portMatch = cmd.match(
    /--(?:hub[-_]port|http[-_]port|https[-_]server[-_]port|server[-_]port)(?:=|\s+)["']?(\d{1,5})["']?(?=\s|$)/i
  );
  if (portMatch) {
    const num = Number(portMatch[1]);
    if (Number.isInteger(num) && num > 0 && num <= 65535) {
      hubPort = num;
    }
  }

  let csrfToken = '';
  const csrfMatch = cmd.match(/--csrf[-_]token(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i);
  if (csrfMatch) {
    csrfToken = String(csrfMatch[1] || csrfMatch[2] || csrfMatch[3] || '').trim();
  }

  return {
    hubPort,
    csrfToken,
    isHub,
    isLanguageServer,
  };
}

/**
 * 解析 Linux `/proc/net/tcp` 或 `/proc/net/tcp6` 内容，提取指定 socket inode 集合中处于 `0A` (LISTEN) 状态的本地端口。
 *
 * @param {string} tcpTableText
 * @param {Set<string>} socketInodes
 * @returns {number[]}
 */
export function parseLinuxProcNetTcpPorts(tcpTableText, socketInodes) {
  if (!tcpTableText || !(socketInodes instanceof Set) || socketInodes.size === 0) {
    return [];
  }
  const ports = new Set();
  for (const rawLine of String(tcpTableText).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^sl\b/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 10) continue;
    const localAddr = cols[1] || '';
    const stateHex = (cols[3] || '').toUpperCase();
    const inode = cols[9] || '';
    if (stateHex !== '0A' || !socketInodes.has(inode)) continue;
    const colonIdx = localAddr.lastIndexOf(':');
    if (colonIdx < 0) continue;
    const port = Number.parseInt(localAddr.slice(colonIdx + 1), 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      ports.add(port);
    }
  }
  return Array.from(ports);
}

/**
 * 解析 Linux `ss -H -lntp` 输出，提取归属于目标 `pid` 的监听端口。
 *
 * @param {string} ssOutput
 * @param {number} pid
 * @returns {number[]}
 */
export function parseSsListeningPorts(ssOutput, pid) {
  if (!ssOutput || !Number.isInteger(pid) || pid <= 0) return [];
  const pidTokenRe = new RegExp(`\\bpid=${pid}\\b`);
  const ports = new Set();
  for (const rawLine of String(ssOutput).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !pidTokenRe.test(line)) continue;
    const cols = line.split(/\s+/);
    const localCol = cols[3] || '';
    const m = localCol.match(/:(\d{1,5})$/);
    if (m) {
      const p = Number(m[1]);
      if (Number.isInteger(p) && p > 0 && p <= 65535) ports.add(p);
    }
  }
  return Array.from(ports);
}

async function readLinuxProcListeningPorts(pid, customProcFs = null) {
  try {
    const fsMod = customProcFs || (await import('node:fs'));
    const readlinkFn = fsMod.readlinkSync || fsMod.default?.readlinkSync;
    const readdirFn = fsMod.readdirSync || fsMod.default?.readdirSync || readdirSync;
    const readFileFn = fsMod.readFileSync || fsMod.default?.readFileSync || readFileSync;
    const existsFn = fsMod.existsSync || fsMod.default?.existsSync || existsSync;
    if (typeof readlinkFn !== 'function') return [];

    const fdDir = `/proc/${pid}/fd`;
    if (!existsFn(fdDir)) return [];
    const socketInodes = new Set();
    for (const fdName of readdirFn(fdDir)) {
      try {
        const target = String(readlinkFn(`${fdDir}/${fdName}`) || '');
        const m = target.match(/^socket:\[(\d+)\]$/);
        if (m) socketInodes.add(m[1]);
      } catch {
        // 忽略瞬态关闭的 fd
      }
    }
    if (socketInodes.size === 0) return [];

    const ports = new Set();
    for (const netFile of [`/proc/${pid}/net/tcp`, `/proc/${pid}/net/tcp6`, '/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsFn(netFile)) continue;
      try {
        const raw = String(readFileFn(netFile, 'utf8') || '');
        for (const p of parseLinuxProcNetTcpPorts(raw, socketInodes)) {
          ports.add(p);
        }
      } catch {
        // 忽略不可读的 proc 网络表
      }
    }
    return Array.from(ports);
  } catch {
    return [];
  }
}

function readHubDaemonCandidates(daemonDirs, preferredPids, isPidAliveFn) {
  const candidates = [];
  const seenKeys = new Set();
  for (const dir of Array.isArray(daemonDirs) ? daemonDirs : []) {
    if (!dir || !existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^hub_.*\.json$/i.test(name)) continue;
      const fullPath = join(dir, name);
      try {
        const st = statSync(fullPath);
        const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
        const csrfToken = String(parsed?.csrfToken || parsed?.csrf_token || '').trim();
        if (!csrfToken) continue;
        const pid = Number(parsed?.pid) || 0;
        if (pid > 0 && !isPidAliveFn(pid)) continue;
        const httpPort = Number(parsed?.httpPort || parsed?.port) || 0;
        const httpsPort = Number(parsed?.httpsPort) || 0;
        const targets = [];
        if (Number.isInteger(httpPort) && httpPort > 0 && httpPort <= 65535) {
          targets.push({ port: httpPort, protos: ['http', 'https'] });
        }
        if (
          Number.isInteger(httpsPort) &&
          httpsPort > 0 &&
          httpsPort <= 65535 &&
          httpsPort !== httpPort
        ) {
          targets.push({ port: httpsPort, protos: ['https', 'http'] });
        }
        if (targets.length === 0) continue;
        const dedupKey = `${pid}:${httpPort}:${httpsPort}:${csrfToken}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);
        const priority = preferredPids.has(pid) ? 115 : 95;
        candidates.push({
          pid,
          priority,
          mtimeMs: Number(st?.mtimeMs || 0),
          csrfToken,
          targets,
        });
      } catch {
        // 忽略损坏或正在替换的 daemon 文件
      }
    }
  }
  candidates.sort((a, b) => b.priority - a.priority || b.mtimeMs - a.mtimeMs || b.pid - a.pid);
  return candidates;
}

async function execLsDiscoveryCmd(file, args, timeoutMs = 5000) {
  const cpMod = await import('node:child_process');
  const execFileFn = cpMod.execFile || cpMod.default?.execFile;
  if (typeof execFileFn !== 'function') {
    throw new Error('child_process.execFile unavailable');
  }
  return new Promise((resolve, reject) => {
    execFileFn(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

function readLinuxProcCandidates() {
  if (!existsSync('/proc')) return [];
  const results = [];
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const rawCmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!rawCmd) continue;
        const commandLine = rawCmd.replace(/\0+/g, ' ').trim();
        if (!/agy|antigravity-cli|language_server/i.test(commandLine)) continue;
        let ppid = 0;
        try {
          const statRaw = readFileSync(`/proc/${pid}/stat`, 'utf8');
          const afterComm = statRaw.slice(statRaw.lastIndexOf(')') + 1).trim();
          const parts = afterComm.split(/\s+/);
          ppid = Number(parts[1]) || 0;
        } catch {
          // 忽略单进程 stat 读取失败
        }
        results.push({ pid, ppid, commandLine });
      } catch {
        // 忽略退出中的瞬态进程
      }
    }
  } catch {
    return [];
  }
  return results;
}

async function listCandidateOsProcesses(platform, execCmdFn) {
  if (platform === 'win32') {
    const psScript =
      "Get-CimInstance Win32_Process -Filter \"Name LIKE 'agy%' OR Name LIKE 'antigravity-cli%' OR Name LIKE 'language_server%'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = await execCmdFn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      psScript,
    ]);
    const trimmed = out.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({
        pid: Number(it.ProcessId) || 0,
        ppid: Number(it.ParentProcessId) || 0,
        commandLine: String(it.CommandLine || ''),
      }));
  }

  if (platform === 'linux') {
    const procList = readLinuxProcCandidates();
    if (procList.length > 0) return procList;
  }

  const psArgs =
    platform === 'darwin' ? ['-ax', '-o', 'pid=,ppid=,command='] : ['-ax', '-o', 'pid=,ppid=,args='];
  const out = await execCmdFn('ps', psArgs);
  const results = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const cmdLine = m[3];
    if (!/agy|antigravity-cli|language_server/i.test(cmdLine)) continue;
    results.push({
      pid: Number(m[1]) || 0,
      ppid: Number(m[2]) || 0,
      commandLine: cmdLine,
    });
  }
  return results;
}

async function findListeningPortsForPid(pid, platform, execCmdFn, procFs = null) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (platform === 'win32') {
    try {
      const out = await execCmdFn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`,
      ]);
      const trimmed = out.trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      const rawPorts = Array.isArray(parsed) ? parsed : [parsed];
      return Array.from(
        new Set(
          rawPorts
            .map(Number)
            .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
        )
      );
    } catch {
      return [];
    }
  }

  if (platform === 'linux') {
    const procPorts = await readLinuxProcListeningPorts(pid, procFs);
    if (procPorts.length > 0) return procPorts;
    try {
      const ssOut = await execCmdFn('ss', ['-H', '-lntp']);
      const ssPorts = parseSsListeningPorts(ssOut, pid);
      if (ssPorts.length > 0) return ssPorts;
    } catch {
      // 无 ss 或权限受限时继续回退至 lsof
    }
  }

  try {
    const out = await execCmdFn('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']);
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/:(\d{1,5})\s+\(LISTEN\)/i);
      if (m) {
        const p = Number(m[1]);
        if (p > 0 && p <= 65535) ports.add(p);
      }
    }
    return Array.from(ports);
  } catch {
    return [];
  }
}

async function probeLsCandidate(port, csrfToken, fetchFn, protos = ['http', 'https']) {
  for (const proto of protos) {
    try {
      const addr = `127.0.0.1:${port}`;
      const baseUrl = `${proto}://${addr}`;
      const res = await fetchFn(
        `${baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrfToken,
          },
          body: '{}',
          signal: AbortSignal.timeout(1500),
        }
      );
      if (res?.ok) {
        return { addr: proto === 'https' ? `https://${addr}` : addr, baseUrl, csrfToken };
      }
    } catch {
      // 继续尝试下一候选协议或端口
    }
  }
  return null;
}

/**
 * 自动探测并握手验证本机正在运行的 Antigravity Hub / Language Server RPC 端点。
 *
 * @param {{
 *   ppid?: number,
 *   ancestorPids?: number[],
 *   platform?: string,
 *   daemonDirs?: string[],
 *   isPidAliveFn?: (pid: number) => boolean,
 *   procFs?: object|null,
 *   execCmdFn?: (file: string, args: string[]) => Promise<string>,
 *   fetchFn?: typeof fetch
 * }} [options]
 * @returns {Promise<{ addr: string, baseUrl: string, csrfToken: string, pid: number } | null>}
 */
export async function discoverAntigravityLsEndpoint(options = {}) {
  const {
    ppid = Number(process?.ppid || 0),
    ancestorPids = [],
    platform = process?.platform || 'win32',
    daemonDirs = options.execCmdFn ? [] : DAEMON_DIRS,
    isPidAliveFn = defaultIsLsPidAlive,
    procFs = null,
    execCmdFn = execLsDiscoveryCmd,
    fetchFn = typeof fetch === 'function' ? fetch : null,
  } = options;

  if (typeof fetchFn !== 'function') return null;

  const preferredPids = new Set(
    [ppid, ...(Array.isArray(ancestorPids) ? ancestorPids : [])]
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  );

  // 1. 优先探测 ~/.gemini/<product>/daemon/hub_*.json 守护端点描述文件（零外部进程开销）
  const daemonCandidates = readHubDaemonCandidates(daemonDirs, preferredPids, isPidAliveFn);
  const probedDaemonKeys = new Set();
  for (const cand of daemonCandidates) {
    for (const target of cand.targets) {
      probedDaemonKeys.add(`${target.port}:${cand.csrfToken}`);
      const verified = await probeLsCandidate(target.port, cand.csrfToken, fetchFn, target.protos);
      if (verified) {
        return { ...verified, pid: cand.pid };
      }
    }
  }

  // 2. 回退枚举操作系统进程并解析监听端口
  let rawProcs = [];
  try {
    rawProcs = await listCandidateOsProcesses(platform, execCmdFn);
  } catch {
    return null;
  }
  if (!rawProcs.length) return null;

  const parsedCandidates = [];
  for (const proc of rawProcs) {
    const info = parseLsArgsFromCommandLine(proc.commandLine);
    if (!info.csrfToken || (!info.isHub && !info.isLanguageServer)) continue;
    let priority = 50;
    if (preferredPids.has(proc.pid)) {
      priority = 100;
    } else if (preferredPids.has(proc.ppid)) {
      priority = 90;
    } else if (info.isHub && info.hubPort) {
      priority = 80;
    }
    parsedCandidates.push({
      pid: proc.pid,
      priority,
      hubPort: info.hubPort,
      csrfToken: info.csrfToken,
    });
  }

  parsedCandidates.sort((a, b) => b.priority - a.priority || b.pid - a.pid);

  for (const cand of parsedCandidates) {
    const ports = cand.hubPort
      ? [cand.hubPort]
      : await findListeningPortsForPid(cand.pid, platform, execCmdFn, procFs);
    for (const port of ports) {
      if (probedDaemonKeys.has(`${port}:${cand.csrfToken}`)) continue;
      const verified = await probeLsCandidate(port, cand.csrfToken, fetchFn);
      if (verified) {
        return { ...verified, pid: cand.pid };
      }
    }
  }
  return null;
}

/**
 * 确保 `lsRuntimeEndpoint` 已就绪（具备并发去重、失败冷却与动态端点重连能力）。
 *
 * @param {{ force?: boolean, respectCooldown?: boolean, ancestorPids?: number[] }} [options]
 * @returns {Promise<boolean>}
 */
export async function ensureLsEndpointDiscovered({
  force = false,
  respectCooldown = false,
  ancestorPids = [],
} = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid') {
    return false;
  }
  if (!force && lsRuntimeEndpoint.baseUrl && (lsRuntimeEndpoint.csrfToken || !lsRuntimeEndpoint.isDynamic)) {
    return true;
  }
  if (lsDiscoveryState.inFlight) {
    return lsDiscoveryState.inFlight;
  }
  const now = Date.now();
  if (
    (!force || respectCooldown) &&
    lsDiscoveryState.lastAttemptMs > 0 &&
    now - lsDiscoveryState.lastAttemptMs < LS_DISC_COOLDOWN_MS
  ) {
    return Boolean(lsRuntimeEndpoint.baseUrl);
  }

  const envHintPids = String(process?.env?.USAGE_MONITOR_HOST_PPID || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  lsDiscoveryState.lastAttemptMs = now;
  lsDiscoveryState.inFlight = (async () => {
    try {
      const found = await discoverAntigravityLsEndpoint({
        ancestorPids: [...envHintPids, ...ancestorPids],
      });
      if (found && found.addr && found.csrfToken) {
        setLsRuntimeEndpoint(found.addr, found.csrfToken, { isDynamic: true });
        return true;
      }
      return Boolean(lsRuntimeEndpoint.baseUrl);
    } finally {
      lsDiscoveryState.inFlight = null;
    }
  })();

  return lsDiscoveryState.inFlight;
}

