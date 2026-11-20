/**
 * @fileoverview Pure formatting utilities for speed metrics, token counts,
 * USD estimates, countdown timers, and custom datetime displays.
 */

import { isEnglishLocale, t } from '../i18n/index.js';
import {
  normalizeModelDisplayMode,
  normalizeOrchestratorIdMode,
} from '../../shared/settings-normalization.mjs';
import {
  classifyCacheTier,
  classifySpeedTier,
  classifyStepCostTier,
  classifyTtftTier,
  formatCompactTokens,
} from '../../shared/telemetry-display-rules.mjs';

const EN_MONTH_SHORT = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

export function formatMetric(value, unit = '') {
  if (!Number.isFinite(value)) return '—';
  const numStr = Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${numStr}${unit}`;
}

export function formatSpeedMetric(value, unit = ' tok/s') {
  return formatMetric(value, unit);
}

export function formatCachePct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const num = Math.max(0, Math.min(100, +Number(value).toFixed(1)));
  return `${num}%`;
}

export function getSpeedToneClass(tokPerSec) {
  return `tone-${classifySpeedTier(tokPerSec)}`;
}

export function getCacheToneClass(cacheHitPct, promptTokens = null) {
  return `tone-${classifyCacheTier(cacheHitPct, promptTokens)}`;
}

export function getStepCostToneClass(costUsd) {
  const tier = classifyStepCostTier(costUsd);
  return tier ? `tone-${tier}` : '';
}

export function getTtftToneClass(ttftSec) {
  const tier = classifyTtftTier(ttftSec);
  return tier === 'warn' || tier === 'danger' ? `tone-${tier}` : '';
}

export const formatTokens = formatCompactTokens;

export function formatTokensPrecise(num) {
  const n = Number(num || 0);
  if (n <= 0) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCnyApprox(usdAmount, rate = 7.2) {
  const rmb = Number(usdAmount || 0) * rate;
  if (rmb <= 0) return '≈ ¥0';
  if (rmb >= 10) return `≈ ¥${Math.round(rmb)}`;
  return `≈ ¥${rmb.toFixed(1)}`;
}

export function formatDateSpanBadge(startMs, endMs) {
  const s = startMs && Number.isFinite(startMs) ? new Date(startMs) : new Date();
  const e = endMs && Number.isFinite(endMs) ? new Date(endMs) : new Date();
  if (isEnglishLocale()) {
    const sMon = EN_MONTH_SHORT[s.getMonth()] || '';
    const eMon = EN_MONTH_SHORT[e.getMonth()] || '';
    if (s.getFullYear() !== e.getFullYear()) {
      return `${sMon} ${s.getDate()}, ${s.getFullYear()} ~ ${eMon} ${e.getDate()}, ${e.getFullYear()}`;
    }
    return `${sMon} ${s.getDate()} ~ ${eMon} ${e.getDate()}`;
  }
  if (s.getFullYear() !== e.getFullYear()) {
    return `${s.getFullYear()}年${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getFullYear()}年${e.getMonth() + 1}月${e.getDate()}日`;
  }
  return `${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getMonth() + 1}月${e.getDate()}日`;
}

export function formatUsd(amount, { precise = false } = {}) {
  if (amount == null || !Number.isFinite(Number(amount))) return t('fmt.pending');
  const val = Number(amount || 0);
  if (precise) {
    if (val > 0 && val < 0.001) return '<$0.001';
    return val >= 1 ? `$${val.toFixed(2)}` : `$${val.toFixed(3)}`;
  }
  return `$${val.toFixed(2)}`;
}

const SPEED_REASON_LABELS = {
  __proto__: null,
  incomplete_or_invalid_timing: 'fmt.speedIncomplete',
  canceled: 'fmt.speedCanceled',
  error: 'fmt.speedError',
  interrupted: 'fmt.speedInterrupted',
  compaction_timing_unavailable: 'fmt.speedCompactionTimingUnavailable',
  invalid_output_tokens: 'fmt.speedInvalidOutput',
  inconsistent_timing: 'fmt.speedInconsistent',
  short_timing: 'fmt.speedShort',
  legacy_cache: 'fmt.speedLegacy',
};

export function speedReasonText(reason) {
  const label = SPEED_REASON_LABELS[reason];
  return label ? t(label) : '';
}

const ANOMALY_KIND_ORDER = Object.freeze([
  'rate_limit',
  'timeout',
  'capacity',
  'disconnect',
  'upstream',
  'model_output',
  'safety',
  'auth_or_model',
  'error',
]);

export function formatAnomalyKindLabel(kind) {
  const k = String(kind || 'error');
  const key = `steps.anomalyKind.${k}`;
  const text = t(key);
  return text === key ? t('steps.anomalyKind.error') : text;
}

export function formatAnomalyTagText(primaryKind, count = 1) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const k = String(primaryKind || 'error');
  if (k === 'capacity' && n === 1) return t('steps.anomalyTag.capacitySingle');
  if (k === 'upstream' && n === 1) return t('steps.anomalyTag.upstreamSingle');
  const key = `steps.anomalyTag.${k}`;
  const formatted = t(key, { n });
  return formatted === key ? t('steps.anomalyTag.error', { n }) : formatted;
}

export function resolveModelAnomalySummary(m) {
  const count = Math.max(0, Number(m?.anomalyCount || 0));
  const steps = Math.max(0, Number(m?.anomalySteps || 0));
  if (count <= 0 && steps <= 0) return null;
  const byKind = m?.anomalyByKind && typeof m.anomalyByKind === 'object' ? m.anomalyByKind : {};
  const entries = Object.entries(byKind)
    .map(([k, v]) => [k, Math.max(0, Number(v || 0))])
    .filter(([, v]) => v > 0)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const pa = ANOMALY_KIND_ORDER.indexOf(a[0]);
      const pb = ANOMALY_KIND_ORDER.indexOf(b[0]);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    });
  const totalCount = count || entries.reduce((sum, [, v]) => sum + v, 0) || steps;
  const primaryKind = entries.length === 1 ? entries[0][0] : entries.length > 1 ? 'mixed' : 'error';
  const severity =
    Number(m?.anomalyDangerCount || 0) > 0 ||
    entries.some(([k]) => k === 'rate_limit' || k === 'auth_or_model')
      ? 'danger'
      : 'warn';
  return {
    count: totalCount,
    steps: steps || totalCount,
    totalDelaySec: Math.max(0, Number(m?.anomalyTotalDelaySec || 0)),
    primaryKind,
    severity,
    entries,
    tagText: formatAnomalyTagText(primaryKind, totalCount),
  };
}

export function formatStepAnomalyInlineSummary(anomaly) {
  if (!anomaly || !(Number(anomaly.count) > 0)) return '';
  const tag = formatAnomalyTagText(anomaly.primaryKind, anomaly.count);
  const label = formatAnomalyKindLabel(anomaly.primaryKind);
  const delaySec = Number(anomaly.totalDelaySec || 0);
  const delayPart = delaySec > 0 ? ` · ${t('steps.anomalyDelayPart', { sec: delaySec })}` : '';
  return `${tag} · ${label}${delayPart}`;
}

export function buildStepAnomalyDiagnostic(st) {
  const a = st?.anomaly;
  if (!a || !(Number(a.count) > 0)) return null;
  const title = t('steps.anomalyStepTitle', {
    step: Number(st.stepIndex ?? 0),
    count: Number(a.count),
  });
  const delaySec = Number(a.totalDelaySec || 0);
  const sub = delaySec > 0 ? t('steps.anomalyDelayPart', { sec: delaySec }) : '';
  const events = Array.isArray(a.events) ? a.events : [];
  const rows = events.map((ev, idx) => {
    const label = formatAnomalyKindLabel(ev.kind);
    const parts = [`#${ev.attempt || idx + 1} ${label}`];
    if (Number(ev.delaySec) > 0) {
      parts.push(t('steps.anomalyDelayPart', { sec: ev.delaySec }));
    }
    if (ev.terminal) {
      parts.push(t('steps.anomalyTerminalTag'));
    }
    return {
      text: parts.join(' · '),
      detail: ev.message || '',
      danger: Boolean(ev.terminal || ev.kind === 'rate_limit' || ev.kind === 'auth_or_model'),
    };
  });
  return {
    title,
    sub,
    rows,
    hint: '',
    severity: a.severity === 'danger' ? 'danger' : 'warn',
  };
}

