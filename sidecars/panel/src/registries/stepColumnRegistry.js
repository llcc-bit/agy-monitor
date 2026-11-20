/**
 * @fileoverview Decoupled Step Table Column Registry (`stepColumnRegistry.js`).
 * Defines all 12 customizable columns for `StepsDetailView` ("按步查看"),
 * preserving 100% of the 7 out-of-the-box default columns, clickable agent filter badges,
 * speed reason sub-lines, token combo tooltips, and high-cost highlights.
 */

import { h, patchAttr, patchText } from '../core/domPatch.js';
import {
  formatCachePct,
  formatMetric,
  formatSpeedMetric,
  formatTokens,
  formatUsd,
  getCacheToneClass,
  getSpeedToneClass,
  getStepCostToneClass,
  getTtftToneClass,
  resolveModelDisplayInfo,
  speedReasonText,
} from '../core/formatters.js';
import { t } from '../i18n/index.js';
import {
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  STEP_TABLE_COLUMN_KEYS,
  normalizeStepTokenComboFormat,
  parseStepTokenComboSegments,
} from '../../shared/settings-normalization.mjs';

export const STEP_COLUMN_KEYS = STEP_TABLE_COLUMN_KEYS;
export const DEFAULT_STEP_COLUMN_KEYS = DEFAULT_STEP_TABLE_COLUMNS;
const DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT = DEFAULT_STEP_TOKEN_COMBO_FORMAT;
const normalizeClientStepTokenComboFormat = normalizeStepTokenComboFormat;
const parseClientStepTokenComboSegments = parseStepTokenComboSegments;

function resolveStepTokenParts(st) {
  const inTok = Math.max(0, Number(st?.inputTokens || 0));
  const cacheTok = Math.max(0, Number(st?.cacheReadTokens || 0));
  const outTok = Math.max(0, Number(st?.outputTokens || 0));
  const thinkTok = Math.max(0, Number(st?.thinkingTokens || 0));
  const respTok =
    st?.responseTokens != null
      ? Math.max(0, Number(st.responseTokens))
      : Math.max(0, outTok - thinkTok);
  const totalTok = inTok + cacheTok + outTok;
  const ctxTok = Math.max(0, Number(st?.contextTokens ?? totalTok));
  return { inTok, cacheTok, outTok, thinkTok, respTok, totalTok, ctxTok };
}

function formatPartWithOptionalCost(tokCount, costVal) {
  const countStr = Math.round(Number(tokCount || 0)).toLocaleString();
  if (costVal != null && Number.isFinite(Number(costVal))) {
    return `${countStr} (${formatUsd(Number(costVal), { precise: true })})`;
  }
  return countStr;
}

export function formatCustomTokenComboHeader(rawFormat) {
  const segs = parseClientStepTokenComboSegments(rawFormat);
  return segs.map((seg) => t(`steps.tokSeg.${seg}.th`)).join(' / ');
}

function resolveSegmentDisplay(seg, parts, st) {
  switch (seg) {
    case 'context':
      return {
        short: formatTokens(parts.ctxTok),
        tip: `${t('steps.tokSeg.context.tip')} ${Math.round(parts.ctxTok).toLocaleString()}`,
      };
    case 'in':
      return {
        short: formatTokens(parts.inTok),
        tip: `${t('steps.tokSeg.in.tip')} ${formatPartWithOptionalCost(parts.inTok, st?.inCostUsd)}`,
      };
    case 'out':
      return {
        short: formatTokens(parts.outTok),
        tip: `${t('steps.tokSeg.out.tip')} ${formatPartWithOptionalCost(parts.outTok, st?.outCostUsd)}`,
      };
    case 'cache':
      return {
        short: formatTokens(parts.cacheTok),
        tip: `${t('steps.tokSeg.cache.tip')} ${formatPartWithOptionalCost(parts.cacheTok, st?.cacheCostUsd)}`,
      };
    case 'think':
      return {
        short: formatTokens(parts.thinkTok),
        tip: `${t('steps.tokSeg.think.tip')} ${Math.round(parts.thinkTok).toLocaleString()}`,
      };
    case 'reply':
      return {
        short: formatTokens(parts.respTok),
        tip: `${t('steps.tokSeg.reply.tip')} ${Math.round(parts.respTok).toLocaleString()}`,
      };
    case 'total':
    default:
      return {
        short: formatTokens(parts.totalTok),
        tip: `${t('steps.tokSeg.total.tip')} ${formatPartWithOptionalCost(parts.totalTok, st?.costUsd)}`,
      };
  }
}

