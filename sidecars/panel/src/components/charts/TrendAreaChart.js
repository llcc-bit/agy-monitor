/**
 * @fileoverview 交互式历史用量趋势图组件 (TrendAreaChart).
 * 支持双模式自适应切换：
 * 1. <= 90 天（或整点小时分桶）：渲染三次贝塞尔平滑曲线面积图、峰值气泡与对齐多刻度时间轴；
 * 2. > 90 天（自然日分桶）：自动切换为类 GitHub 贡献日历的小格子热力排列（一格一天，7 行星期 × 周列、月份刻度、分位数 5 档热力色阶与底部图例）；
 * 3. 两种模式共享自适应防溢出的悬浮详情卡片（精确日期/小时区间、Token 拆分、费用与调用次数）。
 */

import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { formatTokensPrecise, formatUsd } from '../../core/formatters.js';
import { SVG_NS } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';

/** 超过该自然日天数（> 90 天）时，趋势图切换为类 GitHub 每日小格子热力图 */
export const HEATMAP_DAYS_THRESHOLD = 90;

let chartUidCounter = 0;

function safeSlotTokens(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 将二维采样点序列转换为水平张力平滑的三次贝塞尔曲线 SVG 路径 (`M ... C ...`)。
 * 控制点沿 X 轴取相邻点间距的 `0.42` 张力系数，Y 轴与各自端点齐平，
 * 保证曲线在极值点处平缓过渡且不会产生上下过冲 (Overshoot)。
 *
 * @param {Array<{ x: number, y: number }>} points SVG 坐标系下的采样点数组（长度 >= 2）
 * @returns {string} SVG `<path>` 的 `d` 属性字符串
 */
function buildSmoothSplinePath(points) {
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpx1 = p0.x + (p1.x - p0.x) * 0.42;
    const cpx2 = p1.x - (p1.x - p0.x) * 0.42;
    d += ` C ${cpx1.toFixed(1)} ${p0.y.toFixed(1)}, ${cpx2.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

/**
 * 根据分桶总数与标签平均长度，计算底部 X 轴应当展示的均匀刻度下标列表。
 *
 * @param {Array<{ label?: string }>} slots
 * @returns {number[]}
 */
function computeTickIndices(slots) {
  const n = slots.length;
  if (n <= 1) return [0];
  if (n <= 8) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const sampleLabel = String(slots[Math.floor(n / 2)]?.label || slots[0]?.label || '');
  const maxTicks = sampleLabel.length > 6 ? 5 : 6;
  const set = new Set();
  for (let k = 0; k < maxTicks; k++) {
    const idx = Math.round((k / (maxTicks - 1)) * (n - 1));
    set.add(idx);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * 基于非零活跃日的分位数阈值计算热力图 5 档色阶（0 ~ 4），避免单日极端峰值压缩其余活跃日的层次对比。
 *
 * @param {number[]} nonZeroValues 已升序排列的正数 Token 列表
 * @param {number} maxTokens
 * @returns {{ q1: number, q2: number, q3: number, maxTokens: number, count: number }}
 */
function computeHeatmapThresholds(nonZeroValues, maxTokens) {
  const n = nonZeroValues.length;
  if (n === 0 || maxTokens <= 0) {
    return { q1: 0, q2: 0, q3: 0, maxTokens: 0, count: 0 };
  }
  if (n < 4) {
    return {
      q1: maxTokens * 0.25,
      q2: maxTokens * 0.5,
      q3: maxTokens * 0.75,
      maxTokens,
      count: n,
    };
  }
  return {
    q1: nonZeroValues[Math.floor((n - 1) * 0.25)],
    q2: nonZeroValues[Math.floor((n - 1) * 0.5)],
    q3: nonZeroValues[Math.floor((n - 1) * 0.75)],
    maxTokens,
    count: n,
  };
}

function resolveHeatmapLevel(tokens, thresholds) {
  if (tokens <= 0 || thresholds.maxTokens <= 0) return 0;
  if (tokens >= thresholds.maxTokens || tokens > thresholds.q3) return 4;
  if (tokens > thresholds.q2) return 3;
  if (tokens > thresholds.q1) return 2;
  return 1;
}

/**
 * 解析日期槽位的年份与月份信息（兼容真实时间戳 `startMs` 与测试简写 `label`）。
 *
 * @param {object} slot
 * @returns {{ year: number, month: number, day: number }}
 */
function parseSlotCalendarParts(slot) {
  const sMs = Number(slot?.startMs);
  if (Number.isFinite(sMs) && sMs > 0) {
    const d = new Date(sMs);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  const m = String(slot?.label || '').match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    return { year: new Date().getFullYear(), month: Number(m[1]), day: Number(m[2]) };
  }
  return { year: new Date().getFullYear(), month: 0, day: 0 };
}

/**
 * 构建热力图顶部与周列对齐的月份刻度标签（自动跳过首尾过窄残月，防止相邻月份文字重叠）。
 *
 * @param {Array<object>} slots
 * @param {number} firstDow 首日对应的星期行索引（0 = 周一 .. 6 = 周日）
 * @param {number} totalWeeks 总周列数
 * @returns {Array<{ col: number, text: string }>}
 */
function buildHeatmapMonthTicks(slots, firstDow, totalWeeks) {
  if (!slots.length || totalWeeks <= 0) return [];
  const firstParts = parseSlotCalendarParts(slots[0]);
  const lastParts = parseSlotCalendarParts(slots[slots.length - 1]);
  const crossYear = firstParts.year !== lastParts.year;

  const candidates = [];
  let prevMonthKey = '';

  for (let col = 0; col < totalWeeks; col++) {
    let chosenParts = null;
    for (let row = 0; row < 7; row++) {
      const idx = col * 7 + row - firstDow;
      if (idx < 0 || idx >= slots.length) continue;
      const parts = parseSlotCalendarParts(slots[idx]);
      if (!parts.month) continue;
      const mKey = `${parts.year}-${parts.month}`;
      if (col === 0 && !chosenParts) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
      if (mKey !== prevMonthKey) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
    }
    if (chosenParts && chosenParts.month > 0) {
      candidates.push({ col, year: chosenParts.year, month: chosenParts.month });
    }
  }

  const baseMinGap = totalWeeks > 40 ? 4 : 3;
  if (
    candidates.length >= 2 &&
    candidates[0].col === 0 &&
    candidates[1].col - candidates[0].col < baseMinGap
  ) {
    candidates.shift();
  }

  const ticks = [];
  let nextAllowedCol = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (totalWeeks > 16 && c.col >= totalWeeks - 1) continue;
    if (ticks.length > 0 && c.col < nextAllowedCol) continue;
    const showYear = crossYear && (c.month === 1 || ticks.length === 0);
    const text = showYear
      ? t('chart.trend.hmMonthYear', { yy: String(c.year).slice(-2), month: c.month })
      : t('chart.trend.hmMonthOnly', { month: c.month });
    ticks.push({ col: c.col, text });
    nextAllowedCol = c.col + (showYear ? baseMinGap + 1 : baseMinGap);
  }
  return ticks;
}

/**
 * 创建交互式历史趋势组件（<=90 天为 SVG 平滑曲线图，>90 天自动切换为类 GitHub 每日小格子热力图）。
 *
 * @returns {{
 *   el: HTMLElement,
 *   update: (series?: Array<object>) => void
 * }}
 */
export function createTrendAreaChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 184;
  const TOP_Y = 26;
  const BOTTOM_Y = 164;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolvePlotBounds(w) {
    const leftX = 1;
    const rightX = Math.max(leftX + 20, w - 1);
    return { leftX, rightX, spanX: rightX - leftX };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'trend-svg');
  svg.setAttribute('aria-hidden', 'true');

  // 垂直线性渐变（每实例独立 ID，避免多图表挂载时 SVG url(#...) 冲突）
  const gradId = `trend-area-grad-${++chartUidCounter}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');

  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', 'var(--ctx-cached)');
  stop1.setAttribute('stop-opacity', '0.34');

  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--ctx-cached)');
  stop2.setAttribute('stop-opacity', '0.0');

  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 背景水平与垂直参考网格线（水平网格全宽贴边铺满 0..viewW）
  const hGridGroup = document.createElementNS(SVG_NS, 'g');
  hGridGroup.setAttribute('class', 'trend-grid');
  const hGridLines = [];
  for (const y of [
    TOP_Y,
    Math.round(TOP_Y + SPAN_Y / 3),
    Math.round(TOP_Y + (SPAN_Y * 2) / 3),
    BOTTOM_Y,
  ]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(viewW));
    line.setAttribute('y2', String(y));
    hGridGroup.appendChild(line);
    hGridLines.push(line);
  }
  svg.appendChild(hGridGroup);

  const vGridGroup = document.createElementNS(SVG_NS, 'g');
  vGridGroup.setAttribute('class', 'trend-grid trend-v-grid');
  svg.appendChild(vGridGroup);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('class', 'trend-line');
  linePath.setAttribute('fill', 'none');
  svg.appendChild(linePath);

  const dotsGroup = document.createElementNS(SVG_NS, 'g');
  dotsGroup.setAttribute('class', 'trend-dots-group');
  svg.appendChild(dotsGroup);

  const peakDot = document.createElementNS(SVG_NS, 'circle');
  peakDot.setAttribute('r', '3');
  peakDot.setAttribute('class', 'trend-peak-dot');
  svg.appendChild(peakDot);

  // 悬停十字准星与焦点圆点
  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', '12');
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '3.2');
  hoverDot.setAttribute('class', 'trend-hover-dot');
  hoverDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverDot);

  const peakPill = h('span', { className: 'trend-peak-pill text-mono', text: '0' });

  function createTooltipModelRow() {
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

  // 共享悬停详情浮层卡片（曲线图与热力格子图共用，含该时段分模型占比明细）
  const tipTimeEl = h('span', { className: 'trend-tip-time text-mono' });
  const tipCallsEl = h('span', { className: 'trend-tip-calls text-mono' });
  const tipTokensEl = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipCostEl = h('span', { className: 'trend-tip-cost text-mono' });
  const tipSubEl = h('div', { className: 'trend-tip-sub text-mono', hidden: true });
  const tipModelsEl = h('div', { className: 'cons-pop-models', hidden: true });

  const tooltipEl = h(
    'div',
    { className: 'trend-tooltip', hidden: true },
    [
      h('div', { className: 'trend-tip-head' }, [tipTimeEl, tipCallsEl]),
      h('div', { className: 'trend-tip-main' }, [tipTokensEl, tipCostEl]),
      tipSubEl,
      tipModelsEl,
    ]
  );

  // 底部对齐刻度轴（曲线模式）
  const xAxisEl = h('div', { className: 'trend-x-axis' });
  const plotStage = h('div', { className: 'trend-plot-stage' }, [peakPill, svg]);

  // 类 GitHub 每日小格子热力图容器（> 90 天模式）
  const wdayMonEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayMon') });
  const wdayWedEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayWed') });
  const wdayFriEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayFri') });
  const wdaySunEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdaySun') });
  const hmWeekdaysEl = h('div', { className: 'trend-hm-weekdays', 'aria-hidden': 'true' }, [
    h('span', { className: 'trend-hm-month-spacer' }),
    wdayMonEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdayWedEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdayFriEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdaySunEl,
  ]);
  const hmMonthsEl = h('div', { className: 'trend-hm-months' });
  const hmGridEl = h('div', {
    className: 'trend-hm-grid',
    role: 'grid',
    'aria-label': t('chart.trend.hmAria'),
  });
  const hmTrackEl = h('div', { className: 'trend-hm-track' }, [hmMonthsEl, hmGridEl]);
  const hmScrollEl = h('div', { className: 'trend-hm-scroll' }, [hmTrackEl]);
  const hmBodyEl = h('div', { className: 'trend-heatmap-body' }, [hmWeekdaysEl, hmScrollEl]);

  const hmSummaryEl = h('span', { className: 'trend-hm-summary text-mono', text: '' });
  const hmLessEl = h('span', { text: t('chart.trend.hmLess') });
  const hmMoreEl = h('span', { text: t('chart.trend.hmMore') });
  const hmLegendEl = h('span', { className: 'trend-hm-legend', 'aria-hidden': 'true' }, [
    hmLessEl,
    h('span', { className: 'trend-hm-swatch lv-0' }),
    h('span', { className: 'trend-hm-swatch lv-1' }),
    h('span', { className: 'trend-hm-swatch lv-2' }),
    h('span', { className: 'trend-hm-swatch lv-3' }),
    h('span', { className: 'trend-hm-swatch lv-4' }),
    hmMoreEl,
  ]);
  const hmFooterEl = h('div', { className: 'trend-hm-footer' }, [hmSummaryEl, hmLegendEl]);
  const heatmapStage = h('div', { className: 'trend-heatmap-stage', hidden: true }, [
    hmBodyEl,
    hmFooterEl,
  ]);

  const chartWrap = h('div', { className: 'trend-chart-wrap' }, [
    plotStage,
    xAxisEl,
    heatmapStage,
    tooltipEl,
  ]);

  let currentSlots = [];
  let currentPts = [];
  let currentIsHeatmap = false;
  let currentHeatmapWeeks = 0;
  let currentHeatmapFirstDow = 0;
  let currentHeatmapGapPx = 2;
  let currentCellEls = [];
  let tickElsByIdx = new Map();
  let hoveredIdx = -1;
  let hoveredCellEl = null;
  let lastRenderSig = '';
  let tipTrackRaf = 0;

  function cancelTipTrackRaf() {
    if (tipTrackRaf && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(tipTrackRaf);
    }
    tipTrackRaf = 0;
  }

  function armTooltipTracking(wasHidden) {
    if (!wasHidden) return;
    patchClasses(tooltipEl, { 'is-tracking': false });
    patchClasses(hoverDot, { 'is-tracking': false });
    void tooltipEl.offsetWidth;
    cancelTipTrackRaf();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      tipTrackRaf = window.requestAnimationFrame(() => {
        tipTrackRaf = 0;
        if (!tooltipEl.hasAttribute('hidden')) {
          patchClasses(tooltipEl, { 'is-tracking': true });
          patchClasses(hoverDot, { 'is-tracking': true });
        }
      });
    } else {
      patchClasses(tooltipEl, { 'is-tracking': true });
      patchClasses(hoverDot, { 'is-tracking': true });
    }
  }

  function populateTooltipContent(slot) {
    patchText(tipTimeEl, slot.fullLabel || slot.label || '--');
    patchText(
      tipCallsEl,
      t('cons.callsCount', { calls: Math.max(0, Math.floor(Number(slot.calls) || 0)) })
    );
    const slotTok = safeSlotTokens(slot.tokens);
    patchText(tipTokensEl, `${formatTokensPrecise(slotTok)} tok`);
    const slotCost = Number.isFinite(Number(slot.costUsd)) ? Math.max(0, Number(slot.costUsd)) : 0;
    patchText(
      tipCostEl,
      formatUsd(slotCost, {
        precise: slotCost > 0 && slotCost < 0.1,
      })
    );

    const hasSubBreakdown =
      slotTok > 0 &&
      (slot.inputTokens !== undefined ||
        slot.cacheReadTokens !== undefined ||
        slot.outputTokens !== undefined);
    patchAttr(tipSubEl, 'hidden', !hasSubBreakdown);
    if (hasSubBreakdown) {
      patchText(
        tipSubEl,
        t('chart.step.ioSplit', {
          inTok: formatTokensPrecise(safeSlotTokens(slot.inputTokens)),
          cacheTok: formatTokensPrecise(safeSlotTokens(slot.cacheReadTokens)),
          outTok: formatTokensPrecise(safeSlotTokens(slot.outputTokens)),
        })
      );
    }

    const modelSegs = Array.isArray(slot.modelSegments) ? slot.modelSegments : [];
    patchAttr(tipModelsEl, 'hidden', modelSegs.length === 0);
    patchKeyedList(tipModelsEl, modelSegs, {
      keyFn: (r) => r.key,
      sigFn: (r) => `${r.key}:${r.label}:${r.color}:${r.tokText}:${r.pctText}:${r.isOther}`,
      createRow: createTooltipModelRow,
      updateRow: (rRefs, r) => {
        patchClasses(rRefs.rowEl, { 'is-other': Boolean(r.isOther) });
        patchStyleVar(rRefs.dotEl, '--dot-color', r.color);
        patchText(rRefs.nameEl, r.label);
        patchText(rRefs.tokEl, r.tokText);
        patchText(rRefs.pctEl, r.pctText);
      },
    });
  }

  function showLineHoverAtIndex(idx) {
    if (currentIsHeatmap || idx < 0 || idx >= currentSlots.length || !currentPts[idx]) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    hoveredIdx = idx;
    const slot = currentSlots[idx];
    const pt = currentPts[idx];

    patchAttr(hoverLine, 'hidden', false);
    patchAttr(hoverLine, 'x1', pt.x.toFixed(1));
    patchAttr(hoverLine, 'x2', pt.x.toFixed(1));

    patchAttr(hoverDot, 'hidden', false);
    patchAttr(hoverDot, 'cx', pt.x.toFixed(1));
    patchAttr(hoverDot, 'cy', pt.y.toFixed(1));

    const isLineLow = pt.y < Math.round((TOP_Y + BOTTOM_Y) / 2);
    patchAttr(peakPill, 'hidden', true);
    patchClasses(tooltipEl, {
      'is-hm-bottom': false,
      'is-hm-top': false,
      'is-line-low': isLineLow,
    });
    patchAttr(tooltipEl, 'hidden', false);
    populateTooltipContent(slot);

    let tipY = 0;
    if (isLineLow) {
      const wrapH = Number(chartWrap.offsetHeight || 0);
      const tipH = Number(tooltipEl.offsetHeight || 0);
      if (wrapH > 0 && tipH > 0) {
        tipY = Math.max(0, wrapH - tipH - 22);
      }
    }

    const rawPct = (pt.x / viewW) * 100;
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-y', `${Math.round(tipY)}px`);
    armTooltipTracking(wasHidden);

    for (const [tIdx, el] of tickElsByIdx.entries()) {
      patchClasses(el, { 'is-hovered': tIdx === idx });
    }
  }

  function showHeatmapHoverAtIndex(idx, cellEl) {
    if (!currentIsHeatmap || idx < 0 || idx >= currentSlots.length) {
      clearHover();
      return;
    }
    const targetCell = cellEl || currentCellEls[idx] || null;
    if (!targetCell) {
      clearHover();
      return;
    }
    hoveredIdx = idx;
    if (hoveredCellEl && hoveredCellEl !== targetCell) {
      patchClasses(hoveredCellEl, { 'is-hovered': false });
    }
    hoveredCellEl = targetCell;
    patchClasses(targetCell, { 'is-hovered': true });

    const slot = currentSlots[idx];
    const row = Number(targetCell.getAttribute('data-hm-row') || 0);
    const col = Number(targetCell.getAttribute('data-hm-col') || 0);

    const wasHidden = tooltipEl.hasAttribute('hidden');
    // 上半区（周一~周四）浮层停靠热力图下方，下半区（周五~周日）停靠热力图上方，互不遮挡被悬停格子且永不越界裁剪
    patchClasses(tooltipEl, {
      'is-hm-bottom': row <= 3,
      'is-hm-top': row > 3,
      'is-line-low': false,
    });
    patchAttr(tooltipEl, 'hidden', false);
    populateTooltipContent(slot);

    const wrapRect = chartWrap.getBoundingClientRect();
    const cellRect = targetCell.getBoundingClientRect();
    let rawPct = 50;
    if (
      wrapRect &&
      wrapRect.width > 0 &&
      cellRect &&
      cellRect.width > 0 &&
      cellRect.width < wrapRect.width
    ) {
      rawPct = ((cellRect.left + cellRect.width / 2 - wrapRect.left) / wrapRect.width) * 100;
    } else if (currentHeatmapWeeks > 0) {
      rawPct = ((col + 0.5) / currentHeatmapWeeks) * 100;
    }
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-y', '0px');
    armTooltipTracking(wasHidden);
  }

  function clearHover() {
    cancelTipTrackRaf();
    hoveredIdx = -1;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverDot, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, {
      'is-hm-bottom': false,
      'is-hm-top': false,
      'is-line-low': false,
      'is-tracking': false,
    });
    patchClasses(hoverDot, { 'is-tracking': false });
    if (!currentIsHeatmap) {
      patchAttr(peakPill, 'hidden', false);
    }
    if (hoveredCellEl) {
      patchClasses(hoveredCellEl, { 'is-hovered': false });
      hoveredCellEl = null;
    }
    for (const el of tickElsByIdx.values()) {
      patchClasses(el, { 'is-hovered': false });
    }
  }

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      for (const line of hGridLines) {
        line.setAttribute('x1', '0');
        line.setAttribute('x2', String(viewW));
      }
      return true;
    }
    return false;
  }

  function handlePointerMove(e) {
    if (currentIsHeatmap || !currentSlots.length) return;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    const { leftX, spanX } = resolvePlotBounds(viewW);
    const ratio = (relX - leftX) / Math.max(1, spanX);
    const idx = Math.max(
      0,
      Math.min(currentSlots.length - 1, Math.round(ratio * (currentSlots.length - 1)))
    );
    showLineHoverAtIndex(idx);
  }

  function findDirectHeatmapCell(e) {
    let cur = e?.target || null;
    while (cur && cur !== hmGridEl) {
      const idxAttr = cur.getAttribute?.('data-slot-idx');
      if (idxAttr !== null && idxAttr !== undefined && idxAttr !== '') {
        const idx = Number(idxAttr);
        if (Number.isFinite(idx) && idx >= 0 && idx < currentSlots.length) {
          return { idx, cellEl: cur };
        }
      }
      cur = cur.parentNode || null;
    }
    return null;
  }

  function resolveHeatmapCellFromPointer(e) {
    const directHit = findDirectHeatmapCell(e);
    if (directHit) return directHit;

    const clientX = Number(e?.clientX);
    const clientY = Number(e?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
      return null;
    }

    const rect = hmGridEl.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || !(rect.height > 0) || currentHeatmapWeeks <= 0) {
      if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
      return null;
    }

    const W = currentHeatmapWeeks;
    const G = currentHeatmapGapPx;
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    if (
      relX < -(G + 1) ||
      relX > rect.width + G + 1 ||
      relY < -(G + 1) ||
      relY > rect.height + G + 1
    ) {
      return null;
    }

    const pitchX = (rect.width + G) / W;
    const pitchY = (rect.height + G) / 7;
    const cellW = Math.max(1, pitchX - G);
    const cellH = Math.max(1, pitchY - G);

    function distanceToCell(c, r) {
      const x0 = c * pitchX;
      const y0 = r * pitchY;
      const dx = relX < x0 ? x0 - relX : relX > x0 + cellW ? relX - (x0 + cellW) : 0;
      const dy = relY < y0 ? y0 - relY : relY > y0 + cellH ? relY - (y0 + cellH) : 0;
      return { chebyshev: Math.max(dx, dy), distSq: dx * dx + dy * dy };
    }

    // 指针滑入当前悬停格四周的空隙（gap）时保持原高亮，彻底消除跨格空隙闪烁与边缘微抖
    if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
      const curGridPos = currentHeatmapFirstDow + hoveredIdx;
      const curCol = Math.floor(curGridPos / 7);
      const curRow = curGridPos % 7;
      if (distanceToCell(curCol, curRow).chebyshev <= G + 0.75) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
    }

    // 快速扫过或初始落入格子间隙时，按网格步距吸附到最近的有效日期格
    const approxCol = Math.max(0, Math.min(W - 1, Math.floor((relX + G * 0.5) / pitchX)));
    const approxRow = Math.max(0, Math.min(6, Math.floor((relY + G * 0.5) / pitchY)));
    const directSlotIdx = approxCol * 7 + approxRow - currentHeatmapFirstDow;
    if (
      directSlotIdx >= 0 &&
      directSlotIdx < currentSlots.length &&
      currentCellEls[directSlotIdx]
    ) {
      return { idx: directSlotIdx, cellEl: currentCellEls[directSlotIdx] };
    }

    // 首周补位或末周未来空白边缘：仅当仍在相邻有效格的间隙光晕内才吸附，深入纯空白角则清空
    let bestIdx = -1;
    let bestDistSq = Infinity;
    for (let dc = -1; dc <= 1; dc++) {
      const c = approxCol + dc;
      if (c < 0 || c >= W) continue;
      for (let dr = -1; dr <= 1; dr++) {
        const r = approxRow + dr;
        if (r < 0 || r > 6) continue;
        const sIdx = c * 7 + r - currentHeatmapFirstDow;
        if (sIdx < 0 || sIdx >= currentSlots.length || !currentCellEls[sIdx]) continue;
        const d = distanceToCell(c, r);
        if (d.chebyshev <= G + 1.5 && d.distSq < bestDistSq) {
          bestDistSq = d.distSq;
          bestIdx = sIdx;
        }
      }
    }
    if (bestIdx >= 0) {
      return { idx: bestIdx, cellEl: currentCellEls[bestIdx] };
    }
    return null;
  }

  function handleHeatmapPointer(e) {
    if (!currentIsHeatmap || !currentSlots.length) return;
    const hit = resolveHeatmapCellFromPointer(e);
    if (!hit || !Number.isFinite(hit.idx)) {
      clearHover();
      return;
    }
    if (hit.idx !== hoveredIdx || hit.cellEl !== hoveredCellEl) {
      showHeatmapHoverAtIndex(hit.idx, hit.cellEl);
    }
  }

  function handleHeatmapWheel(e) {
    if (!currentIsHeatmap) return;
    const maxScrollLeft = (hmScrollEl.scrollWidth || 0) - (hmScrollEl.clientWidth || 0);
    if (maxScrollLeft <= 2) return;
    const dy = Number(e.deltaY || 0);
    const dx = Number(e.deltaX || 0);
    if (Math.abs(dy) > Math.abs(dx) && dy !== 0) {
      const prev = hmScrollEl.scrollLeft || 0;
      const next = Math.max(0, Math.min(maxScrollLeft, prev + dy));
      if (next !== prev) {
        hmScrollEl.scrollLeft = next;
        e.preventDefault?.();
      }
    }
  }

  plotStage.addEventListener('mousemove', handlePointerMove);
  plotStage.addEventListener('mouseleave', clearHover);

  hmGridEl.addEventListener('mouseover', handleHeatmapPointer);
  hmGridEl.addEventListener('mousemove', handleHeatmapPointer);
  hmGridEl.addEventListener('click', handleHeatmapPointer);
  hmGridEl.addEventListener('mouseleave', clearHover);
  hmScrollEl.addEventListener('wheel', handleHeatmapWheel);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    cancelTipTrackRaf();
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * 根据最新时间分桶序列重绘平滑曲线（<=90天/小时级）或类 GitHub 每日小格子热力图（>90天）。
   */
  function update(series = []) {
    const slots =
      Array.isArray(series) && series.length >= 1
        ? series
        : [
            { label: '00:00', fullLabel: '00:00 - 01:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '06:00', fullLabel: '06:00 - 07:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '12:00', fullLabel: '12:00 - 13:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '18:00', fullLabel: '18:00 - 19:00', tokens: 0, calls: 0, costUsd: 0 },
          ];
    currentSlots = slots;

    const isHourly =
      slots[0]?.granularity === 'hour' || String(slots[0]?.label || '').includes(':');
    const useHeatmap = !isHourly && slots.length > HEATMAP_DAYS_THRESHOLD;
    const modeChanged = useHeatmap !== currentIsHeatmap;
    currentIsHeatmap = useHeatmap;

    if (modeChanged) {
      clearHover();
    }
    patchClasses(chartWrap, { 'is-heatmap': useHeatmap });
    patchAttr(plotStage, 'hidden', useHeatmap);
    patchAttr(xAxisEl, 'hidden', useHeatmap);
    patchAttr(heatmapStage, 'hidden', !useHeatmap);

    if (!useHeatmap) {
      syncViewWidth();
    }

    let maxTokens = 0;
    let peakIdx = 0;
    let activeDays = 0;
    const nonZeroVals = [];

    for (let i = 0; i < slots.length; i++) {
      const tokVal = safeSlotTokens(slots[i]?.tokens);
      if (tokVal > 0) {
        activeDays++;
        nonZeroVals.push(tokVal);
      }
      if (tokVal >= maxTokens) {
        maxTokens = tokVal;
        peakIdx = i;
      }
    }

    const locale = getEffectiveLocale();
    patchText(wdayMonEl, t('chart.trend.wdayMon'));
    patchText(wdayWedEl, t('chart.trend.wdayWed'));
    patchText(wdayFriEl, t('chart.trend.wdayFri'));
    patchText(wdaySunEl, t('chart.trend.wdaySun'));
    patchAttr(hmGridEl, 'aria-label', t('chart.trend.hmAria'));
    patchText(hmLessEl, t('chart.trend.hmLess'));
    patchText(hmMoreEl, t('chart.trend.hmMore'));

    const sig =
      `${locale}|${useHeatmap ? 'hm' : `line:${viewW}`}|` +
      slots
        .map((s) => {
          const mSig = Array.isArray(s?.modelSegments)
            ? s.modelSegments.map((m) => `${m.key}:${m.color}:${m.pctText}`).join(',')
            : '';
          return `${s?.startMs || ''}:${s?.label || ''}:${s?.fullLabel || ''}:${safeSlotTokens(s?.tokens)}:${Number(s?.costUsd || 0)}:${Number(s?.calls || 0)}:${mSig}`;
        })
        .join('|');

    if (hoveredIdx >= 0 && hoveredIdx < slots.length && !tooltipEl.hasAttribute('hidden')) {
      populateTooltipContent(slots[hoveredIdx]);
    }

    if (useHeatmap) {
      currentPts = [];
      if (sig !== lastRenderSig) {
        lastRenderSig = sig;
        nonZeroVals.sort((a, b) => a - b);
        const thresholds = computeHeatmapThresholds(nonZeroVals, maxTokens);

        const firstStartMs = Number(slots[0]?.startMs);
        const firstDow =
          Number.isFinite(firstStartMs) && firstStartMs > 0
            ? (new Date(firstStartMs).getDay() + 6) % 7
            : 0;
        const totalCells = firstDow + slots.length;
        const totalWeeks = Math.max(1, Math.ceil(totalCells / 7));
        const gapPx = totalWeeks > 42 ? 1.5 : 2;
        currentHeatmapWeeks = totalWeeks;
        currentHeatmapFirstDow = firstDow;
        currentHeatmapGapPx = gapPx;

        patchStyleVar(hmBodyEl, '--hm-weeks', String(totalWeeks));
        patchStyleVar(hmBodyEl, '--hm-gap', `${gapPx}px`);

        // 重建顶部对齐月份标签
        while (hmMonthsEl.firstChild) hmMonthsEl.removeChild(hmMonthsEl.firstChild);
        const monthTicks = buildHeatmapMonthTicks(slots, firstDow, totalWeeks);
        for (const mt of monthTicks) {
          const mEl = h('span', { className: 'trend-hm-month text-mono', text: mt.text });
          patchStyleVar(mEl, '--hm-col', String(mt.col));
          hmMonthsEl.appendChild(mEl);
        }

        // 重建 7 行 × N 周列的每日小格子（一格一天），使用 DocumentFragment 一次性批量挂载减少重排
        while (hmGridEl.firstChild) hmGridEl.removeChild(hmGridEl.firstChild);
        hoveredCellEl = null;
        currentCellEls = new Array(slots.length);
        const gridFrag =
          typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function'
            ? document.createDocumentFragment()
            : null;
        const gridTarget = gridFrag || hmGridEl;

        for (let pad = 0; pad < firstDow; pad++) {
          gridTarget.appendChild(
            h('span', { className: 'trend-hm-cell is-pad', 'aria-hidden': 'true' })
          );
        }

        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const tok = safeSlotTokens(slot?.tokens);
          const lv = resolveHeatmapLevel(tok, thresholds);
          const gridPos = firstDow + i;
          const col = Math.floor(gridPos / 7);
          const row = gridPos % 7;
          const cellEl = h('span', {
            className: `trend-hm-cell lv-${lv}`,
            'data-slot-idx': String(i),
            'data-hm-col': String(col),
            'data-hm-row': String(row),
            role: 'gridcell',
          });
          gridTarget.appendChild(cellEl);
          currentCellEls[i] = cellEl;
        }
        if (gridFrag) {
          hmGridEl.appendChild(gridFrag);
        }

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (hmScrollEl.scrollWidth > hmScrollEl.clientWidth) {
              hmScrollEl.scrollLeft = hmScrollEl.scrollWidth;
            }
          });
        }
      }

      const peakSlot = slots[peakIdx];
      const summaryText =
        maxTokens > 0 && peakSlot?.label
          ? t('chart.trend.hmActivePeak', {
              active: activeDays,
              total: slots.length,
              label: peakSlot.label,
              tokens: formatTokensPrecise(maxTokens),
            })
          : t('chart.trend.hmActiveZero', { total: slots.length });
      patchText(hmSummaryEl, summaryText);

      if (hoveredIdx >= slots.length) {
        clearHover();
      } else if (hoveredIdx >= 0) {
        showHeatmapHoverAtIndex(hoveredIdx, currentCellEls[hoveredIdx]);
      }
      return;
    }

    // --- <= 90 天（或整点小时级）：渲染平滑面积曲线图（1:1 贴边对齐） ---
    currentCellEls = [];
    const { leftX, rightX, spanX } = resolvePlotBounds(viewW);
    const denom = Math.max(1, maxTokens);
    const isSingle = slots.length === 1;
    const pts = slots.map((s, idx) => {
      const tok = safeSlotTokens(s?.tokens);
      const x = isSingle
        ? (leftX + rightX) / 2
        : leftX + (idx / Math.max(1, slots.length - 1)) * spanX;
      const ratio = maxTokens > 0 ? tok / denom : 0;
      const y = BOTTOM_Y - ratio * SPAN_Y;
      return { x, y, tokens: tok };
    });
    currentPts = pts;

    if (sig !== lastRenderSig) {
      lastRenderSig = sig;
      let lineD;
      let areaD;
      if (isSingle) {
        const yStr = pts[0].y.toFixed(1);
        lineD = `M ${leftX.toFixed(1)} ${yStr} L ${rightX.toFixed(1)} ${yStr}`;
        areaD = `${lineD} L ${rightX.toFixed(1)} ${BOTTOM_Y} L ${leftX.toFixed(1)} ${BOTTOM_Y} Z`;
      } else {
        lineD = buildSmoothSplinePath(pts);
        areaD = `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${BOTTOM_Y} L ${pts[0].x.toFixed(1)} ${BOTTOM_Y} Z`;
      }
      patchAttr(linePath, 'd', lineD);
      patchAttr(areaPath, 'd', areaD);

      // 渲染与底部刻度对齐的垂直参考网格线及底部 X 轴标签（起止标签严格左右贴边）
      const tickIndices = computeTickIndices(slots);
      while (vGridGroup.firstChild) vGridGroup.removeChild(vGridGroup.firstChild);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      tickElsByIdx = new Map();

      for (let i = 0; i < tickIndices.length; i++) {
        const tIdx = tickIndices[i];
        const pt = pts[tIdx];
        const slot = slots[tIdx];
        if (!pt || !slot) continue;

        if (i > 0 && i < tickIndices.length - 1) {
          const vLine = document.createElementNS(SVG_NS, 'line');
          vLine.setAttribute('x1', pt.x.toFixed(1));
          vLine.setAttribute('y1', '16');
          vLine.setAttribute('x2', pt.x.toFixed(1));
          vLine.setAttribute('y2', String(BOTTOM_Y));
          vGridGroup.appendChild(vLine);
        }

        const isFirst = !isSingle && i === 0;
        const isLast = !isSingle && i === tickIndices.length - 1;
        const pct = isFirst ? 0 : isLast ? 100 : (pt.x / viewW) * 100;
        const tickEl = h('span', {
          className: `trend-x-tick text-mono${isFirst ? ' is-start' : isLast ? ' is-end' : ''}`,
          text: slot.label || '',
          title: slot.fullLabel || slot.label || '',
        });
        patchStyleVar(tickEl, '--tick-x', `${pct.toFixed(2)}%`);
        tickEl.onclick = () => showLineHoverAtIndex(tIdx);
        xAxisEl.appendChild(tickEl);
        tickElsByIdx.set(tIdx, tickEl);
      }

      // 渲染采样点小圆点（当点数 <= 36 时展示，突出有消耗的整点/日期）
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      if (pts.length <= 36) {
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].tokens <= 0) continue;
          const dot = document.createElementNS(SVG_NS, 'circle');
          dot.setAttribute('cx', pts[i].x.toFixed(1));
          dot.setAttribute('cy', pts[i].y.toFixed(1));
          dot.setAttribute('r', '2');
          dot.setAttribute('class', 'trend-node-dot');
          dotsGroup.appendChild(dot);
        }
      }
    }

    const peakPt = pts[peakIdx] || { x: viewW / 2, y: BOTTOM_Y };
    patchAttr(peakDot, 'cx', peakPt.x.toFixed(1));
    patchAttr(peakDot, 'cy', peakPt.y.toFixed(1));

    const peakSlot = slots[peakIdx];
    const peakText =
      maxTokens > 0 && peakSlot?.label
        ? t('chart.trend.peakPill', {
            label: peakSlot.label,
            tokens: formatTokensPrecise(maxTokens),
          })
        : formatTokensPrecise(maxTokens);
    patchText(peakPill, peakText);
    const pctLeft = Math.max(12, Math.min(88, (peakPt.x / viewW) * 100));
    patchStyleVar(peakPill, '--peak-x', `${pctLeft.toFixed(1)}%`);

    if (hoveredIdx >= slots.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showLineHoverAtIndex(hoveredIdx);
    }
  }

  return { el: chartWrap, update, destroy };
}
