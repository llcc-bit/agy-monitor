/**
 * @fileoverview Antigravity CLI (`agy`) 轻量底部状态栏入口 (`cli-statusline.mjs`)。
 *
 * 由 `agy` TUI 在会话状态变更时通过 `statusLine` 配置拉起（300ms 节流，stdin 传入 `StatusLineData` JSON）：
 * 1. 秒级合并三路数据源：
 *    - `stdin` 实时状态（`agent_state`、`context_window.used_percentage`、`cost`、`subagents`、`cwd`）；
 *    - `~/.gemini/antigravity-cli/conversations/<cid>.db` 最新一步的纳秒级 `TPS` / `TTFT` / 缓存命中率；
 *    - `DATA_DIR/cli-status-snapshot.json` 中的官方配额池余量与跨端在线会话计数；
 * 2. 联动用户偏好设置中的胶囊槽位顺序（`topbarCapsuleSlots`）与开关（`enableCliStatusLine`），
 *    向 `stdout` 输出单行 24-bit ANSI 状态胶囊。
 *
 * 同时支持手动管理命令：
 * - `node sidecars/panel/cli-statusline.mjs --install`
 * - `node sidecars/panel/cli-statusline.mjs --uninstall`
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractModelSteps,
  speedMetric,
  summarizeSpeed,
  summarizeTtft,
} from './trajectory-metrics.mjs';
import {
  readLocalSqliteTrajectory,
  readLocalSummaryIndex,
} from './backend/cli-sqlite-reader.mjs';
import { withReadOnlySqliteDb } from './backend/sqlite-client.mjs';
import {
  ensureCliStatusLineConfigured,
  formatCliStatusLineCapsule,
} from './backend/cli-statusline-config.mjs';
import {
  CLI_STATUS_SNAPSHOT_FILE,
  loadJson,
  loadSettings,
} from './backend/config.mjs';
import { computeStepCost, createStepModelResolver } from './backend/model-pricing.mjs';
import { isThirdPartyPoolText } from './shared/telemetry-display-rules.mjs';

const CLI_RUNNING_STALE_MS = 10 * 60 * 1000;
const SNAPSHOT_LIVE_RUNNING_TTL_MS = 20 * 1000;
const SNAPSHOT_QUOTA_TTL_MS = 6 * 3600 * 1000;

function loadFreshestCliStatusSnapshot(geminiBase) {
  if (String(process.env.USAGE_MONITOR_DATA_DIR || '').trim()) {
    return loadJson(CLI_STATUS_SNAPSHOT_FILE, null);
  }
  const candidates = [
    CLI_STATUS_SNAPSHOT_FILE,
    join(geminiBase, 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data', 'cli-status-snapshot.json'),
    join(geminiBase, 'antigravity-cli', 'sidecar_data', 'usage-monitor', 'panel', 'data', 'cli-status-snapshot.json'),
  ];
  let best = null;
  let bestTs = -1;
  const seen = new Set();
  for (const file of candidates) {
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = loadJson(file, null);
    if (!snap || typeof snap !== 'object') continue;
    const ts = Number.isFinite(Number(snap.updatedAtMs)) ? Number(snap.updatedAtMs) : 0;
    if (!best || ts > bestTs) {
      best = snap;
      bestTs = ts;
    }
  }
  return best;
}

function readStdinJsonWithTimeout(timeoutMs = 220) {
  if (process.stdin.isTTY) {
    return Promise.resolve(null);
  }
  return new Promise((resolveDone) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.pause();
      } catch {
        // 忽略关闭异常
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveDone(null);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolveDone(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        resolveDone(null);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

function normalizePathForMatch(rawPath) {
  const clean = String(rawPath || '')
    .trim()
    .replace(/^file:\/\/\/?/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

function extractConversationIdFromStdin(stdinData) {
  if (!stdinData || typeof stdinData !== 'object') return '';
  const direct = String(
    stdinData.conversation_id ||
      stdinData.conversationId ||
      stdinData.session_id ||
      stdinData.sessionId ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      ''
  )
    .trim()
    .toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(direct)) {
    return direct;
  }
  const transcriptPath = String(stdinData.transcript_path || stdinData.transcriptPath || '');
  const m = transcriptPath.match(
    /[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]/i
  );
  return m ? m[1].toLowerCase() : '';
}

function findConversationIdByWorkspaceFts(cliRoot, cwd) {
  if (!cwd) return '';
  const summariesDbPath = join(cliRoot, 'conversation_summaries.db');
  if (!existsSync(summariesDbPath)) return '';

  const normCwd = normalizePathForMatch(cwd);
  if (!normCwd) return '';

  try {
    const matched = withReadOnlySqliteDb(summariesDbPath, (db) => {
      const rows = db
        .prepare(
          `SELECT conversation_id, workspace, last_modified_time
             FROM conversations_fts
            WHERE chunk_index = -1
            ORDER BY last_modified_time DESC
            LIMIT 40`
        )
        .all();
      for (const row of rows || []) {
        const ws = normalizePathForMatch(row?.workspace);
        const cid = String(row?.conversation_id || '').trim().toLowerCase();
        if (cid && ws && ws === normCwd) {
          return cid;
        }
      }
      return '';
    });
    return matched || '';
  } catch {
    // 忽略不存在 conversations_fts 表或读取失败
    return '';
  }
}

/**
 * 解析当前 CLI 窗口对应的本地 `.db` 会话轨迹并计算最新测速、延迟、缓存与成本指标。
 *
 * @param {{ cliRoot: string, stdinData?: object|null, nowMs?: number }} params
 */