export function buildModelAnomalyDiagnostic(m) {
  const sum = resolveModelAnomalySummary(m);
  if (!sum) return null;
  const title = t('steps.anomalyModelTitle', {
    model: m?.displayText || m?.shortName || m?.label || '—',
    count: sum.count,
  });
  const subParts = [t('steps.anomalyModelSub', { steps: sum.steps })];
  if (sum.totalDelaySec > 0) {
    subParts.push(t('steps.anomalyDelayPart', { sec: sum.totalDelaySec }));
  }
  const rows = sum.entries.map(([k, v]) => ({
    text: t('steps.anomalyModelKindRow', { kind: formatAnomalyKindLabel(k), count: v }),
    detail: '',
    danger: k === 'rate_limit' || k === 'auth_or_model',
  }));
  return {
    title,
    sub: subParts.join(' · '),
    rows,
    hint: t('steps.anomalyModelClickHint'),
    severity: sum.severity,
  };
}

export function sampleSummary(summary) {
  const valid = summary?.sampleCount || 0;
  const excluded = summary?.excludedCount || 0;
  return t('fmt.sampleSteps', { valid, total: valid + excluded });
}

export function formatCountdown(isoTime, nowMs = Date.now()) {
  if (!isoTime) return t('fmt.resetUnknown');
  const targetMs = Date.parse(isoTime);
  if (!Number.isFinite(targetMs) || targetMs <= 0) return t('fmt.resetUnknown');
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return t('fmt.resetSoon');
  if (diffMs < 60_000) return t('fmt.resetUnder1m');

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return t('fmt.resetDaysHours', { d: days, h: hours });
  if (hours > 0) return t('fmt.resetHoursMins', { h: hours, m: minutes });
  return t('fmt.resetMins', { m: minutes });
}

