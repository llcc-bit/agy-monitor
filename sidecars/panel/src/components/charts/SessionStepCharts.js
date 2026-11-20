/**
 * @fileoverview 当前会话步骤级线性走势图与模型趋势拟合图组件 (SessionStepCharts).
 *
 * 包含两部分能力：
 * 1. `createSessionLineChart`：查看当前会话（支持主代理 / 子代理 / 全部汇总）所有模型的步进变化，
 *    支持切换 `总Token`（累计调用总量）、`上下文`（单步上下文体积）、`TPS`、`首字`、`费用` 五大维度；
 * 2. `createModelFitChart`：查看指定模型或全部模型的 `TPS`、`首字`、`缓存`、`费用` 散点与鲁棒局部加权线性回归（LOWESS + OLS 基准）拟合曲线，
 *    内置视图级模型锁定状态机，进入视图时自动锚定当前调用模型，停留在视图期间绝不随轮询跳变。
 */

import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';
import {
  formatAgentBadgeText,
  formatMetric,
  formatSpeedMetric,
  formatStepAnomalyInlineSummary,
  formatTokens,
  formatTokensPrecise,
  formatUsd,
  resolveModelDisplayInfo,
  speedReasonText,
} from '../../core/formatters.js';
import { SVG_NS } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';

let sessionChartUid = 0;

/** 多模型节点与多曲线对比语义调色板（全部取自 tokens.css 语义变量，兼顾设计一致性与交叉曲线区分度） */
export const MODEL_COLOR_VARS = Object.freeze([
  'var(--ctx-cached)',
  'var(--ctx-skills)',
  'var(--ctx-user-input)',
  'var(--ctx-checkpoint)',
  'var(--ctx-tool-results)',
  'var(--ctx-subagent-msg)',
]);

/**
 * 提取步骤所属的基础模型分组键（与后端 `usage-aggregator.mjs` 中 `modelBreakdown[].label` 严格一致），
 * 且不受“精简代号 / 原始模型 ID”或“自动压缩”后缀切换影响。
 *
 * @param {object|null|undefined} step
 * @returns {string}
 */
export function getStepModelGroupKey(step) {
  if (!step || typeof step !== 'object') return t('fmt.unknownModel');
  const rawLabel = String(step.baseModelLabel || step.modelLabel || step.label || '')
    .replace(/\s*\[自动压缩\]\s*$/u, '')
    .replace(/\s*\((?:Max|XHigh|High|Medium|Low|Thinking|Extra Low|Tiered)\)\s*$/i, '')
    .trim();
  if (rawLabel) return rawLabel;
  const rawShort = String(step.baseModelShort || step.modelShort || step.shortName || '')
    .replace(/·(?:压缩|Compact)\s*$/iu, '')
    .trim();
  return rawShort || t('fmt.unknownModel');
}

/**
 * 将逆序或混合代理的步骤列表归一化为严格时间升序序列（最旧 -> 最新）。
 *
 * @param {Array<object>} steps
 * @param {boolean} isMergedAllAgents
 * @returns {Array<object>}
 */
export function toChronologicalSteps(steps, isMergedAllAgents = false) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const copy = steps.slice();
  if (isMergedAllAgents) {
    copy.sort(
      (a, b) =>
        (Number(a?.createdAtMs) || 0) - (Number(b?.createdAtMs) || 0) ||
        (Number(a?.agentIndex) || 0) - (Number(b?.agentIndex) || 0) ||
        (Number(a?.stepIndex) || 0) - (Number(b?.stepIndex) || 0)
    );
    return copy;
  }
  copy.sort(
    (a, b) =>
      (Number(a?.stepIndex) || 0) - (Number(b?.stepIndex) || 0) ||
      (Number(a?.createdAtMs) || 0) - (Number(b?.createdAtMs) || 0)
  );
  return copy;
}

function clampValue(v, minVal = 0, maxVal = Infinity) {
  if (!Number.isFinite(v)) return minVal;
  return Math.max(minVal, Math.min(maxVal, v));
}

/**
 * 双侧 95% 置信区间对应的 Student-t 临界值近似表（t_{0.975, df}）。
 *
 * @param {number} df 残差自由度
 * @returns {number}
 */
function tCritical95(df) {
  if (!Number.isFinite(df) || df <= 1.5) return 3.182;
  if (df <= 2.5) return 3.182 + (2.5 - df) * 0.9;
  if (df <= 3.5) return 2.776 + (3.5 - df) * 0.406;
  if (df <= 4.5) return 2.571 + (4.5 - df) * 0.205;
  if (df <= 6) return 2.447;
  if (df <= 8) return 2.306;
  if (df <= 10) return 2.228;
  if (df <= 15) return 2.131;
  if (df <= 20) return 2.086;
  if (df <= 30) return 2.042;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}

/**
 * 计算普通最小二乘线性回归（OLS: y = intercept + slope * x）。
 *
 * @param {number[]} ys 样本纵坐标序列
 * @param {{ minVal?: number, maxVal?: number, xs?: number[] }} [options]
 * @returns {{ values: number[], slope: number, intercept: number, mean: number, r: number, r2: number }}
 */
export function computeLinearFit(ys, { minVal = 0, maxVal = Infinity, xs = null } = {}) {
  const n = Array.isArray(ys) ? ys.length : 0;
  if (n === 0) {
    return { values: [], slope: 0, intercept: 0, mean: 0, r: 0, r2: 0 };
  }
  const xArr =
    Array.isArray(xs) && xs.length === n ? xs : Array.from({ length: n }, (_, idx) => idx);
  const meanY = ys.reduce((acc, v) => acc + v, 0) / n;
  if (n === 1) {
    const c = clampValue(ys[0], minVal, maxVal);
    return { values: [c], slope: 0, intercept: c, mean: c, r: 0, r2: 0 };
  }
  const meanX = xArr.reduce((acc, v) => acc + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xArr[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const r =
    sxx > 1e-12 && syy > 1e-12 ? clampValue(sxy / Math.sqrt(sxx * syy), -1, 1) : 0;
  const values = xArr.map((x) => clampValue(intercept + slope * x, minVal, maxVal));
  return { values, slope, intercept, mean: meanY, r, r2: r * r };
}

/**
 * 学术论文级回归与 95% 置信带计算引擎（Cleveland & Devlin 高斯局部加权线性回归 LOESS + 精确帽子矩阵标准误，
 * 小样本 n <= 5 时自动采用精确 OLS 线性回归与双曲 t 分布 95% 置信区间，等同于 R `ggplot2::geom_smooth(se = TRUE)`）。
 *
 * @param {number[]} xs 严格递增或单调的样本横坐标序列
 * @param {number[]} ys 样本纵坐标序列
 * @param {{ minVal?: number, maxVal?: number, gridSize?: number, span?: number }} [options]
 */
export function computePublicationFit(
  xs,
  ys,
  { minVal = 0, maxVal = Infinity, gridSize = 64, span = 0.5 } = {}
) {
  const n = Math.min(Array.isArray(xs) ? xs.length : 0, Array.isArray(ys) ? ys.length : 0);
  if (n === 0) {
    return {
      method: 'OLS',
      mean: 0,
      sd: 0,
      slope: 0,
      intercept: 0,
      r: 0,
      r2: 0,
      sampleFits: [],
      sampleCiLow: [],
      sampleCiHigh: [],
      sampleCiHalf: [],
      grid: [],
    };
  }

  const ols = computeLinearFit(ys, { minVal, maxVal, xs });
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dy = ys[i] - ols.mean;
    syy += dy * dy;
  }
  const sd = n > 1 ? Math.sqrt(syy / (n - 1)) : 0;

  if (n === 1) {
    const val = clampValue(ys[0], minVal, maxVal);
    return {
      method: 'OLS',
      mean: val,
      sd: 0,
      slope: 0,
      intercept: val,
      r: 0,
      r2: 0,
      sampleFits: [val],
      sampleCiLow: [val],
      sampleCiHigh: [val],
      sampleCiHalf: [0],
      grid: [{ x: xs[0], fit: val, ciLow: val, ciHigh: val }],
    };
  }

  const xMin = xs[0];
  const xMax = xs[n - 1];
  const xSpan = Math.max(1e-9, xMax - xMin);
  const M = Math.max(2, gridSize);
  const gridXs = Array.from({ length: M }, (_, k) => xMin + (k / (M - 1)) * xSpan);

  // 小样本（n <= 5）：采用精确 OLS 线性回归与 Student-t 双曲 95% CI 置信带
  if (n <= 5) {
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      sxx += dx * dx;
      const resid = ys[i] - (ols.intercept + ols.slope * xs[i]);
      sse += resid * resid;
    }
    const df = n - 2;
    const seResid = df >= 1 ? Math.sqrt(sse / df) : 0;
    const tCrit = df >= 1 ? tCritical95(df) : 0;

    const evalOlsAt = (x0) => {
      const rawFit = ols.intercept + ols.slope * x0;
      const sePred =
        seResid > 0
          ? seResid * Math.sqrt(1 / n + (sxx > 1e-12 ? ((x0 - meanX) * (x0 - meanX)) / sxx : 0))
          : 0;
      const half = tCrit * sePred;
      return {
        fit: clampValue(rawFit, minVal, maxVal),
        ciLow: clampValue(rawFit - half, minVal, maxVal),
        ciHigh: clampValue(rawFit + half, minVal, maxVal),
        half,
      };
    };

    const sampleEval = xs.map(evalOlsAt);
    const grid = gridXs.map((gx) => {
      const g = evalOlsAt(gx);
      return { x: gx, fit: g.fit, ciLow: g.ciLow, ciHigh: g.ciHigh };
    });

    return {
      method: 'OLS',
      mean: ols.mean,
      sd,
      slope: ols.slope,
      intercept: ols.intercept,
      r: ols.r,
      r2: ols.r2,
      sampleFits: sampleEval.map((e) => e.fit),
      sampleCiLow: sampleEval.map((e) => e.ciLow),
      sampleCiHigh: sampleEval.map((e) => e.ciHigh),
      sampleCiHalf: sampleEval.map((e) => e.half),
      grid,
    };
  }

  // n >= 6：Cleveland 高斯局部加权一阶线性回归（LOESS）+ 精确帽子矩阵杠杆度 95% CI 置信带
  const q = Math.max(5, Math.min(n, Math.ceil(span * n)));
  const wBuf = new Float64Array(n);
  const sortedXs = q <= n && xs.slice(0, n).every(
    (x, i) => Number.isFinite(x) && (i === 0 || xs[i - 1] <= x)
  );

  function loessBandwidth(x0) {
    // 有序 x 上的 q 个最近样本可取连续区间；二分比较两端，避免每个拟合点都排序。
    let left = 0;
    let right = n - q;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (x0 - xs[mid] > xs[mid + q] - x0) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    return Math.max(Math.abs(xs[left] - x0), Math.abs(xs[left + q - 1] - x0));
  }

  function evalLoessPoint(x0, diagIdx = -1) {
    let h;
    if (sortedXs) {
      h = loessBandwidth(x0);
      if (h <= 1e-9) {
        h = Math.max(Math.abs(xs[0] - x0), Math.abs(xs[n - 1] - x0), xSpan * 0.05, 1e-6);
      }
    } else {
      const sortedDists = Array.from({ length: n }, (_, j) => Math.abs(xs[j] - x0)).sort((a, b) => a - b);
      h = sortedDists[q - 1];
      if (h <= 1e-9) {
        h = Math.max(sortedDists[n - 1], xSpan * 0.05, 1e-6);
      }
    }
    const maxDist = h * 1.0001;
    let start = 0;
    let end = n;
    if (sortedXs) {
      // 三次权重的支持区间之外权重为零，保留区间内样本原来的累加顺序。
      let right = n;
      while (start < right) {
        const mid = (start + right) >>> 1;
        if (x0 - xs[mid] >= maxDist) start = mid + 1;
        else right = mid;
      }
      let left = start;
      while (left < end) {
        const mid = (left + end) >>> 1;
        if (xs[mid] - x0 < maxDist) left = mid + 1;
        else end = mid;
      }
    }

    let sw = 0;
    let swx = 0;
    for (let j = start; j < end; j++) {
      const u = Math.abs(xs[j] - x0) / maxDist;
      const base = 1 - u * u * u;
      const w = u >= 1 ? 0 : base * base * base;
      wBuf[j] = w;
      sw += w;
      swx += w * xs[j];
    }

    if (sw <= 1e-12) {
      const fallbackVal = ols.intercept + ols.slope * x0;
      return { rawFit: fallbackVal, leverageNormSq: 1 / n, diagHat: 1 / n, localHatDiag: 1 / n };
    }

    const mx = swx / sw;
    let sxxW = 0;
    for (let j = start; j < end; j++) {
      const w = wBuf[j];
      if (w <= 0) continue;
      const dx = xs[j] - mx;
      sxxW += w * dx * dx;
    }

    const dx0 = x0 - mx;
    const useSlope = sxxW > 1e-12;
    const inverseWeightSum = 1 / sw;
    const slopeScale = useSlope ? dx0 / sxxW : 0;
    const localHatDiag = inverseWeightSum + (useSlope ? (dx0 * dx0) / sxxW : 0);
    let rawFit = 0;
    let leverageNormSq = 0;
    let diagHat = 0;

    for (let j = start; j < end; j++) {
      const w = wBuf[j];
      if (w <= 0) continue;
      const lj = w * inverseWeightSum + (useSlope ? w * (xs[j] - mx) * slopeScale : 0);
      rawFit += lj * ys[j];
      leverageNormSq += lj * lj;
      if (j === diagIdx) diagHat = lj;
    }

    return { rawFit, leverageNormSq, diagHat, localHatDiag };
  }

  const rawSampleFits = new Float64Array(n);
  const sampleLevSq = new Float64Array(n);
  let sse = 0;
  let traceL = 0;
  let precomputedGridEval = null;

  // 大样本（n > 200 且 x 单调有序）采用与 R `stats::loess(surface = "interpolate")` 一致的网格插值加速：
  // 仅在 M 个均匀网格顶点做精确 LOESS（O(M·N)），再线性插值样本拟合值与杠杆度，避免 O(N²) 阻塞主线程。
  if (n > 200 && sortedXs && M >= 2) {
    const gridRawFit = new Float64Array(M);
    const gridLevSq = new Float64Array(M);
    const gridHatDiag = new Float64Array(M);
    for (let k = 0; k < M; k++) {
      const res = evalLoessPoint(gridXs[k], -1);
      gridRawFit[k] = res.rawFit;
      gridLevSq[k] = res.leverageNormSq;
      gridHatDiag[k] = res.localHatDiag;
    }
    precomputedGridEval = { gridRawFit, gridLevSq };

    const invSpan = (M - 1) / xSpan;
    const maxK0 = M - 2;
    for (let i = 0; i < n; i++) {
      const u = (xs[i] - xMin) * invSpan;
      const k0 = u <= 0 ? 0 : u >= maxK0 ? maxK0 : Math.floor(u);
      const frac = Math.max(0, Math.min(1, u - k0));
      const rf = gridRawFit[k0] + frac * (gridRawFit[k0 + 1] - gridRawFit[k0]);
      const ls = Math.max(0, gridLevSq[k0] + frac * (gridLevSq[k0 + 1] - gridLevSq[k0]));
      const hd = gridHatDiag[k0] + frac * (gridHatDiag[k0 + 1] - gridHatDiag[k0]);
      rawSampleFits[i] = rf;
      sampleLevSq[i] = ls;
      traceL += hd;
      const diff = ys[i] - rf;
      sse += diff * diff;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const res = evalLoessPoint(xs[i], i);
      rawSampleFits[i] = res.rawFit;
      sampleLevSq[i] = res.leverageNormSq;
      traceL += res.diagHat;
      const diff = ys[i] - res.rawFit;
      sse += diff * diff;
    }
  }

  const dfRes = Math.max(1, n - traceL);
  const sigmaHat = Math.sqrt(sse / dfRes);
  const tCrit = tCritical95(dfRes);

  const sampleFits = new Array(n);
  const sampleCiLow = new Array(n);
  const sampleCiHigh = new Array(n);
  const sampleCiHalf = new Array(n);
  let clampedSse = 0;

  for (let i = 0; i < n; i++) {
    const fitVal = clampValue(rawSampleFits[i], minVal, maxVal);
    const half = tCrit * sigmaHat * Math.sqrt(sampleLevSq[i]);
    sampleFits[i] = fitVal;
    sampleCiLow[i] = clampValue(rawSampleFits[i] - half, minVal, maxVal);
    sampleCiHigh[i] = clampValue(rawSampleFits[i] + half, minVal, maxVal);
    sampleCiHalf[i] = half;
    const d = ys[i] - fitVal;
    clampedSse += d * d;
  }

  const grid = precomputedGridEval
    ? gridXs.map((gx, k) => {
        const rf = precomputedGridEval.gridRawFit[k];
        const half = tCrit * sigmaHat * Math.sqrt(Math.max(0, precomputedGridEval.gridLevSq[k]));
        return {
          x: gx,
          fit: clampValue(rf, minVal, maxVal),
          ciLow: clampValue(rf - half, minVal, maxVal),
          ciHigh: clampValue(rf + half, minVal, maxVal),
        };
      })
    : gridXs.map((gx) => {
        const res = evalLoessPoint(gx, -1);
        const half = tCrit * sigmaHat * Math.sqrt(res.leverageNormSq);
        return {
          x: gx,
          fit: clampValue(res.rawFit, minVal, maxVal),
          ciLow: clampValue(res.rawFit - half, minVal, maxVal),
          ciHigh: clampValue(res.rawFit + half, minVal, maxVal),
        };
      });

  const r2Loess = syy > 1e-12 ? clampValue(1 - clampedSse / syy, 0, 1) : 1;

  return {
    method: 'LOESS',
    mean: ols.mean,
    sd,
    slope: ols.slope,
    intercept: ols.intercept,
    r: ols.r,
    r2: r2Loess,
    sampleFits,
    sampleCiLow,
    sampleCiHigh,
    sampleCiHalf,
    grid,
  };
}