export function resolveCliLocalSessionMetrics({
  cliRoot,
  stdinData = null,
  nowMs = Date.now(),
}) {
  const convDir = join(cliRoot, 'conversations');
  const summariesMap = existsSync(cliRoot) ? readLocalSummaryIndex([cliRoot]) : new Map();

  let runningRootCount = 0;
  let runningSubCount = 0;
  for (const summary of summariesMap.values()) {
    const isFreshRunning =
      summary.status === 'CASCADE_RUN_STATUS_RUNNING' &&
      summary.lastModifiedMs > 0 &&
      nowMs - summary.lastModifiedMs <= CLI_RUNNING_STALE_MS;
    if (!isFreshRunning) continue;
    if (summary.parentConversationId) runningSubCount += 1;
    else runningRootCount += 1;
  }

  if (!existsSync(convDir)) {
    return {
      found: false,
      runningRootCount,
      runningSubCount,
    };
  }

  let targetCid = extractConversationIdFromStdin(stdinData);
  if (!targetCid && stdinData?.cwd) {
    const ftsCid = findConversationIdByWorkspaceFts(cliRoot, stdinData.cwd);
    if (ftsCid && existsSync(join(convDir, `${ftsCid}.db`))) {
      targetCid = ftsCid;
    }
  }

  let dbPath = targetCid ? join(convDir, `${targetCid}.db`) : '';
  if (!dbPath || !existsSync(dbPath)) {
    let candidates = [];
    try {
      candidates = readdirSync(convDir)
        .filter((name) => name.endsWith('.db'))
        .map((name) => {
          const cid = name.slice(0, -3).toLowerCase();
          const full = join(convDir, name);
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(full).mtimeMs || 0;
          } catch {
            // 忽略单文件 stat 异常
          }
          const summary = summariesMap.get(cid);
          return {
            cid,
            full,
            mtimeMs,
            isSubagent: Boolean(summary?.parentConversationId),
          };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      candidates = [];
    }

    const picked = candidates.find((c) => !c.isSubagent) || candidates[0];
    if (picked) {
      targetCid = picked.cid;
      dbPath = picked.full;
    }
  }

  if (!dbPath || !existsSync(dbPath)) {
    return {
      found: false,
      runningRootCount,
      runningSubCount,
    };
  }

  let traj = readLocalSqliteTrajectory(dbPath);
  if (traj?.parentConversationId) {
    const rootDb = join(convDir, `${traj.rootConversationId || traj.parentConversationId}.db`);
    if (existsSync(rootDb)) {
      const rootTraj = readLocalSqliteTrajectory(rootDb);
      if (rootTraj) {
        targetCid = traj.rootConversationId || traj.parentConversationId;
        traj = rootTraj;
      }
    }
  }

  if (!traj || !Array.isArray(traj.steps) || traj.steps.length === 0) {
    return {
      found: false,
      cascadeId: targetCid,
      runningRootCount,
      runningSubCount,
    };
  }

  const steps = extractModelSteps(traj.steps, traj.generatorMetadata || []);
  if (steps.length === 0) {
    return {
      found: false,
      cascadeId: targetCid,
      runningRootCount,
      runningSubCount,
    };
  }

  const resolveStepModel = createStepModelResolver(new Map());
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let sessionCostUsd = 0;
  let hasPricedStep = false;
  let latestStepCostUsd = null;
  let latestCacheHitPct = null;
  let latestPromptTokens = null;
  let latestContextTokens = 0;
  let latestLimitTokens = 0;
  let latestTps = null;
  let latestTtft = null;

  for (const step of steps) {
    const inTok = Math.max(0, Number(step.inputTokens || 0));
    const cacheTok = Math.max(0, Number(step.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(step.outputTokens || 0));
    const promptTok = inTok + cacheTok;

    totalInputTokens += inTok;
    totalCacheReadTokens += cacheTok;
    totalOutputTokens += outTok;

    const modelInfo = resolveStepModel(step);
    const stepUsd = computeStepCost(step, modelInfo?.pricing || null);
    if (stepUsd !== null && Number.isFinite(stepUsd)) {
      sessionCostUsd += stepUsd;
      latestStepCostUsd = stepUsd;
      hasPricedStep = true;
    } else {
      latestStepCostUsd = null;
    }

    if (promptTok > 0) {
      latestCacheHitPct = +((cacheTok / promptTok) * 100).toFixed(1);
    }
    latestPromptTokens = promptTok;
    latestContextTokens =
      Number(step.estimatedContextTokens || 0) > 0
        ? Number(step.estimatedContextTokens)
        : promptTok + outTok;
    if (Number(step.maxContextBudgetTokens || 0) > 0) {
      latestLimitTokens = Number(step.maxContextBudgetTokens);
    }

    if (!step.isCompactionStep) {
      const sm = speedMetric(step);
      if (sm.value !== null && Number.isFinite(sm.value)) {
        latestTps = +sm.value.toFixed(1);
      }
      if (step.ttftSec !== null && Number.isFinite(step.ttftSec) && step.ttftSec >= 0) {
        latestTtft = step.ttftSec;
      }
    }
  }

  const speedSum = summarizeSpeed(steps);
  const ttftSum = summarizeTtft(steps);
  const totalPromptAll = totalInputTokens + totalCacheReadTokens;
  const sessionCacheHitPct =
    totalPromptAll > 0 ? +((totalCacheReadTokens / totalPromptAll) * 100).toFixed(1) : null;

  return {
    found: true,
    cascadeId: targetCid,
    stepCount: steps.length,
    runningRootCount,
    runningSubCount,
    tps: latestTps,
    avgTps: speedSum?.avgTokPerSec != null ? +speedSum.avgTokPerSec.toFixed(1) : null,
    ttft: latestTtft ?? ttftSum?.avgSec ?? null,
    stepCost: latestStepCostUsd,
    sessionCost: hasPricedStep ? sessionCostUsd : null,
    cacheHitPct: latestCacheHitPct ?? sessionCacheHitPct,
    latestPromptTokens,
    sessionTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
    usedPct:
      latestLimitTokens > 0 && latestContextTokens > 0
        ? Math.min(100, +((latestContextTokens / latestLimitTokens) * 100).toFixed(1))
        : null,
  };
}

function buildStdinFallbackQuotas(stdinData) {
  const rawQuota = stdinData?.quota;
  if (!rawQuota || typeof rawQuota !== 'object' || Array.isArray(rawQuota)) {
    return null;
  }
  const pools = [];
  for (const [key, bucket] of Object.entries(rawQuota)) {
    if (!bucket || typeof bucket !== 'object' || bucket.disabled) continue;
    const frac = Number(bucket.remaining_fraction);
    if (!Number.isFinite(frac)) continue;
    const remainingPct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    const isThirdParty = isThirdPartyPoolText(key);
    pools.push({
      poolKey: isThirdParty ? 'Claude & GPT' : 'Gemini',
      poolLabel: key,
      family: isThirdParty ? 'claude' : 'gemini',
      remainingPct,
    });
  }
  if (pools.length === 0) return null;
  const modelStr = String(stdinData?.model?.id || stdinData?.model?.display_name || '');
  const activeIsThirdParty = isThirdPartyPoolText(modelStr);
  const matchingPools = pools.filter((p) =>
    activeIsThirdParty ? p.poolKey === 'Claude & GPT' : p.poolKey === 'Gemini'
  );
  const activePool = (matchingPools.length > 0 ? matchingPools : pools).reduce((minP, cur) =>
    cur.remainingPct < minP.remainingPct ? cur : minP
  );
  return {
    activePool,
    pools,
  };
}

/**
 * 融合 `stdin` (`StatusLineData`)、本地 CLI SQLite 步骤指标与后台守护配额快照，生成胶囊上下文。
 */
export function buildMergedCliCapsuleContext({
  stdinData = null,
  localMetrics = null,
  snapshot = null,
  nowMs = Date.now(),
} = {}) {
  const agentState = String(stdinData?.agent_state || '').trim().toLowerCase();
  const stdinIsRunning =
    agentState === 'running' ||
    agentState === 'streaming' ||
    agentState === 'executing' ||
    agentState === 'thinking';
  const stdinIsWaiting = agentState === 'waiting' || agentState === 'awaiting_approval';

  const stdinSubagents = Array.isArray(stdinData?.subagents)
    ? stdinData.subagents.filter((s) => {
        const st = String(s?.state || s?.status || '').toUpperCase();
        return !st.includes('KILLED') && !st.includes('DONE') && !st.includes('COMPLETED');
      }).length
    : 0;

  const snapAgeMs =
    snapshot && Number.isFinite(Number(snapshot.updatedAtMs))
      ? Math.max(0, nowMs - Number(snapshot.updatedAtMs))
      : Infinity;
  const snapLiveFresh = snapAgeMs <= SNAPSHOT_LIVE_RUNNING_TTL_MS;
  const snapQuotaFresh = snapAgeMs <= SNAPSHOT_QUOTA_TTL_MS;

  const baseRunning = snapLiveFresh
    ? Math.max(0, Number(snapshot?.runningCount || 0))
    : Math.max(0, Number(localMetrics?.runningRootCount || 0));
  const runningCount =
    stdinIsRunning || stdinIsWaiting ? Math.max(1, baseRunning) : baseRunning;

  const baseSubRunning = snapLiveFresh
    ? Math.max(0, Number(snapshot?.runningSubCount || 0))
    : Math.max(0, Number(localMetrics?.runningSubCount || 0));
  const runningSubCount = Math.max(stdinSubagents, baseSubRunning);
  const hasWaiting = stdinIsWaiting || Boolean(snapLiveFresh && snapshot?.hasWaiting);

  const stdinUsedPct = stdinData?.context_window?.used_percentage;
  const usedPct =
    stdinUsedPct != null && Number.isFinite(Number(stdinUsedPct))
      ? Math.max(0, Math.min(100, Number(stdinUsedPct)))
      : localMetrics?.usedPct ?? (snapLiveFresh ? snapshot?.activeConversation?.usedPct ?? null : null);

  const stdinTotalUsd = stdinData?.cost?.total_usd;
  const sessionCost =
    localMetrics?.sessionCost != null
      ? localMetrics.sessionCost
      : stdinTotalUsd != null && Number.isFinite(Number(stdinTotalUsd))
        ? Number(stdinTotalUsd)
        : null;

  const stdinInTok = Number(stdinData?.context_window?.total_input_tokens);
  const stdinOutTok = Number(stdinData?.context_window?.total_output_tokens);
  const stdinSessionTokens =
    Number.isFinite(stdinInTok) || Number.isFinite(stdinOutTok)
      ? Math.max(0, (Number.isFinite(stdinInTok) ? stdinInTok : 0) + (Number.isFinite(stdinOutTok) ? stdinOutTok : 0))
      : null;

  const snapActive =
    snapLiveFresh &&
    snapshot?.activeConversation &&
    (!localMetrics?.cascadeId || snapshot.activeConversation.cascadeId === localMetrics.cascadeId)
      ? snapshot.activeConversation
      : null;

  const mergedQuotas =
    (snapQuotaFresh && snapshot?.quotas) || buildStdinFallbackQuotas(stdinData) || null;

  const hasTelemetry = Boolean(
    stdinData || localMetrics?.found || snapActive || mergedQuotas
  );

  return {
    hasTelemetry,
    isRunning: stdinIsRunning || stdinIsWaiting,
    hasWaiting,
    runningCount,
    runningSubCount,
    usedPct,
    tps: localMetrics?.tps ?? snapActive?.latestTokPerSec ?? null,
    avgTps: localMetrics?.avgTps ?? snapActive?.avgTokPerSec ?? null,
    ttft: localMetrics?.ttft ?? snapActive?.latestTtftSec ?? null,
    stepCost: localMetrics?.stepCost ?? snapActive?.latestStepCostUsd ?? null,
    sessionCost: sessionCost ?? snapActive?.sessionCostUsd ?? null,
    cacheHitPct: localMetrics?.cacheHitPct ?? snapActive?.latestCacheHitPct ?? null,
    latestPromptTokens: localMetrics?.latestPromptTokens ?? snapActive?.latestPromptTokens ?? null,
    sessionTokens:
      localMetrics?.sessionTokens ?? stdinSessionTokens ?? snapActive?.totalTokens ?? null,
    quotas: mergedQuotas,
  };
}

export async function runCliStatusLineMain(argv = process.argv.slice(2)) {
  if (argv.includes('--install')) {
    const res = ensureCliStatusLineConfigured({ enabled: true });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }
  if (argv.includes('--uninstall')) {
    const res = ensureCliStatusLineConfigured({ enabled: false });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }

  const settings = loadSettings();
  if (settings?.enableCliStatusLine === false) {
    return;
  }

  const stdinData = await readStdinJsonWithTimeout(220);
  const nowMs = Date.now();
  const geminiBase =
    String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homedir(), '.gemini');
  const cliRoot = join(geminiBase, 'antigravity-cli');

  const localMetrics = resolveCliLocalSessionMetrics({
    cliRoot,
    stdinData,
    nowMs,
  });
  const snapshot = loadFreshestCliStatusSnapshot(geminiBase);
  const slotCtx = buildMergedCliCapsuleContext({
    stdinData,
    localMetrics,
    snapshot,
    nowMs,
  });

  const terminalWidth = Number(stdinData?.terminal_width);
  let modelDisplayName = String(
    stdinData?.model?.display_name || stdinData?.model?.id || ''
  ).trim();
  if (!modelDisplayName && terminalWidth > 0) {
    const cliSettingsObj = loadJson(join(cliRoot, 'settings.json'), null);
    if (cliSettingsObj && typeof cliSettingsObj.model === 'string') {
      modelDisplayName = cliSettingsObj.model.trim();
    }
  }

  const useColor =
    !Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR') ||
    String(process.env.NO_COLOR || '') === '';
  const line = formatCliStatusLineCapsule(slotCtx, {
    slots: settings?.topbarCapsuleSlots,
    showMultiSession: settings?.showTopbarMultiSession !== false,
    language: settings?.language,
    color: useColor,
    terminalWidth: Number.isFinite(terminalWidth) && terminalWidth > 0 ? terminalWidth : 0,
    cycleMode: typeof stdinData?.cycle_mode === 'string' ? stdinData.cycle_mode : '',
    modelDisplayName,
    modelEffort: typeof stdinData?.model?.effort === 'string' ? stdinData.model.effort : '',
    vimMode: typeof stdinData?.vim?.mode === 'string' ? stdinData.vim.mode : '',
  });

  if (line) {
    process.stdout.write(`${line}\n`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isDirectEntry =
  (invokedPath && invokedPath === fileURLToPath(import.meta.url)) ||
  import.meta.url.endsWith('#autorun');
if (isDirectEntry) {
  runCliStatusLineMain().catch(() => {
    // 严格保证静默退出 0，绝不触发 CLI 连续 30 次失败熔断器
    process.exitCode = 0;
  });
}