export function formatCompactDateTime(ms) {
  if (!ms || !Number.isFinite(ms)) return t('fmt.selectTime');
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatElapsedSec(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) {
    return `${m}m ${String(remS).padStart(2, '0')}s`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

export { normalizeModelDisplayMode };

/**
 * 隐藏原始模型 ID 开头的 `gemini-`、`claude-`、`gpt-` 厂商前缀以节省单行表格空间（确保剥离后非空）。
 *
 * @param {string} rawText
 * @returns {string}
 */
export function stripVendorModelPrefix(rawText) {
  return String(rawText || '')
    .trim()
    .replace(/^(?:gemini|claude|gpt)-(?=.+)/i, '');
}

function stripCompactionMarker(rawText) {
  return String(rawText || '')
    .replace(/(?:·(?:压缩|compact)|\[自动压缩\]|\[auto[- ]?compact\])\s*$/iu, '')
    .trim();
}

export const normalizeOrchestratorIdDisplayMode = normalizeOrchestratorIdMode;

/**
 * 统一解析步骤、会话摘要或模型汇总行面向用户的模型显示文本与悬停提示。
 *
 * 规则：
 * - Orchestrator 系列（`Orchestrator (Carbon)`、`Orchestrator (Argon)`、`gemini-flash-worker-agy` / `M669`）
 *   独立遵循 `orchestratorIdMode`（`'compact'` 显示 `orchestrator-carbon` / `orchestrator-argon` / `worker-agy-hydrogen`；
 *   `'full'` 显示带括号标注的完整上游 ID），不受普通模型显示模式影响；
 * - 其余普通模型遵循 `modelDisplayMode`（`'short'` | `'upstream_compact'` | `'upstream'`，兼容旧版布尔 `showUpstreamModel`）；
 * - 独立拆分 `baseText` 与 `compactionSuffix`（`·压缩`），供步骤表单独保护压缩尾标永不截断。
 *
 * @param {object|null|undefined} target
 * @param {{ modelDisplayMode?: string, showUpstreamModel?: boolean, orchestratorIdMode?: string }|boolean} [settings]
 * @param {{ preferLabelInShort?: boolean, fallback?: string }} [options]
 * @returns {{ text: string, baseText: string, compactionSuffix: string, isCompaction: boolean, title: string, isOrchestratorSeries: boolean }}
 */
export function resolveModelDisplayInfo(target, settings = {}, options = {}) {
  const modelDisplayMode =
    typeof settings === 'boolean'
      ? settings
        ? 'upstream'
        : 'short'
      : normalizeModelDisplayMode(settings?.modelDisplayMode, settings?.showUpstreamModel);
  const showUpstream = modelDisplayMode !== 'short';
  const orchestratorMode = normalizeOrchestratorIdDisplayMode(
    typeof settings === 'object' && settings ? settings.orchestratorIdMode : 'compact'
  );
  const preferLabelInShort = Boolean(options?.preferLabelInShort);
  const fallback = options?.fallback ?? t('fmt.unknownModel');

  if (!target || typeof target !== 'object') {
    return {
      text: fallback,
      baseText: fallback,
      compactionSuffix: '',
      isCompaction: false,
      title: fallback,
      isOrchestratorSeries: false,
    };
  }

  const shortText = String(
    target.activeBaseModelShort ??
      target.baseModelShort ??
      target.activeModelShort ??
      target.modelShort ??
      target.shortName ??
      ''
  ).trim();
  const labelText = String(
    target.activeBaseModelLabel ??
      target.baseModelLabel ??
      target.activeModelLabel ??
      target.modelLabel ??
      target.label ??
      ''
  ).trim();
  const upstreamText = String(
    target.baseModelUpstream ??
      target.activeModelUpstream ??
      target.modelUpstream ??
      target.upstreamName ??
      ''
  ).trim();
  const rawCompactionText = `${target.activeModelShort ?? target.modelShort ?? ''} ${target.activeModelLabel ?? target.modelLabel ?? ''} ${target.activeModelUpstream ?? target.modelUpstream ?? ''}`;
  const responseText = String(target.responseModel ?? '').trim();
  const modelKeyText = String(target.modelKey ?? '').trim();

  const isCompaction =
    Boolean(target.isCompactionStep) ||
    /·(?:压缩|compact)(?=\s|$)|\[自动压缩\]/iu.test(rawCompactionText);

  const compactionSuffix = isCompaction ? t('fmt.compactionSuffix') : '';

  const combined = `${modelKeyText} ${shortText} ${labelText} ${upstreamText} ${responseText}`;
  const isOrchWorker =
    /\bMODEL_PLACEHOLDER_M669\b|\b[a-z0-9.-]*worker-agy\b|\bworker-agy-hydrogen\b|\bOrchestrator\s+Worker\b/i.test(
      combined
    );
  const isOrchSeries =
    isOrchWorker ||
    /\bgemini-pro-orchestrator(?:-(?:argon|neon))?\b|\borchestrator-(?:carbon|argon|neon)\b|\borch-(?:carbon|argon|neon)(?:·(?:压缩|compact))?(?=\s|$)|Orchestrator\s*\((?:Carbon|Argon|Neon)\)|\bMODEL_PLACEHOLDER_M(?:667|681|537)\b/i.test(
      combined
    );

  if (isOrchSeries) {
    let compactId = 'orchestrator-carbon';
    let fullId = 'gemini-pro-orchestrator (carbon-4)';
    if (isOrchWorker) {
      compactId = 'worker-agy-hydrogen';
      fullId = 'gemini-flash-worker-agy (hydrogen-4)';
    } else if (/\bargon\b|\bMODEL_PLACEHOLDER_M681\b|\borch-argon\b/i.test(combined)) {
      compactId = 'orchestrator-argon';
      fullId = 'gemini-pro-orchestrator-argon (argon-4)';
    } else if (/\bneon\b|\bMODEL_PLACEHOLDER_M537\b|\borch-neon\b/i.test(combined)) {
      compactId = 'orchestrator-neon';
      fullId = 'gemini-pro-orchestrator-neon (neon-4)';
    }
    const baseText = orchestratorMode === 'full' ? fullId : compactId;
    const text = `${baseText}${compactionSuffix}`;
    const multiUpstream =
      Array.isArray(target.upstreamModels) && target.upstreamModels.length > 1
        ? target.upstreamModels.join(' / ')
        : '';
    const title = multiUpstream || `${fullId}${compactionSuffix}`;
    return {
      text,
      baseText,
      compactionSuffix,
      isCompaction,
      title,
      isOrchestratorSeries: true,
    };
  }

  const rawSelected =
    (showUpstream
      ? upstreamText || responseText || shortText || labelText
      : preferLabelInShort
        ? labelText || shortText
        : shortText || labelText) || fallback;
  const cleanRawBase = stripCompactionMarker(rawSelected) || fallback;
  const baseText =
    modelDisplayMode === 'upstream_compact'
      ? stripVendorModelPrefix(cleanRawBase) || cleanRawBase
      : cleanRawBase;
  const text = `${baseText}${compactionSuffix}`;
  const fullUpstreamWithSuffix = `${cleanRawBase}${compactionSuffix}`;
  const standardTitle =
    showUpstream && Array.isArray(target.upstreamModels) && target.upstreamModels.length > 1
      ? target.upstreamModels.join(' / ')
      : showUpstream
        ? fullUpstreamWithSuffix
        : text;
  return {
    text,
    baseText,
    compactionSuffix,
    isCompaction,
    title: standardTitle,
    isOrchestratorSeries: false,
  };
}

/**
 * 按当前显示策略 (`resolveModelDisplayInfo`) 解析出的最终展示名称对模型统计列表执行二次去重归并，
 * 确保当多个外层模型槽位映射到同一展示名（例如切换至“原始模型 ID”后共享同一 `upstreamName`）时，
 * 不会在排行榜或总览中出现重复同名行，同时完整累加 Token、调用次数、未定价计数与速度/首字加权均值。
 *
 * @param {object[]} [models=[]]
 * @param {object|boolean} [settings={}]
 * @param {{ preferLabelInShort?: boolean, fallback?: string }} [options={}]
 * @returns {object[]}
 */
export function mergeModelsByDisplayName(models = [], settings = {}, options = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const showUpstream =
    typeof settings === 'boolean'
      ? settings
      : normalizeModelDisplayMode(settings?.modelDisplayMode, settings?.showUpstreamModel) !== 'short';
  const byDisplay = new Map();

  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const disp = resolveModelDisplayInfo(m, settings, options);
    const key = String(disp.text || options?.fallback || '—').trim() || '—';

    const calls = Math.max(0, Number(m.calls || 0));
    const inTok = Math.max(0, Number(m.inputTokens || 0));
    const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(m.outputTokens || 0));
    const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
    const respTok =
      m.responseTokens != null
        ? Math.max(0, Number(m.responseTokens))
        : Math.max(0, outTok - thinkTok);
    const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
    const costUsd = Number.isFinite(Number(m.costUsd)) ? Math.max(0, Number(m.costUsd)) : 0;
    const unpricedCalls = Math.max(0, Number(m.unpricedCalls || 0));

    const speedSampleCount = Math.max(0, Number(m.speedSummary?.sampleCount || 0));
    const speedExcludedCount = Math.max(0, Number(m.speedSummary?.excludedCount || 0));
    const speedWeight = speedSampleCount > 0 ? speedSampleCount : Math.max(1, outTok || calls || 1);
    const hasSpeed = m.avgTokPerSec != null && Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0;

    const ttftSampleCount = Math.max(0, Number(m.ttftSampleCount || 0));
    const ttftWeight = ttftSampleCount > 0 ? ttftSampleCount : Math.max(1, calls || 1);
    const hasTtft = m.avgTtftSec != null && Number.isFinite(Number(m.avgTtftSec)) && Number(m.avgTtftSec) >= 0;

    let acc = byDisplay.get(key);
    if (!acc) {
      acc = {
        baseItem: m,
        mergedCount: 1,
        displayText: key,
        firstTitle: disp.title || key,
        titleSet: new Set(disp.title ? [disp.title] : []),
        upstreamSet: new Set(
          Array.isArray(m.upstreamModels) ? m.upstreamModels.filter(Boolean) : []
        ),
        sourceLabels: m.label ? [m.label] : [],
        calls,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        thinkingTokens: thinkTok,
        responseTokens: respTok,
        totalTokens: totTok,
        costUsd,
        unpricedCalls,
        speedWeightedSum: hasSpeed ? Number(m.avgTokPerSec) * speedWeight : 0,
        speedWeight: hasSpeed ? speedWeight : 0,
        speedSampleCount,
        speedExcludedCount,
        ttftWeightedSum: hasTtft ? Number(m.avgTtftSec) * ttftWeight : 0,
        ttftWeight: hasTtft ? ttftWeight : 0,
        ttftSampleCount,
        anomalySteps: Math.max(0, Number(m.anomalySteps || 0)),
        anomalyCount: Math.max(0, Number(m.anomalyCount || 0)),
        anomalyDangerCount: Math.max(0, Number(m.anomalyDangerCount || 0)),
        anomalyTotalDelaySec: Math.max(0, Number(m.anomalyTotalDelaySec || 0)),
        anomalyByKind:
          m.anomalyByKind && typeof m.anomalyByKind === 'object' ? { ...m.anomalyByKind } : {},
      };
      if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
      byDisplay.set(key, acc);
      continue;
    }

    acc.mergedCount += 1;
    if (disp.title) acc.titleSet.add(disp.title);
    if (Array.isArray(m.upstreamModels)) {
      for (const u of m.upstreamModels) {
        if (u) acc.upstreamSet.add(u);
      }
    }
    if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
    if (m.label && !acc.sourceLabels.includes(m.label)) {
      acc.sourceLabels.push(m.label);
    }

    acc.calls += calls;
    acc.inputTokens += inTok;
    acc.cacheReadTokens += cacheTok;
    acc.outputTokens += outTok;
    acc.thinkingTokens += thinkTok;
    acc.responseTokens += respTok;
    acc.totalTokens += totTok;
    acc.costUsd += costUsd;
    acc.unpricedCalls += unpricedCalls;

    acc.anomalySteps += Math.max(0, Number(m.anomalySteps || 0));
    acc.anomalyCount += Math.max(0, Number(m.anomalyCount || 0));
    acc.anomalyDangerCount += Math.max(0, Number(m.anomalyDangerCount || 0));
    acc.anomalyTotalDelaySec += Math.max(0, Number(m.anomalyTotalDelaySec || 0));
    if (m.anomalyByKind && typeof m.anomalyByKind === 'object') {
      for (const [ak, av] of Object.entries(m.anomalyByKind)) {
        const cnt = Math.max(0, Number(av || 0));
        if (cnt > 0) acc.anomalyByKind[ak] = (acc.anomalyByKind[ak] || 0) + cnt;
      }
    }

    if (hasSpeed) {
      acc.speedWeightedSum += Number(m.avgTokPerSec) * speedWeight;
      acc.speedWeight += speedWeight;
    }
    acc.speedSampleCount += speedSampleCount;
    acc.speedExcludedCount += speedExcludedCount;

    if (hasTtft) {
      acc.ttftWeightedSum += Number(m.avgTtftSec) * ttftWeight;
      acc.ttftWeight += ttftWeight;
    }
    acc.ttftSampleCount += ttftSampleCount;
  }

  return Array.from(byDisplay.values()).map((acc) => {
    if (acc.mergedCount === 1) {
      return {
        ...acc.baseItem,
        displayText: acc.displayText,
        displayTitle: acc.firstTitle,
        sourceLabels: acc.sourceLabels,
      };
    }
    const promptTok = acc.inputTokens + acc.cacheReadTokens;
    const cacheHitPct = promptTok > 0 ? +((acc.cacheReadTokens / promptTok) * 100).toFixed(1) : 0;
    const avgTokPerSec =
      acc.speedWeight > 0 ? +(acc.speedWeightedSum / acc.speedWeight).toFixed(1) : null;
    const avgTtftSec =
      acc.ttftWeight > 0 ? +(acc.ttftWeightedSum / acc.ttftWeight).toFixed(1) : null;
    const upstreamModels = Array.from(acc.upstreamSet);
    const displayTitle =
      showUpstream && upstreamModels.length > 1
        ? upstreamModels.join(' / ')
        : Array.from(acc.titleSet).join(' / ') || acc.displayText;

    return {
      ...acc.baseItem,
      calls: acc.calls,
      inputTokens: acc.inputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      outputTokens: acc.outputTokens,
      thinkingTokens: acc.thinkingTokens,
      responseTokens: acc.responseTokens,
      totalTokens: acc.totalTokens,
      costUsd: +acc.costUsd.toFixed(6),
      unpricedCalls: acc.unpricedCalls,
      cacheHitPct,
      avgTokPerSec,
      avgTtftSec,
      ttftSampleCount: acc.ttftSampleCount,
      ...(acc.anomalyCount > 0
        ? {
            anomalySteps: acc.anomalySteps,
            anomalyCount: acc.anomalyCount,
            anomalyDangerCount: acc.anomalyDangerCount,
            anomalyTotalDelaySec: +acc.anomalyTotalDelaySec.toFixed(1),
            anomalyByKind: acc.anomalyByKind,
          }
        : {}),
      speedSummary: acc.baseItem.speedSummary
        ? {
            ...acc.baseItem.speedSummary,
            sampleCount: acc.speedSampleCount,
            excludedCount: acc.speedExcludedCount,
            avgTokPerSec,
          }
        : undefined,
      upstreamModels,
      displayText: acc.displayText,
      displayTitle,
      sourceLabels: acc.sourceLabels,
    };
  });
}