/**
 * Heckbert 科学坐标轴刻度取整算法，生成科研图表风格的均匀整洁刻度。
 */
function niceStepNumber(range, round) {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * 10 ** exponent;
}

function computeNiceYScale(dataMin, dataMax, { minBound = 0, maxBound = Infinity, tickCount = 4 } = {}) {
  let lo = Number.isFinite(dataMin) ? dataMin : 0;
  let hi = Number.isFinite(dataMax) ? dataMax : 1;
  if (minBound === 0 && lo >= 0 && hi > 0 && lo <= hi * 0.32) {
    lo = 0;
  }
  if (hi - lo <= 1e-9) {
    const pad = lo > 0 ? lo * 0.15 : 1;
    lo = Math.max(minBound, lo - pad);
    hi = Math.min(maxBound, hi + pad);
    if (hi - lo <= 1e-9) {
      lo = Math.max(minBound, hi - 1);
    }
  } else {
    const pad = (hi - lo) * 0.05;
    lo = Math.max(minBound, lo - (lo === 0 ? 0 : pad));
    hi = Math.min(maxBound, hi + pad);
  }

  const rawRange = niceStepNumber(hi - lo, false);
  const step = niceStepNumber(rawRange / Math.max(2, tickCount - 1), true);
  let graphMin = Math.max(minBound, Math.floor(lo / step) * step);
  let graphMax = Math.min(maxBound, Math.ceil(hi / step) * step);
  if (graphMax - graphMin <= 1e-9) {
    graphMax = graphMin + step;
  }

  const ticks = [];
  for (let v = graphMin; v <= graphMax + step * 0.25; v += step) {
    const clamped = clampValue(+v.toPrecision(10), minBound, maxBound);
    if (ticks.length === 0 || Math.abs(clamped - ticks[ticks.length - 1]) > step * 1e-4) {
      ticks.push(clamped);
    }
    if (ticks.length >= 8) break;
  }
  return {
    min: ticks[0] ?? graphMin,
    max: ticks[ticks.length - 1] ?? graphMax,
    step,
    ticks,
  };
}

function computeNiceXStepTicks(xs) {
  const n = xs.length;
  if (n === 0) return [];
  if (n <= 5) {
    return Array.from(new Set(xs.map((x) => Math.round(x))));
  }
  const xMin = xs[0];
  const xMax = xs[n - 1];
  const span = xMax - xMin;
  if (span <= 5) {
    return Array.from(new Set(xs.map((x) => Math.round(x))));
  }
  const step = Math.max(1, Math.round(niceStepNumber(span / 4.5, true)));
  const firstTick = Math.ceil(xMin / step) * step;
  const ticks = [];
  if (firstTick - xMin > step * 0.45) {
    ticks.push(Math.round(xMin));
  }
  for (let v = firstTick; v <= xMax + 1e-6; v += step) {
    ticks.push(Math.round(v));
    if (ticks.length >= 7) break;
  }
  if (ticks.length === 0) {
    return [Math.round(xMin), Math.round(xMax)];
  }
  return ticks;
}

function formatYAxisTick(metric, val, step) {
  if (!Number.isFinite(val)) return '';
  if (Math.abs(val) < 1e-9) {
    return metric === 'cost' ? '$0' : metric === 'cache' ? '0%' : metric === 'ttft' ? '0s' : '0';
  }
  if (metric === 'tps') {
    return step >= 1 ? `${Math.round(val)}` : val.toFixed(1);
  }
  if (metric === 'ttft') {
    return step >= 1 ? `${Math.round(val)}s` : `${val.toFixed(1)}s`;
  }
  if (metric === 'cache') {
    return step >= 1 ? `${Math.round(val)}%` : `${val.toFixed(1)}%`;
  }
  if (metric === 'cost') {
    if (step >= 1) return `$${Math.round(val)}`;
    if (step >= 0.1) return `$${val.toFixed(1)}`;
    if (step >= 0.01) return `$${val.toFixed(2)}`;
    return `$${val.toFixed(3)}`;
  }
  return String(val);
}

