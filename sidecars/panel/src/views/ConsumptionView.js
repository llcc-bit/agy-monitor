/**
 * @fileoverview View 2: ConsumptionView (全景消耗统计视图).
 * 采用 5 段式分析布局展示指定时间窗口内的全量 Token 与费用消耗：
 * 1. 用量概览：支持预设时间段与自定义区间筛选，通过 3+3 组合矩阵展示总 Token/调用次数、
 *    USD/CNY 预估费用、缓存命中率与命中量、新输入/缓存读取（含节省费用）/输出细分占比，以及底部 4 段比例条 (`FourSegmentBar`)。
 * 2. 历史趋势：基于 `TrendAreaChart` 渲染纯 SVG 三次贝塞尔平滑曲线面积图、峰值气泡、对齐多刻度时间轴与悬停详情浮层。
 * 3. 热门模型：按 Token 总量降序展示各模型的消耗占比徽章、4 段构成条及输入/缓存/输出/思考/调用明细。
 * 4. 数据来源：按调用来源聚合展示 Token 构成、占比与费用明细。
 * 5. 按月细分：12 个月垂直 4 段堆叠柱状图，直观对比全年各月费用、Token 总量与缓存/思考结构。
 */

import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../core/domPatch.js';
import {
  buildDeterministicModelColorMap,
  formatCnyApprox,
  formatDateSpanBadge,
  formatTokensPrecise,
  formatUsd,
  getCanonicalModelColorSeed,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdDisplayMode,
  resolveDeterministicModelColor,
} from '../core/formatters.js';
import { scaleBucketsExact } from '../../shared/telemetry-display-rules.mjs';
import { i18nStore, isEnglishLocale, t } from '../i18n/index.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import {
  prefetchConsumptionPresets,
  selectConsumptionTimeRange,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import {
  createTrendAreaChart,
  HEATMAP_DAYS_THRESHOLD,
} from '../components/charts/TrendAreaChart.js';
import { CustomDateTimePicker } from '../components/ui/CustomDateTimePicker.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { createFourSegmentBar } from '../components/ui/FourSegmentBar.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';

/** 消耗统计顶栏支持的时间范围预设项 */
function getConsumptionTimeRangeOptions() {
  return [
    { value: 'cycle', label: t('cons.rangeCycle') },
    { value: 'today', label: t('cons.rangeToday') },
    { value: '24h', label: t('cons.range24h') },
    { value: '7d', label: t('cons.range7d') },
    { value: '14d', label: t('cons.range14d') },
    { value: '30d', label: t('cons.range30d') },
    { value: 'all', label: t('cons.rangeAll') },
    { value: 'custom', label: t('cons.rangeCustom') },
  ];
}