/**
 * 根据代理索引返回对应的微边框语义徽章样式类名。
 *
 * @param {number} [index=0]
 * @param {boolean} [isMain=false]
 * @returns {string}
 */
export function getAgentBadgeClass(index = 0, isMain = false) {
  if (isMain || index <= 0) return 'badge-main';
  const slot = ((index - 1) % 3) + 1;
  return `badge-sub-${slot}`;
}

function resolveStructuredAgentKind(agent) {
  if (!agent) return 'main';
  if (agent.agentKind) return agent.agentKind;
  if (agent.isMain) return 'main';
  if (agent.isSideQuestion || agent.typeName === 'side_question') return 'side_question';
  if (
    agent.typeName === 'worker' ||
    agent.typeName === 'swarm_worker' ||
    /^Swarm\s+Worker\s*\(/i.test(String(agent.role || ''))
  ) {
    return 'swarm_worker';
  }
  return 'subagent';
}

function normalizeSwarmMemberHandle(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return '';
  const wrapper = trimmed.match(/^Swarm\s+Worker\s*\(([^)]+)\)\s*$/i);
  const inner = (wrapper ? wrapper[1] : trimmed).replace(/^@+/, '').trim();
  if (
    !inner ||
    inner === '蜂群' ||
    inner === '工蜂' ||
    inner.toLowerCase() === 'swarm' ||
    inner.toLowerCase() === 'worker' ||
    inner.toLowerCase() === 'swarm worker'
  ) {
    return '';
  }
  return `@${inner}`;
}