function formatStepClockTime(createdAtMs) {
  const ms = Number(createdAtMs || 0);
  if (!(ms > 0) || !Number.isFinite(ms)) {
    return { text: '—', title: '' };
  }
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const hhmmss = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const full = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmmss}`;
  return { text: hhmmss, title: full };
}

export const STEP_COLUMN_REGISTRY = Object.freeze({
  step: {
    key: 'step',
    thLabel: () => t('stepCol.step.th'),
    optLabel: () => t('stepCol.step.opt'),
    sigPart: (st) => `${st.stepIndex}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, `#${Number(st.stepIndex)}`);
    },
  },

  time: {
    key: 'time',
    thLabel: () => t('stepCol.time.th'),
    optLabel: () => t('stepCol.time.opt'),
    sigPart: (st) => `${st.createdAtMs || 0}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', { className: 'text-muted' }, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const { text, title } = formatStepClockTime(st.createdAtMs);
      patchText(refs.valEl, text);
      patchAttr(refs.td, 'title', title || null);
    },
  },

  model: {
    key: 'model',
    thLabel: () => t('stepCol.model.th'),
    optLabel: () => t('stepCol.model.opt'),
    sigPart: (st, ctx) => {
      const disp = resolveModelDisplayInfo(st, ctx.displaySettings, { fallback: '—' });
      return `${disp.baseText}:${disp.compactionSuffix}:${disp.title}`;
    },
    createCell: () => {
      const nameEl = h('span', { className: 'step-model-name' });
      const compactEl = h('span', { className: 'step-model-compact', hidden: true });
      const wrapEl = h('span', { className: 'step-model-cell' }, [nameEl, compactEl]);
      const td = h('td', {}, [wrapEl]);
      return { td, refs: { td, wrapEl, nameEl, compactEl } };
    },
    updateCell: (refs, st, ctx) => {
      const modelDisplay = resolveModelDisplayInfo(st, ctx.displaySettings, { fallback: '—' });
      patchText(refs.nameEl, modelDisplay.baseText);
      const suffix = modelDisplay.compactionSuffix || '';
      patchText(refs.compactEl, suffix);
      patchAttr(refs.compactEl, 'hidden', !suffix);
      patchAttr(refs.td, 'title', modelDisplay.title);
    },
  },

  tps: {
    key: 'tps',
    thLabel: () => t('stepCol.tps.th'),
    optLabel: () => t('stepCol.tps.opt'),
    sigPart: (st, ctx) =>
      `${st.tokPerSec}:${st.selectedSpeedReason || ''}:${ctx?.showStepSpeedColor === true ? 1 : 0}`,
    createCell: () => {
      const speedMain = h('strong', {
        className: 'cell-value tone-muted',
        style: 'font-size: var(--fs-base-sm);',
      });
      const wrapEl = h(
        'span',
        { style: 'display: inline-block; vertical-align: middle;' },
        [speedMain]
      );
      const td = h('td', {}, [wrapEl]);
      return { td, refs: { wrapEl, speedMain, speedReason: null } };
    },
    updateCell: (refs, st, ctx) => {
      patchText(refs.speedMain, formatSpeedMetric(st.tokPerSec, ' tok/s'));
      const hasValidSpeed =
        st.tokPerSec != null && Number.isFinite(Number(st.tokPerSec)) && Number(st.tokPerSec) > 0;
      const toneCls =
        ctx?.showStepSpeedColor === true
          ? getSpeedToneClass(st.tokPerSec)
          : hasValidSpeed
            ? ''
            : 'tone-muted';
      patchAttr(refs.speedMain, 'class', toneCls ? `cell-value ${toneCls}` : 'cell-value');
      const reason = speedReasonText(st.selectedSpeedReason);
      if (reason && !refs.speedReason) {
        refs.speedReason = h('div', {
          className: 'text-muted',
          style: 'font-size: var(--fs-xs);',
        });
        refs.wrapEl.appendChild(refs.speedReason);
      }
      if (refs.speedReason) {
        patchText(refs.speedReason, reason);
        patchAttr(refs.speedReason, 'hidden', !reason);
      }
    },
  },

  ttft: {
    key: 'ttft',
    thLabel: () => t('stepCol.ttft.th'),
    optLabel: () => t('stepCol.ttft.opt'),
    sigPart: (st) => `${st.ttftSec}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, formatMetric(st.ttftSec, 's'));
      const tone = getTtftToneClass(st.ttftSec);
      patchAttr(refs.valEl, 'class', tone || null);
    },
  },

  duration: {
    key: 'duration',
    thLabel: () => t('stepCol.duration.th'),
    optLabel: () => t('stepCol.duration.opt'),
    sigPart: (st) => `${st.totalDurationSec ?? st.streamDurationSec ?? ''}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const dur = st.totalDurationSec ?? st.streamDurationSec ?? null;
      patchText(refs.valEl, formatMetric(dur, 's'));
    },
  },

  tokens_combo: {
    key: 'tokens_combo',
    thLabel: () => t('stepCol.tokens_combo.th'),
    optLabel: () => t('stepCol.tokens_combo.opt'),
    sigPart: (st) =>
      `${st.contextTokens}:${st.outputTokens}:${st.thinkingTokens}:${st.responseTokens}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const parts = resolveStepTokenParts(st);
      patchText(
        refs.valEl,
        `${formatTokens(parts.ctxTok)} / ${formatTokens(parts.thinkTok)} / ${formatTokens(parts.respTok)}`
      );
      patchAttr(
        refs.td,
        'title',
        t('steps.ctxTitle', {
          ctx: Math.round(parts.ctxTok),
          think: Math.round(parts.thinkTok),
          resp: Math.round(parts.respTok),
        })
      );
    },
  },

  tokens_io_cache: {
    key: 'tokens_io_cache',
    thLabel: () => t('stepCol.tokens_io_cache.th'),
    optLabel: () => t('stepCol.tokens_io_cache.opt'),
    sigPart: (st) =>
      `${st.inputTokens || 0}:${st.outputTokens || 0}:${st.cacheReadTokens || 0}:${st.inCostUsd ?? ''}:${st.outCostUsd ?? ''}:${st.cacheCostUsd ?? ''}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const parts = resolveStepTokenParts(st);
      patchText(
        refs.valEl,
        `${formatTokens(parts.inTok)} / ${formatTokens(parts.outTok)} / ${formatTokens(parts.cacheTok)}`
      );
      patchAttr(
        refs.td,
        'title',
        t('steps.ioCacheTitle', {
          inPart: formatPartWithOptionalCost(parts.inTok, st?.inCostUsd),
          outPart: formatPartWithOptionalCost(parts.outTok, st?.outCostUsd),
          cachePart: formatPartWithOptionalCost(parts.cacheTok, st?.cacheCostUsd),
        })
      );
    },
  },

  tokens_custom: {
    key: 'tokens_custom',
    thLabel: (ctx) => formatCustomTokenComboHeader(ctx?.stepTokenComboFormat),
    optLabel: (ctx) =>
      t('stepCol.tokens_custom.opt', {
        fmt: formatCustomTokenComboHeader(ctx?.stepTokenComboFormat),
      }),
    sigPart: (st, ctx) =>
      `${normalizeClientStepTokenComboFormat(ctx?.stepTokenComboFormat)}:${st.contextTokens || 0}:${st.inputTokens || 0}:${st.cacheReadTokens || 0}:${st.outputTokens || 0}:${st.thinkingTokens || 0}:${st.responseTokens ?? ''}:${st.costUsd ?? ''}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st, ctx) => {
      const segs = parseClientStepTokenComboSegments(ctx?.stepTokenComboFormat);
      const parts = resolveStepTokenParts(st);
      const rendered = segs.map((seg) => resolveSegmentDisplay(seg, parts, st));
      patchText(
        refs.valEl,
        rendered.map((r) => r.short).join(' / ')
      );
      patchAttr(
        refs.td,
        'title',
        rendered.map((r) => r.tip).join(' · ')
      );
    },
  },

  input_tokens: {
    key: 'input_tokens',
    thLabel: () => t('stepCol.input_tokens.th'),
    optLabel: () => t('stepCol.input_tokens.opt'),
    sigPart: (st) => `${st.inputTokens || 0}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, formatTokens(st.inputTokens || 0));
    },
  },

  cache_tokens: {
    key: 'cache_tokens',
    thLabel: () => t('stepCol.cache_tokens.th'),
    optLabel: () => t('stepCol.cache_tokens.opt'),
    sigPart: (st) => `${st.cacheReadTokens || 0}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, formatTokens(st.cacheReadTokens || 0));
    },
  },

  output_tokens: {
    key: 'output_tokens',
    thLabel: () => t('stepCol.output_tokens.th'),
    optLabel: () => t('stepCol.output_tokens.opt'),
    sigPart: (st) => `${st.outputTokens || 0}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, formatTokens(st.outputTokens || 0));
    },
  },

  cache: {
    key: 'cache',
    thLabel: () => t('stepCol.cache.th'),
    optLabel: () => t('stepCol.cache.opt'),
    sigPart: (st) =>
      `${st.cacheHitPct ?? 0}:${(st.inputTokens || 0) + (st.cacheReadTokens || 0) > 0 ? 1 : 0}`,
    createCell: () => {
      const valEl = h('span', {
        className: 'cell-value tone-muted',
        style: 'font-size: var(--fs-base-sm);',
      });
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const promptTokens = Number(st.inputTokens || 0) + Number(st.cacheReadTokens || 0);
      patchText(refs.valEl, formatCachePct(st.cacheHitPct ?? 0));
      patchAttr(
        refs.valEl,
        'class',
        `cell-value ${getCacheToneClass(st.cacheHitPct ?? 0, promptTokens)}`
      );
    },
  },

  cost: {
    key: 'cost',
    thLabel: () => t('stepCol.cost.th'),
    optLabel: () => t('stepCol.cost.opt'),
    sigPart: (st) => `${st.costUsd}`,
    createCell: () => {
      const valEl = h('span', { style: 'font-weight: 600;' });
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const costVal = st.costUsd;
      patchText(refs.valEl, formatUsd(costVal, { precise: true }));
      const tone = getStepCostToneClass(costVal);
      patchAttr(refs.valEl, 'class', tone || null);
    },
  },
});

export function getStepColumnOptions(
  stepTokenComboFormat = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT
) {
  const ctx = { stepTokenComboFormat };
  return STEP_COLUMN_KEYS.map((key) => ({
    value: key,
    label: STEP_COLUMN_REGISTRY[key].optLabel(ctx),
  }));
}