export const ConsumptionView = defineComponent({
  name: 'ConsumptionView',
  setup({ onCleanup }) {
    // --- 时间筛选栏：快速时间段分段控制器与自定义起止时间选择条 ---
    let draftStartMs = telemetryStore.getState().customStartMs;
    let draftEndMs = telemetryStore.getState().customEndMs;
    let hasUncommittedCustomDraft = false;

    const timeFilterSwitch = SegmentedControl({
      ariaLabel: t('cons.rangeAria'),
      modelValue: telemetryStore.getState().selectedTimeRange,
      options: getConsumptionTimeRangeOptions(),
      onUpdateModelValue: (nextRange) => {
        if (nextRange === 'custom') {
          const st = telemetryStore.getState();
          draftStartMs = st.customStartMs;
          draftEndMs = st.customEndMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(draftStartMs);
          endPicker.setValue(draftEndMs);
        } else {
          hasUncommittedCustomDraft = false;
        }
        selectConsumptionTimeRange(nextRange);
      },
    });

    const startPicker = CustomDateTimePicker({
      modelValue: draftStartMs,
      onUpdateModelValue: (ms) => {
        draftStartMs = ms;
        hasUncommittedCustomDraft = true;
        startPicker.setValue(ms);
      },
    });

    const endPicker = CustomDateTimePicker({
      modelValue: draftEndMs,
      onUpdateModelValue: (ms) => {
        draftEndMs = ms;
        hasUncommittedCustomDraft = true;
        endPicker.setValue(ms);
      },
    });

    const applyCustomBtnLabel = h('span', { text: t('cons.applyFilter') });
    const applyCustomBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        style: 'height: 26px; padding: 0 10px;',
        onClick: () => {
          const sMs = Number(draftStartMs || 0);
          const eMs = Number(draftEndMs || 0);
          const minMs = sMs > 0 && eMs > 0 ? Math.min(sMs, eMs) : sMs;
          const maxMs = sMs > 0 && eMs > 0 ? Math.max(sMs, eMs) : eMs;
          draftStartMs = minMs;
          draftEndMs = maxMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(minMs);
          endPicker.setValue(maxMs);
          selectConsumptionTimeRange('custom', {
            customStartMs: minMs,
            customEndMs: maxMs,
          });
        },
      },
      [createSvgIcon('check', { size: 12 }), applyCustomBtnLabel]
    );

    const rangeToSpan = h('span', { className: 'text-muted', text: t('cons.rangeTo') });
    const customRangeBar = h(
      'div',
      {
        className: 'cons-custom-range-bar',
        hidden: true,
      },
      [
        startPicker.el,
        rangeToSpan,
        endPicker.el,
        applyCustomBtn,
      ]
    );

    // --- Section 1: 用量概览矩阵 (上层 3 列核心总量 + 下层 3 列新输入/缓存读取/输出拆分 + 底部 4 段比例条) ---
    const dateSpanBadge = h('span', { className: 'cons-badge text-mono', text: '-- ~ --' });
    const heroTotalTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });
    const heroTotalCalls = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.callsCount', { calls: 0 }) });
    const heroCostUsd = h('strong', { className: 'cons-hero-cost text-mono', text: '$0.00' });
    const heroCostCny = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: '≈ ¥0' });

    const cacheHitPctEl = h('strong', { className: 'cons-hero-cache text-mono', text: '0%' });
    const cacheTokensEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.cacheHitTokens', { tokens: 0 }) });

    const inputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-input); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const inputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const inputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.uncachedInput') });

    const cacheSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-cached); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const cacheMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const cacheSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.savedCost', { cost: '$0.00' }) });

    const outputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-output); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const outputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const outputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.replyAndThink', { resp: 0, think: 0 }) });

    const overviewSegBar = createFourSegmentBar();
    const overviewTitleSpan = h('span', { text: t('cons.overviewTitle') });
    const totalTokensLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.totalTokens') });
    const estCostLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.estCost') });
    const cacheHitRateLabel = h('span', { text: t('cons.cacheHitRate') });
    const newInputLabel = h('span', { text: t('cons.newInput') });
    const cacheReadLabel = h('span', { text: t('cons.cacheRead') });
    const outputUsageLabel = h('span', { text: t('cons.outputUsage') });

    const overviewPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-overview-head' }, [
        h('span', { className: 'panel-title' }, [
          overviewTitleSpan,
          dateSpanBadge,
        ]),
        timeFilterSwitch.el,
      ]),
      customRangeBar,
      h('div', { className: 'cons-box cons-unified-matrix' }, [
        h('div', { className: 'cons-split-3' }, [
          h('div', { className: 'cons-col' }, [
            totalTokensLabel,
            h('div', { className: 'cons-baseline' }, [heroTotalTokens, heroTotalCalls]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            estCostLabel,
            h('div', { className: 'cons-baseline' }, [heroCostUsd, heroCostCny]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('span', { className: 'legend-left', style: 'font-size: var(--fs-md);' }, [
              h('span', { className: 'dot-swatch seg-cached' }),
              cacheHitRateLabel,
            ]),
            h('div', { className: 'cons-baseline' }, [cacheHitPctEl, cacheTokensEl]),
          ]),
        ]),
        h('div', { className: 'cons-split-3 cons-matrix-bottom' }, [
          h('div', { className: 'cons-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-input' }),
                newInputLabel,
              ]),
              inputSharePct,
            ]),
            inputMainTokens,
            inputSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-cached' }),
                cacheReadLabel,
              ]),
              cacheSharePct,
            ]),
            cacheMainTokens,
            cacheSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-output' }),
                outputUsageLabel,
              ]),
              outputSharePct,
            ]),
            outputMainTokens,
            outputSubText,
          ]),
        ]),
      ]),
      overviewSegBar.el,
    ]);

    // --- Section 2: 历史趋势 (交互式 SVG 平滑曲线图 + 悬停精确日期/小时浮层 + 多刻度时间轴) ---
    const trendTitleSpan = h('span', { text: t('cons.trendTitle') });
    const trendRangeBadge = h('span', { className: 'cons-badge', text: t('cons.allTime') });
    const trendGranularityHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.trendPointsHintHourly', { points: 0 }),
    });
    const trendChart = createTrendAreaChart();

    const trendPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          trendTitleSpan,
          trendRangeBadge,
        ]),
        trendGranularityHint,
      ]),
      trendChart.el,
    ]);

    // --- Section 3: 模型排行列表 ---
    const modelsTitleSpan = h('span', { className: 'panel-title', text: t('cons.topModels') });
    const modelsListEl = h('div', { className: 'cons-item-list' });
    const modelsPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        modelsTitleSpan,
      ]),
      modelsListEl,
    ]);

    // --- Section 4: 客户端来源列表 ---
    const sourcesTitleSpan = h('span', { className: 'panel-title', text: t('cons.clientSources') });
    const sourcesHoverHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.hoverModelsHint'),
    });
    const sourcesListEl = h('div', { className: 'cons-item-list' });
    const sourcesPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        sourcesTitleSpan,
        sourcesHoverHint,
      ]),
      sourcesListEl,
    ]);

    // --- Section 5: 按月细分 (12 个月垂直按模型配色堆叠柱状图 + 悬停明细浮层) ---
    const monthlyTitleSpan = h('span', { text: t('cons.monthlyTitle') });
    const monthlyYearBadge = h('span', { className: 'cons-badge text-mono', text: '2026' });
    const monthlyHoverHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.hoverModelsHint'),
    });

    let activeHoverTargetEl = null;

    function createPopoverModelRow() {
      const dotEl = h('span', { className: 'dot-swatch cons-model-dot' });
      const nameEl = h('span', { className: 'cons-pop-model-name' });
      const tokEl = h('span', { className: 'cons-pop-model-tok' });
      const pctEl = h('strong', { className: 'cons-pop-model-pct' });
      const rowEl = h('div', { className: 'cons-pop-model-row' }, [
        h('span', { className: 'cons-pop-model-left' }, [dotEl, nameEl]),
        h('span', { className: 'cons-pop-model-right text-mono' }, [tokEl, pctEl]),
      ]);
      return {
        el: rowEl,
        refs: { rowEl, dotEl, nameEl, tokEl, pctEl },
      };
    }

    const popTitleEl = h('span', { className: 'trend-tip-time' });
    const popCallsEl = h('span', { className: 'trend-tip-calls text-mono' });
    const popTokensEl = h('strong', { className: 'trend-tip-tokens text-mono' });
    const popCostEl = h('span', { className: 'trend-tip-cost text-mono' });
    const popListEl = h('div', { className: 'cons-pop-models' });
    const breakdownPopoverEl = h(
      'div',
      { className: 'cons-breakdown-popover', hidden: true },
      [
        h('div', { className: 'trend-tip-head' }, [popTitleEl, popCallsEl]),
        h('div', { className: 'trend-tip-main' }, [popTokensEl, popCostEl]),
        popListEl,
      ]
    );

    function hideBreakdownPopover() {
      if (activeHoverTargetEl) {
        patchClasses(activeHoverTargetEl, { 'is-hovered': false });
        activeHoverTargetEl = null;
      }
      patchAttr(breakdownPopoverEl, 'hidden', true);
      patchClasses(breakdownPopoverEl, { 'is-tracking': false });
    }

    function positionBreakdownPopover(anchorEl, pointerClientX = null) {
      const rootRect = rootEl.getBoundingClientRect?.() || {
        left: 0,
        top: 0,
        width: 360,
        height: 600,
      };
      const anchorRect = anchorEl?.getBoundingClientRect?.() || {
        left: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
      };
      const tipRect = breakdownPopoverEl.getBoundingClientRect?.() || {
        width: 220,
        height: 120,
      };
      const rootW = rootRect.width > 0 ? rootRect.width : 360;
      const rootH = rootRect.height > 0 ? rootRect.height : 600;
      const tipW = tipRect.width > 0 ? tipRect.width : 220;
      const tipH = tipRect.height > 0 ? tipRect.height : 120;

      const centerX =
        Number.isFinite(pointerClientX) && pointerClientX > 0 && rootRect.width > 0
          ? pointerClientX - rootRect.left
          : anchorRect.left - rootRect.left + anchorRect.width / 2;

      const maxLeft = Math.max(8, rootW - tipW - 8);
      const leftPx = Math.max(8, Math.min(maxLeft, centerX - tipW / 2));

      const aboveTop = anchorRect.top - rootRect.top - tipH - 8;
      const belowTop = anchorRect.bottom - rootRect.top + 8;
      const topPx =
        aboveTop >= 6
          ? aboveTop
          : Math.min(Math.max(6, rootH - tipH - 6), Math.max(6, belowTop));

      patchStyleVar(breakdownPopoverEl, '--pop-x', `${Math.round(leftPx)}px`);
      patchStyleVar(breakdownPopoverEl, '--pop-y', `${Math.round(topPx)}px`);
    }

    function showBreakdownPopover(anchorEl, payload, pointerClientX = null) {
      if (!payload || !(payload.totalTokens > 0 || payload.calls > 0)) {
        hideBreakdownPopover();
        return;
      }
      if (activeHoverTargetEl && activeHoverTargetEl !== anchorEl) {
        patchClasses(activeHoverTargetEl, { 'is-hovered': false });
      }
      activeHoverTargetEl = anchorEl;
      patchClasses(anchorEl, { 'is-hovered': true });

      patchText(popTitleEl, payload.title || '—');
      patchText(popCallsEl, t('cons.callsCount', { calls: payload.calls || 0 }));
      patchText(popTokensEl, `${formatTokensPrecise(payload.totalTokens || 0)} tok`);
      patchText(popCostEl, payload.costText || '$0.00');

      const rows = Array.isArray(payload.segments) ? payload.segments : [];
      patchAttr(popListEl, 'hidden', rows.length === 0);
      patchKeyedList(popListEl, rows, {
        keyFn: (r) => r.key,
        sigFn: (r) => `${r.key}:${r.label}:${r.color}:${r.tokText}:${r.pctText}:${r.isOther}`,
        createRow: createPopoverModelRow,
        updateRow: (rRefs, r) => {
          patchClasses(rRefs.rowEl, { 'is-other': Boolean(r.isOther) });
          patchStyleVar(rRefs.dotEl, '--dot-color', r.color);
          patchText(rRefs.nameEl, r.label);
          patchText(rRefs.tokEl, r.tokText);
          patchText(rRefs.pctEl, r.pctText);
        },
      });

      const wasHidden = breakdownPopoverEl.hasAttribute('hidden');
      patchAttr(breakdownPopoverEl, 'hidden', false);
      positionBreakdownPopover(anchorEl, pointerClientX);
      if (wasHidden) {
        patchClasses(breakdownPopoverEl, { 'is-tracking': false });
        void breakdownPopoverEl.offsetWidth;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            if (!breakdownPopoverEl.hasAttribute('hidden')) {
              patchClasses(breakdownPopoverEl, { 'is-tracking': true });
            }
          });
        } else {
          patchClasses(breakdownPopoverEl, { 'is-tracking': true });
        }
      }
    }

    function createMonthModelSegment() {
      const segEl = h('div', { className: 'month-seg cons-model-seg' });
      return { el: segEl, refs: { segEl } };
    }

    const monthlyCols = Array.from({ length: 12 }, (_, idx) => {
      const costText = h('span', { className: 'month-cost text-mono', text: '' });
      const stackWrap = h('div', { className: 'month-stack' });
      const zeroDot = h('span', { className: 'month-zero-dot' });
      const monthLabel = h('span', { className: 'month-label', text: t('cons.monthLabel', { m: idx + 1 }) });
      const tokText = h('span', { className: 'month-tok text-mono', text: '' });

      const colState = { hoverPayload: null };
      const colEl = h(
        'div',
        {
          className: 'month-col',
          onMouseEnter: (e) => {
            if (colState.hoverPayload) {
              showBreakdownPopover(colEl, colState.hoverPayload, null);
            } else {
              e?.stopPropagation?.();
            }
          },
          onMouseLeave: () => {
            if (activeHoverTargetEl === colEl) hideBreakdownPopover();
          },
        },
        [
          costText,
          h('div', { className: 'month-bar-well' }, [stackWrap, zeroDot]),
          monthLabel,
          tokText,
        ]
      );
      return {
        el: colEl,
        costText,
        stackWrap,
        zeroDot,
        monthLabel,
        tokText,
        colState,
      };
    });

    const monthlyPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          monthlyTitleSpan,
          monthlyYearBadge,
        ]),
        monthlyHoverHint,
      ]),
      h(
        'div',
        { className: 'monthly-grid' },
        monthlyCols.map((c) => c.el)
      ),
    ]);

    const scrollInner = h(
      'div',
      {
        style: 'display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-3);',
      },
      [
        overviewPanel,
        trendPanel,
        modelsPanel,
        sourcesPanel,
        monthlyPanel,
      ]
    );

    const viewScrollbar = CustomScrollbar({
      contentEl: scrollInner,
      className: 'view-pane',
    });
    viewScrollbar.el.addEventListener?.('scroll', hideBreakdownPopover, { passive: true });

    const rootEl = h('div', { className: 'cons-view-stage' }, [
      viewScrollbar.el,
      breakdownPopoverEl,
    ]);

    /**
     * 将分模型列表收敛为主力模型 + 长尾「其他 (N)」，避免进度条尾部与浮层出现 0.0% 碎屑噪音。
     */
    function partitionModelSegments(
      mergedModels,
      modelColorMap,
      { maxMain = 5, minSharePct = 1.5 } = {}
    ) {
      if (!Array.isArray(mergedModels) || mergedModels.length === 0) return [];
      const sumTok = mergedModels.reduce((sum, m) => sum + Number(m.totalTokens || 0), 0);
      const mainModels = [];
      const tailModels = [];

      for (let i = 0; i < mergedModels.length; i++) {
        const m = mergedModels[i];
        const mTok = Number(m.totalTokens || 0);
        const sharePct = sumTok > 0 ? (mTok / sumTok) * 100 : 0;
        if (i === 0 || (mainModels.length < maxMain && sharePct >= minSharePct)) {
          mainModels.push(m);
        } else {
          tailModels.push(m);
        }
      }

      if (tailModels.length === 1) {
        mainModels.push(tailModels.pop());
      }

      const out = mainModels.map((m) => {
        const seed = getCanonicalModelColorSeed(m);
        const color =
          modelColorMap?.get(seed) || resolveDeterministicModelColor(seed || m.displayText);
        const tok = Number(m.totalTokens || 0);
        const pct = sumTok > 0 ? (tok / sumTok) * 100 : 0;
        const label = m.displayText || m.label || m.shortName || '—';
        return {
          key: label,
          label,
          tok,
          pct,
          tokText: formatTokensPrecise(tok),
          pctText: `${pct.toFixed(1)}%`,
          color,
          isOther: false,
        };
      });

      if (tailModels.length >= 2) {
        const otherTok = tailModels.reduce((sum, m) => sum + Number(m.totalTokens || 0), 0);
        const otherPct = sumTok > 0 ? (otherTok / sumTok) * 100 : 0;
        const otherLabel = t('cons.otherModelsCount', { count: tailModels.length });
        out.push({
          key: '__other__',
          label: otherLabel,
          tok: otherTok,
          pct: otherPct,
          tokText: formatTokensPrecise(otherTok),
          pctText: `${otherPct.toFixed(1)}%`,
          color: 'var(--cons-other-seg)',
          isOther: true,
        });
      }

      return out;
    }

    /**
     * 创建热门模型单行 DOM 结构（模型名称后附专属颜色圆点 + 按总占比缩放的 4 段比例条 + 底部分项脚标）。
     */
    function createBreakdownItemRow() {
      const nameTextEl = h('span', { className: 'cons-row-title-text' });
      const modelDotEl = h('span', { className: 'dot-swatch cons-model-dot cons-title-model-dot' });
      const nameEl = h('strong', { className: 'cons-row-title' }, [nameTextEl, modelDotEl]);
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const segBar = createFourSegmentBar();

      const inLbl = h('span', { text: t('cons.footInput') });
      const cacheLbl = h('span', { text: t('cons.footCache') });
      const outLbl = h('span', { text: t('cons.footOutput') });
      const thinkLbl = h('span', { text: t('cons.footThinking') });
      const callsLbl = h('span', { text: t('cons.footCalls') });

      const inVal = h('strong', { className: 'text-mono' });
      const cacheVal = h('strong', { className: 'text-mono' });
      const outVal = h('strong', { className: 'text-mono' });
      const thinkVal = h('strong', { className: 'text-mono' });
      const callsVal = h('strong', { className: 'text-mono' });

      const rowEl = h('div', { className: 'cons-item-row' }, [
        h('div', { className: 'panel-header' }, [
          nameEl,
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        segBar.el,
        h('div', { className: 'cons-item-foot' }, [
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-input' }),
            inLbl,
            inVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-cached' }),
            cacheLbl,
            cacheVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-output' }),
            outLbl,
            outVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-thinking' }),
            thinkLbl,
            thinkVal,
          ]),
          h('span', { className: 'legend-left' }, [
            callsLbl,
            callsVal,
          ]),
        ]),
      ]);

      return {
        el: rowEl,
        refs: {
          nameEl,
          nameTextEl,
          modelDotEl,
          pctBadge,
          totalTokEl,
          costEl,
          segBar,
          inLbl,
          cacheLbl,
          outLbl,
          thinkLbl,
          callsLbl,
          inVal,
          cacheVal,
          outVal,
          thinkVal,
          callsVal,
        },
      };
    }

    /**
     * 增量更新热门模型单行的指标文本、名称后的专属颜色圆点与按总占比缩放的 4 段比例条宽度。
     */
    function updateBreakdownItemRow(refs, item, grandTotalTokens, modelColor = '') {
      patchText(refs.inLbl, t('cons.footInput'));
      patchText(refs.cacheLbl, t('cons.footCache'));
      patchText(refs.outLbl, t('cons.footOutput'));
      patchText(refs.thinkLbl, t('cons.footThinking'));
      patchText(refs.callsLbl, t('cons.footCalls'));
      const displayLabel = item.label || item.name || item.shortName || '—';
      patchText(refs.nameTextEl, displayLabel);
      patchAttr(refs.nameEl, 'title', item.title || displayLabel);
      patchAttr(refs.modelDotEl, 'hidden', !modelColor);
      if (modelColor) {
        patchStyleVar(refs.modelDotEl, '--dot-color', modelColor);
      }
      const total = Number(item.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      const scaleRatio =
        grandTotalTokens > 0 && total > 0 ? Math.min(1, Math.max(0.008, total / grandTotalTokens)) : 0;
      patchText(refs.pctBadge, `${share.toFixed(1)}%`);
      patchText(refs.totalTokEl, formatTokensPrecise(total));
      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      patchText(
        refs.costEl,
        formatUsd(isAllUnpriced ? null : costVal, {
          precise: costVal > 0 && costVal < 0.1,
        })
      );

      const responseTok =
        item.responseTokens != null
          ? Number(item.responseTokens)
          : Math.max(0, Number(item.outputTokens || 0) - Number(item.thinkingTokens || 0));
      const thinkingTok = Number(item.thinkingTokens || 0);

      refs.segBar.update({
        inputTokens: Number(item.inputTokens || 0),
        cacheReadTokens: Number(item.cacheReadTokens || 0),
        responseTokens: responseTok,
        thinkingTokens: thinkingTok,
        scaleRatio,
      });

      patchText(refs.inVal, formatTokensPrecise(item.inputTokens || 0));
      patchText(refs.cacheVal, formatTokensPrecise(item.cacheReadTokens || 0));
      patchText(refs.outVal, formatTokensPrecise(responseTok));
      patchText(refs.thinkVal, formatTokensPrecise(thinkingTok));
      patchText(refs.callsVal, String(Number(item.calls || 0)));
    }

    function createSourceModelSegment() {
      const segEl = h('div', { className: 'progress-seg cons-model-seg' });
      return { el: segEl, refs: { segEl } };
    }

    function createSourceTopModelItem() {
      const dotEl = h('span', { className: 'dot-swatch cons-model-dot cons-source-top-dot' });
      const nameEl = h('span', { className: 'cons-source-top-name' });
      const pctEl = h('strong', { className: 'cons-source-top-pct text-mono' });
      const itemEl = h('span', { className: 'cons-source-top-item' }, [dotEl, nameEl, pctEl]);
      return { el: itemEl, refs: { itemEl, dotEl, nameEl, pctEl } };
    }

    function formatCompactSourceSharePct(pct) {
      const num = Number(pct || 0);
      if (!Number.isFinite(num) || num <= 0) return '0%';
      if (num >= 10) return `${Math.round(num)}%`;
      return `${num.toFixed(1)}%`;
    }

    /**
     * 创建客户端来源单行 DOM 结构（保留长尾合并分段配色进度条、单行不换行的 Top 2-3 模型速览和右侧总调用数，悬停进度条或速览区弹出完整明细浮层）。
     */
    function createSourceBreakdownRow() {
      const nameTextEl = h('span', { className: 'cons-row-title-text' });
      const nameEl = h('strong', { className: 'cons-row-title' }, [nameTextEl]);
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const trackEl = h('div', { className: 'progress-track cons-seg-bar cons-source-model-bar' });
      const rowState = { hoverPayload: null };
      const bindPopoverHover = (targetEl) => ({
        onMouseEnter: (e) => {
          if (rowState.hoverPayload) {
            showBreakdownPopover(targetEl, rowState.hoverPayload, e?.clientX ?? null);
          }
        },
        onMouseMove: (e) => {
          if (rowState.hoverPayload && activeHoverTargetEl === targetEl) {
            positionBreakdownPopover(targetEl, e?.clientX ?? null);
          }
        },
        onMouseLeave: () => {
          if (activeHoverTargetEl === targetEl) hideBreakdownPopover();
        },
      });
      const barHitEl = h(
        'div',
        {
          className: 'cons-source-bar-hit',
        },
        [trackEl]
      );
      const barHandlers = bindPopoverHover(barHitEl);
      barHitEl.addEventListener('mouseenter', barHandlers.onMouseEnter);
      barHitEl.addEventListener('mousemove', barHandlers.onMouseMove);
      barHitEl.addEventListener('mouseleave', barHandlers.onMouseLeave);

      const topModelsEl = h('div', { className: 'cons-source-top-models', hidden: true });
      const topHandlers = bindPopoverHover(topModelsEl);
      topModelsEl.addEventListener('mouseenter', topHandlers.onMouseEnter);
      topModelsEl.addEventListener('mousemove', topHandlers.onMouseMove);
      topModelsEl.addEventListener('mouseleave', topHandlers.onMouseLeave);

      const callsLbl = h('span', { text: t('cons.footCalls') });
      const callsVal = h('strong', { className: 'text-mono' });

      const rowEl = h('div', { className: 'cons-item-row cons-source-row' }, [
        h('div', { className: 'panel-header' }, [
          nameEl,
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        barHitEl,
        h('div', { className: 'cons-item-foot cons-source-foot' }, [
          topModelsEl,
          h('span', { className: 'legend-left cons-calls-stat' }, [
            callsLbl,
            callsVal,
          ]),
        ]),
      ]);

      return {
        el: rowEl,
        refs: {
          nameEl,
          nameTextEl,
          pctBadge,
          totalTokEl,
          costEl,
          barHitEl,
          trackEl,
          topModelsEl,
          callsLbl,
          callsVal,
          rowState,
        },
      };
    }

    function updateSourceBreakdownRow(refs, item, grandTotalTokens, modelColorMap) {
      patchText(refs.callsLbl, t('cons.footCalls'));
      const displayLabel = item.label || item.name || '—';
      patchText(refs.nameTextEl, displayLabel);
      patchAttr(refs.nameEl, 'title', item.title || displayLabel);

      const total = Number(item.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      const scaleRatio =
        grandTotalTokens > 0 && total > 0 ? Math.min(1, Math.max(0.01, total / grandTotalTokens)) : 0;
      patchText(refs.pctBadge, `${share.toFixed(1)}%`);
      patchText(refs.totalTokEl, formatTokensPrecise(total));

      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      const costText = formatUsd(isAllUnpriced ? null : costVal, {
        precise: costVal > 0 && costVal < 0.1,
      });
      patchText(refs.costEl, costText);
      patchText(refs.callsVal, String(callsCount));

      const sourceModels = Array.isArray(item.mergedModels) ? item.mergedModels : [];
      const partitioned = partitionModelSegments(sourceModels, modelColorMap, {
        maxMain: 5,
        minSharePct: 1.5,
      });

      const barItems =
        partitioned.length > 0
          ? partitioned.map((seg) => ({
              key: seg.key,
              segPct: scaleRatio > 0 ? seg.pct * scaleRatio : 0,
              color: seg.color,
            }))
          : total > 0
            ? [
                {
                  key: '__source_fallback__',
                  segPct: scaleRatio * 100,
                  color: 'var(--accent-primary)',
                },
              ]
            : [];

      patchKeyedList(refs.trackEl, barItems, {
        keyFn: (seg) => seg.key,
        sigFn: (seg) => `${seg.key}:${seg.segPct.toFixed(2)}:${seg.color}`,
        createRow: createSourceModelSegment,
        updateRow: (segRefs, seg) => {
          patchStyleVar(segRefs.segEl, '--seg-w', `${seg.segPct.toFixed(2)}%`);
          patchStyleVar(segRefs.segEl, '--seg-color', seg.color);
        },
      });

      const topModels = partitioned
        .filter((seg) => !seg.isOther)
        .slice(0, 3)
        .map((seg) => ({
          key: seg.key,
          label: seg.label,
          pctText: formatCompactSourceSharePct(seg.pct),
          color: seg.color,
        }));
      patchAttr(refs.topModelsEl, 'hidden', topModels.length === 0);
      patchKeyedList(refs.topModelsEl, topModels, {
        keyFn: (m) => m.key,
        sigFn: (m) => `${m.key}:${m.label}:${m.pctText}:${m.color}`,
        createRow: createSourceTopModelItem,
        updateRow: (mRefs, m) => {
          patchStyleVar(mRefs.dotEl, '--dot-color', m.color);
          patchText(mRefs.nameEl, m.label);
          patchText(mRefs.pctEl, m.pctText);
          patchAttr(mRefs.itemEl, 'title', `${m.label} (${m.pctText})`);
        },
      });

      refs.rowState.hoverPayload =
        total > 0 || callsCount > 0
          ? {
              title: displayLabel,
              calls: callsCount,
              totalTokens: total,
              costText,
              segments: partitioned,
            }
          : null;
    }

    let latestSlice = null;
    let isDirty = false;
    let prefetchedOnCurrentVisit = false;

    let lastRenderedTuple = null;
    let cachedMonthlySeriesRef = null;
    let cachedMonthlyDisplayKey = '';
    let cachedMonthsMergedModels = null;
    let cachedAllMonthMergedModels = null;

    function isSameRenderTuple(prev, next) {
      if (!prev || prev.length !== next.length) return false;
      for (let i = 0; i < prev.length; i++) {
        if (!Object.is(prev[i], next[i])) return false;
      }
      return true;
    }

    /**
     * 将遥测状态切片同步渲染至消费统计视图的 5 个子面板。
     */
    function renderConsumptionData(slice) {
      if (!slice) return;
      const cons = slice.consumption || {};
      const rangeInfo = cons.selectedRange || {};

      // 始终在 0ms 同步顶部时间段滑块与自定义日期条显隐，给予即刻交互反馈
      timeFilterSwitch.setValue(slice.range);
      patchAttr(customRangeBar, 'hidden', slice.range !== 'custom');
      if (!hasUncommittedCustomDraft) {
        draftStartMs = slice.customStartMs;
        draftEndMs = slice.customEndMs;
        startPicker.setValue(draftStartMs);
        endPicker.setValue(draftEndMs);
      }

      // 极少数缓存未命中时（如自定义新区间或进页瞬间抢点），跳过用旧趋势/模型跑无效半更新重绘，待几毫秒后单帧原子绘制
      if (rangeInfo.key && slice.range && rangeInfo.key !== slice.range) {
        return;
      }

      const preset =
        slice.range !== 'custom' && cons.presets?.[slice.range]
          ? cons.presets[slice.range]
          : null;
      const acct = cons.account || preset?.account || {};
      const dateSpan = formatDateSpanBadge(rangeInfo.startMs, rangeInfo.endMs);
      const now = new Date();
      const currentMonthIdx = now.getMonth();
      const monthlyYear = cons.monthlyYear || now.getFullYear();
      const locale = i18nStore.getState().locale;
      const renderTuple = [
        locale,
        slice.range,
        slice.customStartMs,
        slice.customEndMs,
        slice.modelDisplayMode,
        slice.showUpstreamModel,
        slice.orchestratorIdMode,
        dateSpan,
        preset?.label || rangeInfo.label,
        acct,
        cons.trendSeries,
        slice.modelBreakdown,
        cons.sourcesBreakdown,
        monthlyYear,
        currentMonthIdx,
        cons.monthlySeries,
      ];
      if (isSameRenderTuple(lastRenderedTuple, renderTuple)) return;
      drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear });
      lastRenderedTuple = renderTuple;
    }

    function drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear }) {
      // 1. 同步用量概览矩阵与顶部 4 段比例条
      patchText(dateSpanBadge, dateSpan);
      const totalTokens = Number(acct.totalTokens || 0);
      const inputTokens = Number(acct.inputTokens || 0);
      const cacheTokens = Number(acct.cacheReadTokens || 0);
      const outputTokens = Number(acct.outputTokens || 0);
      const responseTokens = Number(acct.responseTokens || 0);
      const thinkingTokens = Number(acct.thinkingTokens || 0);
      const costUsd = Number(acct.costUsd || 0);
      const savedCostUsd = Number(acct.savedCostUsd || 0);

      patchText(heroTotalTokens, formatTokensPrecise(totalTokens));
      patchText(heroTotalCalls, t('cons.callsCount', { calls: acct.calls || 0 }));
      patchText(heroCostUsd, formatUsd(costUsd));
      patchText(heroCostCny, formatCnyApprox(costUsd));

      patchText(cacheHitPctEl, `${Number(acct.cacheHitPct ?? 0).toFixed(1)}%`);
      patchText(cacheTokensEl, t('cons.cacheHitTokens', { tokens: formatTokensPrecise(cacheTokens) }));

      let inPct = 0;
      let cachePct = 0;
      let outPct = 0;
      if (totalTokens > 0) {
        const scaled = scaleBucketsExact(
          { in: inputTokens, cache: cacheTokens, out: outputTokens },
          ['in', 'cache', 'out'],
          1000
        );
        inPct = +(scaled.in / 10).toFixed(1);
        cachePct = +(scaled.cache / 10).toFixed(1);
        outPct = +(scaled.out / 10).toFixed(1);
      }

      patchText(inputSharePct, `${inPct}%`);
      patchText(inputMainTokens, formatTokensPrecise(inputTokens));
      patchText(inputSubText, t('cons.uncachedInput'));

      patchText(cacheSharePct, `${cachePct}%`);
      patchText(cacheMainTokens, formatTokensPrecise(cacheTokens));
      patchText(
        cacheSubText,
        t('cons.savedCost', {
          cost: formatUsd(savedCostUsd, { precise: savedCostUsd > 0 && savedCostUsd < 0.01 }),
        })
      );

      patchText(outputSharePct, `${outPct}%`);
      patchText(outputMainTokens, formatTokensPrecise(outputTokens));
      patchText(
        outputSubText,
        t('cons.replyAndThink', {
          resp: formatTokensPrecise(responseTokens),
          think: formatTokensPrecise(thinkingTokens),
        })
      );

      overviewSegBar.update({
        inputTokens,
        cacheReadTokens: cacheTokens,
        responseTokens,
        thinkingTokens,
      });

      // 2-5. 统一解析展示模式与全局确定性模型配色映射（确保趋势浮层、模型排行圆点、客户端来源条、月度堆叠柱四处完全同色）
      const localeSig = i18nStore.getState().locale;
      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };
      const mergeAndSortBucketModels = (rawList) =>
        mergeModelsByDisplayName(rawList || [], displaySettings, {
          preferLabelInShort: true,
        })
          .filter((m) => Number(m.totalTokens || 0) > 0 || Number(m.calls || 0) > 0)
          .sort(
            (a, b) =>
              (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0)
          );

      const models = mergeModelsByDisplayName(slice.modelBreakdown || [], displaySettings, {
        preferLabelInShort: true,
      }).sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
      const modelsTotalTok = models.reduce((s, m) => s + Number(m.totalTokens || 0), 0);

      const rawSources = cons.sourcesBreakdown || [];
      const sourcesTotalTok = rawSources.reduce((s, x) => s + Number(x.totalTokens || 0), 0);
      const allSourceMergedModels = [];
      const sourcesWithModels = rawSources.map((s) => {
        const mergedModels = mergeAndSortBucketModels(s.models);
        for (const m of mergedModels) {
          allSourceMergedModels.push(m);
        }
        return { ...s, mergedModels };
      });

      const monthlySeries = cons.monthlySeries || [];
      const monthlyDisplayKey = `${displaySettings.modelDisplayMode}|${displaySettings.showUpstreamModel ? 1 : 0}|${displaySettings.orchestratorIdMode}`;
      let monthsMergedModels;
      let allMonthMergedModels;
      if (
        cachedMonthlySeriesRef === monthlySeries &&
        cachedMonthlyDisplayKey === monthlyDisplayKey &&
        cachedMonthsMergedModels &&
        cachedAllMonthMergedModels
      ) {
        monthsMergedModels = cachedMonthsMergedModels;
        allMonthMergedModels = cachedAllMonthMergedModels;
      } else {
        allMonthMergedModels = [];
        monthsMergedModels = Array.from({ length: 12 }, (_, idx) => {
          const merged = mergeAndSortBucketModels(monthlySeries[idx]?.models);
          for (const m of merged) {
            allMonthMergedModels.push(m);
          }
          return merged;
        });
        cachedMonthlySeriesRef = monthlySeries;
        cachedMonthlyDisplayKey = monthlyDisplayKey;
        cachedMonthsMergedModels = monthsMergedModels;
        cachedAllMonthMergedModels = allMonthMergedModels;
      }

      const rawTrendSeries = cons.trendSeries || [];
      const allTrendMergedModels = [];
      const trendMergedByIdx = rawTrendSeries.map((slot) => {
        if (!Array.isArray(slot?.models) || slot.models.length === 0) return null;
        const merged = mergeAndSortBucketModels(slot.models);
        for (const m of merged) {
          allTrendMergedModels.push(m);
        }
        return merged;
      });

      const modelColorMap = buildDeterministicModelColorMap([
        ...models,
        ...allSourceMergedModels,
        ...allMonthMergedModels,
        ...allTrendMergedModels,
      ]);

      // 2. 同步历史趋势交互式 SVG 面积图 / 类 GitHub 每日热力图（>90天）与悬停分模型浮层
      const rangeBadgeText = isEnglishLocale()
        ? getConsumptionTimeRangeOptions().find((o) => o.value === slice.range)?.label ||
          t('cons.allTime')
        : preset?.label || rangeInfo.label || t('cons.allTime');
      patchText(trendRangeBadge, rangeBadgeText);
      const isHourlyTrend =
        rawTrendSeries[0]?.granularity === 'hour' ||
        (rawTrendSeries[0]?.label || '').includes(':');
      const isHeatmapTrend = !isHourlyTrend && rawTrendSeries.length > HEATMAP_DAYS_THRESHOLD;
      patchText(
        trendGranularityHint,
        isHeatmapTrend
          ? t('cons.trendHeatmapHint', { days: rawTrendSeries.length })
          : isHourlyTrend
            ? t('cons.trendPointsHintHourly', { points: rawTrendSeries.length || 0 })
            : t('cons.trendPointsHintDaily', { points: rawTrendSeries.length || 0 })
      );
      const enrichedTrendSeries = rawTrendSeries.map((slot, idx) => {
        const mergedSlotModels = trendMergedByIdx[idx];
        if (!mergedSlotModels || mergedSlotModels.length === 0) return slot;
        return {
          ...slot,
          modelSegments: partitionModelSegments(mergedSlotModels, modelColorMap, {
            maxMain: 5,
            minSharePct: 1.5,
          }),
        };
      });
      trendChart.update(enrichedTrendSeries);

      // 3. 同步热门模型列表（名称后带专属颜色圆点 + 4 段条按总占比缩放长度）
      patchKeyedList(modelsListEl, models, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) => {
          const seed = getCanonicalModelColorSeed(m);
          const color = modelColorMap.get(seed) || resolveDeterministicModelColor(seed);
          return `${localeSig}:${m.displayText}:${m.displayTitle}:${color}:${m.totalTokens}:${m.inputTokens}:${m.cacheReadTokens}:${m.responseTokens}:${m.thinkingTokens}:${m.costUsd}:${m.unpricedCalls}:${m.calls}:${modelsTotalTok}`;
        },
        createRow: createBreakdownItemRow,
        updateRow: (refs, m) => {
          const seed = getCanonicalModelColorSeed(m);
          const color = modelColorMap.get(seed) || resolveDeterministicModelColor(seed);
          updateBreakdownItemRow(
            refs,
            { ...m, label: m.displayText, title: m.displayTitle },
            modelsTotalTok,
            color
          );
        },
      });

      // 4. 同步客户端来源列表（长尾合并分段配色 + 右侧总调用数 + 悬停进度条弹出明细浮层）
      patchKeyedList(sourcesListEl, sourcesWithModels, {
        keyFn: (s) => s.name,
        sigFn: (s) => {
          const modelsSig = s.mergedModels
            .map((m) => {
              const seed = getCanonicalModelColorSeed(m);
              return `${m.displayText}:${m.totalTokens}:${m.calls}:${modelColorMap.get(seed) || ''}`;
            })
            .join('|');
          return `${localeSig}:${s.name}:${s.totalTokens}:${s.costUsd}:${s.unpricedCalls}:${s.calls}:${sourcesTotalTok}:${modelsSig}`;
        },
        createRow: createSourceBreakdownRow,
        updateRow: (refs, s) => updateSourceBreakdownRow(refs, s, sourcesTotalTok, modelColorMap),
      });

      // 5. 同步 12 个月垂直堆叠柱状图（按模型配色堆叠 + 长尾合并 + 悬停弹出明细浮层）
      patchText(monthlyYearBadge, String(monthlyYear));
      const maxMonthTokens = Math.max(
        1,
        ...monthlySeries.map((m) => Number(m.totalTokens || 0))
      );

      for (let i = 0; i < 12; i++) {
        const col = monthlyCols[i];
        const m = monthlySeries[i] || { totalTokens: 0, costUsd: 0, calls: 0 };
        const mTot = Number(m.totalTokens || 0);
        const mCalls = Number(m.calls || 0);
        const hasData = mTot > 0;

        patchClasses(col.el, { 'is-interactive': hasData || mCalls > 0 });
        patchClasses(col.monthLabel, { 'is-current': i === currentMonthIdx });
        patchAttr(col.stackWrap, 'hidden', !hasData);
        patchAttr(col.zeroDot, 'hidden', hasData);

        if (!hasData) {
          patchText(col.costText, '');
          patchText(col.tokText, '');
          col.colState.hoverPayload = null;
          patchKeyedList(col.stackWrap, [], {
            keyFn: (x) => x.key,
            sigFn: (x) => x.key,
            createRow: createMonthModelSegment,
            updateRow: () => {},
          });
        } else {
          const cVal = Number(m.costUsd || 0);
          const isMonthUnpriced =
            mCalls > 0 && Number(m.unpricedCalls || 0) >= mCalls && !(cVal > 0);
          patchText(
            col.costText,
            isMonthUnpriced ? '—' : cVal >= 10 ? `$${Math.round(cVal)}` : `$${cVal.toFixed(2)}`
          );
          patchText(col.tokText, formatTokensPrecise(mTot));

          const totalHeightPct = Math.max(8, Math.min(100, (mTot / maxMonthTokens) * 100));
          patchStyleVar(col.stackWrap, '--bar-h', `${totalHeightPct.toFixed(1)}%`);

          const monthModels = monthsMergedModels[i] || [];
          const barPartitioned = partitionModelSegments(monthModels, modelColorMap, {
            maxMain: 5,
            minSharePct: 1.5,
          });
          // 垂直柱状图底端放主力模型、顶端叠放小占比及「其他」，视觉重心稳定
          const verticalSegments =
            barPartitioned.length > 0
              ? [...barPartitioned].reverse()
              : [{ key: '__month_fallback__', pct: 100, color: 'var(--accent-primary)' }];

          patchKeyedList(col.stackWrap, verticalSegments, {
            keyFn: (seg) => seg.key,
            sigFn: (seg) => `${seg.key}:${seg.pct.toFixed(2)}:${seg.color}`,
            createRow: createMonthModelSegment,
            updateRow: (segRefs, seg) => {
              patchStyleVar(segRefs.segEl, '--seg-h', `${seg.pct.toFixed(2)}%`);
              patchStyleVar(segRefs.segEl, '--seg-color', seg.color);
            },
          });

          col.colState.hoverPayload = {
            title: t('cons.monthFullLabel', { year: monthlyYear, m: i + 1 }),
            calls: mCalls,
            totalTokens: mTot,
            costText: formatUsd(isMonthUnpriced ? null : cVal, {
              precise: cVal > 0 && cVal < 0.1,
            }),
            segments: barPartitioned,
          };
        }
      }

      if (activeHoverTargetEl && activeHoverTargetEl.isConnected === false) {
        hideBreakdownPopover();
      }

      viewScrollbar.refresh();
    }

    const unsub = telemetryStore.subscribe(
      (st) => ({
        range: st.selectedTimeRange,
        customStartMs: st.customStartMs,
        customEndMs: st.customEndMs,
        consumption: st.telemetry?.consumption,
        modelBreakdown: st.telemetry?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'consumption') {
          hideBreakdownPopover();
          isDirty = true;
          return;
        }
        isDirty = false;
        renderConsumptionData(slice);
        if (!prefetchedOnCurrentVisit && Number(slice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    const unsubView = uiStore.subscribe(
      getVisibleMonitorView,
      (activeView) => {
        if (activeView !== 'consumption') {
          prefetchedOnCurrentVisit = false;
          hideBreakdownPopover();
          return;
        }
        if (isDirty) {
          isDirty = false;
          if (latestSlice) {
            renderConsumptionData(latestSlice);
          }
        }
        if (!prefetchedOnCurrentVisit && Number(latestSlice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    function syncStaticLocaleLabels() {
      timeFilterSwitch.setProps({
        ariaLabel: t('cons.rangeAria'),
        options: getConsumptionTimeRangeOptions(),
      });
      patchText(applyCustomBtnLabel, t('cons.applyFilter'));
      patchText(rangeToSpan, t('cons.rangeTo'));
      patchText(overviewTitleSpan, t('cons.overviewTitle'));
      patchText(totalTokensLabel, t('cons.totalTokens'));
      patchText(estCostLabel, t('cons.estCost'));
      patchText(cacheHitRateLabel, t('cons.cacheHitRate'));
      patchText(newInputLabel, t('cons.newInput'));
      patchText(cacheReadLabel, t('cons.cacheRead'));
      patchText(outputUsageLabel, t('cons.outputUsage'));
      patchText(trendTitleSpan, t('cons.trendTitle'));
      patchText(modelsTitleSpan, t('cons.topModels'));
      patchText(sourcesTitleSpan, t('cons.clientSources'));
      patchText(sourcesHoverHint, t('cons.hoverModelsHint'));
      patchText(monthlyTitleSpan, t('cons.monthlyTitle'));
      patchText(monthlyHoverHint, t('cons.hoverModelsHint'));
      for (let i = 0; i < 12; i++) {
        patchText(monthlyCols[i].monthLabel, t('cons.monthLabel', { m: i + 1 }));
      }
    }

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStaticLocaleLabels();
        if (getVisibleMonitorView() === 'consumption' && latestSlice) {
          isDirty = false;
          renderConsumptionData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      hideBreakdownPopover();
      unsub();
      unsubView();
      unsubI18n();
      trendChart.destroy?.();
      timeFilterSwitch.destroy();
      startPicker.destroy();
      endPicker.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: { timeFilterSwitch, startPicker, endPicker, viewScrollbar, breakdownPopoverEl },
    };
  },
});