/**
 * 基于结构化 `agentKind` / `agentOrdinal` 格式化主/子代理、蜂群节点或旁路提问的紧凑徽章文本（零正则反拆中文）。
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
export function formatAgentBadgeText(agent) {
  if (!agent) return t('fmt.mainBadge');
  const kind = resolveStructuredAgentKind(agent);
  if (kind === 'all') return t('header.scopeAllShort');
  if (kind === 'main') return t('fmt.mainBadge');
  if (kind === 'side_question') {
    const ord = Number(agent.agentOrdinal || agent.sideIndex || 0);
    if (ord > 0) return t('fmt.sideBadge', { index: ord });
    if (!isEnglishLocale() && agent.badgeText) return String(agent.badgeText);
    return t('fmt.sideBadgeShort');
  }
  if (kind === 'swarm_worker') {
    const ord = Number(agent.agentOrdinal || agent.index || 0);
    if (ord > 0) return t('fmt.swarmBadge', { index: ord });
    if (!isEnglishLocale() && agent.badgeText) return String(agent.badgeText);
    return t('fmt.swarmBadgeShort');
  }
  const ord = Number(agent.agentOrdinal || agent.index || 0);
  if (ord > 0) return t('fmt.subBadge', { index: ord });
  if (!isEnglishLocale() && agent.badgeText) return String(agent.badgeText);
  return t('fmt.subBadgeShort');
}

/**
 * 基于结构化 `agentKind` / `agentOrdinal` / `customRole` 格式化代理完整显示名称（零正则反拆中文）。
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
export function formatAgentLabel(agent) {
  if (!agent) return t('fmt.mainAgent');
  const kind = resolveStructuredAgentKind(agent);
  if (kind === 'all') return t('header.scopeAll');
  if (kind === 'main') return t('fmt.mainAgent');

  const rawCustom =
    agent.customRole !== undefined
      ? String(agent.customRole || '').trim()
      : String(agent.role || '').trim();
  if (kind === 'side_question') {
    const ord = Number(agent.agentOrdinal || agent.sideIndex || 0);
    const baseLabel = ord > 0 ? `${t('fmt.sideQuestion')} #${ord}` : t('fmt.sideQuestion');
    const isGeneric =
      !rawCustom ||
      rawCustom === baseLabel ||
      rawCustom === agent.shortLabel ||
      rawCustom === t('fmt.sideQuestion') ||
      rawCustom === 'Side Question' ||
      rawCustom === 'side_question';
    return isGeneric ? baseLabel : `${baseLabel} · ${rawCustom}`;
  }

  if (kind === 'swarm_worker') {
    const ord = Number(agent.agentOrdinal || agent.index || 0);
    const baseLabel = ord > 0 ? `${t('fmt.swarmAgent')} #${ord}` : t('fmt.swarmAgent');
    const handle = normalizeSwarmMemberHandle(rawCustom || agent.role || '');
    if (!handle) return baseLabel;
    let auxSuffix = '';
    if (/^@monitor(?:-\d+)?$/i.test(handle)) {
      auxSuffix = ` (${t('fmt.swarmMonitorHint')})`;
    } else if (/^@narrator(?:-\d+)?$/i.test(handle)) {
      auxSuffix = ` (${t('fmt.swarmNarratorHint')})`;
    }
    return `${baseLabel} · ${handle}${auxSuffix}`;
  }

  const ord = Number(agent.agentOrdinal || agent.index || 0);
  const baseLabel = ord > 0 ? `${t('fmt.subAgent')} #${ord}` : t('fmt.subAgent');
  const isGeneric =
    !rawCustom ||
    rawCustom === baseLabel ||
    rawCustom === agent.shortLabel ||
    rawCustom === t('fmt.subAgent') ||
    rawCustom === 'Subagent';
  return isGeneric ? baseLabel : `${baseLabel} · ${rawCustom}`;
}

/**
 * 格式化会话选项右侧元信息（自适应区分纯蜂群、蜂群+子代理混合、常规子代理与单会话步数）。
 *
 * @param {object|null|undefined} conv
 * @returns {string}
 */
