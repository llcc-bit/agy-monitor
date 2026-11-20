/**
 * @fileoverview Antigravity CLI (`agy`) 底部状态栏胶囊 (`statusLine`) 配置管理与终端 ANSI 渲染器。
 *
 * 负责两部分纯逻辑与安全落盘职责：
 * 1. 无损维护 `~/.gemini/antigravity-cli/settings.json` 中的 `statusLine` 配置：
 *    - 仅当 `~/.gemini/antigravity-cli` 目录已存在时生效；
 *    - 若用户已自行配置第三方 `statusLine.command`（非本插件 `cli-statusline.mjs`），严格原样保留绝不覆盖；
 *    - 开启时默认以 `stack_with_default: false` 单行内联接管底栏（左侧保留 `? for shortcuts`，中间渲染无底色监控指标，右侧保留 `auto · Model · effort`）；关闭时干净移除本插件托管项；
 * 2. 将 13 项胶囊槽位（`TOPBAR_SLOT_KEYS`）与多会话状态渲染为兼容 Windows `cmd.exe` (CP936) /
 *    PowerShell / Windows Terminal / macOS / Linux 的单行无底色 24-bit ANSI 状态条（仅使用标准前景 CSI SGR，
 *    避免深色背景色块突兀及 OSC 序列干扰 Bubble Tea 宽度计算）。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, lsRuntimeEndpoint, normalizeLanguageSetting, normalizeTopbarCapsuleSlots } from './config.mjs';
import {
  classifyCacheTier,
  classifySpeedTier,
  classifyStepCostTier,
  classifyTtftTier,
  formatCompactCapsuleCost,
  formatCompactCapsuleTtft,
  formatCompactTokens,
  resolveCapsuleQuotaSlotPct,
} from '../shared/telemetry-display-rules.mjs';

// 24-bit ANSI 前景 SGR 调色板（透明底色，与桌面端四档语义色阶及 CLI 原生底栏色调对齐，无任何背景填充或非 SGR 控制符）
const SGR_RESET = '\x1b[0m';
const SGR_BOLD = '\x1b[1m';
const SGR_FG_BRIGHT = '\x1b[38;2;226;232;240m';
const SGR_FG_NORMAL = '\x1b[38;2;203;213;225m';
const SGR_FG_MUTED = '\x1b[38;2;148;163;184m';
const SGR_FG_DIM = '\x1b[38;2;120;133;155m';
const SGR_FG_CHROME = '\x1b[38;2;136;142;150m';
const SGR_FG_SEP = '\x1b[38;2;90;100;116m';
const SGR_FG_DOT_IDLE = '\x1b[38;2;100;116;139m';
const SGR_FG_ACCENT = '\x1b[38;2;96;165;250m';
const SGR_FG_GOOD = '\x1b[38;2;52;211;153m';
const SGR_FG_INFO = '\x1b[38;2;56;189;248m';
const SGR_FG_WARN = '\x1b[38;2;251;191;36m';
const SGR_FG_DANGER = '\x1b[38;2;248;113;113m';
const SGR_FG_MODE_AUTO = '\x1b[38;2;234;179;8m';
const SGR_FG_MODE_VIOLET = '\x1b[38;2;192;132;252m';

function isCliStatusPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 解析 `~/.gemini/antigravity-cli/settings.json` 路径（支持 `ANTIGRAVITY_GEMINI_DIR` 覆盖）。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @returns {string}
 */
export function resolveCliSettingsPath(env = process.env, homeDir = homedir()) {
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  return join(geminiBase, 'antigravity-cli', 'settings.json');
}

/**
 * 优先解析本机已安装插件目录下的 `cli-statusline.mjs`，不存在时回退至当前运行目录 `HERE`。
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string, fallbackHere?: string }} [options]
 * @returns {string}
 */
export function resolvePreferredCliStatusLineScriptPath({
  env = process.env,
  homeDir = homedir(),
  fallbackHere = HERE,
} = {}) {
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  const installedCandidate = join(
    geminiBase,
    'config',
    'plugins',
    'usage-monitor',
    'sidecars',
    'panel',
    'cli-statusline.mjs'
  );
  if (existsSync(installedCandidate)) {
    return installedCandidate;
  }
  return join(fallbackHere, 'cli-statusline.mjs');
}

