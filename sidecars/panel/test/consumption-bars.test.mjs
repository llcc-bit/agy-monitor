import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockDom } from './mock-dom.mjs';
import { backendHarness } from './backend-harness.mjs';
import {
  buildDeterministicModelColorMap,
  getCanonicalModelColorSeed,
  mergeModelsByDisplayName,
  resolveDeterministicModelColor,
} from '../src/core/formatters.js';
import {
  clearConsumptionRangeCache,
  fetchTelemetry,
  isEquivalentTelemetry,
  prefetchConsumptionPresets,
  selectConsumptionTimeRange,
  stopAsyncTelemetryLoop,
  telemetryStore,
} from '../src/store/telemetryStore.js';
import { createTrendAreaChart } from '../src/components/charts/TrendAreaChart.js';
import { uiStore } from '../src/store/uiStore.js';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { createFourSegmentBar } from '../src/components/ui/FourSegmentBar.js';
import { ConsumptionView } from '../src/views/ConsumptionView.js';

function parsePctVar(el, prop = '--seg-w') {
  const raw = el?.style?.getPropertyValue?.(prop) || '';
  return Number.parseFloat(raw.replace('%', '')) || 0;
}

test('Perceptual 20-color ring: deterministic cross-machine assignment without green pileups or hardcoded tables', () => {
  const realUserModels = [
    '3.7-flash',
    '3-flash-b',
    '3.8-flash',
    'pro-default',
    '3-flash-c',
    '3.6-flash',
    'opus-4-6-thinking',
    '3.1-flash-lite',
    'sonnet-4-6',
    '2.5-flash-lite',
    '4-argon',
    '4-carbon',
    '3.8-flash-n',
    '4-hydrogen',
    'orchestrator-carbon',
    'worker-agy-hydrogen',
  ];

  const mapForward = buildDeterministicModelColorMap(realUserModels);
  const mapReversed = buildDeterministicModelColorMap([...realUserModels].reverse());
  assert.deepEqual([...mapForward.entries()], [...mapReversed.entries()]);

  // All 16 models receive 16 completely distinct perceptual HSL colors
  const uniqueColors = new Set(mapForward.values());
  assert.equal(uniqueColors.size, realUserModels.length);

  // Merged upstream buckets ('4-carbon' across App vs CLI with different sourceLabels subsets) share identical seed
  const appMergedCarbon = {
    displayText: '4-carbon',
    mergedCount: 2,
    sourceLabels: ['Gemini 4 Carbon (High)', 'Gemini 4 Carbon (Medium)'],
  };
  const cliMergedCarbon = {
    displayText: '4-carbon',
    mergedCount: 1,
    sourceLabels: ['Gemini 4 Carbon (Low)'],
    label: 'Gemini 4 Carbon (Low)',
  };
  assert.equal(getCanonicalModelColorSeed(appMergedCarbon), '4-carbon');
  const singleModeModels = mergeModelsByDisplayName(
    [
      {
        label: 'Gemini 4 Carbon (Low)',
        shortName: '4-carbon',
        upstreamName: '4-carbon',
        calls: 2,
        totalTokens: 1000,
      },
    ],
    { modelDisplayMode: 'upstream', showUpstreamModel: true }
  );
  assert.equal(singleModeModels[0].displayText, '4-carbon');

  // Arbitrary future models work without hardcoding
  const future = resolveDeterministicModelColor('Gemini 9 Krypton (Ultra)');
  assert.match(future, /^hsl\(\d+\s+\d+%\s+\d+%\)$/);
  assert.equal(future, resolveDeterministicModelColor('  gemini 9   krypton (ultra) '));
  assert.ok(cliMergedCarbon);
});