export function formatConversationMeta(conv) {
  if (!conv) return '';
  const main = Number(conv.stepCount || 0);
  const totalSubs = Number(conv.subagentCount || 0);
  const swarm = Number(conv.swarmCount || 0);
  const otherSubs = Math.max(0, totalSubs - swarm);
  const total = Number(conv.totalStepCount ?? conv.totalStepsAllAgents ?? main);
  if (swarm > 0 && otherSubs > 0) {
    return t('header.convMetaWithSwarmAndSubs', { main, swarm, subs: otherSubs, total });
  }
  if (swarm > 0) {
    return t('header.convMetaWithSwarm', { main, swarm, total });
  }
  if (totalSubs > 0) {
    return t('header.convMetaWithSubs', { main, subs: totalSubs, total });
  }
  return t('header.convMetaSteps', { count: main });
}

/**
 * 基于后端结构化 `actionKey` + `waitingApproval` 渲染实时动作短标题（兼容自定义 `label` 回退）。
 *
 * @param {object|null|undefined} act
 * @param {string} [fallbackKey='live.thinking']
 * @returns {string}
 */
export function formatLiveActivityLabel(act, fallbackKey = 'live.thinking') {
  if (!act || typeof act !== 'object') return t(fallbackKey);
  let baseLabel = '';
  if (act.actionKey) {
    const i18nKey = `live.act.${act.actionKey}`;
    const translated = t(i18nKey);
    if (translated && translated !== i18nKey) {
      baseLabel = translated;
    }
  }
  if (!baseLabel) {
    baseLabel = String(act.label || '').trim() || t(fallbackKey);
  }
  if (act.waitingApproval) {
    return t('live.act.awaitingApproval', { label: baseLabel });
  }
  return baseLabel;
}