/**
 * 检测当前环境变量 `PATH` 中是否可直接定位 `node` 可执行文件。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [platform=process.platform]
 * @returns {boolean}
 */
export function detectNodeOnSystemPath(env = process.env, platform = process.platform) {
  const rawPath = String(env?.PATH || env?.Path || env?.path || '').trim();
  if (!rawPath) return false;
  const binNames = platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  const sep = platform === 'win32' ? ';' : delimiter;
  for (const rawDir of rawPath.split(sep)) {
    const cleanDir = rawDir.trim().replace(/^"+|"+$/g, '');
    if (!cleanDir) continue;
    for (const bin of binNames) {
      try {
        if (existsSync(join(cleanDir, bin))) return true;
      } catch {
        // 忽略无权限目录
      }
    }
  }
  return false;
}

function toPercentEncodedFileUrl(winOrPosixPath) {
  const clean = String(winOrPosixPath || '').trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(clean)) {
    const encoded = clean
      .split('/')
      .map((seg, idx) => (idx === 0 ? seg : encodeURIComponent(seg)))
      .join('/');
    return `file:///${encoded}#autorun`;
  }
  try {
    return `${pathToFileURL(clean).href}#autorun`;
  } catch {
    return `file://${encodeURI(clean)}#autorun`;
  }
}

/**
 * 构造跨平台安全的 `statusLine.command` 字符串：
 * - Windows 下 `agy.exe` 通过 Go `exec.Command("cmd", "/c", command)` 执行：Go 的 `syscall.EscapeArg`
 *   会把 `command` 内的任何双引号 `"` 转义成 `\"`，而 `cmd.exe` 不消费 `\"` 会将其原样传给 `node.exe`，
 *   导致 `argv[1]` 混入字面量双引号而找不到模块。因此 Windows 下严格避免在 `command` 中出现双引号 `"`：
 *   - 路径无空格时直接生成 `node C:/.../cli-statusline.mjs`；
 *   - 路径含空格时生成零双引号、零空格参数的 `node --input-type=module -e import('file:///C:/...%20.../cli-statusline.mjs#autorun')`；
 * - macOS / Linux 下由 `sh -c` 解析，正常使用标准引号包裹。
 *
 * @param {string} scriptPath
 * @param {{ platform?: string, execPath?: string, nodeOnPath?: boolean }} [options]
 * @returns {string}
 */