function buildPolylinePath(points) {
  if (!points.length) return '';
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}`;
  }
  return d;
}

function buildSplinePath(points) {
  if (!points.length) return '';
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpx1 = p0.x + (p1.x - p0.x) * 0.38;
    const cpx2 = p1.x - (p1.x - p0.x) * 0.38;
    d += ` C ${cpx1.toFixed(1)} ${p0.y.toFixed(1)}, ${cpx2.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

function computeStepTickIndices(count) {
  if (count <= 0) return [];
  if (count <= 6) return Array.from({ length: count }, (_, i) => i);
  const maxTicks = 6;
  const set = new Set();
  for (let k = 0; k < maxTicks; k++) {
    set.add(Math.round((k / (maxTicks - 1)) * (count - 1)));
  }
  return Array.from(set).sort((a, b) => a - b);
}

function formatStepAxisTag(st, showAgentPrefix) {
  const num = `#${Number(st?.stepIndex ?? 0)}`;
  if (!showAgentPrefix) return num;
  const badge = formatAgentBadgeText({
    agentKind:
      st?.agentKind || (!st?.isSubagent ? 'main' : st?.isSideQuestion ? 'side_question' : 'subagent'),
    agentOrdinal:
      st?.agentOrdinal || (st?.isSideQuestion ? st?.sideIndex || 0 : st?.agentIndex || 0),
    isMain: !st?.isSubagent,
    isSideQuestion: Boolean(st?.isSideQuestion),
    sideIndex: st?.sideIndex || 0,
    index: st?.agentIndex || 0,
    badgeText: st?.agentBadge,
  });
  return `${badge}${num}`;
}

function formatChartMetricValue(metric, val) {
  if (!Number.isFinite(val)) return '—';
  switch (metric) {
    case 'totalTokens':
    case 'context':
      return `${formatTokensPrecise(val)} tok`;
    case 'tps':
      return formatSpeedMetric(val, ' tok/s');
    case 'ttft':
      return formatMetric(val, 's');
    case 'cache':
      return `${val.toFixed(1)}%`;
    case 'cost':
      return formatUsd(val, { precise: true });
    default:
      return String(val);
  }
}

function formatChartMetricCompact(metric, val) {
  if (!Number.isFinite(val)) return '—';
  switch (metric) {
    case 'totalTokens':
    case 'context':
      return formatTokens(val);
    case 'tps':
      return formatSpeedMetric(val, ' tok/s');
    case 'ttft':
      return formatMetric(val, 's');
    case 'cache':
      return `${val.toFixed(1)}%`;
    case 'cost':
      return formatUsd(val, { precise: true });
    default:
      return String(val);
  }
}

/**
 * 创建会话全模型线性走势图（支持 `totalTokens` | `context` | `tps` | `ttft` | `cost`，全宽 1:1 贴边对齐）。
 */
export function createSessionLineChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 106;
  const TOP_Y = 18;
  const BOTTOM_Y = 94;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolvePlotBounds(w) {
    const leftX = 1;
    const rightX = Math.max(leftX + 20, w - 1);
    return { leftX, rightX, spanX: rightX - leftX };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'sstep-svg');
  svg.setAttribute('aria-hidden', 'true');

  const gradId = `sstep-line-grad-${++sessionChartUid}`;
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
  stop1.setAttribute('stop-opacity', '0.28');
  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--ctx-cached)');
  stop2.setAttribute('stop-opacity', '0.0');
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const gridGroup = document.createElementNS(SVG_NS, 'g');
  gridGroup.setAttribute('class', 'trend-grid');
  const gridLines = [];
  for (const y of [TOP_Y, Math.round((TOP_Y + BOTTOM_Y) / 2), BOTTOM_Y]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(viewW));
    line.setAttribute('y2', String(y));
    gridGroup.appendChild(line);
    gridLines.push(line);
  }
  svg.appendChild(gridGroup);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  const multiAreaGroup = document.createElementNS(SVG_NS, 'g');
  multiAreaGroup.setAttribute('class', 'sstep-multi-area-group');
  svg.appendChild(multiAreaGroup);

  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('class', 'trend-line');
  linePath.setAttribute('fill', 'none');
  svg.appendChild(linePath);

  const multiLineGroup = document.createElementNS(SVG_NS, 'g');
  multiLineGroup.setAttribute('class', 'sstep-multi-line-group');
  svg.appendChild(multiLineGroup);

  const dotsGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(dotsGroup);

  const anomalyDotsGroup = document.createElementNS(SVG_NS, 'g');
  anomalyDotsGroup.setAttribute('class', 'sstep-anomaly-dots');
  svg.appendChild(anomalyDotsGroup);

  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', '10');
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '3.4');
  hoverDot.setAttribute('class', 'trend-hover-dot');
  hoverDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverDot);

  const emptyHintEl = h('div', {
    className: 'sstep-empty-hint text-muted',
    text: t('chart.step.empty'),
    hidden: true,
  });

  const peakPill = h('span', { className: 'trend-peak-pill text-mono', hidden: true });

  const tipHeadLeft = h('span', { className: 'trend-tip-time text-mono' });
  const tipHeadRight = h('span', { className: 'trend-tip-calls text-mono' });
  const tipMainLeft = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipMainRight = h('span', { className: 'trend-tip-cost text-mono' });
  const tipSub = h('div', { className: 'trend-tip-sub text-mono', hidden: true });
  const tipAnomaly = h('div', { className: 'trend-tip-anomaly text-mono', hidden: true });
  const tooltipEl = h('div', { className: 'trend-tooltip', hidden: true }, [
    h('div', { className: 'trend-tip-head' }, [tipHeadLeft, tipHeadRight]),
    h('div', { className: 'trend-tip-main' }, [tipMainLeft, tipMainRight]),
    tipSub,
    tipAnomaly,
  ]);

  const xAxisEl = h('div', { className: 'trend-x-axis' });
  const modelLegendEl = h('div', { className: 'sstep-model-legend', hidden: true });
  const plotStage = h('div', { className: 'sstep-plot-stage' }, [
    peakPill,
    emptyHintEl,
    tooltipEl,
    svg,
  ]);
  const rootEl = h('div', { className: 'sstep-chart-wrap' }, [
    plotStage,
    xAxisEl,
    modelLegendEl,
  ]);

  let currentPoints = [];
  let currentMetric = 'totalTokens';
  let hoveredIdx = -1;
  let tickElsByIdx = new Map();
  let lastSig = '';
  let lastUpdateParams = null;

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
      for (const line of gridLines) {
        line.setAttribute('x1', '0');
        line.setAttribute('x2', String(viewW));
      }
      return true;
    }
    return false;
  }

  function showHoverAt(idx) {
    if (idx < 0 || idx >= currentPoints.length) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    hoveredIdx = idx;
    const pt = currentPoints[idx];
    patchAttr(hoverLine, 'hidden', false);
    patchAttr(hoverLine, 'x1', pt.x.toFixed(1));
    patchAttr(hoverLine, 'x2', pt.x.toFixed(1));

    patchAttr(hoverDot, 'hidden', false);
    patchAttr(hoverDot, 'cx', pt.x.toFixed(1));
    patchAttr(hoverDot, 'cy', pt.y.toFixed(1));
    const hoverAccent = pt.anomalySummary
      ? pt.anomalySeverity === 'danger'
        ? 'var(--metric-danger)'
        : 'var(--metric-warn)'
      : pt.hoverColor || 'var(--ctx-cached)';
    patchStyleVar(hoverDot, '--hover-dot-color', hoverAccent);

    patchAttr(peakPill, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', false);

    patchText(tipHeadLeft, pt.stepTag);
    patchText(tipHeadRight, pt.modelText);
    patchText(
      tipMainLeft,
      pt.valid ? formatChartMetricValue(currentMetric, pt.value) : t('chart.step.excluded')
    );
    patchText(tipMainRight, pt.secondaryRight || '');
    patchAttr(tipSub, 'hidden', !pt.subDetail);
    if (pt.subDetail) {
      patchText(tipSub, pt.subDetail);
    }
    patchAttr(tipAnomaly, 'hidden', !pt.anomalySummary);
    if (pt.anomalySummary) {
      patchText(tipAnomaly, pt.anomalySummary);
      patchClasses(tipAnomaly, { 'is-danger': pt.anomalySeverity === 'danger' });
    }

    const rawPct = (pt.x / viewW) * 100;
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-y', '0px');
    if (wasHidden) {
      patchClasses(tooltipEl, { 'is-tracking': false });
      void tooltipEl.offsetWidth;
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          if (!tooltipEl.hasAttribute('hidden')) {
            patchClasses(tooltipEl, { 'is-tracking': true });
          }
        });
      } else {
        patchClasses(tooltipEl, { 'is-tracking': true });
      }
    }

    for (const [tIdx, el] of tickElsByIdx.entries()) {
      patchClasses(el, { 'is-hovered': tIdx === idx });
    }
  }

  function clearHover() {
    hoveredIdx = -1;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverDot, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, { 'is-tracking': false });
    if (currentPoints.some((p) => p.valid)) {
      patchAttr(peakPill, 'hidden', false);
    }
    for (const el of tickElsByIdx.values()) {
      patchClasses(el, { 'is-hovered': false });
    }
  }

  plotStage.addEventListener('mousemove', (e) => {
    if (!currentPoints.length) return;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    const { leftX, spanX } = resolvePlotBounds(viewW);
    const ratio = (relX - leftX) / Math.max(1, spanX);
    const idx = Math.max(
      0,
      Math.min(currentPoints.length - 1, Math.round(ratio * (currentPoints.length - 1)))
    );
    showHoverAt(idx);
  });
  plotStage.addEventListener('mouseleave', clearHover);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update(lastUpdateParams);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update(lastUpdateParams);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * @param {{
   *   steps: Array<object>,
   *   modelGroupKey?: string,
   *   modelGroupKeys?: string[]|null,
   *   modelColorByGroup?: Map<string, string>|null,
   *   metric: 'totalTokens'|'context'|'tps'|'ttft'|'cost',
   *   showAgentPrefix?: boolean,
   *   displaySettings?: object,
   * }} params
   * @returns {{ summaryBadge: string }}
   */
  function update({
    steps = [],
    modelGroupKey = '__all__',
    modelGroupKeys = null,
    modelColorByGroup = null,
    metric = 'totalTokens',
    showAgentPrefix = false,
    displaySettings = {},
  } = {}) {
    lastUpdateParams = {
      steps,
      modelGroupKey,
      modelGroupKeys,
      modelColorByGroup,
      metric,
      showAgentPrefix,
      displaySettings,
    };
    currentMetric = metric;
    syncViewWidth();

    const accentColor = 'var(--ctx-cached)';
    patchAttr(stop1, 'stop-color', accentColor);
    patchAttr(stop2, 'stop-color', accentColor);
    patchStyleVar(rootEl, '--sstep-accent', accentColor);

    const rawKeys =
      Array.isArray(modelGroupKeys) && modelGroupKeys.length > 0
        ? modelGroupKeys
        : [modelGroupKey || '__all__'];
    const isPooledAll = rawKeys.includes('__all__');
    const targetKeys = isPooledAll
      ? ['__all__']
      : Array.from(new Set(rawKeys.map((k) => String(k || '')).filter(Boolean)));
    const targetKeySet = new Set(targetKeys);
    const isMultiCompare = !isPooledAll && targetKeys.length >= 2;

    const matchedSteps = isPooledAll
      ? steps
      : steps.filter((st) => st && targetKeySet.has(getStepModelGroupKey(st)));

    patchText(emptyHintEl, t('chart.step.empty'));
    if (!matchedSteps.length) {
      currentPoints = [];
      lastSig = 'empty';
      patchAttr(areaPath, 'd', '');
      patchAttr(linePath, 'd', '');
      while (multiAreaGroup.firstChild) multiAreaGroup.removeChild(multiAreaGroup.firstChild);
      while (multiLineGroup.firstChild) multiLineGroup.removeChild(multiLineGroup.firstChild);
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      while (anomalyDotsGroup.firstChild) anomalyDotsGroup.removeChild(anomalyDotsGroup.firstChild);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      patchAttr(modelLegendEl, 'hidden', true);
      patchAttr(peakPill, 'hidden', true);
      patchAttr(emptyHintEl, 'hidden', false);
      clearHover();
      return { summaryBadge: t('chart.step.zeroSteps') };
    }

    const modelColorMap = new Map();
    const modelLabelByGroup = new Map();
    if (isMultiCompare) {
      for (let i = 0; i < targetKeys.length; i++) {
        const gk = targetKeys[i];
        const colorVar =
          modelColorByGroup?.get(gk) || MODEL_COLOR_VARS[i % MODEL_COLOR_VARS.length];
        modelColorMap.set(gk, colorVar);
        const disp = resolveModelDisplayInfo({ modelLabel: gk, label: gk }, displaySettings, {
          fallback: gk,
        });
        modelLabelByGroup.set(gk, disp.baseText || disp.text || gk);
      }
    }
    for (const st of matchedSteps) {
      const gk = getStepModelGroupKey(st);
      if (!modelColorMap.has(gk)) {
        const colorVar =
          modelColorByGroup?.get(gk) ||
          MODEL_COLOR_VARS[modelColorMap.size % MODEL_COLOR_VARS.length];
        modelColorMap.set(gk, colorVar);
      }
      if (!modelLabelByGroup.has(gk)) {
        const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: gk });
        modelLabelByGroup.set(gk, disp.baseText || disp.text || gk);
      }
    }

    let runningTokens = 0;
    let runningCost = 0;
    let validSum = 0;
    let validCount = 0;
    const perModelRunningTokens = new Map();
    const perModelRunningCost = new Map();
    const perModelPrevCtx = new Map();
    const perModelStats = new Map();

    const rawItems = matchedSteps.map((st, idx) => {
      const gk = getStepModelGroupKey(st);
      const inTok = Math.max(0, Number(st.inputTokens || 0));
      const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(st.outputTokens || 0));
      const stepTotalTok = inTok + cacheTok + outTok;
      runningTokens += stepTotalTok;
      const modelCumTok = (perModelRunningTokens.get(gk) || 0) + stepTotalTok;
      perModelRunningTokens.set(gk, modelCumTok);

      const stepCost = Number.isFinite(Number(st.costUsd)) ? Math.max(0, Number(st.costUsd)) : null;
      if (stepCost !== null) {
        runningCost += stepCost;
        perModelRunningCost.set(gk, (perModelRunningCost.get(gk) || 0) + stepCost);
      }
      const modelCumCost = perModelRunningCost.get(gk) || 0;

      const ctxTok = Math.max(0, Number(st.contextTokens ?? stepTotalTok));
      const hasPrevModelCtx = perModelPrevCtx.has(gk);
      const prevSameModelCtx = hasPrevModelCtx ? perModelPrevCtx.get(gk) : ctxTok;
      perModelPrevCtx.set(gk, ctxTok);

      const prevGlobalCtx =
        idx > 0
          ? Math.max(
              0,
              Number(
                matchedSteps[idx - 1].contextTokens ??
                  Number(matchedSteps[idx - 1].inputTokens || 0) +
                    Number(matchedSteps[idx - 1].cacheReadTokens || 0) +
                    Number(matchedSteps[idx - 1].outputTokens || 0)
              )
            )
          : ctxTok;
      const hasPrevCtx = isMultiCompare ? hasPrevModelCtx : idx > 0;
      const ctxDelta = isMultiCompare ? ctxTok - prevSameModelCtx : idx > 0 ? ctxTok - prevGlobalCtx : 0;

      const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '—' });
      const stepTag = formatStepAxisTag(st, showAgentPrefix);

      let valid = true;
      let value = 0;
      let secondaryRight = '';
      let subDetail = '';

      if (metric === 'totalTokens') {
        value = isMultiCompare ? modelCumTok : runningTokens;
        secondaryRight = t('chart.step.stepAdd', { tokens: formatTokens(stepTotalTok) });
        subDetail = t('chart.step.ioSplit', {
          inTok: formatTokens(inTok),
          cacheTok: formatTokens(cacheTok),
          outTok: formatTokens(outTok),
        });
      } else if (metric === 'context') {
        value = ctxTok;
        if (hasPrevCtx) {
          const sign = ctxDelta >= 0 ? '+' : '-';
          secondaryRight = `${sign}${formatTokens(Math.abs(ctxDelta))}`;
        } else {
          secondaryRight = t('chart.step.cacheShort', { pct: Number(st.cacheHitPct ?? 0) });
        }
        subDetail = st.isCompactionStep
          ? t('chart.step.compactionCheckpoint')
          : t('chart.step.cacheHitOut', {
              pct: Number(st.cacheHitPct ?? 0),
              outTok: formatTokens(outTok),
            });
      } else if (metric === 'tps') {
        valid = !st.isCompactionStep && Number.isFinite(st.tokPerSec) && st.tokPerSec > 0;
        value = valid ? Number(st.tokPerSec) : 0;
        secondaryRight = Number.isFinite(st.ttftSec)
          ? t('chart.step.ttftShort', { sec: formatMetric(st.ttftSec, '') })
          : '';
        subDetail = valid
          ? t('chart.step.outAndCtx', {
              outTok: formatTokens(outTok),
              ctxTok: formatTokens(ctxTok),
            })
          : speedReasonText(st.selectedSpeedReason) ||
            (st.isCompactionStep ? t('chart.step.compactionStep') : t('chart.step.noSpeedSample'));
      } else if (metric === 'ttft') {
        valid = !st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0;
        value = valid ? Number(st.ttftSec) : 0;
        secondaryRight = Number.isFinite(st.tokPerSec) ? formatSpeedMetric(st.tokPerSec, ' tok/s') : '';
        subDetail = valid
          ? t('chart.step.ctxAndCache', {
              ctxTok: formatTokens(ctxTok),
              pct: Number(st.cacheHitPct ?? 0),
            })
          : st.isCompactionStep
            ? t('chart.step.compactionStep')
            : t('chart.step.noTtftSample');
      } else if (metric === 'cost') {
        valid = stepCost !== null;
        value = valid ? stepCost : 0;
        const shownCumCost = isMultiCompare ? modelCumCost : runningCost;
        secondaryRight = t('chart.step.cumCost', {
          cost: formatUsd(shownCumCost, { precise: shownCumCost > 0 && shownCumCost < 0.1 }),
        });
        subDetail = t('chart.step.cacheAndStepTok', {
          pct: Number(st.cacheHitPct ?? 0),
          tokens: formatTokens(stepTotalTok),
        });
      }

      if (valid) {
        validSum += value;
        validCount += 1;
        let stStat = perModelStats.get(gk);
        if (!stStat) {
          stStat = { count: 0, sum: 0, max: 0, last: 0, cumTok: 0, cumCost: 0 };
          perModelStats.set(gk, stStat);
        }
        stStat.count += 1;
        stStat.sum += value;
        if (value > stStat.max) stStat.max = value;
        stStat.last = value;
        stStat.cumTok = modelCumTok;
        stStat.cumCost = modelCumCost;
      }

      const dotColor = modelColorMap.get(gk) || accentColor;
      const anomalySummary = formatStepAnomalyInlineSummary(st.anomaly);
      return {
        idx,
        st,
        stepTag,
        modelGroupKey: gk,
        modelText: disp.text,
        dotColor,
        hoverColor: isMultiCompare ? dotColor : accentColor,
        valid,
        value,
        secondaryRight,
        subDetail,
        anomalySummary,
        anomalySeverity: st.anomaly?.severity || '',
      };
    });

    let maxVal = 0;
    let peakIdx = -1;
    for (let i = 0; i < rawItems.length; i++) {
      if (rawItems[i].valid && rawItems[i].value >= maxVal) {
        maxVal = rawItems[i].value;
        peakIdx = i;
      }
    }

    const { leftX, rightX, spanX } = resolvePlotBounds(viewW);
    const denom = maxVal > 0 ? maxVal : 1;
    const isSingle = rawItems.length === 1;
    const points = rawItems.map((item, i) => {
      const x = isSingle
        ? (leftX + rightX) / 2
        : leftX + (i / Math.max(1, rawItems.length - 1)) * spanX;
      const ratio = item.valid && maxVal > 0 ? item.value / denom : 0;
      const y = item.valid ? BOTTOM_Y - ratio * SPAN_Y : BOTTOM_Y;
      return { ...item, x, y };
    });
    currentPoints = points;

    const validPoints = points.filter((p) => p.valid);
    patchAttr(emptyHintEl, 'hidden', validPoints.length > 0);

    const locale = getEffectiveLocale();
    const colorSig = Array.from(modelColorMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const sig =
      `${locale}|${viewW}|${metric}|${showAgentPrefix}|${isMultiCompare ? 'multi' : 'single'}:${targetKeys.join(',')}|${colorSig}|` +
      points
        .map(
          (p) =>
            `${p.stepTag}:${p.modelText}:${p.valid ? p.value.toFixed(4) : 'x'}:${p.st?.anomalySig || ''}`
        )
        .join('|');

    if (sig !== lastSig) {
      lastSig = sig;
      while (multiAreaGroup.firstChild) multiAreaGroup.removeChild(multiAreaGroup.firstChild);
      while (multiLineGroup.firstChild) multiLineGroup.removeChild(multiLineGroup.firstChild);
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      while (anomalyDotsGroup.firstChild) anomalyDotsGroup.removeChild(anomalyDotsGroup.firstChild);

      if (isMultiCompare) {
        patchAttr(linePath, 'd', '');
        patchAttr(areaPath, 'd', '');

        for (const gk of targetKeys) {
          const seriesColor = modelColorMap.get(gk) || accentColor;
          const seriesPts = points.filter((p) => p.modelGroupKey === gk && p.valid);
          if (seriesPts.length === 0) continue;

          if (seriesPts.length === 1) {
            const singleDot = document.createElementNS(SVG_NS, 'circle');
            singleDot.setAttribute('cx', seriesPts[0].x.toFixed(1));
            singleDot.setAttribute('cy', seriesPts[0].y.toFixed(1));
            singleDot.setAttribute('r', '3.1');
            singleDot.setAttribute('class', 'sstep-series-single-dot');
            patchStyleVar(singleDot, '--sstep-series-color', seriesColor);
            multiLineGroup.appendChild(singleDot);
          } else {
            const seriesLineD = buildSplinePath(seriesPts);
            const firstX = seriesPts[0].x.toFixed(1);
            const lastX = seriesPts[seriesPts.length - 1].x.toFixed(1);

            const mArea = document.createElementNS(SVG_NS, 'path');
            mArea.setAttribute('class', 'sstep-multi-area');
            mArea.setAttribute(
              'd',
              `${seriesLineD} L ${lastX} ${BOTTOM_Y} L ${firstX} ${BOTTOM_Y} Z`
            );
            patchStyleVar(mArea, '--sstep-series-color', seriesColor);
            multiAreaGroup.appendChild(mArea);

            const mLine = document.createElementNS(SVG_NS, 'path');
            mLine.setAttribute('class', 'sstep-fit-line');
            mLine.setAttribute('fill', 'none');
            mLine.setAttribute('d', seriesLineD);
            patchStyleVar(mLine, '--sstep-fit-accent', seriesColor);
            multiLineGroup.appendChild(mLine);

            if (seriesPts.length <= 36) {
              for (const pt of seriesPts) {
                const dot = document.createElementNS(SVG_NS, 'circle');
                dot.setAttribute('cx', pt.x.toFixed(1));
                dot.setAttribute('cy', pt.y.toFixed(1));
                dot.setAttribute('r', seriesPts.length > 20 ? '1.7' : '2.1');
                dot.setAttribute('class', 'sstep-node-dot');
                patchStyleVar(dot, '--dot-stroke', seriesColor);
                dotsGroup.appendChild(dot);
              }
            }
          }
        }
      } else {
        if (validPoints.length === 0) {
          patchAttr(linePath, 'd', '');
          patchAttr(areaPath, 'd', '');
        } else if (validPoints.length === 1) {
          const yStr = validPoints[0].y.toFixed(1);
          const lineD = `M ${leftX.toFixed(1)} ${yStr} L ${rightX.toFixed(1)} ${yStr}`;
          patchAttr(linePath, 'd', lineD);
          patchAttr(
            areaPath,
            'd',
            `${lineD} L ${rightX.toFixed(1)} ${BOTTOM_Y} L ${leftX.toFixed(1)} ${BOTTOM_Y} Z`
          );
        } else {
          const lineD = buildSplinePath(validPoints);
          const firstX = validPoints[0].x.toFixed(1);
          const lastX = validPoints[validPoints.length - 1].x.toFixed(1);
          patchAttr(linePath, 'd', lineD);
          patchAttr(areaPath, 'd', `${lineD} L ${lastX} ${BOTTOM_Y} L ${firstX} ${BOTTOM_Y} Z`);
        }

        if (points.length <= 64) {
          for (const pt of points) {
            const dot = document.createElementNS(SVG_NS, 'circle');
            dot.setAttribute('cx', pt.x.toFixed(1));
            dot.setAttribute('cy', pt.y.toFixed(1));
            if (pt.valid) {
              dot.setAttribute('r', points.length > 36 ? '1.8' : '2.3');
              dot.setAttribute('class', 'sstep-node-dot');
              patchStyleVar(
                dot,
                '--dot-stroke',
                modelColorMap.size > 1 ? pt.dotColor : accentColor
              );
            } else {
              dot.setAttribute('r', '1.6');
              dot.setAttribute('class', 'sstep-node-dot is-skipped');
            }
            dotsGroup.appendChild(dot);
          }
        }
      }

      for (const pt of points) {
        if (!pt.valid || !pt.anomalySummary) continue;
        const aDot = document.createElementNS(SVG_NS, 'circle');
        aDot.setAttribute('cx', pt.x.toFixed(1));
        aDot.setAttribute('cy', pt.y.toFixed(1));
        aDot.setAttribute('r', '2.9');
        aDot.setAttribute(
          'class',
          `sstep-anomaly-dot${pt.anomalySeverity === 'danger' ? ' is-danger' : ''}`
        );
        anomalyDotsGroup.appendChild(aDot);
      }

      const tickIndices = computeStepTickIndices(points.length);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      tickElsByIdx = new Map();
      for (let i = 0; i < tickIndices.length; i++) {
        const tIdx = tickIndices[i];
        const pt = points[tIdx];
        if (!pt) continue;
        const isFirst = !isSingle && i === 0;
        const isLast = !isSingle && i === tickIndices.length - 1;
        const pct = isFirst ? 0 : isLast ? 100 : (pt.x / viewW) * 100;
        const tickEl = h('span', {
          className: `trend-x-tick text-mono${isFirst ? ' is-start' : isLast ? ' is-end' : ''}`,
          text: pt.stepTag,
          title: `${pt.stepTag} · ${pt.modelText}`,
        });
        patchStyleVar(tickEl, '--tick-x', `${pct.toFixed(2)}%`);
        tickEl.onclick = () => showHoverAt(tIdx);
        xAxisEl.appendChild(tickEl);
        tickElsByIdx.set(tIdx, tickEl);
      }

      while (modelLegendEl.firstChild) modelLegendEl.removeChild(modelLegendEl.firstChild);
      if (isMultiCompare) {
        patchAttr(modelLegendEl, 'hidden', false);
        for (const gk of targetKeys) {
          const colorVar = modelColorMap.get(gk) || accentColor;
          const swatch = h('span', { className: 'sstep-legend-line' });
          patchStyleVar(swatch, '--swatch-bg', colorVar);
          const stStat = perModelStats.get(gk);
          const baseLabel = modelLabelByGroup.get(gk) || gk;
          let summarySuffix = t('chart.step.noSamples');
          if (stStat && stStat.count > 0) {
            if (metric === 'totalTokens') {
              summarySuffix = formatTokens(stStat.cumTok);
            } else if (metric === 'context') {
              summarySuffix = t('chart.step.peakShort', { val: formatTokens(stStat.max) });
            } else if (metric === 'tps' || metric === 'ttft') {
              summarySuffix = formatChartMetricCompact(metric, stStat.sum / stStat.count);
            } else if (metric === 'cost') {
              summarySuffix = formatUsd(stStat.cumCost, {
                precise: stStat.cumCost > 0 && stStat.cumCost < 0.1,
              });
            }
          }
          modelLegendEl.appendChild(
            h('span', { className: 'sstep-legend-item' }, [
              swatch,
              h('span', { text: `${baseLabel} (${summarySuffix})` }),
            ])
          );
        }
      } else {
        const showPooledDotLegend = points.length <= 64 && modelColorMap.size > 1;
        patchAttr(modelLegendEl, 'hidden', !showPooledDotLegend);
        if (showPooledDotLegend) {
          for (const [gk, colorVar] of modelColorMap.entries()) {
            const swatch = h('span', { className: 'sstep-legend-dot' });
            patchStyleVar(swatch, '--swatch-bg', colorVar);
            modelLegendEl.appendChild(
              h('span', { className: 'sstep-legend-item' }, [
                swatch,
                h('span', { text: modelLabelByGroup.get(gk) || gk }),
              ])
            );
          }
        }
      }
    }

    if (peakIdx >= 0 && validPoints.length > 0) {
      const peakPt = points[peakIdx];
      patchText(
        peakPill,
        t('chart.step.peakPill', {
          tag: peakPt.stepTag,
          val: formatChartMetricCompact(metric, peakPt.value),
        })
      );
      patchStyleVar(peakPill, '--sstep-accent', isMultiCompare ? peakPt.dotColor : accentColor);
      const pctLeft = Math.max(14, Math.min(86, (peakPt.x / viewW) * 100));
      patchStyleVar(peakPill, '--peak-x', `${pctLeft.toFixed(1)}%`);
      if (hoveredIdx < 0) patchAttr(peakPill, 'hidden', false);
    } else {
      patchAttr(peakPill, 'hidden', true);
    }

    if (hoveredIdx >= points.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showHoverAt(hoveredIdx);
    }

    let summaryBadge = t('chart.step.stepsCount', { count: matchedSteps.length });
    const activeCompareCount = isMultiCompare ? targetKeys.length : 1;
    const multiPrefix = isMultiCompare
      ? t('chart.step.multiPrefix', { count: activeCompareCount })
      : '';
    if (metric === 'totalTokens') {
      summaryBadge = t('chart.step.sumTokens', {
        prefix: multiPrefix,
        tokens: formatTokens(runningTokens),
      });
    } else if (metric === 'context') {
      const lastCtx = points[points.length - 1]?.value || 0;
      summaryBadge = isMultiCompare
        ? t('chart.step.peakTokens', { prefix: multiPrefix, tokens: formatTokens(maxVal) })
        : t('chart.step.currentCtx', { tokens: formatTokens(lastCtx) });
    } else if (metric === 'tps') {
      summaryBadge =
        validCount > 0
          ? t('chart.step.meanTps', {
              prefix: multiPrefix,
              val: (validSum / validCount).toFixed(1),
            })
          : t('chart.step.noValidSamples');
    } else if (metric === 'ttft') {
      summaryBadge =
        validCount > 0
          ? t('chart.step.meanSec', {
              prefix: multiPrefix,
              val: (validSum / validCount).toFixed(1),
            })
          : t('chart.step.noValidSamples');
    } else if (metric === 'cost') {
      summaryBadge = t('chart.step.sumCost', {
        prefix: multiPrefix,
        cost: formatUsd(runningCost, { precise: runningCost > 0 && runningCost < 0.1 }),
      });
    }

    return { summaryBadge };
  }

  return { el: rootEl, update, destroy };
}