/**
 * 基于后端结构化 `detailKey` 渲染实时动作补充说明（兼容自由文本 `detail`）。
 *
 * @param {object|null|undefined} act
 * @returns {string}
 */
export function formatLiveActivityDetail(act) {
  if (!act || typeof act !== 'object') return '';
  if (act.detailKey === 'compaction_resuming') {
    return t('live.act.compactionResuming');
  }
  return String(act.detail || '');
}

/**
 * 20 色感知均匀色环（无特定模型绑定，兼顾亮/暗背景可读性，彻底消除标准 HSL 绿色/暗红区过度聚集撞色）。
 * 每项为 `[hue, saturationPct, lightnessPct]`。
 */
const PERCEPTUAL_MODEL_COLOR_RING = [
  [217, 82, 53], // Royal Blue
  [14, 80, 52], // Coral / Vermilion
  [162, 74, 41], // Teal / Jade
  [272, 74, 58], // Vivid Violet
  [36, 88, 47], // Rich Amber
  [336, 78, 53], // Rose / Raspberry
  [193, 84, 43], // Cerulean / Cyan
  [138, 66, 41], // Emerald Green
  [246, 74, 60], // Indigo
  [25, 86, 50], // Tangerine Orange
  [306, 70, 52], // Magenta / Orchid
  [177, 76, 39], // Deep Seafoam
  [355, 76, 54], // Crimson Red
  [205, 80, 48], // Ocean Blue
  [45, 88, 44], // Warm Gold
  [288, 68, 55], // Amethyst Purple
  [102, 60, 42], // Leaf Green
  [230, 76, 57], // Cobalt Blue
  [322, 74, 51], // Berry Pink
  [185, 72, 46], // Turquoise
];