export function buildCliStatusLineCommand(
  scriptPath,
  {
    platform = process.platform,
    execPath = process.execPath,
    nodeOnPath = true,
  } = {}
) {
  const normScript = String(scriptPath || '').trim().replace(/\\/g, '/');
  if (platform === 'win32') {
    const normExec = String(execPath || 'node').trim().replace(/\\/g, '/');
    const runner = nodeOnPath || /\s/.test(normExec) ? 'node' : normExec;
    if (!/\s/.test(normScript)) {
      return `${runner} ${normScript}`;
    }
    const fileUrl = toPercentEncodedFileUrl(normScript).replace(/'/g, '%27');
    return `${runner} --input-type=module -e import('${fileUrl}')`;
  }
  if (nodeOnPath) {
    return `node "${normScript.replace(/"/g, '\\"')}"`;
  }
  const escapedExec = String(execPath || 'node').replace(/"/g, '\\"');
  const escapedScript = normScript.replace(/"/g, '\\"');
  return `"${escapedExec}" "${escapedScript}"`;
}

/**
 * 判断一条 `statusLine.command` 是否由本插件托管（指向 `cli-statusline.mjs`）。
 *
 * @param {unknown} cmd
 * @returns {boolean}
 */
export function isManagedCliStatusLineCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  return /(?:^|[\\/\s"'])cli-statusline\.mjs(?:#autorun)?(?:["')\s]|$)/i.test(trimmed);
}

/**
 * 在纯对象层面更新或移除本插件托管的 `statusLine` 配置，绝不覆盖用户自定义的第三方脚本。
 *
 * @param {unknown} rawObj
 * @param {{ enabled?: boolean, command?: string, stackWithDefault?: boolean }} [options]
 */
export function applyCliStatusLineToSettingsObject(
  rawObj,
  { enabled = true, command = '', stackWithDefault = false } = {}
) {
  const baseObj = isCliStatusPlainObject(rawObj) ? rawObj : {};
  const existing = baseObj.statusLine;

  if (isCliStatusPlainObject(existing)) {
    const existingCmd = typeof existing.command === 'string' ? existing.command.trim() : '';
    if (existingCmd && !isManagedCliStatusLineCommand(existingCmd)) {
      return {
        changed: false,
        preservedCustom: true,
        reason: 'custom_command_preserved',
        object: baseObj,
      };
    }
  } else if (existing !== undefined && existing !== null) {
    return {
      changed: false,
      preservedCustom: true,
      reason: 'custom_statusline_preserved',
      object: baseObj,
    };
  }

  if (!enabled) {
    if (!Object.prototype.hasOwnProperty.call(baseObj, 'statusLine')) {
      return {
        changed: false,
        alreadyRemoved: true,
        object: baseObj,
      };
    }
    const nextObj = { ...baseObj };
    delete nextObj.statusLine;
    return {
      changed: true,
      removed: true,
      object: nextObj,
    };
  }

  const cleanCmd = String(command || '').trim();
  if (!cleanCmd) {
    return {
      changed: false,
      reason: 'empty_command',
      object: baseObj,
    };
  }

  const prevBlock = isCliStatusPlainObject(existing) ? existing : {};
  const desiredPadding =
    Number.isInteger(prevBlock.padding) && prevBlock.padding >= 0 ? prevBlock.padding : 0;
  const desiredStack = typeof stackWithDefault === 'boolean' ? stackWithDefault : false;

  const nextStatusLine = {
    ...prevBlock,
    type: 'command',
    command: cleanCmd,
    enabled: true,
    padding: desiredPadding,
    stack_with_default: desiredStack,
  };

  const unchanged =
    isCliStatusPlainObject(existing) &&
    existing.type === nextStatusLine.type &&
    existing.command === nextStatusLine.command &&
    existing.enabled === nextStatusLine.enabled &&
    existing.padding === nextStatusLine.padding &&
    existing.stack_with_default === nextStatusLine.stack_with_default;

  if (unchanged) {
    return {
      changed: false,
      alreadyConfigured: true,
      object: baseObj,
    };
  }

  return {
    changed: true,
    configured: true,
    object: {
      ...baseObj,
      statusLine: nextStatusLine,
    },
  };
}

/**
 * 同步本插件在 `~/.gemini/antigravity-cli/settings.json` 中的托管 `statusLine` 配置。
 *
 * @param {{
 *   enabled?: boolean,
 *   env?: Record<string, string|undefined>,
 *   homeDir?: string,
 *   scriptPath?: string,
 *   platform?: string,
 *   execPath?: string,
 *   nodeOnPath?: boolean,
 * }} [options]
 */
export function ensureCliStatusLineConfigured({
  enabled = true,
  env = process.env,
  homeDir = homedir(),
  scriptPath = '',
  platform = process.platform,
  execPath = process.execPath,
  nodeOnPath,
} = {}) {
  if (
    lsRuntimeEndpoint.addr === 'test.invalid' &&
    String(env?.USAGE_MONITOR_ALLOW_TEST_CLI_SETTINGS || '') !== '1'
  ) {
    return { checked: false, updated: false, reason: 'test_sandbox_skipped' };
  }

  const settingsPath = resolveCliSettingsPath(env, homeDir);
  try {
    const cliDir = dirname(settingsPath);
    if (!existsSync(cliDir)) {
      return { checked: true, updated: false, reason: 'cli_dir_missing', settingsPath };
    }

    let currentObj = {};
    let eol = platform === 'win32' ? '\r\n' : '\n';
    if (existsSync(settingsPath)) {
      const rawText = readFileSync(settingsPath, 'utf8');
      if (rawText.includes('\r\n')) eol = '\r\n';
      else if (rawText.includes('\n')) eol = '\n';
      const trimmed = rawText.replace(/^\uFEFF/, '').trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          if (!isCliStatusPlainObject(parsed)) {
            return { checked: true, updated: false, reason: 'non_object_json', settingsPath };
          }
          currentObj = parsed;
        } catch {
          return { checked: true, updated: false, reason: 'invalid_json', settingsPath };
        }
      }
    } else if (!enabled) {
      return { checked: true, updated: false, alreadyRemoved: true, settingsPath };
    }

    const resolvedScript =
      scriptPath || resolvePreferredCliStatusLineScriptPath({ env, homeDir });
    const hasNodePath =
      typeof nodeOnPath === 'boolean' ? nodeOnPath : detectNodeOnSystemPath(env, platform);
    const command = buildCliStatusLineCommand(resolvedScript, {
      platform,
      execPath,
      nodeOnPath: hasNodePath,
    });

    const applied = applyCliStatusLineToSettingsObject(currentObj, { enabled, command });
    if (!applied.changed) {
      return {
        checked: true,
        updated: false,
        ...applied,
        command,
        settingsPath,
      };
    }

    const serialized = `${JSON.stringify(applied.object, null, 2).replace(/\n/g, eol)}${eol}`;
    const tmpPath = `${settingsPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, settingsPath);
    } catch {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // 忽略临时文件清理异常
      }
      writeFileSync(settingsPath, serialized, 'utf8');
    }

    return {
      checked: true,
      updated: true,
      ...applied,
      command,
      settingsPath,
    };
  } catch (err) {
    return {
      checked: true,
      updated: false,
      reason: 'io_error',
      error: err?.message || String(err),
      settingsPath,
    };
  }
}

// ---------------------------------------------------------------------------
// 胶囊槽位纯格式化与终端 ANSI 渲染（与前端 `metricRegistry.js` 语义阈值 1:1 对齐）
// ---------------------------------------------------------------------------

function cliStatusSpeedSgr(tokPerSec) {
  const tier = classifySpeedTier(tokPerSec);
  if (tier === 'good') return SGR_FG_GOOD;
  if (tier === 'info') return SGR_FG_INFO;
  if (tier === 'warn') return SGR_FG_WARN;
  if (tier === 'danger') return SGR_FG_DANGER;
  return SGR_FG_MUTED;
}

function cliStatusCacheSgr(cacheHitPct, promptTokens = null) {
  const tier = classifyCacheTier(cacheHitPct, promptTokens);
  if (tier === 'good') return SGR_FG_GOOD;
  if (tier === 'info') return SGR_FG_INFO;
  if (tier === 'warn') return SGR_FG_WARN;
  if (tier === 'danger') return SGR_FG_DANGER;
  return SGR_FG_MUTED;
}

function cliStatusCostSgr(costUsd) {
  const tier = classifyStepCostTier(costUsd);
  if (tier === 'danger') return SGR_FG_DANGER;
  if (tier === 'warn') return SGR_FG_WARN;
  return SGR_FG_NORMAL;
}

function cliStatusTtftSgr(ttftSec) {
  const tier = classifyTtftTier(ttftSec);
  if (tier === 'muted') return SGR_FG_MUTED;
  if (tier === 'danger') return SGR_FG_DANGER;
  if (tier === 'warn') return SGR_FG_WARN;
  return SGR_FG_NORMAL;
}

const cliFormatCompactCost = formatCompactCapsuleCost;
const cliFormatCompactTtft = formatCompactCapsuleTtft;
const cliFormatTokens = formatCompactTokens;
const cliResolveQuotaPct = resolveCapsuleQuotaSlotPct;

/**
 * 计算终端可见列宽（剥离 CSI SGR 转义序列，CJK 全角字符按 2 列、`●`/`◎`/`·` 与 ASCII 按 1 列计算）。
 *
 * @param {string} rawStr
 * @returns {number}
 */
export function cliDisplayWidth(rawStr) {
  const plain = String(rawStr || '').replace(/\x1b\[[0-9;]*m/g, '');
  let cols = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) || 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x0300 && cp <= 0x036f)) {
      continue;
    }
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33bf) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    cols += isWide ? 2 : 1;
  }
  return cols;
}

/**
 * 拆分 CLI 模型显示名与推理档位（例如将 `"Gemini 4 Hydrogen (Medium)"` 拆为 `"Gemini 4 Hydrogen"` + `"medium"`，
 * 与 `agy` 原生 `stripEffortSuffix` 显示效果一致）。
 *
 * @param {unknown} rawModelName
 * @param {unknown} [rawEffort]
 * @returns {{ modelName: string, effort: string }}
 */
export function parseCliModelAndEffort(rawModelName, rawEffort = '') {
  const cleanModel = String(rawModelName || '').trim();
  let modelName = cleanModel;
  let inferredEffort = '';
  const suffixMatch = cleanModel.match(/^(.*?)\s*\((minimal|low|medium|high|max|xhigh)\)\s*$/i);
  if (suffixMatch) {
    modelName = suffixMatch[1].trim();
    inferredEffort = suffixMatch[2].toLowerCase();
  }
  const explicitEffort = String(rawEffort || '')
    .trim()
    .replace(/^EFFORT_/i, '')
    .toLowerCase();
  return {
    modelName,
    effort: explicitEffort || inferredEffort,
  };
}

function normalizeCliCycleMode(rawMode) {
  const trimmed = String(rawMode || '')
    .trim()
    .replace(/^(?:AGENT_MODE_|PERMISSION_MODE_)/i, '')
    .toLowerCase();
  if (!trimmed || trimmed === 'none' || trimmed === 'default' || trimmed === 'unspecified') {
    return '';
  }
  return trimmed.replace(/_/g, '-');
}

function cliModeSgr(normMode) {
  if (normMode === 'auto') return SGR_FG_MODE_AUTO;
  if (normMode === 'plan') return SGR_FG_ACCENT;
  if (normMode === 'accept-edits' || normMode === 'edit') return SGR_FG_GOOD;
  if (normMode === 'best-of-n' || normMode === 'battle') return SGR_FG_MODE_VIOLET;
  return SGR_FG_CHROME;
}

function cliBuildLeftSegment({ vimMode = '', short = false, useColor = true } = {}) {
  const cleanVim = String(vimMode || '').trim().toUpperCase();
  const baseText = short
    ? '?'
    : cleanVim
      ? `${cleanVim} · ? for shortcuts`
      : '? for shortcuts';
  if (!useColor) return baseText;
  return `${SGR_FG_CHROME}${baseText}${SGR_RESET}`;
}

function cliBuildRightSegment({
  cycleMode = '',
  modelDisplayName = '',
  modelEffort = '',
  includeEffort = true,
  useColor = true,
} = {}) {
  const normMode = normalizeCliCycleMode(cycleMode);
  const { modelName, effort } = parseCliModelAndEffort(modelDisplayName, modelEffort);
  const plainParts = [];
  const styledParts = [];

  if (normMode) {
    plainParts.push(normMode);
    styledParts.push(useColor ? `${cliModeSgr(normMode)}${normMode}${SGR_RESET}` : normMode);
  }
  if (modelName) {
    plainParts.push(modelName);
    styledParts.push(useColor ? `${SGR_FG_CHROME}${modelName}${SGR_RESET}` : modelName);
  }
  if (includeEffort && effort) {
    plainParts.push(effort);
    styledParts.push(useColor ? `${SGR_FG_CHROME}${effort}${SGR_RESET}` : effort);
  }
  if (plainParts.length === 0) return '';
  if (!useColor) return plainParts.join(' · ');
  const dotSep = `${SGR_FG_CHROME} · ${SGR_RESET}`;
  return styledParts.join(dotSep);
}

function cliComposeBalancedThreeColumn(leftStr, centerStr, rightStr, maxWidth) {
  const lw = cliDisplayWidth(leftStr);
  const cw = cliDisplayWidth(centerStr);
  const rw = cliDisplayWidth(rightStr);
  if (leftStr && rightStr) {
    const free = maxWidth - lw - cw - rw;
    if (free < 4) return '';
    const leftGap = Math.floor(free / 2);
    const rightGap = free - leftGap;
    return `${leftStr}${' '.repeat(leftGap)}${centerStr}${' '.repeat(rightGap)}${rightStr}`;
  }
  if (leftStr && !rightStr) {
    if (lw + cw + 2 > maxWidth) return '';
    const idealCenterStart = Math.max(lw + 2, Math.floor((maxWidth - cw) / 2));
    const leftGap = Math.min(maxWidth - lw - cw, idealCenterStart - lw);
    return `${leftStr}${' '.repeat(leftGap)}${centerStr}`;
  }
  if (!leftStr && rightStr) {
    const free = maxWidth - cw - rw;
    if (free < 2) return '';
    return `${centerStr}${' '.repeat(free)}${rightStr}`;
  }
  return cw <= maxWidth ? centerStr : '';
}

/**
 * 将单槽位指标格式化为纯文本与无背景前景语义 SGR 片段。
 */
function cliRenderSingleSlot(metricKey, slotCtx, { isEn = false, useColor = true, slotSet } = {}) {
  const hasTelemetry = slotCtx.hasTelemetry !== false;

  if (metricKey === 'context') {
    const valid = hasTelemetry && slotCtx.usedPct != null && Number.isFinite(Number(slotCtx.usedPct));
    const pctNum = valid ? Math.max(0, Math.min(100, Math.round(Number(slotCtx.usedPct)))) : null;
    const textVal = pctNum != null ? `${pctNum}%` : '--%';
    if (!useColor) {
      return `◎ ${textVal}`;
    }
    const isDanger = pctNum != null && pctNum >= 88;
    const isWarn = !isDanger && pctNum != null && pctNum >= 70;
    const ringColor = isDanger
      ? SGR_FG_DANGER
      : isWarn
        ? SGR_FG_WARN
        : pctNum != null
          ? SGR_FG_ACCENT
          : SGR_FG_MUTED;
    const valColor = isDanger
      ? `${SGR_BOLD}${SGR_FG_DANGER}`
      : isWarn
        ? `${SGR_BOLD}${SGR_FG_WARN}`
        : pctNum != null
          ? `${SGR_BOLD}${SGR_FG_BRIGHT}`
          : SGR_FG_MUTED;
    return `${ringColor}◎ ${valColor}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'tps') {
    const valid = hasTelemetry && Number.isFinite(Number(slotCtx.tps)) && Number(slotCtx.tps) > 0;
    const numVal = valid ? Number(slotCtx.tps) : 0;
    const textVal = valid
      ? `${numVal >= 100 ? Math.round(numVal) : numVal.toFixed(1)} t/s`
      : slotCtx.isRunning
        ? isEn
          ? 'Gen...'
          : '生成中...'
        : isEn
          ? 'Idle'
          : '空闲';
    if (!useColor) return textVal;
    const color = valid
      ? `${SGR_BOLD}${cliStatusSpeedSgr(numVal)}`
      : slotCtx.isRunning
        ? SGR_FG_INFO
        : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'avg_tps') {
    const valid =
      hasTelemetry && Number.isFinite(Number(slotCtx.avgTps)) && Number(slotCtx.avgTps) > 0;
    const numVal = valid ? Number(slotCtx.avgTps) : 0;
    const needPrefix = slotSet?.has('tps');
    const prefix = needPrefix ? (isEn ? 'avg ' : '均 ') : '';
    const textVal = valid
      ? `${prefix}${numVal >= 100 ? Math.round(numVal) : numVal.toFixed(1)} t/s`
      : `${prefix}-- t/s`;
    if (!useColor) return textVal;
    const color = valid ? cliStatusSpeedSgr(numVal) : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'ttft') {
    const valid =
      hasTelemetry && slotCtx.ttft != null && Number.isFinite(Number(slotCtx.ttft)) && Number(slotCtx.ttft) >= 0;
    const textVal = valid ? cliFormatCompactTtft(Number(slotCtx.ttft)) : '--s';
    if (!useColor) return textVal;
    const color = valid ? cliStatusTtftSgr(Number(slotCtx.ttft)) : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'cost' || metricKey === 'session_cost') {
    const rawVal = !hasTelemetry
      ? null
      : metricKey === 'session_cost'
        ? slotCtx.sessionCost
        : slotCtx.stepCost;
    const needPrefix =
      metricKey === 'session_cost' && slotSet?.has('cost') ? (isEn ? 'sum ' : '总 ') : '';
    const textVal = `${needPrefix}${hasTelemetry ? cliFormatCompactCost(rawVal) : '--'}`;
    if (!useColor) return textVal;
    const color =
      metricKey === 'cost' && hasTelemetry && rawVal != null
        ? cliStatusCostSgr(rawVal)
        : rawVal != null
          ? SGR_FG_NORMAL
          : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'cache_hit') {
    const valid =
      hasTelemetry && slotCtx.cacheHitPct != null && Number.isFinite(Number(slotCtx.cacheHitPct));
    const numVal = valid ? Math.max(0, Math.min(100, Math.round(Number(slotCtx.cacheHitPct)))) : 0;
    const prefix = isEn ? 'cache ' : '缓 ';
    const textVal = valid ? `${prefix}${numVal}%` : `${prefix}--%`;
    if (!useColor) return textVal;
    const color = valid
      ? cliStatusCacheSgr(Number(slotCtx.cacheHitPct), slotCtx.latestPromptTokens)
      : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'session_tokens') {
    const valid =
      hasTelemetry &&
      slotCtx.sessionTokens != null &&
      Number.isFinite(Number(slotCtx.sessionTokens)) &&
      Number(slotCtx.sessionTokens) >= 0;
    const textVal = valid ? `${cliFormatTokens(Number(slotCtx.sessionTokens))} tok` : '-- tok';
    if (!useColor) return textVal;
    return `${valid ? SGR_FG_NORMAL : SGR_FG_MUTED}${textVal}${SGR_RESET}`;
  }

  const quotaPct = hasTelemetry ? cliResolveQuotaPct(slotCtx.quotas, metricKey) : null;
  const textVal =
    quotaPct != null
      ? isEn
        ? `${quotaPct}% left`
        : `余 ${quotaPct}%`
      : isEn
        ? 'Quota --'
        : '余 --%';
  if (!useColor) return textVal;
  const isDanger = quotaPct != null && quotaPct <= 15;
  const isWarn = !isDanger && quotaPct != null && quotaPct <= 30;
  const color = isDanger
    ? `${SGR_BOLD}${SGR_FG_DANGER}`
    : isWarn
      ? `${SGR_BOLD}${SGR_FG_WARN}`
      : SGR_FG_MUTED;
  return `${color}${textVal}${SGR_RESET}`;
}

/**
 * 渲染单行无背景 CLI 底部状态条（传入 `terminalWidth > 0` 时自动合成「左快捷键提示 + 居中指标 + 右模式与模型」三栏单行布局）。
 *
 * @param {{
 *   hasTelemetry?: boolean,
 *   usedPct?: number|null,
 *   isRunning?: boolean,
 *   hasWaiting?: boolean,
 *   runningCount?: number,
 *   runningSubCount?: number,
 *   tps?: number|null,
 *   avgTps?: number|null,
 *   ttft?: number|null,
 *   stepCost?: number|null,
 *   sessionCost?: number|null,
 *   cacheHitPct?: number|null,
 *   latestPromptTokens?: number|null,
 *   sessionTokens?: number|null,
 *   quotas?: object|null,
 * }} slotCtx
 * @param {{
 *   slots?: string[],
 *   showMultiSession?: boolean,
 *   language?: string,
 *   color?: boolean,
 *   terminalWidth?: number,
 *   cycleMode?: string,
 *   modelDisplayName?: string,
 *   modelEffort?: string,
 *   vimMode?: string,
 * }} [options]
 * @returns {string}
 */
export function formatCliStatusLineCapsule(slotCtx = {}, options = {}) {
  const slots = normalizeTopbarCapsuleSlots(options.slots);
  const showMulti = options.showMultiSession !== false;
  const normLang = normalizeLanguageSetting(options.language);
  const isEn = normLang === 'en-US';
  const useColor = options.color !== false;
  const slotSet = new Set(slots);

  const runningCount = Math.max(0, Math.floor(Number(slotCtx.runningCount) || 0));
  const runningSubCount = Math.max(0, Math.floor(Number(slotCtx.runningSubCount) || 0));
  const hasWaiting = Boolean(slotCtx.hasWaiting);

  let multiCore = '';
  if (showMulti) {
    const labelText =
      runningCount > 0
        ? runningSubCount > 0
          ? isEn
            ? `${runningCount} active · ${runningSubCount} sub`
            : `${runningCount} 运行中 · ${runningSubCount} 子`
          : isEn
            ? `${runningCount} active`
            : `${runningCount} 运行中`
        : isEn
          ? '0 active'
          : '0 运行中';
    if (!useColor) {
      multiCore = `● ${labelText}`;
    } else {
      const dotSgr =
        runningCount > 0
          ? hasWaiting
            ? SGR_FG_WARN
            : SGR_FG_GOOD
          : SGR_FG_DOT_IDLE;
      const textSgr = runningCount > 0 ? SGR_FG_NORMAL : SGR_FG_DIM;
      multiCore = `${dotSgr}● ${textSgr}${labelText}${SGR_RESET}`;
    }
  }

  const renderedSlots = slots.map((key) =>
    cliRenderSingleSlot(key, slotCtx, { isEn, useColor, slotSet })
  );
  const sep = useColor ? `${SGR_FG_SEP} | ${SGR_RESET}` : ' | ';
  const slotsBody = renderedSlots.join(sep);
  const fullCapsule = multiCore ? `${multiCore}   ${slotsBody}` : slotsBody;

  const rawWidth = Number(options.terminalWidth);
  if (!Number.isFinite(rawWidth) || rawWidth <= 0) {
    return fullCapsule;
  }

  // 预留右侧 1 列安全边距，与 `agy` 原生底栏右边缘对齐并避免 Windows `conhost`/`cmd.exe` 末列自动折行
  const maxWidth = Math.max(1, Math.floor(rawWidth) - 1);
  const compactCapsule = multiCore ? `${multiCore}  ${slotsBody}` : slotsBody;
  const fullLeft = cliBuildLeftSegment({ vimMode: options.vimMode, short: false, useColor });
  const shortLeft = cliBuildLeftSegment({ vimMode: '', short: true, useColor });
  const fullRight = cliBuildRightSegment({
    cycleMode: options.cycleMode,
    modelDisplayName: options.modelDisplayName,
    modelEffort: options.modelEffort,
    includeEffort: true,
    useColor,
  });
  const compactRight = cliBuildRightSegment({
    cycleMode: options.cycleMode,
    modelDisplayName: options.modelDisplayName,
    modelEffort: options.modelEffort,
    includeEffort: false,
    useColor,
  });

  const tier1 = cliComposeBalancedThreeColumn(fullLeft, fullCapsule, fullRight, maxWidth);
  if (tier1) return tier1;

  const tier2 = cliComposeBalancedThreeColumn(shortLeft, fullCapsule, fullRight, maxWidth);
  if (tier2) return tier2;

  const tier3 = cliComposeBalancedThreeColumn(shortLeft, compactCapsule, compactRight, maxWidth);
  if (tier3) return tier3;

  const tier4 = cliComposeBalancedThreeColumn('', compactCapsule, compactRight, maxWidth);
  if (tier4) return tier4;

  if (cliDisplayWidth(fullCapsule) <= maxWidth) {
    return fullCapsule;
  }
  return slotsBody;
}