/**
 * 创建学术论文风格散点回归与 95% 置信带拟合图（全宽 1:1 贴边对齐 + 项目统一冷蓝灰设计语言）：
 * - 全宽水平参考网格与底部线性步序刻度轴（内嵌左对齐 Y 轴刻度标签，零左右缩进留白）；
 * - 半透明冷蓝灰实心观测散点（自然呈现重叠密度）；
 * - 围绕回归曲线的 95% CI 置信区间阴影带（绝不向 y=0 做面积图填充）；
 * - 高斯局部线性回归曲线（LOESS, n >= 6）或精确线性回归（OLS, n <= 5），配相关系数 r 与拟合优度 R²。
 */
export function createModelFitChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 136;
  const TOP_Y = 16;
  const BOTTOM_Y = 116;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolveFitBounds(w) {
    const plotLeft = 2;
    const plotRight = Math.max(plotLeft + 20, w - 2);
    return { plotLeft, plotRight, plotSpanX: plotRight - plotLeft };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'sstep-svg sstep-fit-svg');
  svg.setAttribute('aria-hidden', 'true');

  const gridGroup = document.createElementNS(SVG_NS, 'g');
  gridGroup.setAttribute('class', 'sstep-sci-grid');
  svg.appendChild(gridGroup);

  const axesGroup = document.createElementNS(SVG_NS, 'g');
  axesGroup.setAttribute('class', 'sstep-sci-axes');
  svg.appendChild(axesGroup);

  const multiBandGroup = document.createElementNS(SVG_NS, 'g');
  multiBandGroup.setAttribute('class', 'sstep-multi-band-group');
  svg.appendChild(multiBandGroup);

  const scatterGroup = document.createElementNS(SVG_NS, 'g');
  scatterGroup.setAttribute('class', 'sstep-scatter-group');
  svg.appendChild(scatterGroup);

  const multiCurveGroup = document.createElementNS(SVG_NS, 'g');
  multiCurveGroup.setAttribute('class', 'sstep-multi-curve-group');
  svg.appendChild(multiCurveGroup);

  const ciBandPath = document.createElementNS(SVG_NS, 'path');
  ciBandPath.setAttribute('class', 'sstep-ci-band');
  svg.appendChild(ciBandPath);

  const olsLine = document.createElementNS(SVG_NS, 'line');
  olsLine.setAttribute('class', 'sstep-ols-line');
  olsLine.setAttribute('hidden', 'true');
  svg.appendChild(olsLine);

  const fitPath = document.createElementNS(SVG_NS, 'path');
  fitPath.setAttribute('class', 'sstep-fit-line');
  fitPath.setAttribute('fill', 'none');
  svg.appendChild(fitPath);

  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', String(TOP_Y));
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverRawDot = document.createElementNS(SVG_NS, 'circle');
  hoverRawDot.setAttribute('r', '3.0');
  hoverRawDot.setAttribute('class', 'sstep-hover-raw-dot');
  hoverRawDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverRawDot);

  const hoverFitDot = document.createElementNS(SVG_NS, 'circle');
  hoverFitDot.setAttribute('r', '3.1');
  hoverFitDot.setAttribute('class', 'trend-hover-dot');
  hoverFitDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverFitDot);

  const emptyHintEl = h('div', {
    className: 'sstep-empty-hint text-muted',
    text: t('chart.fit.empty'),
    hidden: true,
  });

  const tipHeadLeft = h('span', { className: 'trend-tip-time text-mono' });
  const tipHeadRight = h('span', { className: 'trend-tip-calls text-mono' });
  const tipMainLeft = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipMainRight = h('span', { className: 'trend-tip-cost text-mono' });
  const tipSub = h('div', { className: 'trend-tip-sub text-mono', hidden: true });
  const tipAnomaly = h('div', { className: 'trend-tip-anomaly text-mono', hidden: true });
  const tooltipEl = h('div', { className: 'trend-tooltip', hidden: true }, [
    h('div', { className: 'trend-tip-head' }, [tipHeadLeft, tipHeadRight]),
    h('div', { className: 'trend-tip-main' }, [tipMainLeft, tipMainRight]),
    tipSub,
    tipAnomaly,
  ]);

  const fitMethodLabelEl = h('span', { text: t('chart.fit.loess') });
  const olsLegendTextEl = h('span', { text: t('chart.fit.olsLinear') });
  const olsLegendWrapEl = h('span', { className: 'sstep-fit-legend-ols' }, [
    h('span', { className: 'sstep-fit-swatch is-ols' }),
    olsLegendTextEl,
  ]);
  const obsLegendTextEl = h('span', { text: t('chart.fit.observed') });
  const singleLegendEl = h('span', { className: 'sstep-fit-legend' }, [
    h('span', { className: 'sstep-fit-swatch is-scatter' }),
    obsLegendTextEl,
    h('span', { className: 'sstep-fit-swatch is-curve' }),
    fitMethodLabelEl,
    h('span', { className: 'sstep-fit-swatch is-ci' }),
    h('span', { text: '95% CI' }),
    olsLegendWrapEl,
  ]);
  const multiLegendEl = h('div', { className: 'sstep-model-legend', hidden: true });
  const fitStatsEl = h('span', { className: 'sstep-fit-delta text-mono text-muted' });

  const fitLegendFoot = h('div', { className: 'sstep-fit-foot' }, [
    singleLegendEl,
    multiLegendEl,
    fitStatsEl,
  ]);

  const plotStage = h('div', { className: 'sstep-plot-stage' }, [emptyHintEl, tooltipEl, svg]);
  const rootEl = h('div', { className: 'sstep-chart-wrap' }, [plotStage, fitLegendFoot]);

  let currentSamples = [];
  let currentMetric = 'tps';
  let hoveredIdx = -1;
  let lastSig = '';
  let lastUpdateParams = null;
  let fitCacheMetric = '';
  const fitCache = new Map();

  function reusePublicationFit(key, xs, ys, maxVal, isMultiCompare) {
    const previous = fitCache.get(key);
    if (
      previous && previous.xs.length === xs.length &&
      xs.every((x, i) => x === previous.xs[i] && ys[i] === previous.ys[i])
    ) {
      return previous.result;
    }
    const result = computePublicationFit(xs, ys, {
      minVal: 0,
      maxVal,
      gridSize: isMultiCompare ? 56 : 64,
      span: 0.5,
    });
    fitCache.set(key, { xs, ys, result });
    return result;
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
      return true;
    }
    return false;
  }

  function showHoverAt(idx) {
    if (idx < 0 || idx >= currentSamples.length) {
      clearHover();
      return;
    }
    hoveredIdx = idx;
    const sp = currentSamples[idx];
    patchAttr(hoverLine, 'hidden', false);
    patchAttr(hoverLine, 'x1', sp.x.toFixed(1));
    patchAttr(hoverLine, 'x2', sp.x.toFixed(1));

    patchAttr(hoverFitDot, 'hidden', false);
    patchAttr(hoverFitDot, 'cx', sp.x.toFixed(1));
    patchAttr(hoverFitDot, 'cy', sp.fitY.toFixed(1));
    patchStyleVar(hoverFitDot, '--hover-dot-color', sp.seriesColor || 'var(--accent-primary)');

    patchAttr(hoverRawDot, 'hidden', false);
    patchAttr(hoverRawDot, 'cx', sp.x.toFixed(1));
    patchAttr(hoverRawDot, 'cy', sp.rawY.toFixed(1));
    patchClasses(hoverRawDot, {
      'is-anomaly': Boolean(sp.anomalySummary),
      'is-danger': Boolean(sp.anomalySummary && sp.anomalySeverity === 'danger'),
    });

    const wasHidden = tooltipEl.hasAttribute('hidden');
    patchAttr(tooltipEl, 'hidden', false);
    patchText(tipHeadLeft, sp.stepTag);
    patchText(tipHeadRight, sp.modelText);
    patchText(
      tipMainLeft,
      t('chart.fit.tipFit', { val: formatChartMetricValue(currentMetric, sp.fitVal) })
    );
    patchText(
      tipMainRight,
      t('chart.fit.tipObs', { val: formatChartMetricValue(currentMetric, sp.rawVal) })
    );

    patchAttr(tipSub, 'hidden', false);
    if (sp.compareHint) {
      patchText(tipSub, sp.compareHint);
    } else if (currentSamples.length >= 3 && sp.ciHalf > 0) {
      patchText(
        tipSub,
        `95% CI [${formatChartMetricCompact(currentMetric, sp.ciLow)}, ${formatChartMetricCompact(currentMetric, sp.ciHigh)}]`
      );
    } else {
      const ctxTok = Math.max(0, Number(sp.st?.contextTokens || 0));
      patchText(
        tipSub,
        t('chart.step.ctxAndCache', {
          ctxTok: formatTokens(ctxTok),
          pct: Number(sp.st?.cacheHitPct ?? 0),
        })
      );
    }
    patchAttr(tipAnomaly, 'hidden', !sp.anomalySummary);
    if (sp.anomalySummary) {
      patchText(tipAnomaly, sp.anomalySummary);
      patchClasses(tipAnomaly, { 'is-danger': sp.anomalySeverity === 'danger' });
    }

    const rawPct = (sp.x / viewW) * 100;
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-y', '0px');
    if (wasHidden) {
      patchClasses(tooltipEl, { 'is-tracking': false });
      void tooltipEl.offsetWidth;
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          if (!tooltipEl.hasAttribute('hidden')) {
            patchClasses(tooltipEl, { 'is-tracking': true });
          }
        });
      } else {
        patchClasses(tooltipEl, { 'is-tracking': true });
      }
    }
  }

  function clearHover() {
    hoveredIdx = -1;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverFitDot, 'hidden', true);
    patchAttr(hoverRawDot, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, { 'is-tracking': false });
  }

  plotStage.addEventListener('mousemove', (e) => {
    if (!currentSamples.length) return;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    let lo = 0;
    let hi = currentSamples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (currentSamples[mid].x < relX) lo = mid + 1;
      else hi = mid;
    }
    let bestIdx = lo;
    if (
      lo > 0 &&
      Math.abs(currentSamples[lo - 1].x - relX) <= Math.abs(currentSamples[lo].x - relX)
    ) {
      bestIdx = lo - 1;
    }
    showHoverAt(bestIdx);
  });
  plotStage.addEventListener('mouseleave', clearHover);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update(lastUpdateParams);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update(lastUpdateParams);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * 在给定横坐标 x0 处对某模型的回归网格做线性插值（仅当 x0 位于该模型观测区间内时返回拟合值）。
   */
  function interpolateSeriesGridFit(grid, x0) {
    if (!Array.isArray(grid) || grid.length === 0) return null;
    if (grid.length === 1) {
      return Math.abs(grid[0].x - x0) < 1e-6 ? grid[0].fit : null;
    }
    const gMin = grid[0].x;
    const gMax = grid[grid.length - 1].x;
    if (x0 < gMin - 1e-6 || x0 > gMax + 1e-6) return null;
    if (x0 <= gMin) return grid[0].fit;
    if (x0 >= gMax) return grid[grid.length - 1].fit;
    for (let i = 0; i < grid.length - 1; i++) {
      const a = grid[i];
      const b = grid[i + 1];
      if (x0 >= a.x && x0 <= b.x) {
        const span = b.x - a.x;
        const t = span > 1e-9 ? (x0 - a.x) / span : 0;
        return a.fit + t * (b.fit - a.fit);
      }
    }
    return grid[grid.length - 1].fit;
  }

  /**
   * 绘制共享的水平网格线、底部步序坐标轴及左对齐内联 Y 轴刻度标签。
   */
  function renderFitAxesAndGrid({ yScale, mapY, mapX, xs, isSingle, plotLeft, plotRight, metric, showAgentPrefix }) {
    while (gridGroup.firstChild) gridGroup.removeChild(gridGroup.firstChild);
    while (axesGroup.firstChild) axesGroup.removeChild(axesGroup.firstChild);

    const xMin = xs[0];
    const xMax = xs[xs.length - 1];

    const xSpine = document.createElementNS(SVG_NS, 'line');
    xSpine.setAttribute('x1', '0');
    xSpine.setAttribute('y1', String(BOTTOM_Y));
    xSpine.setAttribute('x2', String(viewW));
    xSpine.setAttribute('y2', String(BOTTOM_Y));
    xSpine.setAttribute('class', 'sstep-axis-spine');
    axesGroup.appendChild(xSpine);

    for (const tv of yScale.ticks) {
      const ty = mapY(tv);
      if (Math.abs(ty - BOTTOM_Y) > 1.5) {
        const gLine = document.createElementNS(SVG_NS, 'line');
        gLine.setAttribute('x1', '0');
        gLine.setAttribute('y1', ty.toFixed(1));
        gLine.setAttribute('x2', String(viewW));
        gLine.setAttribute('y2', ty.toFixed(1));
        gridGroup.appendChild(gLine);
      }

      const labelEl = document.createElementNS(SVG_NS, 'text');
      labelEl.setAttribute('x', '0');
      labelEl.setAttribute('y', (ty - 3.5).toFixed(1));
      labelEl.setAttribute('text-anchor', 'start');
      labelEl.setAttribute('class', 'sstep-axis-label is-y-inline');
      labelEl.textContent = formatYAxisTick(metric, tv, yScale.step);
      axesGroup.appendChild(labelEl);
    }

    const xTickEntries = [];
    if (isSingle) {
      xTickEntries.push({
        xv: Math.round(xMin),
        tickX: mapX(xMin),
        labelX: mapX(xMin),
        anchor: 'middle',
      });
    } else {
      xTickEntries.push({
        xv: Math.round(xMin),
        tickX: plotLeft,
        labelX: 0,
        anchor: 'start',
      });
      const interiorTicks = computeNiceXStepTicks(xs);
      for (const xv of interiorTicks) {
        if (xv <= xMin || xv >= xMax) continue;
        const tx = mapX(xv);
        if (tx < plotLeft + 38 || tx > plotRight - 38) continue;
        xTickEntries.push({
          xv,
          tickX: tx,
          labelX: tx,
          anchor: 'middle',
        });
      }
      xTickEntries.push({
        xv: Math.round(xMax),
        tickX: plotRight,
        labelX: viewW,
        anchor: 'end',
      });
    }

    for (const xt of xTickEntries) {
      const tickMark = document.createElementNS(SVG_NS, 'line');
      tickMark.setAttribute('x1', xt.tickX.toFixed(1));
      tickMark.setAttribute('y1', String(BOTTOM_Y));
      tickMark.setAttribute('x2', xt.tickX.toFixed(1));
      tickMark.setAttribute('y2', (BOTTOM_Y + 3.2).toFixed(1));
      tickMark.setAttribute('class', 'sstep-axis-tick');
      axesGroup.appendChild(tickMark);

      const labelEl = document.createElementNS(SVG_NS, 'text');
      labelEl.setAttribute('x', xt.labelX.toFixed(1));
      labelEl.setAttribute('y', (BOTTOM_Y + 13.5).toFixed(1));
      labelEl.setAttribute('text-anchor', xt.anchor);
      labelEl.setAttribute('class', 'sstep-axis-label');
      labelEl.textContent = showAgentPrefix ? `${xt.xv}` : `#${xt.xv}`;
      axesGroup.appendChild(labelEl);
    }
  }

  /**
   * @param {{
   *   steps: Array<object>,
   *   modelGroupKey?: string,
   *   modelGroupKeys?: string[]|null,
   *   modelColorByGroup?: Map<string, string>|null,
   *   metric: 'tps'|'ttft'|'cache'|'cost',
   *   showAgentPrefix?: boolean,
   *   displaySettings?: object,
   * }} params
   * @returns {{ sampleCount: number, summaryBadge: string }}
   */
  function update({
    steps = [],
    modelGroupKey = '__all__',
    modelGroupKeys = null,
    modelColorByGroup = null,
    metric = 'tps',
    showAgentPrefix = false,
    displaySettings = {},
  } = {}) {
    lastUpdateParams = {
      steps,
      modelGroupKey,
      modelGroupKeys,
      modelColorByGroup,
      metric,
      showAgentPrefix,
      displaySettings,
    };
    currentMetric = metric;
    syncViewWidth();

    patchStyleVar(rootEl, '--sstep-fit-accent', 'var(--ctx-cached)');

    const rawKeys =
      Array.isArray(modelGroupKeys) && modelGroupKeys.length > 0
        ? modelGroupKeys
        : [modelGroupKey || '__all__'];
    const isPooledAll = rawKeys.includes('__all__');
    const targetKeys = isPooledAll
      ? ['__all__']
      : Array.from(new Set(rawKeys.map((k) => String(k || '')).filter(Boolean)));
    const targetKeySet = new Set(targetKeys);
    const isMultiCompare = !isPooledAll && targetKeys.length >= 2;

    const matchedItems = [];
    let prevXVal = -Infinity;
    for (let idx = 0; idx < steps.length; idx++) {
      const st = steps[idx];
      if (!st || typeof st !== 'object') continue;
      let globalX = showAgentPrefix ? idx + 1 : Number(st.stepIndex ?? idx + 1);
      if (!Number.isFinite(globalX) || globalX <= prevXVal) {
        globalX = prevXVal === -Infinity ? idx + 1 : prevXVal + 1;
      }
      prevXVal = globalX;

      const gk = getStepModelGroupKey(st);
      if (!isPooledAll && !targetKeySet.has(gk)) {
        continue;
      }
      let valid = false;
      let rawVal = 0;
      if (metric === 'tps') {
        valid = !st.isCompactionStep && Number.isFinite(st.tokPerSec) && st.tokPerSec > 0;
        rawVal = valid ? Number(st.tokPerSec) : 0;
      } else if (metric === 'ttft') {
        valid = !st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0;
        rawVal = valid ? Number(st.ttftSec) : 0;
      } else if (metric === 'cache') {
        valid = !st.isCompactionStep && Number.isFinite(st.cacheHitPct) && st.cacheHitPct >= 0;
        rawVal = valid ? Number(st.cacheHitPct) : 0;
      } else if (metric === 'cost') {
        valid = Number.isFinite(Number(st.costUsd)) && Number(st.costUsd) >= 0;
        rawVal = valid ? Number(st.costUsd) : 0;
      }
      if (valid) {
        const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '—' });
        matchedItems.push({
          st,
          gk,
          xVal: globalX,
          rawVal,
          stepTag: formatStepAxisTag(st, showAgentPrefix),
          modelText: disp.baseText || disp.text,
          anomalySummary: formatStepAnomalyInlineSummary(st.anomaly),
          anomalySeverity: st.anomaly?.severity || '',
        });
      }
    }

    const locale = getEffectiveLocale();
    patchText(emptyHintEl, t('chart.fit.empty'));
    patchText(obsLegendTextEl, t('chart.fit.observed'));
    patchText(olsLegendTextEl, t('chart.fit.olsLinear'));

    if (fitCacheMetric !== metric) {
      fitCache.clear();
      fitCacheMetric = metric;
    }
    for (const key of fitCache.keys()) {
      if (isMultiCompare ? !targetKeySet.has(key) : key !== null) fitCache.delete(key);
    }

    if (matchedItems.length === 0) {
      fitCache.clear();
      currentSamples = [];
      lastSig = 'empty';
      patchAttr(ciBandPath, 'd', '');
      patchAttr(fitPath, 'd', '');
      patchAttr(olsLine, 'hidden', true);
      while (multiBandGroup.firstChild) multiBandGroup.removeChild(multiBandGroup.firstChild);
      while (multiCurveGroup.firstChild) multiCurveGroup.removeChild(multiCurveGroup.firstChild);
      while (gridGroup.firstChild) gridGroup.removeChild(gridGroup.firstChild);
      while (axesGroup.firstChild) axesGroup.removeChild(axesGroup.firstChild);
      while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);
      patchAttr(singleLegendEl, 'hidden', false);
      patchAttr(multiLegendEl, 'hidden', true);
      patchAttr(emptyHintEl, 'hidden', false);
      patchText(fitMethodLabelEl, t('chart.fit.loess'));
      patchText(fitStatsEl, 'n = 0');
      clearHover();
      return { sampleCount: 0, summaryBadge: t('chart.fit.zeroSamples') };
    }

    patchAttr(emptyHintEl, 'hidden', true);
    const minBound = 0;
    const maxBound = metric === 'cache' ? 100 : Infinity;

    // 分支 A：多模型同图独立拟合曲线对比模式（勾选 >= 2 个模型）
    if (isMultiCompare) {
      const seriesList = [];
      for (let kIdx = 0; kIdx < targetKeys.length; kIdx++) {
        const key = targetKeys[kIdx];
        const items = matchedItems.filter((it) => it.gk === key);
        if (items.length === 0) continue;
        const xs = items.map((d) => d.xVal);
        const rawYs = items.map((d) => d.rawVal);
        const pubFit = reusePublicationFit(key, xs, rawYs, maxBound, true);
        const colorVar =
          modelColorByGroup?.get(key) || MODEL_COLOR_VARS[kIdx % MODEL_COLOR_VARS.length];
        seriesList.push({
          key,
          label: items[0].modelText || key,
          colorVar,
          items,
          xs,
          rawYs,
          pubFit,
        });
      }

      patchAttr(singleLegendEl, 'hidden', true);
      patchAttr(multiLegendEl, 'hidden', false);
      patchAttr(ciBandPath, 'd', '');
      patchAttr(fitPath, 'd', '');
      patchAttr(olsLine, 'hidden', true);

      const allXs = matchedItems.map((d) => d.xVal);
      let dataMin = Infinity;
      let dataMax = -Infinity;
      for (const s of seriesList) {
        for (const v of s.rawYs) {
          if (v < dataMin) dataMin = v;
          if (v > dataMax) dataMax = v;
        }
        for (const g of s.pubFit.grid) {
          if (g.ciLow < dataMin) dataMin = g.ciLow;
          if (g.ciHigh > dataMax) dataMax = g.ciHigh;
        }
      }

      const yScale = computeNiceYScale(dataMin, dataMax, {
        minBound,
        maxBound,
        tickCount: 4,
      });
      const yRange = Math.max(1e-9, yScale.max - yScale.min);
      const mapY = (v) =>
        BOTTOM_Y - ((clampValue(v, yScale.min, yScale.max) - yScale.min) / yRange) * SPAN_Y;

      const { plotLeft, plotRight, plotSpanX } = resolveFitBounds(viewW);
      const xMin = allXs[0];
      const xMax = allXs[allXs.length - 1];
      const isSingle = matchedItems.length === 1 || xMax - xMin <= 1e-9;
      const mapX = (xv) =>
        isSingle
          ? (plotLeft + plotRight) / 2
          : plotLeft + ((xv - xMin) / (xMax - xMin)) * plotSpanX;

      const combinedSamples = [];
      for (const s of seriesList) {
        const sSamples = s.items.map((item, i) => {
          const x = mapX(item.xVal);
          const rawY = mapY(item.rawVal);
          const fitVal = s.pubFit.sampleFits[i];
          const fitY = mapY(fitVal);
          const peerParts = [];
          for (const other of seriesList) {
            if (other.key === s.key) continue;
            const interp = interpolateSeriesGridFit(other.pubFit.grid, item.xVal);
            if (interp !== null) {
              peerParts.push(`${other.label} ${formatChartMetricCompact(metric, interp)}`);
            } else {
              peerParts.push(
                t('chart.fit.peerMean', {
                  label: other.label,
                  val: formatChartMetricCompact(metric, other.pubFit.mean),
                })
              );
            }
          }
          return {
            ...item,
            x,
            rawY,
            fitVal,
            fitY,
            ciLow: s.pubFit.sampleCiLow[i],
            ciHigh: s.pubFit.sampleCiHigh[i],
            ciHalf: s.pubFit.sampleCiHalf[i],
            seriesColor: s.colorVar,
            compareHint:
              peerParts.length > 0
                ? t('chart.fit.peerCompare', { peers: peerParts.join(' · ') })
                : '',
          };
        });
        s.samples = sSamples;
        combinedSamples.push(...sSamples);
      }
      combinedSamples.sort((a, b) => a.x - b.x || a.xVal - b.xVal);
      currentSamples = combinedSamples;

      const sig =
        `multi|${locale}|${viewW}|${targetKeys.join(',')}|${metric}|${showAgentPrefix}|${yScale.min.toFixed(4)}|${yScale.max.toFixed(4)}|` +
        seriesList
          .map(
            (s) =>
              `${s.key}:${s.colorVar}:` +
              s.samples
                .map(
                  (p) =>
                    `${p.xVal}:${p.rawVal.toFixed(3)}:${p.fitVal.toFixed(3)}:${p.st?.anomalySig || ''}`
                )
                .join(',')
          )
          .join('||');

      if (sig !== lastSig) {
        lastSig = sig;
        renderFitAxesAndGrid({
          yScale,
          mapY,
          mapX,
          xs: allXs,
          isSingle,
          plotLeft,
          plotRight,
          metric,
          showAgentPrefix,
        });

        while (multiBandGroup.firstChild) multiBandGroup.removeChild(multiBandGroup.firstChild);
        while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);
        while (multiCurveGroup.firstChild) multiCurveGroup.removeChild(multiCurveGroup.firstChild);

        const dotRadius =
          combinedSamples.length > 80 ? '1.8' : combinedSamples.length > 36 ? '2.1' : '2.4';
        const dedupOverdraw = combinedSamples.length > 200;
        const scatterTarget =
          typeof document.createDocumentFragment === 'function'
            ? document.createDocumentFragment()
            : scatterGroup;
        const anomalyOverlayDots = [];

        for (const s of seriesList) {
          const binCounts = dedupOverdraw ? new Map() : null;
          for (const sp of s.samples) {
            if (sp.anomalySummary) {
              anomalyOverlayDots.push(sp);
              continue;
            }
            if (binCounts) {
              const binKey = (Math.round(sp.x * 2) << 11) ^ Math.round(sp.rawY * 2);
              const prevCnt = binCounts.get(binKey) || 0;
              if (prevCnt >= 6) continue;
              binCounts.set(binKey, prevCnt + 1);
            }
            const dot = document.createElementNS(SVG_NS, 'circle');
            dot.setAttribute('cx', sp.x.toFixed(1));
            dot.setAttribute('cy', sp.rawY.toFixed(1));
            dot.setAttribute('r', dotRadius);
            dot.setAttribute('class', 'sstep-scatter-dot is-multi');
            patchStyleVar(dot, '--sstep-fit-accent', s.colorVar);
            scatterTarget.appendChild(dot);
          }

          if (s.samples.length === 1) {
            const sp = s.samples[0];
            const segHalf = Math.min(12, plotSpanX * 0.04);
            const x1 = Math.max(plotLeft, sp.x - segHalf).toFixed(1);
            const x2 = Math.min(plotRight, sp.x + segHalf).toFixed(1);
            const yStr = sp.fitY.toFixed(1);
            const lineEl = document.createElementNS(SVG_NS, 'path');
            lineEl.setAttribute('class', 'sstep-fit-line');
            lineEl.setAttribute('fill', 'none');
            lineEl.setAttribute('d', `M ${x1} ${yStr} L ${x2} ${yStr}`);
            patchStyleVar(lineEl, '--sstep-fit-accent', s.colorVar);
            multiCurveGroup.appendChild(lineEl);
          } else {
            const gridPts = s.pubFit.grid.map((g) => ({
              x: mapX(g.x),
              fitY: mapY(g.fit),
              lowY: mapY(g.ciLow),
              highY: mapY(g.ciHigh),
            }));

            if (s.samples.length >= 3) {
              let bandD = `M ${gridPts[0].x.toFixed(1)} ${gridPts[0].highY.toFixed(1)}`;
              for (let i = 1; i < gridPts.length; i++) {
                bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].highY.toFixed(1)}`;
              }
              for (let i = gridPts.length - 1; i >= 0; i--) {
                bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].lowY.toFixed(1)}`;
              }
              bandD += ' Z';
              const bandEl = document.createElementNS(SVG_NS, 'path');
              bandEl.setAttribute('class', 'sstep-ci-band is-multi');
              bandEl.setAttribute('d', bandD);
              patchStyleVar(bandEl, '--sstep-fit-accent', s.colorVar);
              multiBandGroup.appendChild(bandEl);
            }

            const curveEl = document.createElementNS(SVG_NS, 'path');
            curveEl.setAttribute('class', 'sstep-fit-line');
            curveEl.setAttribute('fill', 'none');
            curveEl.setAttribute(
              'd',
              buildPolylinePath(gridPts.map((p) => ({ x: p.x, y: p.fitY })))
            );
            patchStyleVar(curveEl, '--sstep-fit-accent', s.colorVar);
            multiCurveGroup.appendChild(curveEl);
          }
        }
        for (const sp of anomalyOverlayDots) {
          const aDot = document.createElementNS(SVG_NS, 'circle');
          aDot.setAttribute('cx', sp.x.toFixed(1));
          aDot.setAttribute('cy', sp.rawY.toFixed(1));
          aDot.setAttribute('r', '2.9');
          aDot.setAttribute(
            'class',
            `sstep-scatter-dot is-anomaly${sp.anomalySeverity === 'danger' ? ' is-danger' : ''}`
          );
          scatterTarget.appendChild(aDot);
        }
        if (scatterTarget !== scatterGroup) {
          scatterGroup.appendChild(scatterTarget);
        }

        while (multiLegendEl.firstChild) multiLegendEl.removeChild(multiLegendEl.firstChild);
        for (const s of seriesList) {
          const swatch = h('span', { className: 'sstep-legend-line' });
          patchStyleVar(swatch, '--swatch-bg', s.colorVar);
          multiLegendEl.appendChild(
            h('span', { className: 'sstep-legend-item' }, [
              swatch,
              h('span', {
                text: `${s.label} (${formatChartMetricCompact(metric, s.pubFit.mean)})`,
              }),
            ])
          );
        }
      }

      const r2SummaryTitle = seriesList
        .map((s) => {
          const rSign = s.pubFit.r >= 0 ? '+' : '';
          return `${s.label}: n=${s.samples.length}, r=${rSign}${s.pubFit.r.toFixed(2)}, R²=${s.pubFit.r2.toFixed(2)}`;
        })
        .join(' | ');
      patchText(
        fitStatsEl,
        seriesList.length <= 2
          ? seriesList.map((s) => `R²=${s.pubFit.r2.toFixed(2)}`).join(' · ')
          : t('chart.fit.curvesCount', { count: seriesList.length })
      );
      patchAttr(fitStatsEl, 'title', r2SummaryTitle);

      if (hoveredIdx >= currentSamples.length) {
        clearHover();
      } else if (hoveredIdx >= 0) {
        showHoverAt(hoveredIdx);
      }

      return {
        sampleCount: combinedSamples.length,
        summaryBadge: t('chart.fit.multiBadge', {
          steps: combinedSamples.length,
          models: seriesList.length,
        }),
      };
    }

    // 分支 B：单模型或整体合并单曲线模式
    while (multiBandGroup.firstChild) multiBandGroup.removeChild(multiBandGroup.firstChild);
    while (multiCurveGroup.firstChild) multiCurveGroup.removeChild(multiCurveGroup.firstChild);
    patchAttr(singleLegendEl, 'hidden', false);
    patchAttr(multiLegendEl, 'hidden', true);

    const filtered = matchedItems;
    const xs = filtered.map((d) => d.xVal);
    const rawYs = filtered.map((d) => d.rawVal);
    const pubFit = reusePublicationFit(null, xs, rawYs, maxBound, false);

    patchText(
      fitMethodLabelEl,
      pubFit.method === 'LOESS' ? t('chart.fit.loess') : t('chart.fit.olsReg')
    );
    patchAttr(olsLegendWrapEl, 'hidden', filtered.length < 6);

    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (let i = 0; i < filtered.length; i++) {
      if (rawYs[i] < dataMin) dataMin = rawYs[i];
      if (rawYs[i] > dataMax) dataMax = rawYs[i];
    }
    for (const g of pubFit.grid) {
      if (g.ciLow < dataMin) dataMin = g.ciLow;
      if (g.ciHigh > dataMax) dataMax = g.ciHigh;
    }

    const yScale = computeNiceYScale(dataMin, dataMax, {
      minBound,
      maxBound,
      tickCount: 4,
    });
    const yRange = Math.max(1e-9, yScale.max - yScale.min);
    const mapY = (v) =>
      BOTTOM_Y - ((clampValue(v, yScale.min, yScale.max) - yScale.min) / yRange) * SPAN_Y;

    const { plotLeft, plotRight, plotSpanX } = resolveFitBounds(viewW);
    const xMin = xs[0];
    const xMax = xs[xs.length - 1];
    const isSingle = filtered.length === 1 || xMax - xMin <= 1e-9;
    const mapX = (xv) =>
      isSingle
        ? (plotLeft + plotRight) / 2
        : plotLeft + ((xv - xMin) / (xMax - xMin)) * plotSpanX;

    const samples = filtered.map((item, i) => {
      const x = mapX(item.xVal);
      const rawY = mapY(item.rawVal);
      const fitVal = pubFit.sampleFits[i];
      const fitY = mapY(fitVal);
      return {
        ...item,
        x,
        rawY,
        fitVal,
        fitY,
        ciLow: pubFit.sampleCiLow[i],
        ciHigh: pubFit.sampleCiHigh[i],
        ciHalf: pubFit.sampleCiHalf[i],
        seriesColor: 'var(--accent-primary)',
        compareHint: '',
      };
    });
    currentSamples = samples;

    const sig =
      `single|${locale}|${viewW}|${targetKeys[0]}|${metric}|${showAgentPrefix}|${yScale.min.toFixed(4)}|${yScale.max.toFixed(4)}|` +
      samples
        .map(
          (s) => `${s.xVal}:${s.rawVal.toFixed(4)}:${s.fitVal.toFixed(4)}:${s.st?.anomalySig || ''}`
        )
        .join('|');

    if (sig !== lastSig) {
      lastSig = sig;
      renderFitAxesAndGrid({
        yScale,
        mapY,
        mapX,
        xs,
        isSingle,
        plotLeft,
        plotRight,
        metric,
        showAgentPrefix,
      });

      // 2. 绘制半透明冷蓝灰实心观测散点（自然呈现局部密度，不抢夺拟合曲线焦点）
      while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);
      const dotRadius = samples.length > 80 ? '1.8' : samples.length > 36 ? '2.1' : '2.4';
      const binCounts = samples.length > 200 ? new Map() : null;
      const scatterTarget =
        typeof document.createDocumentFragment === 'function'
          ? document.createDocumentFragment()
          : scatterGroup;
      const singleAnomalyDots = [];
      for (const s of samples) {
        if (s.anomalySummary) {
          singleAnomalyDots.push(s);
          continue;
        }
        if (binCounts) {
          const binKey = (Math.round(s.x * 2) << 11) ^ Math.round(s.rawY * 2);
          const prevCnt = binCounts.get(binKey) || 0;
          if (prevCnt >= 6) continue;
          binCounts.set(binKey, prevCnt + 1);
        }
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', s.x.toFixed(1));
        dot.setAttribute('cy', s.rawY.toFixed(1));
        dot.setAttribute('r', dotRadius);
        dot.setAttribute('class', 'sstep-scatter-dot');
        scatterTarget.appendChild(dot);
      }
      for (const s of singleAnomalyDots) {
        const aDot = document.createElementNS(SVG_NS, 'circle');
        aDot.setAttribute('cx', s.x.toFixed(1));
        aDot.setAttribute('cy', s.rawY.toFixed(1));
        aDot.setAttribute('r', '2.9');
        aDot.setAttribute(
          'class',
          `sstep-scatter-dot is-anomaly${s.anomalySeverity === 'danger' ? ' is-danger' : ''}`
        );
        scatterTarget.appendChild(aDot);
      }
      if (scatterTarget !== scatterGroup) {
        scatterGroup.appendChild(scatterTarget);
      }

      // 3. 绘制 95% CI 置信带闭合多边形与回归拟合曲线（绝不向底部 X 轴填充面积！）
      if (isSingle) {
        const yStr = samples[0].fitY.toFixed(1);
        patchAttr(fitPath, 'd', `M ${plotLeft.toFixed(1)} ${yStr} L ${plotRight.toFixed(1)} ${yStr}`);
        patchAttr(ciBandPath, 'd', '');
        patchAttr(olsLine, 'hidden', true);
      } else {
        const gridPts = pubFit.grid.map((g) => ({
          x: mapX(g.x),
          fitY: mapY(g.fit),
          lowY: mapY(g.ciLow),
          highY: mapY(g.ciHigh),
        }));

        patchAttr(
          fitPath,
          'd',
          buildPolylinePath(gridPts.map((p) => ({ x: p.x, y: p.fitY })))
        );

        if (samples.length >= 3) {
          let bandD = `M ${gridPts[0].x.toFixed(1)} ${gridPts[0].highY.toFixed(1)}`;
          for (let i = 1; i < gridPts.length; i++) {
            bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].highY.toFixed(1)}`;
          }
          for (let i = gridPts.length - 1; i >= 0; i--) {
            bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].lowY.toFixed(1)}`;
          }
          bandD += ' Z';
          patchAttr(ciBandPath, 'd', bandD);
        } else {
          patchAttr(ciBandPath, 'd', '');
        }

        const showOlsRef = samples.length >= 6;
        patchAttr(olsLine, 'hidden', !showOlsRef);
        if (showOlsRef) {
          const olsStartVal = clampValue(pubFit.intercept + pubFit.slope * xMin, minBound, maxBound);
          const olsEndVal = clampValue(pubFit.intercept + pubFit.slope * xMax, minBound, maxBound);
          patchAttr(olsLine, 'x1', plotLeft.toFixed(1));
          patchAttr(olsLine, 'y1', mapY(olsStartVal).toFixed(1));
          patchAttr(olsLine, 'x2', plotRight.toFixed(1));
          patchAttr(olsLine, 'y2', mapY(olsEndVal).toFixed(1));
        }
      }
    }

    const summaryBadge = t('chart.fit.singleBadge', {
      steps: samples.length,
      mean: formatChartMetricCompact(metric, pubFit.mean),
    });
    if (samples.length >= 2) {
      const rSign = pubFit.r >= 0 ? '+' : '';
      const slopeSign = pubFit.slope >= 0 ? '+' : '';
      patchText(fitStatsEl, `r = ${rSign}${pubFit.r.toFixed(2)} · R² = ${pubFit.r2.toFixed(2)}`);
      patchAttr(
        fitStatsEl,
        'title',
        t('chart.fit.olsTitle', {
          slope: `${slopeSign}${pubFit.slope.toFixed(3)}`,
          intercept: pubFit.intercept.toFixed(2),
          sd: pubFit.sd.toFixed(2),
        })
      );
    } else {
      patchText(fitStatsEl, `n = ${samples.length}`);
      patchAttr(fitStatsEl, 'title', '');
    }

    if (hoveredIdx >= samples.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showHoverAt(hoveredIdx);
    }

    return { sampleCount: samples.length, summaryBadge };
  }

  return { el: rootEl, update, destroy };
}