/**
 * 提取跨平台、跨语言、同屏三栏（模型排行 / 客户端来源 / 月度统计）严格一致的模型颜色种子字符串。
 *
 * 优先取单模型稳定 `sourceLabels[0]`；若多个外层槽位已在当前显示策略下合并（如 `4-argon`），
 * 则以规范化 `displayText` 为种子，确保跨客户端与跨月份聚合子集不同时依然映射至完全相同的颜色。
 *
 * @param {object|string|null|undefined} model
 * @returns {string}
 */
export function getCanonicalModelColorSeed(model) {
  if (typeof model === 'string') {
    return model.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  if (!model || typeof model !== 'object') return '';
  if (
    Number(model.mergedCount || 0) <= 1 &&
    Array.isArray(model.sourceLabels) &&
    model.sourceLabels.length === 1 &&
    model.sourceLabels[0]
  ) {
    return String(model.sourceLabels[0]).trim().toLowerCase().replace(/\s+/g, ' ');
  }
  const raw =
    model.displayText ||
    model.label ||
    model.modelId ||
    model.baseItem?.modelId ||
    model.shortName ||
    model.name ||
    '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashModelSeed32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function formatRingSlotHsl(slotIdx, shiftLight = 0) {
  const [hue, sat, light] = PERCEPTUAL_MODEL_COLOR_RING[slotIdx % PERCEPTUAL_MODEL_COLOR_RING.length];
  const clampedLight = Math.min(66, Math.max(34, light + shiftLight));
  return `hsl(${hue} ${sat}% ${clampedLight}%)`;
}

/**
 * 基于模型标识通过 32 位雪崩哈希映射至 20 色感知均匀色环，确保跨电脑同模型同色且无需硬编码颜色表。
 *
 * @param {object|string|null|undefined} seedOrModel
 * @returns {string}
 */
export function resolveDeterministicModelColor(seedOrModel) {
  const seed = getCanonicalModelColorSeed(seedOrModel);
  if (!seed) return 'var(--accent-primary)';
  const h = hashModelSeed32(seed);
  return formatRingSlotHsl(h % PERCEPTUAL_MODEL_COLOR_RING.length);
}

/**
 * 为一组模型构建确定性颜色映射表（双遍固有槽位保护）：
 * 1. 所有无槽位冲突的模型 100% 保持其纯哈希固有色，不受长尾模型增减影响；
 * 2. 仅当同屏两个模型恰好落入同一色环槽位时，按严格字典序以互质步长 `+7` 优先探查未被任何模型占用的空闲槽位。
 *
 * @param {Array<object|string>} [models=[]]
 * @returns {Map<string, string>} `canonicalSeed -> hsl(...)`
 */
export function buildDeterministicModelColorMap(models = []) {
  const ringLen = PERCEPTUAL_MODEL_COLOR_RING.length;
  const uniqueSeeds = Array.from(
    new Set(
      (Array.isArray(models) ? models : [])
        .map((m) => getCanonicalModelColorSeed(m))
        .filter(Boolean)
    )
  ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const naturalSlotCounts = new Map();
  for (const seed of uniqueSeeds) {
    const nat = hashModelSeed32(seed) % ringLen;
    naturalSlotCounts.set(nat, (naturalSlotCounts.get(nat) || 0) + 1);
  }

  const usedSlots = new Set();
  const colorMap = new Map();

  for (const seed of uniqueSeeds) {
    const h = hashModelSeed32(seed);
    const nat = h % ringLen;
    if (!usedSlots.has(nat)) {
      usedSlots.add(nat);
      colorMap.set(seed, formatRingSlotHsl(nat));
      continue;
    }

    let picked = -1;
    for (let k = 1; k < ringLen; k++) {
      const cand = (nat + k * 7) % ringLen;
      if (!usedSlots.has(cand) && !naturalSlotCounts.has(cand)) {
        picked = cand;
        break;
      }
    }
    if (picked < 0) {
      for (let k = 1; k < ringLen; k++) {
        const cand = (nat + k * 7) % ringLen;
        if (!usedSlots.has(cand)) {
          picked = cand;
          break;
        }
      }
    }

    if (picked >= 0) {
      usedSlots.add(picked);
      colorMap.set(seed, formatRingSlotHsl(picked));
    } else {
      const shift = (h >>> 8) & 1 ? 9 : -8;
      colorMap.set(seed, formatRingSlotHsl(nat, shift));
    }
  }

  return colorMap;
}