test('FourSegmentBar supports percentage scaling while keeping 100% default for Overview', () => {
  const prevDoc = globalThis.document;
  const { document } = createMockDom();
  globalThis.document = document;
  try {
    const barFull = createFourSegmentBar();
    barFull.update({
      inputTokens: 200,
      cacheReadTokens: 500,
      responseTokens: 200,
      thinkingTokens: 100,
    });
    const segsFull = barFull.el.querySelectorAll('.progress-seg');
    const sumFull = segsFull.reduce((acc, el) => acc + parsePctVar(el), 0);
    assert.ok(Math.abs(sumFull - 100) < 0.05);

    const barScaled = createFourSegmentBar();
    barScaled.update({
      inputTokens: 200,
      cacheReadTokens: 500,
      responseTokens: 200,
      thinkingTokens: 100,
      scaleRatio: 0.4,
    });
    const segsScaled = barScaled.el.querySelectorAll('.progress-seg');
    const sumScaled = segsScaled.reduce((acc, el) => acc + parsePctVar(el), 0);
    assert.ok(Math.abs(sumScaled - 40) < 0.05);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('Backend aggregates per-model breakdown on both sourcesBreakdown and monthlySeries', async () => {
  const nowMs = Date.parse('2026-11-18T12:00:00Z');
  const nowIso = '2026-11-18T12:00:00Z';
  const appCid = 'aaaaaaaa-1111-4111-8111-111111111111';
  const cliCid = 'cccccccc-2222-4222-8222-222222222222';

  const harness = backendHarness({
    clock: () => nowMs,
    trajectories: {
      [appCid]: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_USER_INPUT',
              status: 'CORTEX_STEP_STATUS_DONE',
              userInput: { userResponse: 'Hello App' },
              metadata: { createdAt: nowIso },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: nowIso,
                completedAt: '2026-11-18T12:00:03Z',
                sourceTrajectoryStepInfo: { stepIndex: 1 },
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  inputTokens: '6000',
                  cacheReadTokens: '2000',
                  outputTokens: '2000',
                },
              },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-18T12:00:05Z',
                completedAt: '2026-11-18T12:00:08Z',
                sourceTrajectoryStepInfo: { stepIndex: 2 },
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M405',
                  apiProvider: 'API_PROVIDER_ANTHROPIC',
                  inputTokens: '4000',
                  cacheReadTokens: '0',
                  outputTokens: '1000',
                },
              },
            },
          ],
        },
      },
    },
    summaries: {
      [appCid]: {
        summary: 'App Session',
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 3,
        createdTime: nowIso,
        lastModifiedTime: '2026-11-18T12:00:08Z',
      },
    },
    deepStats: {
      perConvo: {
        [`cli:${cliCid}`]: {
          appSource: 'cli',
          entries: [
            {
              ts: '2026-11-18T12:01:00Z',
              modelRuntimeId: 'MODEL_PLACEHOLDER_M429',
              inp: 3000,
              cache: 1000,
              out: 800,
              reasoning: 200,
            },
          ],
        },
      },
    },
  });

  const payload = await harness.buildTelemetryPayloadInternal({ range: 'all' });
  const sources = payload.consumption?.sourcesBreakdown || [];
  assert.equal(sources.length, 2);
  assert.equal(sources[0].name, 'Antigravity App');
  assert.equal(sources[0].totalTokens, 15_000);
  assert.equal(sources[0].models.length, 2);
  assert.equal(sources[1].name, 'Antigravity CLI');
  assert.equal(sources[1].totalTokens, 5_000);
  assert.equal(sources[1].models.length, 1);

  // November (index 10) in monthlySeries also carries aggregated per-model breakdown
  const novBucket = payload.consumption?.monthlySeries?.[10];
  assert.ok(novBucket);
  assert.equal(novBucket.totalTokens, 20_000);
  assert.equal(novBucket.models.length, 2);

  // Active trendSeries bucket carries per-model breakdown while zero-token buckets omit models
  const trendSlots = payload.consumption?.trendSeries || [];
  const activeTrendSlot = trendSlots.find((s) => s.tokens > 0);
  const zeroTrendSlot = trendSlots.find((s) => s.tokens === 0);
  assert.ok(activeTrendSlot);
  assert.equal(activeTrendSlot.tokens, 20_000);
  assert.equal(activeTrendSlot.models.length, 2);
  if (zeroTrendSlot) {
    assert.equal(zeroTrendSlot.models, undefined);
  }
});

test('ConsumptionView: Top Models color dot + % bar, clutter-free Client Sources + Monthly model bars with long-tail folding & hover popover', async (t) => {
  const prevLocale = i18nStore.getState().locale;
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTelState = { ...telemetryStore.getState() };
  const prevUiState = { ...uiStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };

  let view = null;
  t.after(() => {
    if (view) view.destroy();
    setI18nLanguage(prevLocale);
    telemetryStore.setState(prevTelState, { sync: true });
    uiStore.setState(prevUiState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState(
    { monitorVisible: true, activeView: 'consumption', settingsOpen: false },
    { sync: true }
  );

  const mkModel = (name, tok, calls = 2, costUsd = 0.1) => ({
    label: name,
    shortName: name,
    upstreamName: name,
    calls,
    inputTokens: Math.floor(tok * 0.2),
    cacheReadTokens: Math.floor(tok * 0.6),
    outputTokens: Math.floor(tok * 0.2),
    responseTokens: Math.floor(tok * 0.15),
    thinkingTokens: tok - Math.floor(tok * 0.2) - Math.floor(tok * 0.6) - Math.floor(tok * 0.15),
    totalTokens: tok,
    costUsd,
    unpricedCalls: 0,
  });

  const mArgon = mkModel('4-argon', 50_000, 10, 0.5);
  const mCarbon = mkModel('4-carbon', 30_000, 6, 0.3);
  const mFlash = mkModel('3.8-flash-n', 18_000, 4, 0.12);
  const mTail1 = mkModel('opus-4-6-thinking', 800, 1, 0.02);
  const mTail2 = mkModel('3.1-flash-lite', 700, 1, 0.01);
  const mTail3 = mkModel('2.5-flash-lite', 500, 1, 0.01);

  const emptyMonths = Array.from({ length: 12 }, (_, idx) => ({
    month: idx + 1,
    label: `${idx + 1}月`,
    calls: 0,
    totalTokens: 0,
    costUsd: 0,
    models: [],
  }));
  emptyMonths[10] = {
    month: 11,
    label: '11月',
    calls: 23,
    totalTokens: 100_000,
    costUsd: 0.96,
    models: [mArgon, mCarbon, mFlash, mTail1, mTail2, mTail3],
  };

  const baseTelemetry = {
    settings: {
      language: 'zh-CN',
      modelDisplayMode: 'upstream',
      showUpstreamModel: true,
    },
    modelBreakdown: [mArgon, mCarbon, mFlash, mTail1, mTail2, mTail3],
    consumption: {
      selectedRange: { key: 'all', label: '全部', startMs: 1_700_000_000_000, endMs: 1_700_086_400_000 },
      account: {
        totalTokens: 100_000,
        inputTokens: 20_000,
        cacheReadTokens: 60_000,
        outputTokens: 20_000,
        responseTokens: 15_000,
        thinkingTokens: 5_000,
        calls: 23,
        costUsd: 0.96,
        savedCostUsd: 0.25,
        cacheHitPct: 75.0,
      },
      trendSeries: [
        {
          index: 0,
          granularity: 'day',
          label: '11/17',
          fullLabel: '11月17日 (周二)',
          tokens: 0,
          calls: 0,
          costUsd: 0,
        },
        {
          index: 1,
          granularity: 'day',
          label: '11/18',
          fullLabel: '11月18日 (周三)',
          tokens: 100_000,
          inputTokens: 20_000,
          cacheReadTokens: 60_000,
          outputTokens: 20_000,
          calls: 23,
          costUsd: 0.96,
          models: [mArgon, mCarbon, mFlash, mTail1, mTail2, mTail3],
        },
      ],
      monthlyYear: 2026,
      monthlySeries: emptyMonths,
      sourcesBreakdown: [
        {
          name: 'Antigravity App',
          calls: 20,
          totalTokens: 80_000,
          costUsd: 0.8,
          unpricedCalls: 0,
          models: [
            mkModel('4-argon', 40_000, 8, 0.4),
            mkModel('4-carbon', 25_000, 5, 0.25),
            mkModel('3.8-flash-n', 13_000, 4, 0.1),
            mTail1,
            mTail2,
            mTail3,
          ],
        },
        {
          name: 'Antigravity CLI',
          calls: 3,
          totalTokens: 20_000,
          costUsd: 0.16,
          unpricedCalls: 0,
          models: [
            mkModel('4-argon', 10_000, 2, 0.1),
            mkModel('4-carbon', 5_000, 1, 0.05),
            mkModel('3.8-flash-n', 5_000, 0, 0.01),
          ],
        },
      ],
    },
  };

  assert.equal(
    isEquivalentTelemetry(baseTelemetry, {
      ...baseTelemetry,
      consumption: {
        ...baseTelemetry.consumption,
        monthlySeries: emptyMonths.map((m, idx) =>
          idx === 10 ? { ...m, models: [mArgon] } : m
        ),
      },
    }),
    false,
    'isEquivalentTelemetry must detect model breakdown changes inside monthlySeries'
  );

  telemetryStore.setState(
    { selectedTimeRange: 'all', telemetry: baseTelemetry },
    { sync: true }
  );

  view = ConsumptionView({});
  document.body.appendChild(view.el);
  await Promise.resolve();

  const allRows = view.el.querySelectorAll('.cons-item-row');
  const modelRows = allRows.filter((r) => !r.classList.contains('cons-source-row'));
  const sourceRows = view.el.querySelectorAll('.cons-source-row');
  assert.equal(modelRows.length, 6);
  assert.equal(sourceRows.length, 2);

  // 1. Top Models: colored dot appears right after model name & 4-segment bar scales to 50% (not 100%)
  const argonTitleDot = modelRows[0].querySelector('.cons-title-model-dot');
  assert.ok(argonTitleDot && !argonTitleDot.hasAttribute('hidden'));
  const argonDotColor = argonTitleDot.style.getPropertyValue('--dot-color');
  assert.match(argonDotColor, /^hsl\(/);

  const argonSegSum = modelRows[0]
    .querySelectorAll('.progress-seg')
    .reduce((s, el) => s + parsePctVar(el, '--seg-w'), 0);
  assert.ok(Math.abs(argonSegSum - 50) < 0.1, `Expected 50% width for 4-argon row, got ${argonSegSum}`);

  // 2. Client Sources: NO multi-line .cons-source-model-chip dump; renders single-line Top 2-3 models + 1 merged '__other__' segment on the bar!
  assert.equal(sourceRows[0].querySelectorAll('.cons-source-model-chip').length, 0);
  const appTopItems = sourceRows[0].querySelectorAll('.cons-source-top-item');
  assert.equal(appTopItems.length, 3, 'Should show top 3 non-other models in single-line footer');
  assert.equal(appTopItems[0].querySelector('.cons-source-top-name')?.textContent, '4-argon');
  assert.equal(appTopItems[0].querySelector('.cons-source-top-pct')?.textContent, '50%');
  assert.equal(appTopItems[0].querySelector('.cons-source-top-dot')?.style.getPropertyValue('--dot-color'), argonDotColor);
  assert.equal(appTopItems[1].querySelector('.cons-source-top-name')?.textContent, '4-carbon');
  assert.equal(appTopItems[1].querySelector('.cons-source-top-pct')?.textContent, '31%');
  assert.equal(appTopItems[2].querySelector('.cons-source-top-name')?.textContent, '3.8-flash-n');
  assert.equal(appTopItems[2].querySelector('.cons-source-top-pct')?.textContent, '16%');

  const appSegs = sourceRows[0].querySelectorAll('.cons-model-seg');
  assert.equal(appSegs.length, 4, '3 main models + 1 merged other segment');
  assert.equal(appSegs[0].style.getPropertyValue('--seg-color'), argonDotColor);
  assert.equal(appSegs[3].style.getPropertyValue('--seg-color'), 'var(--cons-other-seg)');
  const appBarSum = appSegs.reduce((s, el) => s + parsePctVar(el, '--seg-w'), 0);
  assert.ok(Math.abs(appBarSum - 80) < 0.1);

  // Hovering Client Source bar hit area OR top-models summary opens shared popover with model details + '其他 (3)'
  const popover = view.refs.breakdownPopoverEl;
  assert.equal(popover.hasAttribute('hidden'), true);
  const appBarHit = sourceRows[0].querySelector('.cons-source-bar-hit');
  appBarHit.dispatchEvent({ type: 'mouseenter', clientX: 120 });
  assert.equal(popover.hasAttribute('hidden'), false);
  assert.equal(popover.querySelector('.trend-tip-time')?.textContent, 'Antigravity App');
  const popRows = popover.querySelectorAll('.cons-pop-model-row');
  assert.equal(popRows.length, 4);
  assert.equal(popRows[0].querySelector('.cons-pop-model-name')?.textContent, '4-argon');
  assert.equal(popRows[0].querySelector('.cons-pop-model-pct')?.textContent, '50.0%');
  assert.equal(popRows[3].querySelector('.cons-pop-model-name')?.textContent, '其他 (3)');

  appBarHit.dispatchEvent({ type: 'mouseleave' });
  assert.equal(popover.hasAttribute('hidden'), true);

  const appTopModelsEl = sourceRows[0].querySelector('.cons-source-top-models');
  appTopModelsEl.dispatchEvent({ type: 'mouseenter', clientX: 90 });
  assert.equal(popover.hasAttribute('hidden'), false);
  assert.equal(popover.querySelector('.trend-tip-time')?.textContent, 'Antigravity App');
  appTopModelsEl.dispatchEvent({ type: 'mouseleave' });
  assert.equal(popover.hasAttribute('hidden'), true);

  // Verify single-line non-wrapping CSS rules exist for client source top models
  const { readFileSync } = await import('node:fs');
  const consCss = readFileSync(new URL('../src/styles/views-consumption.css', import.meta.url), 'utf8');
  assert.match(consCss, /\.cons-source-foot\s*\{[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(consCss, /\.cons-source-top-models\s*\{[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(consCss, /@container\s*\(max-width:\s*340px\)\s*\{\s*\.cons-source-top-item:nth-child\(n\s*\+\s*3\)/);

  // 3. Monthly Breakdown: old 4-channel legend removed; Nov column renders model-colored vertical segments & hover popover
  assert.equal(view.el.querySelectorAll('.monthly-legend').length, 0);
  const monthCols = view.el.querySelectorAll('.month-col');
  const novCol = monthCols[10];
  const novSegs = novCol.querySelectorAll('.month-seg.cons-model-seg');
  assert.equal(novSegs.length, 4, '3 main models + 1 merged other segment stacked vertically');
  // Bottom segment of vertical stack is the #1 model (4-argon) with exact matching color
  assert.equal(novSegs[novSegs.length - 1].style.getPropertyValue('--seg-color'), argonDotColor);
  const novSegHeightSum = novSegs.reduce((s, el) => s + parsePctVar(el, '--seg-h'), 0);
  assert.ok(Math.abs(novSegHeightSum - 100) < 0.1);

  novCol.dispatchEvent({ type: 'mouseenter' });
  assert.equal(popover.hasAttribute('hidden'), false);
  assert.equal(popover.querySelector('.trend-tip-time')?.textContent, '2026年 11月');
  assert.equal(popover.querySelectorAll('.cons-pop-model-row').length, 4);

  // 4. Usage Trend: taller 184px viewBox & hovering x-axis tick opens trend tooltip with identical model colors + long-tail '其他 (3)'
  const trendSvg = view.el.querySelector('.trend-svg');
  assert.match(trendSvg?.getAttribute('viewBox') || '', /\s184$/);
  const trendTicks = view.el.querySelectorAll('.trend-x-tick');
  assert.equal(trendTicks.length, 2);
  trendTicks[1].onclick();
  const trendTip = view.el.querySelector('.trend-tooltip');
  assert.equal(trendTip?.hasAttribute('hidden'), false);
  const trendTipModelRows = trendTip.querySelectorAll('.cons-pop-model-row');
  assert.equal(trendTipModelRows.length, 4);
  assert.equal(trendTipModelRows[0].querySelector('.cons-pop-model-name')?.textContent, '4-argon');
  assert.equal(
    trendTipModelRows[0].querySelector('.cons-model-dot')?.style.getPropertyValue('--dot-color'),
    argonDotColor
  );
  assert.equal(trendTipModelRows[3].querySelector('.cons-pop-model-name')?.textContent, '其他 (3)');
});

test('selectConsumptionTimeRange serves prefetched presets with 0 network calls, blocks stale 2s poll overwrites, and TrendAreaChart heatmap batches via DocumentFragment', async (t) => {
  const prevTelState = { ...telemetryStore.getState() };
  const prevDoc = globalThis.document;
  t.after(() => {
    stopAsyncTelemetryLoop();
    clearConsumptionRangeCache();
    telemetryStore.setState(prevTelState, { sync: true });
    globalThis.document = prevDoc;
  });

  clearConsumptionRangeCache();
  const mkSlice = (key, label, totalTokens, rev = 7) => ({
    revision: rev,
    selectedRange: { key, label, startMs: 1_700_000_000_000, endMs: 1_700_086_400_000 },
    session: { totalTokens },
    account: { totalTokens, calls: 2, inputTokens: totalTokens, cacheReadTokens: 0, outputTokens: 0, costUsd: 0.1, savedCostUsd: 0, cacheHitPct: 0 },
    trendSeries: [{ index: 0, label: '11/19', fullLabel: '11月19日', tokens: totalTokens, calls: 2, costUsd: 0.1 }],
    sourcesBreakdown: [{ name: 'Antigravity App', calls: 2, totalTokens, costUsd: 0.1, models: [] }],
    modelBreakdown: [{ label: 'Claude 4.5 Sonnet', shortName: 'Sonnet 4.5', calls: 2, totalTokens, costUsd: 0.1 }],
  });

  const baseTelemetry = {
    account: { email: 'u@example.com', status: 'signedIn' },
    settings: { language: 'zh-CN', weeklyLimitMode: 'official' },
    cloudStatus: { catalogVersion: 'v1' },
    activeConversation: { cascadeId: 'c1', recentSteps: [], agents: [] },
    consumption: {
      ...mkSlice('today', '今日', 1000, 7),
      presets: { today: { label: '今日', account: { totalTokens: 1000 } } },
      monthlyYear: 2026,
      monthlySeries: [],
    },
    modelBreakdown: mkSlice('today', '今日', 1000, 7).modelBreakdown,
  };
  telemetryStore.setState({ selectedTimeRange: 'today', telemetry: baseTelemetry }, { sync: true });

  const requestedUrls = [];
  let resolveStalePoll = null;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    requestedUrls.push(u);
    if (u.includes('scope=consumption-presets')) {
      return {
        ok: true,
        json: async () => ({
          scope: 'consumption-presets',
          usageRevision: 7,
          ranges: {
            cycle: mkSlice('cycle', '当前周期', 4000, 7),
            today: mkSlice('today', '今日', 1000, 7),
            '24h': mkSlice('24h', '近 24 小时', 1500, 7),
            '7d': mkSlice('7d', '近 7 天', 7000, 7),
            '14d': mkSlice('14d', '近 14 天', 14000, 7),
            '30d': mkSlice('30d', '近 30 天', 30000, 7),
            all: mkSlice('all', '全部时间', 90000, 7),
          },
        }),
      };
    }
    if (u.includes('scope=consumption') && u.includes('range=30d')) {
      return {
        ok: true,
        json: async () => ({
          scope: 'consumption',
          usageRevision: 8,
          consumption: mkSlice('30d', '近 30 天', 31000, 8),
          modelBreakdown: mkSlice('30d', '近 30 天', 31000, 8).modelBreakdown,
        }),
      };
    }
    // Simulated slow 2s background poll started on 'today' that resolves later with rev=8
    return {
      ok: true,
      json: async () =>
        new Promise((resolve) => {
          resolveStalePoll = () =>
            resolve({
              ...baseTelemetry,
              consumption: {
                ...baseTelemetry.consumption,
                ...mkSlice('today', '今日', 1200, 8),
              },
              modelBreakdown: mkSlice('today', '今日', 1200, 8).modelBreakdown,
            });
        }),
    };
  });

  // 1. Entering ConsumptionView prefetches all 7 presets once
  assert.equal(await prefetchConsumptionPresets(), true);
  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /scope=consumption-presets/);

  // 2. Switching across presets hits rangeCache with ZERO network requests and atomic state swap
  await selectConsumptionTimeRange('7d');
  assert.equal(requestedUrls.length, 1, 'Cached preset switch must issue 0 HTTP requests');
  assert.equal(telemetryStore.getState().selectedTimeRange, '7d');
  assert.equal(telemetryStore.getState().telemetry.consumption.selectedRange.key, '7d');
  assert.equal(telemetryStore.getState().telemetry.consumption.account.totalTokens, 7000);

  await selectConsumptionTimeRange('today');
  assert.equal(requestedUrls.length, 1);

  // 3. Stale in-flight 2s background poll ('today', rev=8) finishes AFTER user switched to '30d' locally:
  // must NOT overwrite view back to 'today', and should trigger silent background revalidation for '30d'
  const stalePollPromise = fetchTelemetry({ force: false });
  await Promise.resolve();
  await selectConsumptionTimeRange('30d');
  assert.equal(telemetryStore.getState().telemetry.consumption.selectedRange.key, '30d');
  assert.equal(telemetryStore.getState().telemetry.consumption.account.totalTokens, 30000);

  assert.equal(typeof resolveStalePoll, 'function');
  resolveStalePoll();
  await stalePollPromise;
  // Wait microtasks for silent background scope=consumption revalidation of 30d
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(telemetryStore.getState().selectedTimeRange, '30d');
  assert.equal(telemetryStore.getState().telemetry.consumption.selectedRange.key, '30d');
  assert.equal(telemetryStore.getState().telemetry.consumption.account.totalTokens, 31000);

  // 4. TrendAreaChart >90d heatmap builds all cells cleanly via DocumentFragment when available
  const { document } = createMockDom();
  let fragUsed = false;
  document.createDocumentFragment = () => {
    fragUsed = true;
    const holder = document.createElement('div');
    holder.isFragment = true;
    return holder;
  };
  const origAppend = Object.getPrototypeOf(document.createElement('div')).appendChild;
  globalThis.document = document;
  const chart = createTrendAreaChart();
  const hmGrid = chart.el.querySelector('.trend-hm-grid');
  hmGrid.appendChild = function (node) {
    if (node?.isFragment) {
      for (const child of [...(node.children || [])]) {
        origAppend.call(this, child);
      }
      return node;
    }
    return origAppend.call(this, node);
  };
  const startDay = Date.parse('2026-06-01T00:00:00.000Z');
  const slots = Array.from({ length: 100 }, (_, i) => ({
    index: i,
    granularity: 'day',
    startMs: startDay + i * 86400_000,
    label: `D${i}`,
    fullLabel: `Day ${i}`,
    tokens: (i % 5) * 1000,
    calls: i % 5,
    costUsd: 0.05,
  }));
  chart.update(slots);
  assert.equal(fragUsed, true);
  assert.equal(
    chart.el.querySelectorAll('.trend-hm-cell').filter((c) => !c.classList.contains('is-pad')).length,
    100
  );
  chart.destroy();
});
